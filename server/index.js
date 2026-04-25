import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import credentials from "./credentials.json" with { type: "json" };
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: ["http://localhost:5173", "http://localhost:3000"] }));

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
        fields: "sheets(properties(title),data(columnMetadata(pixelSize)))",
      }),
    ]);

    const sheetMeta = metaRes.data.sheets?.find(
      (s) => s.properties?.title === sheetName
    );
    const colMeta = sheetMeta?.data?.[0]?.columnMetadata ?? [];
    const columnWidths = colMeta.map((col) => col.pixelSize || 100);

    const rows = valuesRes.data.values ?? [];
    const headers = rows[0] ?? [];
    const data = rows.slice(1);

    const result = { headers, data, columnWidths };
    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("[sheet-data]", err.message);
    // Google API returns 400 for bad sheet names
    res.status(err.code === 400 ? 400 : 500).json({ error: err.message || "Failed to load sheet" });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
