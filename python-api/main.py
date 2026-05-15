import os
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
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

# Row heights are fetched only for the first N rows.
# Fetching rowMetadata for all rows on a 20k+ row sheet causes 504 timeouts
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


# ── In-memory cache — configurable via .env ──────────────────────────────────

CACHE_TTL_MS    = int(os.getenv("CACHE_TTL_MS",    str(6 * 60 * 60 * 1000)))   # default 6h
CACHE_FRESH_MS  = int(os.getenv("CACHE_FRESH_MS",  str(5 * 60 * 60 * 1000)))   # default 5h
ERROR_CACHE_TTL_MS = int(os.getenv("ERROR_CACHE_TTL_MS", str(5 * 60 * 1000)))  # default 5min
MAX_CACHE_SIZE  = int(os.getenv("MAX_CACHE_SIZE",  "1000"))
WARMUP_WORKERS  = int(os.getenv("WARMUP_WORKERS",  "10"))
_cache: dict = {}
_cache_lock = threading.Lock()
_error_cache: dict = {}
_error_cache_lock = threading.Lock()


def get_cached_error(key: str):
    with _error_cache_lock:
        entry = _error_cache.get(key)
        if entry is None:
            return None
        if time.time() * 1000 - entry["ts"] > ERROR_CACHE_TTL_MS:
            del _error_cache[key]
            return None
        return entry


def set_cached_error(key: str, status: int, detail: str):
    with _error_cache_lock:
        _error_cache[key] = {"status": status, "detail": detail, "ts": time.time() * 1000}


def _is_error_cached(spreadsheetId: str, sheetName: str) -> bool:
    key = f"{spreadsheetId}::{sheetName}"
    return get_cached_error(key) is not None

# ── Warmup registry — survives server restarts ────────────────────────────────

WARMUP_REGISTRY_FILE = os.getenv("WARMUP_REGISTRY_FILE", "warmup_registry.json")
_registry: list = []
_registry_lock = threading.Lock()


def _load_registry():
    global _registry
    try:
        with open(WARMUP_REGISTRY_FILE, "r", encoding="utf-8") as f:
            _registry = json.load(f)
        logger.info(f"Warmup registry loaded: {len(_registry)} sheet(s)")
    except FileNotFoundError:
        _registry = []
    except Exception as e:
        logger.warning(f"Failed to load warmup registry: {e}")
        _registry = []


