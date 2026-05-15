import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import credentials from "./credentials.json" with { type: "json" };
import path from "path";
import { readFile, writeFile } from "fs/promises";
import ExcelJS from "exceljs";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:5173", "http://localhost:3000"];
app.use(cors({ origin: allowedOrigins }));

// ── Google Sheets auth ────────────────────────────────────────────────────────
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

// ── Config ────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS       = parseInt(process.env.CACHE_TTL_MS       ?? String(6 * 60 * 60 * 1000), 10); // 6h
const CACHE_FRESH_MS     = parseInt(process.env.CACHE_FRESH_MS     ?? String(5 * 60 * 60 * 1000), 10); // 5h
const ERROR_CACHE_TTL_MS = parseInt(process.env.ERROR_CACHE_TTL_MS ?? String(5 * 60 * 1000),      10); // 5min
const MAX_CACHE_SIZE     = parseInt(process.env.MAX_CACHE_SIZE     ?? "1000", 10);
const WARMUP_WORKERS     = parseInt(process.env.WARMUP_WORKERS     ?? "10",   10);
// Row heights are fetched only for the first N rows — avoids 504 timeouts on 20k+ row sheets
const ROW_META_ROWS      = parseInt(process.env.ROW_META_ROWS      ?? "50",   10);
const WARMUP_REGISTRY_FILE = process.env.WARMUP_REGISTRY_FILE
  ?? path.join(process.cwd(), "server", "warmup_registry.json");

// ── In-memory cache ───────────────────────────────────────────────────────────
const cache      = new Map(); // key → { data, ts }
const errorCache = new Map(); // key → { status, detail, ts }
let   registry   = [];        // [{ spreadsheetId, sheetName }]

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
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

function isCacheFresh(spreadsheetId, sheetName) {
  const entry = cache.get(`${spreadsheetId}::${sheetName}`);
  return !!entry && Date.now() - entry.ts < CACHE_FRESH_MS;
}

function getCachedError(key) {
  const entry = errorCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ERROR_CACHE_TTL_MS) { errorCache.delete(key); return null; }
  return entry;
}

function setCachedError(key, status, detail) {
  errorCache.set(key, { status, detail, ts: Date.now() });
}

function isErrorCached(spreadsheetId, sheetName) {
  return getCachedError(`${spreadsheetId}::${sheetName}`) !== null;
}

// ── Warmup registry ───────────────────────────────────────────────────────────
async function loadRegistry() {
  try {
    const content = await readFile(WARMUP_REGISTRY_FILE, "utf-8");
    registry = JSON.parse(content);
    console.log(`[registry] Loaded ${registry.length} sheet(s)`);
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`[registry] Load failed: ${e.message}`);
    registry = [];
  }
}

function updateRegistry(newSheets) {
  const existing = new Set(registry.map((s) => `${s.spreadsheetId}::${s.sheetName}`));
  let added = 0;
  for (const s of newSheets) {
    const key = `${s.spreadsheetId}::${s.sheetName}`;
    if (!existing.has(key)) {
      registry.push(s);
      existing.add(key);
      added++;
    }
  }
  if (added) {
    writeFile(WARMUP_REGISTRY_FILE, JSON.stringify(registry, null, 2), "utf-8")
      .catch((e) => console.warn(`[registry] Save failed: ${e.message}`));
    console.log(`[registry] +${added} sheet(s), total ${registry.length}`);
  }
}

// ── Retry helper ──────────────────────────────────────────────────────────────
const RETRYABLE = ["SSL", "WRONG_VERSION", "Connection", "Broken", "ECONNRESET", "socket hang up"];

