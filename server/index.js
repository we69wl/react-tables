import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import credentials from "./credentials.json" with { type: "json" };
import path from "path";
import { readFile } from "fs/promises";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:5173", "http://localhost:3000"];
app.use(cors({ origin: allowedOrigins }));

const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

// ── In-memory cache — 1 hour TTL, max 500 entries ────────────────────────────
const CACHE_TTL = 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  if (cache.size >= MAX_CACHE_SIZE) {
    let oldestKey, oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    }
    cache.delete(oldestKey);
  }
  cache.set(key, { data, ts: Date.now() });
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Server is working"));

// GET /api/sheet-data?spreadsheetId=...&sheetName=...&offset=0&limit=200
// offset — number of data rows to skip (0 = first page)
// limit  — rows per page (max 1000)
// Returns: { headers, data, columnWidths, rowHeights, total }
//   offset=0  → columnWidths and rowHeights populated from sheet metadata
//   offset>0  → columnWidths=[], rowHeights={} (use cached from first page)
app.get("/api/sheet-data", async (req, res) => {
  const spreadsheetId = req.query.spreadsheetId?.trim();
  const sheetName = req.query.sheetName?.trim();
  const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10) || 0);
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit ?? "200", 10) || 200));

  if (!spreadsheetId) {
    return res.status(400).json({ error: "Missing required query param: spreadsheetId" });
  }
  if (!sheetName) {
    return res.status(400).json({ error: "Missing required query param: sheetName" });
  }

  const pageKey = `${spreadsheetId}::${sheetName}::${offset}:${limit}`;
  const metaKey = `${spreadsheetId}::${sheetName}::meta`;

  const cachedPage = getCached(pageKey);
  if (cachedPage) return res.json(cachedPage);

  try {
    if (offset === 0) {
      // First page: headers, first-page data, and sheet metadata — all in parallel
      const [headersRes, dataRes, metaRes] = await Promise.all([
        sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `'${sheetName}'!1:1`,
        }),
        sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `'${sheetName}'!2:${limit + 1}`,
        }),
        sheets.spreadsheets.get({
          spreadsheetId,
          fields: "sheets(properties(title,gridProperties(rowCount)),data(columnMetadata(pixelSize),rowMetadata(pixelSize)))",
        }),
      ]);

      const headers = headersRes.data.values?.[0] ?? [];
      const data = dataRes.data.values ?? [];

      const sheetMeta = metaRes.data.sheets?.find(
        (s) => s.properties?.title === sheetName
      );
      const gridProps = sheetMeta?.properties?.gridProperties ?? {};
      let total = Math.max(0, (gridProps.rowCount ?? 1) - 1);

      const colMeta = sheetMeta?.data?.[0]?.columnMetadata ?? [];
      const columnWidths = colMeta.map((col) => col.pixelSize || 100);

      const rowMeta = sheetMeta?.data?.[0]?.rowMetadata ?? [];
      const rowHeights = {};
      rowMeta.forEach((row, idx) => {
        if (row.pixelSize && idx >= 1 && idx - 1 < limit) {
          rowHeights[idx - 1] = row.pixelSize;
        }
      });

      // Self-correct total: if fewer rows came back than limit, we have everything
      if (data.length < limit) total = data.length;

      setCached(metaKey, { headers, columnWidths, rowHeights, total });

      const result = { headers, data, columnWidths, rowHeights, total };
      setCached(pageKey, result);
      return res.json(result);

    } else {
      // Subsequent pages: fetch only the requested range
      // Row 1 = header, data starts at row 2. offset=200 → rows 202..401
      const startRow = offset + 2;
      const endRow = offset + limit + 1;

      const valuesRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'!${startRow}:${endRow}`,
      });

      const data = valuesRes.data.values ?? [];

      const cachedMeta = getCached(metaKey);
      const headers = cachedMeta?.headers ?? [];
      let total = cachedMeta?.total ?? null;

      // Refine total when last page comes back shorter than limit
      if (data.length < limit) {
        total = offset + data.length;
        if (cachedMeta) setCached(metaKey, { ...cachedMeta, total });
      }

      const result = { headers, data, columnWidths: [], rowHeights: {}, total };
      setCached(pageKey, result);
      return res.json(result);
    }
  } catch (err) {
    console.error("[sheet-data]", err.message);
    res.status(err.code === 400 ? 400 : 500).json({ error: err.message || "Failed to load sheet" });
  }
});

// GET /api/json-data?url=...
// Accepts either an absolute URL (https://...) or a local path (/catalog.json).
// Local paths are resolved to server/data/<filename> and read from disk.
// Expects JSON: [{ key: value, ... }, ...]
app.get("/api/json-data", async (req, res) => {
  const url = req.query.url?.trim();
  if (!url) {
    return res.status(400).json({ error: "Missing required query param: url" });
  }

  const cacheKey = `json::${url}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    let jsonArray;

    if (url.startsWith("/")) {
      // Local file — read from server/data/, path.basename prevents traversal
      const fileName = path.basename(url);
      const filePath = path.join(process.cwd(), "server", "data", fileName);
      const content = await readFile(filePath, "utf-8");
      jsonArray = JSON.parse(content);
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
      jsonArray = await response.json();
    }

    if (!Array.isArray(jsonArray) || jsonArray.length === 0) {
      return res.status(400).json({ error: "Expected a non-empty JSON array" });
    }

    const headers = Object.keys(jsonArray[0]);
    const data = jsonArray.map((row) => headers.map((h) => row[h] ?? ""));

    const result = { headers, data, columnWidths: [], rowHeights: {} };
    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("[json-data]", err.message);
    res.status(500).json({ error: err.message || "Failed to load JSON" });
  }
});

// POST /api/cache/clear
app.post("/api/cache/clear", (_req, res) => {
  const count = cache.size;
  cache.clear();
  console.log(`Cache cleared (${count} entries)`);
  res.json({ message: `Cache cleared (${count} entries)` });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
