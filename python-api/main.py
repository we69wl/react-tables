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
    # Double-checked locking: avoid lock on every request after first init
    if _sheets_service is None:
        with _service_lock:
            if _sheets_service is None:
                creds = service_account.Credentials.from_service_account_file(
                    CREDENTIALS_FILE, scopes=SCOPES
                )
                _sheets_service = build("sheets", "v4", credentials=creds)
                logger.info("Google Sheets service initialized")
    return _sheets_service


# ── In-memory cache — 1 hour TTL, max 100 entries ────────────────────────────

CACHE_TTL_MS = 60 * 60 * 1000
MAX_CACHE_SIZE = 100
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
            # Evict oldest entry
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


# GET /api/sheet-data?spreadsheetId=...&sheetName=...
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

    try:
        service = get_sheets_service()

        # Fetch cell values and metadata in parallel — mirrors Node.js Promise.all
        def fetch_values():
            return (
                service.spreadsheets()
                .values()
                .get(spreadsheetId=spreadsheetId, range=f"'{sheetName}'")
                .execute()
            )

        def fetch_meta():
            return (
                service.spreadsheets()
                .get(
                    spreadsheetId=spreadsheetId,
                    fields="sheets(properties(title),data(columnMetadata(pixelSize),rowMetadata(pixelSize)))",
                )
                .execute()
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            f_values = pool.submit(fetch_values)
            f_meta = pool.submit(fetch_meta)
            values_res = f_values.result()
            meta_res = f_meta.result()

        # Find sheet metadata by name
        sheet_meta = next(
            (
                s for s in meta_res.get("sheets", [])
                if s.get("properties", {}).get("title") == sheetName
            ),
            None,
        )

        sheet_data_block = (sheet_meta or {}).get("data", [{}])[0]

        # Column widths from Google Sheets pixel sizes
        col_meta = sheet_data_block.get("columnMetadata", [])
        column_widths = [col.get("pixelSize", 100) for col in col_meta]

        # Row heights: rowMetadata[0] = header row (skip),
        # rowMetadata[1] → rowHeights[0], rowMetadata[2] → rowHeights[1], …
        row_meta = sheet_data_block.get("rowMetadata", [])
        row_heights = {}
        for idx, row in enumerate(row_meta):
            pixel_size = row.get("pixelSize")
            if pixel_size and idx >= 1:
                row_heights[idx - 1] = pixel_size

        rows = values_res.get("values", [])
        headers = rows[0] if rows else []
        data = rows[1:] if len(rows) > 1 else []

        result = {
            "headers": headers,
            "data": data,
            "columnWidths": column_widths,
            "rowHeights": row_heights,
        }
        set_cached(cache_key, result)
        logger.info(f"Fresh data: {cache_key}, rows: {len(data)}")
        return result

    except HttpError as e:
        status = int(e.resp.status)
        logger.error(f"[sheet-data] Google API {status}: {e}")
        # Google returns 400 for invalid sheet names — pass that through
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
            # Local file — os.path.basename prevents path traversal
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


# POST /api/cache/clear — сбросить кэш вручную (например после обновления таблицы)
@app.post("/api/cache/clear")
def clear_cache():
    with _cache_lock:
        count = len(_cache)
        _cache.clear()
    logger.info(f"Cache cleared ({count} entries)")
    return {"message": f"Cache cleared ({count} entries)"}