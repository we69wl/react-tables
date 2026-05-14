import os
import json
import time
import threading
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from google.oauth2 import service_account
import httplib2
import google_auth_httplib2
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
import requests as req_lib
from dotenv import load_dotenv
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

load_dotenv()

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Table Widget API")

_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins.split(",")],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ── Config ────────────────────────────────────────────────────────────────────

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
CREDENTIALS_FILE = os.getenv("CREDENTIALS_FILE", "credentials.json")
API_TIMEOUT = int(os.getenv("API_TIMEOUT", "60"))

# Row heights are fetched only for the first N rows per page.
# Fetching rowMetadata for all limit rows on a 20k+ row sheet causes 504 timeouts
# because the response payload is huge. 50 rows is enough for the initial viewport.
ROW_META_ROWS = int(os.getenv("ROW_META_ROWS", "50"))


# ── Google Sheets service — new per request, no singleton ────────────────────
#
# A shared singleton reuses the same httplib2 keep-alive connection across
# requests. On repeated calls (different spreadsheetIds), the stale SSL session
# causes "WRONG_VERSION_NUMBER" errors and occasional segmentation faults.
# Creating a fresh AuthorizedHttp per request avoids all of that.

def build_service():
    creds = service_account.Credentials.from_service_account_file(
        CREDENTIALS_FILE, scopes=SCOPES
    )
    http = google_auth_httplib2.AuthorizedHttp(
        creds,
        http=httplib2.Http(timeout=API_TIMEOUT),
    )
    # cache_discovery=False — skip writing/reading the local discovery cache file,
    # which is not needed when service objects are short-lived.
    return build("sheets", "v4", http=http, cache_discovery=False)


# ── Retry helper ──────────────────────────────────────────────────────────────

_RETRYABLE = ("SSL", "WRONG_VERSION", "Connection", "Broken", "RemoteDisconnected", "reset")


def _with_retry(fn, max_retries=3):
    """Call fn(), retrying on transient network/SSL errors.

    fn() must be self-contained: it calls build_service() internally so that
    each retry opens a completely fresh TCP+SSL connection.
    """
    last_exc = None
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as e:
            err = str(e)
            if any(s in err for s in _RETRYABLE) and attempt < max_retries - 1:
                logger.warning(
                    f"Retryable error (attempt {attempt + 1}/{max_retries}, "
                    f"{type(e).__name__}): {e} — retrying in {0.3 * (attempt + 1):.1f}s"
                )
                last_exc = e
                time.sleep(0.3 * (attempt + 1))
                continue
            raise
    raise last_exc  # unreachable but satisfies type checkers


# ── In-memory cache — 1 hour TTL, max 500 entries ────────────────────────────

CACHE_TTL_MS = 60 * 60 * 1000
MAX_CACHE_SIZE = 500
_cache: dict = {}
_cache_lock = threading.Lock()


