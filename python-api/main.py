import os
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from google.oauth2 import service_account
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

# ── Google Sheets service — singleton, thread-safe ────────────────────────────

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
CREDENTIALS_FILE = os.getenv("CREDENTIALS_FILE", "credentials.json")

_sheets_service = None
_service_lock = threading.Lock()


def get_sheets_service():
    global _sheets_service
    if _sheets_service is None:
        with _service_lock:
            if _sheets_service is None:
                creds = service_account.Credentials.from_service_account_file(
                    CREDENTIALS_FILE, scopes=SCOPES
                )
                _sheets_service = build("sheets", "v4", credentials=creds)
                logger.info("Google Sheets service initialized")
    return _sheets_service


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
#   offset=0  → columnWidths and rowHeights populated from sheet metadata
#   offset>0  → columnWidths=[], rowHeights={} (use cached from first page)
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

    try:
        service = get_sheets_service()

        if offset == 0:
            # First page: headers (!1:1), first-page data (!2:limit+1), metadata — all parallel
            def fetch_headers():
                return (
                    service.spreadsheets()
                    .values()
                    .get(spreadsheetId=spreadsheetId, range=f"'{sheetName}'!1:1")
                    .execute()
                )

            def fetch_data():
                return (
                    service.spreadsheets()
                    .values()
                    .get(spreadsheetId=spreadsheetId, range=f"'{sheetName}'!2:{limit + 1}")
                    .execute()
                )

            def fetch_meta():
                return (
                    service.spreadsheets()
                    .get(
                        spreadsheetId=spreadsheetId,
                        fields="sheets(properties(title,gridProperties(rowCount)),data(columnMetadata(pixelSize),rowMetadata(pixelSize)))",
                    )
                    .execute()
                )

            with ThreadPoolExecutor(max_workers=3) as pool:
                f_headers = pool.submit(fetch_headers)
                f_data = pool.submit(fetch_data)
                f_meta = pool.submit(fetch_meta)
                headers_res = f_headers.result()
                data_res = f_data.result()
                meta_res = f_meta.result()

            headers = (headers_res.get("values") or [[]])[0]
            data = data_res.get("values") or []

            sheet_meta = next(
                (
                    s for s in meta_res.get("sheets", [])
                    if s.get("properties", {}).get("title") == sheetName
                ),
                None,
            )

            grid_props = (sheet_meta or {}).get("properties", {}).get("gridProperties", {})
            total = max(0, grid_props.get("rowCount", 1) - 1)

            sheet_data_block = (sheet_meta or {}).get("data", [{}])[0]

            col_meta = sheet_data_block.get("columnMetadata", [])
            column_widths = [col.get("pixelSize", 100) for col in col_meta]

            # rowMetadata[0] = header row (skip)
            # rowMetadata[1] → rowHeights[0], rowMetadata[2] → rowHeights[1], …
            row_meta = sheet_data_block.get("rowMetadata", [])
            row_heights = {}
            for idx, row in enumerate(row_meta):
                pixel_size = row.get("pixelSize")
                if pixel_size and idx >= 1 and idx - 1 < limit:
                    row_heights[idx - 1] = pixel_size

            # Self-correct total: if fewer rows came back than limit, we have everything
            if len(data) < limit:
                total = len(data)

            set_cached(meta_key, {
                "headers": headers,
                "columnWidths": column_widths,
                "rowHeights": row_heights,
                "total": total,
            })

            result = {
                "headers": headers,
                "data": data,
                "columnWidths": column_widths,
                "rowHeights": row_heights,
                "total": total,
            }
            set_cached(page_key, result)
            logger.info(f"Fresh data (p0): {sheetName}, rows: {len(data)}, total: {total}")
            return result

        else:
            # Subsequent pages: fetch only the requested range
            # Row 1 = header, data starts at row 2. offset=200 → rows 202..401
            start_row = offset + 2
            end_row = offset + limit + 1

            values_res = (
                service.spreadsheets()
                .values()
                .get(spreadsheetId=spreadsheetId, range=f"'{sheetName}'!{start_row}:{end_row}")
                .execute()
            )
            data = values_res.get("values") or []

            cached_meta = get_cached(meta_key)
            headers = (cached_meta or {}).get("headers", [])
            total = (cached_meta or {}).get("total")

            # Refine total when last page comes back shorter than limit
            if len(data) < limit:
                total = offset + len(data)
                if cached_meta:
                    set_cached(meta_key, {**cached_meta, "total": total})

            result = {
                "headers": headers,
                "data": data,
                "columnWidths": [],
                "rowHeights": {},
                "total": total,
            }
            set_cached(page_key, result)
            logger.info(f"Fresh data (p{offset}): {sheetName}, rows: {len(data)}, total: {total}")
            return result

    except HttpError as e:
        status = int(e.resp.status)
        logger.error(f"[sheet-data] Google API {status}: {e}")
        raise HTTPException(
            status_code=400 if status == 400 else 500,
            detail=str(e) or "Failed to load sheet",
        )
    except Exception as e:
        logger.error(f"[sheet-data] {e}")
        raise HTTPException(status_code=500, detail=str(e) or "Failed to load sheet")


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
