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

// ── In-memory cache — 1 hour TTL ─────────────────────────────────────────────
const CACHE_TTL = 60 * 60 * 1000;
const cache = new Map(); // key: "spreadsheetId::sheetName" → { data, ts }

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
  cache.set(key, { data, ts: Date.now() });
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Server is working"));

// GET /api/sheet-data?spreadsheetId=...&sheetName=...
app.get("/api/sheet-data", async (req, res) => {
  const spreadsheetId = req.query.spreadsheetId?.trim();
  const sheetName = req.query.sheetName?.trim();

  if (!spreadsheetId) {
    return res.status(400).json({ error: "Missing required query param: spreadsheetId" });
  }
  if (!sheetName) {
    return res.status(400).json({ error: "Missing required query param: sheetName" });
  }

  const cacheKey = `${spreadsheetId}::${sheetName}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Fetch cell values and column metadata in parallel
    const [valuesRes, metaRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'`,
      }),
      sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets(properties(title),data(columnMetadata(pixelSize),rowMetadata(pixelSize)))",
      }),
    ]);

    const sheetMeta = metaRes.data.sheets?.find(
      (s) => s.properties?.title === sheetName
    );
    const colMeta = sheetMeta?.data?.[0]?.columnMetadata ?? [];
    const columnWidths = colMeta.map((col) => col.pixelSize || 100);

    // Extract row heights from Google Sheets metadata
    // Note: rowMetadata includes headers (row 0), but data array excludes them
    // So we need to skip index 0 and shift indices: rowHeights[0] = rowMeta[1].pixelSize
    const rowMeta = sheetMeta?.data?.[0]?.rowMetadata ?? [];
    const rowHeights = {}; // { dataIndex: heightInPixels }
    rowMeta.forEach((row, idx) => {
      // Skip header row (idx 0), start from data rows (idx >= 1)
      // Map to data indices: rowMeta[1] → rowHeights[0], rowMeta[2] → rowHeights[1], etc.
      if (row.pixelSize && idx >= 1) {
        rowHeights[idx - 1] = row.pixelSize;
      }
    });

    const rows = valuesRes.data.values ?? [];
    const headers = rows[0] ?? [];
    const data = rows.slice(1);

    const result = { headers, data, columnWidths, rowHeights };
    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("[sheet-data]", err.message);
    // Google API returns 400 for bad sheet names
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

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