def get_cached(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        if time.time() * 1000 - entry["ts"] > CACHE_TTL_MS:
            del _cache[key]
            return None
        return entry["data"]


def set_cached(key: str, data: dict):
    with _cache_lock:
        if len(_cache) >= MAX_CACHE_SIZE:
            oldest = min(_cache, key=lambda k: _cache[k]["ts"])
            del _cache[oldest]
        _cache[key] = {"data": data, "ts": time.time() * 1000}


# ── Error helpers ────────────────────────────────────────────────────────────

def _get_sheet_names(spreadsheetId: str) -> list:
    cache_key = f"sheet_names::{spreadsheetId}"
    cached = get_cached(cache_key)
    if cached is not None:
        return cached

    def do_get():
        svc = build_service()
        res = svc.spreadsheets().get(
            spreadsheetId=spreadsheetId,
            fields="sheets(properties(title))",
        ).execute()
        return [s["properties"]["title"] for s in res.get("sheets", [])]

    names = _with_retry(do_get)
    set_cached(cache_key, names)
    return names


def _humanize_google_error(e: HttpError, sheet_name: str, spreadsheetId: str = "") -> str:
    status = int(e.resp.status)
    msg = str(e).lower()
    try:
        reason = (e.error_details[0].get("reason") or "").lower()
    except Exception:
        reason = ""

    if status == 403 or reason == "forbidden":
        return "Нет доступа к таблице. Проверьте права доступа для сервисного аккаунта."
    if status == 404 or reason == "notfound":
        return "Таблица не найдена. Проверьте ID таблицы."
    if status == 400:
        if "unable to parse range" in msg:
            base = f"Лист «{sheet_name}» не найден в таблице."
            if spreadsheetId:
                try:
                    names = _get_sheet_names(spreadsheetId)
                    if names:
                        quoted = ", ".join(f"«{n}»" for n in names)
                        return f"{base} Доступные листы: {quoted}."
                except Exception:
                    pass
            return f"{base} Проверьте название листа в настройках."
        if "requested entity was not found" in msg:
            return "Таблица не найдена. Проверьте ID таблицы."
        return f"Некорректный запрос: {e}"
    if status >= 500:
        return "Ошибка сервера Google. Попробуйте повторить позже."
    return str(e) or "Не удалось загрузить данные."


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/api/")
def root():
    return {"message": "Server is working"}


@app.get("/api/health")
def health():
    return {"status": "ok"}


# GET /api/sheet-data?spreadsheetId=...&sheetName=...&offset=0&limit=200
# offset — number of data rows to skip (0 = first page)
# limit  — rows per page (max 1000)
# Returns: { headers, data, columnWidths, rowHeights, total }
#   offset=0  → columnWidths populated; rowHeights for first ROW_META_ROWS rows
#   offset>0  → columnWidths=[]; rowHeights for first ROW_META_ROWS rows of the page
@app.get("/api/sheet-data")
def get_sheet_data(
    spreadsheetId: str = Query(...),
    sheetName: str = Query(...),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
):
    spreadsheetId = spreadsheetId.strip()
    sheetName = sheetName.strip()

    page_key = f"{spreadsheetId}::{sheetName}::{offset}:{limit}"
    meta_key = f"{spreadsheetId}::{sheetName}::meta"

    cached = get_cached(page_key)
    if cached:
        logger.info(f"Cache hit: {page_key}")
        return cached

    t_start = time.perf_counter()

    try:
        if offset == 0:
            result = _fetch_first_page(spreadsheetId, sheetName, limit, meta_key)
        else:
            result = _fetch_page(spreadsheetId, sheetName, offset, limit, meta_key)

        set_cached(page_key, result)
        logger.info(
            f"Fresh p{offset}: {sheetName} rows={len(result['data'])} "
            f"total={result['total']} in {(time.perf_counter() - t_start) * 1000:.0f}ms"
        )
        return result

    except HttpError as e:
        status = int(e.resp.status)
        logger.error(f"[sheet-data] Google API {status}: {e}")
        http_status = status if status in (400, 403, 404) else 502
        raise HTTPException(
            status_code=http_status,
            detail=_humanize_google_error(e, sheetName, spreadsheetId),
        )
    except Exception as e:
        logger.error(f"[sheet-data] {e}")
        raise HTTPException(status_code=500, detail=str(e) or "Не удалось загрузить данные.")


def _fetch_first_page(spreadsheetId: str, sheetName: str, limit: int, meta_key: str) -> dict:
    # Request 1 — batchGet: headers row + data rows in one HTTP call
    def do_batch():
        svc = build_service()
        t0 = time.perf_counter()
        res = svc.spreadsheets().values().batchGet(
            spreadsheetId=spreadsheetId,
            ranges=[
                f"'{sheetName}'!1:1",
                f"'{sheetName}'!2:{limit + 1}",
            ],
            valueRenderOption="UNFORMATTED_VALUE",  # Только значения, без формул
            dateTimeRenderOption="FORMATTED_STRING",
        ).execute()
        logger.info(f"  batchGet: {(time.perf_counter() - t0) * 1000:.0f}ms")
        return res

    values_res = _with_retry(do_batch)
    value_ranges = values_res.get("valueRanges", [])
    headers = (value_ranges[0].get("values") or [[]])[0] if value_ranges else []
    data = value_ranges[1].get("values") or [] if len(value_ranges) > 1 else []

    # Request 2 — spreadsheets.get: gridProps + columnMeta + rowMeta
    # ranges= limits rowMetadata to the first ROW_META_ROWS data rows + header only.
    # Without ranges=, Google returns rowMetadata for ALL rows in the sheet —
    # on 20k+ row sheets that is megabytes of JSON and causes 504 timeouts.
    meta_range = f"'{sheetName}'!1:{ROW_META_ROWS + 1}"

    def do_meta():
        svc = build_service()
        t0 = time.perf_counter()
        res = svc.spreadsheets().get(
            spreadsheetId=spreadsheetId,
            ranges=[meta_range],
            fields=(
                "sheets(properties(title,gridProperties(rowCount)),"
                "data(startRow,columnMetadata(pixelSize),rowMetadata(pixelSize)))"
            ),
        ).execute()
        logger.info(f"  spreadsheets.get: {(time.perf_counter() - t0) * 1000:.0f}ms")
        return res

    meta_res = _with_retry(do_meta)

    sheet_meta = next(
        (s for s in meta_res.get("sheets", [])
         if s.get("properties", {}).get("title") == sheetName),
        None,
    )

    grid_props = (sheet_meta or {}).get("properties", {}).get("gridProperties", {})
    total = max(0, grid_props.get("rowCount", 1) - 1)

    data_block = (sheet_meta or {}).get("data", [{}])[0]
    block_start = data_block.get("startRow", 0)  # 0-indexed; always 0 for first page

    col_meta = data_block.get("columnMetadata", [])
    column_widths = [col.get("pixelSize", 100) for col in col_meta]

    # block_start=0: idx=0 → header (data_idx=-1, skipped); idx=1 → data[0]
    row_heights = {}
    for idx, row in enumerate(data_block.get("rowMetadata", [])):
        pixel_size = row.get("pixelSize")
        if pixel_size:
            data_idx = block_start + idx - 1
            if 0 <= data_idx < limit:
                row_heights[data_idx] = pixel_size

    if len(data) < limit:
        total = len(data)

    set_cached(meta_key, {
        "headers": headers,
        "columnWidths": column_widths,
        "rowHeights": row_heights,
        "total": total,
    })

    return {
        "headers": headers,
        "data": data,
        "columnWidths": column_widths,
        "rowHeights": row_heights,
        "total": total,
    }


def _fetch_page(
    spreadsheetId: str, sheetName: str, offset: int, limit: int, meta_key: str
) -> dict:
    row_start = offset + 2                                    # 1-indexed sheet row
    row_end = offset + limit + 1                              # 1-indexed sheet row
    row_meta_end = min(row_end, row_start + ROW_META_ROWS - 1)  # cap at ROW_META_ROWS

    # Request 1 — page data
    def do_values():
        svc = build_service()
        t0 = time.perf_counter()
        res = svc.spreadsheets().values().get(
            spreadsheetId=spreadsheetId,
            range=f"'{sheetName}'!{row_start}:{row_end}",
        ).execute()
        logger.info(f"  values.get: {(time.perf_counter() - t0) * 1000:.0f}ms")
        return res

    values_res = _with_retry(do_values)
    data = values_res.get("values") or []

    # Request 2 — row heights for first ROW_META_ROWS rows of this page only
    def do_row_meta():
        svc = build_service()
        t0 = time.perf_counter()
        res = svc.spreadsheets().get(
            spreadsheetId=spreadsheetId,
            ranges=[f"'{sheetName}'!{row_start}:{row_meta_end}"],
            fields="sheets(data(startRow,rowMetadata(pixelSize)))",
        ).execute()
        logger.info(f"  row-meta: {(time.perf_counter() - t0) * 1000:.0f}ms")
        return res

    row_meta_res = _with_retry(do_row_meta)

    # block_start (0-indexed): offset=200 → row_start=202 (1-idx) → startRow=201 (0-idx)
    # data_idx = block_start + idx - 1  →  201 + 0 - 1 = 200 = offset ✓
    row_heights = {}
    sheets_list = row_meta_res.get("sheets", [])
    if sheets_list:
        data_block = (sheets_list[0].get("data") or [{}])[0]
        block_start = data_block.get("startRow", offset + 1)
        for idx, row in enumerate(data_block.get("rowMetadata", [])):
            pixel_size = row.get("pixelSize")
            if pixel_size:
                data_idx = block_start + idx - 1
                row_heights[data_idx] = pixel_size

    cached_meta = get_cached(meta_key)
    headers = (cached_meta or {}).get("headers", [])
    total = (cached_meta or {}).get("total")

    if len(data) < limit:
        total = offset + len(data)
        if cached_meta:
            set_cached(meta_key, {**cached_meta, "total": total})

    return {
        "headers": headers,
        "data": data,
        "columnWidths": [],
        "rowHeights": row_heights,
        "total": total,
    }


# GET /api/json-data?url=...
# Accepts an absolute URL (https://...) or a local path (/catalog.json).
# Local paths are resolved to data/<filename> relative to cwd.
# Expects JSON array: [{ key: value, ... }, ...]
@app.get("/api/json-data")
def get_json_data(url: str = Query(...)):
    url = url.strip()
    cache_key = f"json::{url}"

    cached = get_cached(cache_key)
    if cached:
        logger.info(f"Cache hit: {cache_key}")
        return cached

    try:
        if url.startswith("/"):
            file_name = os.path.basename(url)
            file_path = os.path.join(os.getcwd(), "data", file_name)
            with open(file_path, "r", encoding="utf-8") as f:
                json_array = json.load(f)
        else:
            response = req_lib.get(url, timeout=30)
            if not response.ok:
                raise Exception(f"HTTP {response.status_code} fetching {url}")
            json_array = response.json()

        if not isinstance(json_array, list) or len(json_array) == 0:
            raise HTTPException(status_code=400, detail="Expected a non-empty JSON array")

        headers = list(json_array[0].keys())
        data = [[row.get(h, "") for h in headers] for row in json_array]

        result = {"headers": headers, "data": data, "columnWidths": [], "rowHeights": {}}
        set_cached(cache_key, result)
        logger.info(f"Fresh JSON: {url}, rows: {len(data)}")
        return result

    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"File not found: {os.path.basename(url)}",
        )
    except Exception as e:
        logger.error(f"[json-data] {e}")
        raise HTTPException(status_code=500, detail=str(e) or "Failed to load JSON")


# POST /api/cache/clear
@app.post("/api/cache/clear")
def clear_cache():
    with _cache_lock:
        count = len(_cache)
        _cache.clear()
    logger.info(f"Cache cleared ({count} entries)")
    return {"message": f"Cache cleared ({count} entries)"}