async function withRetry(fn, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e.message || "";
      if (RETRYABLE.some((s) => msg.includes(s)) && attempt < maxRetries - 1) {
        console.warn(`[retry] attempt ${attempt + 1}/${maxRetries}: ${msg}`);
        lastErr = e;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ── Error helpers ─────────────────────────────────────────────────────────────

async function getSheetNames(spreadsheetId) {
  const cacheKey = `sheet_names::${spreadsheetId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const res = await withRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title))" })
  );
  const names = (res.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean);
  setCached(cacheKey, names);
  return names;
}

async function humanizeGoogleError(err, sheetName, spreadsheetId = "") {
  const status = err.code ?? err.status;
  const msg = (err.message || "").toLowerCase();
  const reason = (err.errors?.[0]?.reason || "").toLowerCase();

  if (status === 403 || reason === "forbidden")
    return "Нет доступа к таблице. Проверьте права доступа для сервисного аккаунта.";
  if (status === 404 || reason === "notfound")
    return "Таблица не найдена. Проверьте ID таблицы.";
  if (status === 400) {
    if (msg.includes("unable to parse range")) {
      const base = `Лист «${sheetName}» не найден в таблице.`;
      if (spreadsheetId) {
        try {
          const names = await getSheetNames(spreadsheetId);
          if (names.length) return `${base} Доступные листы: ${names.map((n) => `«${n}»`).join(", ")}.`;
        } catch { /* sheet names unavailable — return base message */ }
      }
      return `${base} Проверьте название листа в настройках.`;
    }
    if (msg.includes("requested entity was not found"))
      return "Таблица не найдена. Проверьте ID таблицы.";
    return `Некорректный запрос: ${err.message}`;
  }
  if (status >= 500) return "Ошибка сервера Google. Попробуйте повторить позже.";
  return err.message || "Не удалось загрузить данные.";
}

// ── fetchAll ──────────────────────────────────────────────────────────────────
async function fetchAll(spreadsheetId, sheetName) {
  const [valuesRes, metaRes] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'`,
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      })
    ),
    withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`'${sheetName}'!1:${ROW_META_ROWS + 1}`],
        fields: "sheets(properties(title),data(startRow,columnMetadata(pixelSize),rowMetadata(pixelSize)))",
      })
    ),
  ]);

  const rows = valuesRes.data.values ?? [];
  const headers = rows[0] ?? [];
  const data = rows.slice(1);

  const sheetMeta = (metaRes.data.sheets ?? []).find((s) => s.properties?.title === sheetName);
  const dataBlock = sheetMeta?.data?.[0] ?? {};
  const blockStart = dataBlock.startRow ?? 0;

  const columnWidths = (dataBlock.columnMetadata ?? []).map((c) => c.pixelSize ?? 100);
  const rowHeights = {};
  for (let idx = 0; idx < (dataBlock.rowMetadata ?? []).length; idx++) {
    const px = dataBlock.rowMetadata[idx].pixelSize;
    if (px) {
      const dataIdx = blockStart + idx - 1;
      if (dataIdx >= 0) rowHeights[dataIdx] = px;
    }
  }

  return { headers, data, columnWidths, rowHeights, total: data.length };
}

// ── Concurrent runner ─────────────────────────────────────────────────────────
async function runConcurrent(items, fn, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { await fn(items[i]); } catch { /* errors handled inside fn */ }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, worker)
  );
}

// ── Warmup helpers ────────────────────────────────────────────────────────────
async function warmupOne(s, tag) {
  const { spreadsheetId, sheetName } = s;
  const cacheKey = `${spreadsheetId}::${sheetName}`;
  try {
    const result = await fetchAll(spreadsheetId, sheetName);
    setCached(cacheKey, result);
    console.log(`[${tag}] OK: ${sheetName} rows=${result.data.length}`);
    return result;
  } catch (e) {
    const status = e.code ?? 502;
    const httpStatus = [400, 403, 404].includes(status) ? status : 502;
    const detail = await humanizeGoogleError(e, sheetName, spreadsheetId);
    setCachedError(cacheKey, httpStatus, detail);
    console.warn(`[${tag}] error cached (${httpStatus}): ${sheetName}`);
    throw e;
  }
}