def _save_registry():
    try:
        with open(WARMUP_REGISTRY_FILE, "w", encoding="utf-8") as f:
            json.dump(_registry, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.warning(f"Failed to save warmup registry: {e}")


def _update_registry(sheets: list):
    with _registry_lock:
        existing = {(s["spreadsheetId"], s["sheetName"]) for s in _registry}
        added = 0
        for s in sheets:
            key = (s["spreadsheetId"], s["sheetName"])
            if key not in existing:
                _registry.append(s)
                existing.add(key)
                added += 1
        if added:
            _save_registry()
            logger.info(f"Registry updated: +{added} sheet(s), total {len(_registry)}")


_load_registry()


@app.on_event("startup")
def startup_warmup():
    sheets = list(_registry)
    if not sheets:
        logger.info("[startup] Warmup registry is empty — skipping")
        return

    def _do():
        time.sleep(3)  # wait for server to fully start
        logger.info(f"[startup] Warming up {len(sheets)} sheet(s), workers={WARMUP_WORKERS}")
        with ThreadPoolExecutor(max_workers=WARMUP_WORKERS) as pool:
            future_to_sheet = {pool.submit(_warmup_if_needed, s, "startup"): s for s in sheets}
            for fut in as_completed(future_to_sheet):
                s = future_to_sheet[fut]
                try:
                    fut.result()
                except Exception as e:
                    logger.warning(f"[startup] {s['sheetName']}: {e}")
        logger.info("[startup] Done")

    threading.Thread(target=_do, daemon=True).start()


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


# GET /api/sheet-data?spreadsheetId=...&sheetName=...
# Returns all rows in one response: { headers, data, columnWidths, rowHeights, total }
# columnWidths and rowHeights cover only the first ROW_META_ROWS rows.
@app.get("/api/sheet-data")
def get_sheet_data(
    spreadsheetId: str = Query(...),
    sheetName: str = Query(...),
):
    spreadsheetId = spreadsheetId.strip()
    sheetName = sheetName.strip()

    cache_key = f"{spreadsheetId}::{sheetName}"

    cached = get_cached(cache_key)
    if cached:
        logger.info(f"Cache hit: {cache_key}")
        return cached

    cached_err = get_cached_error(cache_key)
    if cached_err:
        logger.info(f"Error cache hit: {cache_key}")
        raise HTTPException(status_code=cached_err["status"], detail=cached_err["detail"])

    t_start = time.perf_counter()

    try:
        result = _fetch_all(spreadsheetId, sheetName)
        set_cached(cache_key, result)
        logger.info(
            f"Fresh: {sheetName} rows={len(result['data'])} "
            f"in {(time.perf_counter() - t_start) * 1000:.0f}ms"
        )
        return result

    except HttpError as e:
        status = int(e.resp.status)
        logger.error(f"[sheet-data] Google API {status}: {e}")
        http_status = status if status in (400, 403, 404) else 502
        detail = _humanize_google_error(e, sheetName, spreadsheetId)
        set_cached_error(cache_key, http_status, detail)
        raise HTTPException(status_code=http_status, detail=detail)
    except Exception as e:
        logger.error(f"[sheet-data] {e}")
        raise HTTPException(status_code=500, detail=str(e) or "Не удалось загрузить данные.")


def _fetch_all(spreadsheetId: str, sheetName: str) -> dict:
    # Request 1 — values.get with just the sheet name fetches the entire sheet
    def do_values():
        svc = build_service()
        t0 = time.perf_counter()
        res = svc.spreadsheets().values().get(
            spreadsheetId=spreadsheetId,
            range=f"'{sheetName}'",
            valueRenderOption="UNFORMATTED_VALUE",
            dateTimeRenderOption="FORMATTED_STRING",
        ).execute()
        logger.info(f"  values.get: {(time.perf_counter() - t0) * 1000:.0f}ms")
        return res

    values_res = _with_retry(do_values)
    rows = values_res.get("values") or []
    headers = rows[0] if rows else []
    data = rows[1:] if len(rows) > 1 else []

    # Request 2 — spreadsheets.get: columnMeta + rowMeta for first ROW_META_ROWS rows.
    # ranges= limits rowMetadata scope; without it Google returns rowMetadata for ALL rows —
    # on 20k+ row sheets that is megabytes of JSON and causes 504 timeouts.
    meta_range = f"'{sheetName}'!1:{ROW_META_ROWS + 1}"

    def do_meta():
        svc = build_service()
        t0 = time.perf_counter()
        res = svc.spreadsheets().get(
            spreadsheetId=spreadsheetId,
            ranges=[meta_range],
            fields=(
                "sheets(properties(title),"
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

    data_block = (sheet_meta or {}).get("data", [{}])[0]
    block_start = data_block.get("startRow", 0)  # 0-indexed; always 0 here

    col_meta = data_block.get("columnMetadata", [])
    column_widths = [col.get("pixelSize", 100) for col in col_meta]

    # block_start=0: idx=0 → header (data_idx=-1, skipped); idx=1 → data[0]
    row_heights = {}
    for idx, row in enumerate(data_block.get("rowMetadata", [])):
        pixel_size = row.get("pixelSize")
        if pixel_size:
            data_idx = block_start + idx - 1
            if data_idx >= 0:
                row_heights[data_idx] = pixel_size

    return {
        "headers": headers,
        "data": data,
        "columnWidths": column_widths,
        "rowHeights": row_heights,
        "total": len(data),
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


# ── Warmup helpers ────────────────────────────────────────────────────────────

def _is_cache_fresh(spreadsheetId: str, sheetName: str) -> bool:
    key = f"{spreadsheetId}::{sheetName}"
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return False
        return time.time() * 1000 - entry["ts"] < CACHE_FRESH_MS


def _warmup_one(s: dict, tag: str):
    """Fetch all rows unconditionally and store in cache. Raises on error."""
    sid, name = s["spreadsheetId"], s["sheetName"]
    cache_key = f"{sid}::{name}"
    try:
        result = _fetch_all(sid, name)
        set_cached(cache_key, result)
        logger.info(f"[{tag}] OK: {name} rows={len(result['data'])}")
    except HttpError as e:
        status = int(e.resp.status)
        http_status = status if status in (400, 403, 404) else 502
        detail = _humanize_google_error(e, name, sid)
        set_cached_error(cache_key, http_status, detail)
        logger.warning(f"[{tag}] error cached ({http_status}): {name}")
        raise


def _warmup_if_needed(s: dict, tag: str) -> bool:
    """Warm up only when cache is absent or stale. Returns True if warmed."""
    if _is_cache_fresh(s["spreadsheetId"], s["sheetName"]):
        logger.info(f"[{tag}] skipped (fresh): {s['sheetName']}")
        return False
    if _is_error_cached(s["spreadsheetId"], s["sheetName"]):
        logger.info(f"[{tag}] skipped (error cached): {s['sheetName']}")
        return False
    _warmup_one(s, tag)
    return True


# POST /api/warmup
# Body: [{"spreadsheetId": "...", "sheetName": "..."}]
# Called by WordPress save_post hook — pre-warms cache for a page's sheets.
# Skips sheets whose cache is still fresh. Registers only successfully warmed sheets.
# Runs in a background thread so the HTTP response returns immediately.
@app.post("/api/warmup")
def warmup(sheets: list[dict]):
    valid = [
        {"spreadsheetId": s["spreadsheetId"].strip(), "sheetName": s["sheetName"].strip()}
        for s in sheets
        if (s.get("spreadsheetId") or "").strip() and (s.get("sheetName") or "").strip()
    ]

    def _do():
        warmed = []
        workers = min(WARMUP_WORKERS, len(valid)) if valid else 1
        with ThreadPoolExecutor(max_workers=workers) as pool:
            future_to_sheet = {pool.submit(_warmup_if_needed, s, "warmup"): s for s in valid}
            for fut in as_completed(future_to_sheet):
                s = future_to_sheet[fut]
                try:
                    if fut.result():
                        warmed.append(s)
                except Exception as e:
                    logger.warning(f"[warmup] {s['sheetName']}: {e}")
        if warmed:
            _update_registry(warmed)

    threading.Thread(target=_do, daemon=True).start()
    return {"message": f"Warmup started for {len(valid)} sheet(s)"}


# POST /api/warmup-all
# Re-warms all registered sheets whose cache has gone stale.
# Intended for cron: run every 6 hours (CACHE_TTL default = 6h, CACHE_FRESH default = 5h).
@app.post("/api/warmup-all")
def warmup_all():
    with _registry_lock:
        sheets = list(_registry)

    if not sheets:
        return {"message": "Registry is empty — nothing to warm up"}

    def _do():
        logger.info(f"[warmup-all] Starting: {len(sheets)} sheet(s), workers={WARMUP_WORKERS}")
        with ThreadPoolExecutor(max_workers=WARMUP_WORKERS) as pool:
            future_to_sheet = {pool.submit(_warmup_if_needed, s, "warmup-all"): s for s in sheets}
            for fut in as_completed(future_to_sheet):
                s = future_to_sheet[fut]
                try:
                    fut.result()
                except Exception as e:
                    logger.warning(f"[warmup-all] {s['sheetName']}: {e}")
        logger.info("[warmup-all] Done")

    threading.Thread(target=_do, daemon=True).start()
    return {"message": f"Warmup-all started for {len(sheets)} sheet(s)"}


# GET /api/cache/stats
@app.get("/api/cache/stats")
def cache_stats():
    now = time.time() * 1000
    with _cache_lock:
        data_entries = [
            {"key": k, "age_s": round((now - v["ts"]) / 1000)}
            for k, v in _cache.items()
        ]
    with _error_cache_lock:
        error_entries = [
            {"key": k, "status": v["status"], "age_s": round((now - v["ts"]) / 1000)}
            for k, v in _error_cache.items()
        ]
    with _registry_lock:
        registry_count = len(_registry)
    return {
        "data_cache": {"count": len(data_entries), "entries": data_entries},
        "error_cache": {"count": len(error_entries), "entries": error_entries},
        "registry": {"count": registry_count},
    }


# POST /api/cache/clear
@app.post("/api/cache/clear")
def clear_cache():
    with _cache_lock:
        count = len(_cache)
        _cache.clear()
    with _error_cache_lock:
        err_count = len(_error_cache)
        _error_cache.clear()
    logger.info(f"Cache cleared ({count} data + {err_count} error entries)")
    return {"message": f"Cache cleared ({count} data + {err_count} error entries)"}