async function warmupIfNeeded(s, tag) {
  if (isCacheFresh(s.spreadsheetId, s.sheetName)) {
    console.log(`[${tag}] skipped (fresh): ${s.sheetName}`);
    return false;
  }
  if (isErrorCached(s.spreadsheetId, s.sheetName)) {
    console.log(`[${tag}] skipped (error cached): ${s.sheetName}`);
    return false;
  }
  await warmupOne(s, tag);
  return true;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/",           (_req, res) => res.send("Server is working"));
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// GET /api/sheet-data?spreadsheetId=...&sheetName=...
app.get("/api/sheet-data", async (req, res) => {
  const spreadsheetId = req.query.spreadsheetId?.trim();
  const sheetName     = req.query.sheetName?.trim();

  if (!spreadsheetId) return res.status(400).json({ error: "Missing required query param: spreadsheetId" });
  if (!sheetName)     return res.status(400).json({ error: "Missing required query param: sheetName" });

  const cacheKey = `${spreadsheetId}::${sheetName}`;

  const cached = getCached(cacheKey);
  if (cached) { console.log(`Cache hit: ${cacheKey}`); return res.json(cached); }

  const cachedErr = getCachedError(cacheKey);
  if (cachedErr) {
    console.log(`Error cache hit: ${cacheKey}`);
    return res.status(cachedErr.status).json({ error: cachedErr.detail });
  }

  const t0 = Date.now();
  try {
    const result = await fetchAll(spreadsheetId, sheetName);
    setCached(cacheKey, result);
    console.log(`Fresh: ${sheetName} rows=${result.data.length} in ${Date.now() - t0}ms`);
    res.json(result);
  } catch (err) {
    console.error("[sheet-data]", err.message);
    const status = err.code ?? 500;
    const httpStatus = [400, 403, 404].includes(status) ? status : 502;
    const message = await humanizeGoogleError(err, sheetName, spreadsheetId);
    setCachedError(cacheKey, httpStatus, message);
    res.status(httpStatus).json({ error: message });
  }
});

// GET /api/json-data?url=...
// Local paths (/file.json) are resolved to server/data/<filename>.
app.get("/api/json-data", async (req, res) => {
  const url = req.query.url?.trim();
  if (!url) return res.status(400).json({ error: "Missing required query param: url" });

  const cacheKey = `json::${url}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    let jsonArray;
    if (url.startsWith("/")) {
      const fileName = path.basename(url);
      const filePath = path.join(process.cwd(), "server", "data", fileName);
      const content  = await readFile(filePath, "utf-8");
      jsonArray = JSON.parse(content);
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
      jsonArray = await response.json();
    }

    if (!Array.isArray(jsonArray) || jsonArray.length === 0)
      return res.status(400).json({ error: "Expected a non-empty JSON array" });

    const headers = Object.keys(jsonArray[0]);
    const data    = jsonArray.map((row) => headers.map((h) => row[h] ?? ""));

    const result = { headers, data, columnWidths: [], rowHeights: {} };
    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("[json-data]", err.message);
    if (err.code === "ENOENT") return res.status(404).json({ error: `File not found: ${path.basename(url)}` });
    res.status(500).json({ error: err.message || "Failed to load JSON" });
  }
});

// POST /api/warmup
// Body: [{"spreadsheetId": "...", "sheetName": "..."}]
// Starts background warmup, returns immediately.
app.post("/api/warmup", (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Body must be an array" });

  const valid = req.body
    .filter((s) => (s.spreadsheetId || "").trim() && (s.sheetName || "").trim())
    .map((s) => ({ spreadsheetId: s.spreadsheetId.trim(), sheetName: s.sheetName.trim() }));

  (async () => {
    const warmed = [];
    await runConcurrent(valid, async (s) => {
      try {
        if (await warmupIfNeeded(s, "warmup")) warmed.push(s);
      } catch (e) {
        console.warn(`[warmup] ${s.sheetName}: ${e.message}`);
      }
    }, Math.min(WARMUP_WORKERS, valid.length || 1));
    if (warmed.length) updateRegistry(warmed);
  })().catch((e) => console.error("[warmup] background error:", e));

  res.json({ message: `Warmup started for ${valid.length} sheet(s)` });
});

// POST /api/warmup-all — re-warms all registered sheets whose cache is stale.
// Intended for cron: run every 6h (matches CACHE_TTL default = 6h, CACHE_FRESH = 5h).
app.post("/api/warmup-all", (req, res) => {
  const items = [...registry];
  if (!items.length) return res.json({ message: "Registry is empty — nothing to warm up" });

  (async () => {
    console.log(`[warmup-all] Starting: ${items.length} sheet(s), workers=${WARMUP_WORKERS}`);
    await runConcurrent(items, async (s) => {
      try {
        await warmupIfNeeded(s, "warmup-all");
      } catch (e) {
        console.warn(`[warmup-all] ${s.sheetName}: ${e.message}`);
      }
    }, WARMUP_WORKERS);
    console.log("[warmup-all] Done");
  })().catch((e) => console.error("[warmup-all] background error:", e));

  res.json({ message: `Warmup-all started for ${items.length} sheet(s)` });
});

// GET /api/cache/stats
app.get("/api/cache/stats", (_req, res) => {
  const now = Date.now();
  res.json({
    data_cache: {
      count: cache.size,
      entries: [...cache.entries()].map(([k, v]) => ({ key: k, age_s: Math.round((now - v.ts) / 1000) })),
    },
    error_cache: {
      count: errorCache.size,
      entries: [...errorCache.entries()].map(([k, v]) => ({ key: k, status: v.status, age_s: Math.round((now - v.ts) / 1000) })),
    },
    registry: { count: registry.length },
  });
});

// POST /api/cache/clear
app.post("/api/cache/clear", (_req, res) => {
  const count    = cache.size;
  const errCount = errorCache.size;
  cache.clear();
  errorCache.clear();
  console.log(`Cache cleared (${count} data + ${errCount} error entries)`);
  res.json({ message: `Cache cleared (${count} data + ${errCount} error entries)` });
});

// POST /api/export
// Body: { "spreadsheetId": "...", "sheetName": "..." }
// Returns XLSX with real Google Sheets formatting.
// 404 if data not in cache — open the table in the browser first.
app.post("/api/export", async (req, res) => {
  const { spreadsheetId, sheetName } = req.body ?? {};
  if (!spreadsheetId || !sheetName)
    return res.status(400).json({ error: "Missing spreadsheetId or sheetName" });

  const sid    = spreadsheetId.trim();
  const sname  = sheetName.trim();
  const cached = getCached(`${sid}::${sname}`);
  if (!cached)
    return res.status(404).json({ error: "Данные не найдены в кэше. Сначала откройте таблицу в браузере." });

  const headers        = cached.headers ?? [];
  const data           = cached.data ?? [];
  const cachedColWidths  = cached.columnWidths ?? [];
  const cachedRowHeights = cached.rowHeights ?? {};
  const numRows = data.length + 1; // +1 for header row

  // ── Fetch cell formatting from Google Sheets API ──────────────────────────
  let fmtRowData = [], fmtColMeta = [], fmtRowMeta = [], merges = [];
  try {
    const fmtRes = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: sid,
        ranges: [`'${sname}'!1:${numRows}`],
        includeGridData: true,
        fields:
          "sheets(properties(title)," +
          "data(startRow,startColumn," +
          "columnMetadata(pixelSize)," +
          "rowMetadata(pixelSize)," +
          "rowData(values(effectiveFormat)))," +
          "merges)",
      })
    );
    for (const s of fmtRes.data.sheets ?? []) {
      if (s.properties?.title === sname) {
        merges     = s.merges ?? [];
        const b    = s.data?.[0] ?? {};
        fmtRowData = b.rowData ?? [];
        fmtColMeta = b.columnMetadata ?? [];
        fmtRowMeta = b.rowMetadata ?? [];
        break;
      }
    }
  } catch (e) {
    console.warn(`[export] Formatting fetch failed (${e.message}) — using basic style`);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function rgbArgb(color) {
    if (!color) return null;
    const r = Math.round((color.red   ?? 0) * 255);
    const g = Math.round((color.green ?? 0) * 255);
    const b = Math.round((color.blue  ?? 0) * 255);
    const rgb = [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
    if (rgb === "FFFFFF" || rgb === "000000") return null;
    return `FF${rgb}`;
  }

  const BORDER_STYLE = {
    SOLID: "thin", SOLID_MEDIUM: "medium", SOLID_THICK: "thick",
    DOTTED: "dotted", DASHED: "dashed", DOUBLE: "double",
  };

  function buildCellStyle(eff) {
    if (!eff) return {};
    const style = {};

    // Background
    const bg     = eff.backgroundColor ?? eff.backgroundColorStyle?.rgbColor;
    const bgArgb = rgbArgb(bg);
    if (bgArgb) style.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };

    // Font
    const tf = eff.textFormat ?? {};
    const font = {};
    if (tf.bold)          font.bold      = true;
    if (tf.italic)        font.italic    = true;
    if (tf.strikethrough) font.strike    = true;
    if (tf.underline)     font.underline = true;
    if (tf.fontSize)      font.size      = tf.fontSize;
    if (tf.fontFamily)    font.name      = tf.fontFamily;
    const fg     = tf.foregroundColor ?? tf.foregroundColorStyle?.rgbColor;
    const fgArgb = rgbArgb(fg);
    if (fgArgb) font.color = { argb: fgArgb };
    if (Object.keys(font).length) style.font = font;

    // Alignment
    const ha = (eff.horizontalAlignment ?? "").toUpperCase();
    const va = (eff.verticalAlignment   ?? "").toUpperCase();
    const vaMap = { TOP: "top", MIDDLE: "middle", BOTTOM: "bottom" };
    const alignment = {};
    if (["LEFT", "CENTER", "RIGHT"].includes(ha)) alignment.horizontal = ha.toLowerCase();
    if (vaMap[va]) alignment.vertical = vaMap[va];
    if (eff.wrapStrategy === "WRAP") alignment.wrapText = true;
    if (Object.keys(alignment).length) style.alignment = alignment;

    // Borders
    const border = {};
    for (const side of ["top", "bottom", "left", "right"]) {
      const bd = (eff.borders ?? {})[side] ?? {};
      const bs = BORDER_STYLE[bd.style ?? ""];
      if (bs) {
        border[side] = { style: bs };
        const bcArgb = rgbArgb(bd.color ?? bd.colorStyle?.rgbColor);
        if (bcArgb) border[side].color = { argb: bcArgb };
      }
    }
    if (Object.keys(border).length) style.border = border;

    // Number format
    const nf = eff.numberFormat?.pattern;
    if (nf) style.numFmt = nf;

    return style;
  }

  // ── Build XLSX ────────────────────────────────────────────────────────────
  const workbook  = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sname.slice(0, 31));

  // Column widths (pixels → Excel char units, ~7 px per char)
  for (let ci = 0; ci < headers.length; ci++) {
    const px  = fmtColMeta[ci]?.pixelSize ?? cachedColWidths[ci];
    const col = worksheet.getColumn(ci + 1);
    if (px) {
      col.width = Math.min(px / 7, 80);
    } else {
      const maxLen = Math.max(
        String(headers[ci]).length,
        ...data.map((row) => String(row[ci] ?? "").length),
      );
      col.width = Math.min(maxLen + 2, 50);
    }
  }

  // Pre-compute which cells to skip (non-top-left cells of merges)
  const mergedSkip = new Set();
  for (const mg of merges) {
    const sr = mg.startRowIndex    ?? 0;
    const er = (mg.endRowIndex    ?? 0) - 1;
    const sc = mg.startColumnIndex ?? 0;
    const ec = (mg.endColumnIndex  ?? 0) - 1;
    for (let r = sr; r <= er; r++) {
      for (let c = sc; c <= ec; c++) {
        if (r !== sr || c !== sc) mergedSkip.add(`${r},${c}`);
      }
    }
  }

  // Write rows (ri is 0-indexed; ExcelJS uses 1-indexed)
  for (let ri = 0; ri < numRows; ri++) {
    // Row height: pixels → points (1 pt ≈ 1.333 px)
    const pxH = fmtRowMeta[ri]?.pixelSize
      ?? (ri > 0 ? (cachedRowHeights[ri - 1] ?? cachedRowHeights[String(ri - 1)]) : undefined);
    if (pxH) worksheet.getRow(ri + 1).height = pxH * 0.75;

    const rdValues = fmtRowData[ri]?.values ?? [];

    for (let ci = 0; ci < headers.length; ci++) {
      if (mergedSkip.has(`${ri},${ci}`)) continue;

      const eff   = rdValues[ci]?.effectiveFormat ?? null;
      const style = buildCellStyle(eff);
      const val   = ri === 0 ? headers[ci] : (data[ri - 1]?.[ci] ?? "");

      const cell = worksheet.getCell(ri + 1, ci + 1);
      cell.value = val == null ? "" : val;
      if (Object.keys(style).length) cell.style = style;
    }
  }

  // Freeze header row
  worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

  // Apply merged ranges (after writing cells so top-left cell keeps its value)
  for (const mg of merges) {
    const sr = mg.startRowIndex    ?? 0;
    const er = (mg.endRowIndex    ?? 0) - 1;
    const sc = mg.startColumnIndex ?? 0;
    const ec = (mg.endColumnIndex  ?? 0) - 1;
    if (sr >= numRows || sc >= headers.length) continue;
    const clampedEr = Math.min(er, numRows - 1);
    const clampedEc = Math.min(ec, headers.length - 1);
    if (sr === clampedEr && sc === clampedEc) continue;
    try {
      worksheet.mergeCells(sr + 1, sc + 1, clampedEr + 1, clampedEc + 1);
    } catch { /* ignore overlapping merge errors */ }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${sname}.xlsx"`);
  res.send(Buffer.from(buffer));
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await loadRegistry();

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);

    if (registry.length === 0) return;
    const items = [...registry];
    setTimeout(async () => {
      console.log(`[startup] Warming up ${items.length} sheet(s), workers=${WARMUP_WORKERS}`);
      await runConcurrent(items, async (s) => {
        try {
          await warmupIfNeeded(s, "startup");
        } catch (e) {
          console.warn(`[startup] ${s.sheetName}: ${e.message}`);
        }
      }, WARMUP_WORKERS);
      console.log("[startup] Done");
    }, 3000);
  });
}

start();
