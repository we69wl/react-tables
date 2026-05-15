import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import credentials from "./credentials.json" with { type: "json" };
import path from "path";
import { readFile } from "fs/promises";
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
// Fetch row heights for the first N rows only — avoids huge payloads on 20k+ row sheets
const ROW_META_ROWS = parseInt(process.env.ROW_META_ROWS ?? "50", 10);
// Skip per-cell formatting fetch for sheets larger than this (includeGridData is huge)
const EXPORT_FORMAT_MAX_ROWS = parseInt(process.env.EXPORT_FORMAT_MAX_ROWS ?? "5000", 10);

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
  const res = await withRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title))" })
  );
  return (res.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean);
}

async function humanizeGoogleError(err, sheetName, spreadsheetId = "") {
  const status = err.code ?? err.status;
  const msg    = (err.message || "").toLowerCase();
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
          if (names.length)
            return `${base} Доступные листы: ${names.map((n) => `«${n}»`).join(", ")}.`;
        } catch { /* sheet names unavailable */ }
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

// ── Data fetchers ─────────────────────────────────────────────────────────────

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
        fields:
          "sheets(properties(title),data(startRow,columnMetadata(pixelSize),rowMetadata(pixelSize)))",
      })
    ),
  ]);

  const rows    = valuesRes.data.values ?? [];
  const headers = rows[0] ?? [];
  const data    = rows.slice(1);

  const sheetMeta  = (metaRes.data.sheets ?? []).find((s) => s.properties?.title === sheetName);
  const dataBlock  = sheetMeta?.data?.[0] ?? {};
  const blockStart = dataBlock.startRow ?? 0;
  const columnWidths = (dataBlock.columnMetadata ?? []).map((c) => c.pixelSize ?? 100);
  const rowHeights   = {};
  for (let idx = 0; idx < (dataBlock.rowMetadata ?? []).length; idx++) {
    const px = dataBlock.rowMetadata[idx].pixelSize;
    if (px) {
      const dataIdx = blockStart + idx - 1;
      if (dataIdx >= 0) rowHeights[dataIdx] = px;
    }
  }
  return { headers, data, columnWidths, rowHeights, total: data.length };
}

async function fetchJsonFile(url) {
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
  if (!Array.isArray(jsonArray) || jsonArray.length === 0) {
    const err = new Error("Expected a non-empty JSON array");
    err.statusCode = 400;
    throw err;
  }
  const headers = Object.keys(jsonArray[0]);
  const data    = jsonArray.map((row) => headers.map((h) => row[h] ?? ""));
  return { headers, data, columnWidths: [], rowHeights: {} };
}

// ── XLSX helpers ──────────────────────────────────────────────────────────────

function rgbArgb(color) {
  if (!color) return null;
  const r = Math.round((color.red   ?? 0) * 255);
  const g = Math.round((color.green ?? 0) * 255);
  const b = Math.round((color.blue  ?? 0) * 255);
  const rgb = [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
  if (rgb === "FFFFFF" || rgb === "000000") return null;
  return `FF${rgb}`;
}

const BORDER_STYLE_MAP = {
  SOLID: "thin", SOLID_MEDIUM: "medium", SOLID_THICK: "thick",
  DOTTED: "dotted", DASHED: "dashed", DOUBLE: "double",
};

function buildCellStyle(eff) {
  if (!eff) return {};
  const style = {};

  const bg     = eff.backgroundColor ?? eff.backgroundColorStyle?.rgbColor;
  const bgArgb = rgbArgb(bg);
  if (bgArgb) style.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };

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

  const ha = (eff.horizontalAlignment ?? "").toUpperCase();
  const va = (eff.verticalAlignment   ?? "").toUpperCase();
  const vaMap = { TOP: "top", MIDDLE: "middle", BOTTOM: "bottom" };
  const alignment = {};
  if (["LEFT", "CENTER", "RIGHT"].includes(ha)) alignment.horizontal = ha.toLowerCase();
  if (vaMap[va]) alignment.vertical = vaMap[va];
  if (eff.wrapStrategy === "WRAP") alignment.wrapText = true;
  if (Object.keys(alignment).length) style.alignment = alignment;

  const border = {};
  for (const side of ["top", "bottom", "left", "right"]) {
    const bd = (eff.borders ?? {})[side] ?? {};
    const bs = BORDER_STYLE_MAP[bd.style ?? ""];
    if (bs) {
      border[side] = { style: bs };
      const bcArgb = rgbArgb(bd.color ?? bd.colorStyle?.rgbColor);
      if (bcArgb) border[side].color = { argb: bcArgb };
    }
  }
  if (Object.keys(border).length) style.border = border;

  const nf = eff.numberFormat?.pattern;
  if (nf) style.numFmt = nf;

  return style;
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

  const t0 = Date.now();
  try {
    const result = await fetchAll(spreadsheetId, sheetName);
    console.log(`[sheet-data] ${sheetName} rows=${result.data.length} in ${Date.now() - t0}ms`);
    res.json(result);
  } catch (err) {
    console.error("[sheet-data]", err.message);
    const status     = err.code ?? 500;
    const httpStatus = [400, 403, 404].includes(status) ? status : 502;
    const message    = await humanizeGoogleError(err, sheetName, spreadsheetId);
    res.status(httpStatus).json({ error: message });
  }
});

// GET /api/json-data?url=...
// Local paths (/file.json) are resolved to server/data/<filename>.
app.get("/api/json-data", async (req, res) => {
  const url = req.query.url?.trim();
  if (!url) return res.status(400).json({ error: "Missing required query param: url" });
  try {
    const result = await fetchJsonFile(url);
    res.json(result);
  } catch (err) {
    console.error("[json-data]", err.message);
    if (err.code === "ENOENT") return res.status(404).json({ error: `File not found: ${path.basename(url)}` });
    res.status(err.statusCode ?? 500).json({ error: err.message || "Failed to load JSON" });
  }
});

// POST /api/export
// Body: { spreadsheetId?, sheetName?, jsonUrl?, format: "csv" | "xlsx" }
// Fetches data fresh and returns the file — no cache required.
app.post("/api/export", async (req, res) => {
  const { spreadsheetId, sheetName, jsonUrl, format = "xlsx" } = req.body ?? {};
  const sid  = (spreadsheetId ?? "").trim();
  const sname = (sheetName    ?? "").trim();
  const jUrl  = (jsonUrl      ?? "").trim();

  if (!jUrl && (!sid || !sname))
    return res.status(400).json({ error: "Missing spreadsheetId/sheetName or jsonUrl" });

  // ── Fetch data ─────────────────────────────────────────────────────────────
  let headers, data, colWidths = [], rowHeights = {};
  try {
    if (jUrl) {
      ({ headers, data } = await fetchJsonFile(jUrl));
    } else {
      const r = await fetchAll(sid, sname);
      headers = r.headers; data = r.data;
      colWidths = r.columnWidths; rowHeights = r.rowHeights;
    }
  } catch (err) {
    const status     = err.code ?? err.statusCode ?? 500;
    const httpStatus = [400, 403, 404].includes(status) ? status : 502;
    const message    = jUrl ? err.message : await humanizeGoogleError(err, sname, sid);
    return res.status(httpStatus).json({ error: message });
  }

  const name      = sname || path.basename(jUrl).replace(/\.[^.]+$/, "") || "export";
  const safeName  = name.replace(/[^\x20-\x7E]/g, "_");
  const encName   = (n) => encodeURIComponent(n);

  // ── CSV ────────────────────────────────────────────────────────────────────
  if (format === "csv") {
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [
      headers.map(esc).join(","),
      ...data.map((row) => headers.map((_, i) => esc(row[i])).join(",")),
    ];
    res.setHeader("Content-Type", "text/csv;charset=utf-8;");
    res.setHeader("Content-Disposition",
      `attachment; filename="${safeName}.csv"; filename*=UTF-8''${encName(name + ".csv")}`);
    return res.send("﻿" + rows.join("\r\n"));
  }

  // ── XLSX ───────────────────────────────────────────────────────────────────
  const numRows = data.length + 1;
  const useFmt  = !jUrl && numRows <= EXPORT_FORMAT_MAX_ROWS;

  let fmtRowData = [], fmtColMeta = [], fmtRowMeta = [], merges = [];
  if (useFmt) {
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
  }

  const workbook  = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(name.slice(0, 31));

  // Column widths (pixels → Excel char units, ~7 px per char)
  for (let ci = 0; ci < headers.length; ci++) {
    const px  = fmtColMeta[ci]?.pixelSize ?? colWidths[ci];
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

  // Pre-compute which cells to skip (non-top-left cells of merge regions)
  const mergedSkip = new Set();
  for (const mg of merges) {
    const sr = mg.startRowIndex    ?? 0;
    const er = (mg.endRowIndex    ?? 0) - 1;
    const sc = mg.startColumnIndex ?? 0;
    const ec = (mg.endColumnIndex  ?? 0) - 1;
    for (let r = sr; r <= er; r++)
      for (let c = sc; c <= ec; c++)
        if (r !== sr || c !== sc) mergedSkip.add(`${r},${c}`);
  }

  // Write rows (ri is 0-indexed; ExcelJS is 1-indexed)
  for (let ri = 0; ri < numRows; ri++) {
    const pxH = fmtRowMeta[ri]?.pixelSize
      ?? (ri > 0 ? (rowHeights[ri - 1] ?? rowHeights[String(ri - 1)]) : undefined);
    if (pxH) worksheet.getRow(ri + 1).height = pxH * 0.75;

    const rdValues = fmtRowData[ri]?.values ?? [];
    for (let ci = 0; ci < headers.length; ci++) {
      if (mergedSkip.has(`${ri},${ci}`)) continue;
      const eff   = rdValues[ci]?.effectiveFormat ?? null;
      const style = buildCellStyle(eff);
      const val   = ri === 0 ? headers[ci] : (data[ri - 1]?.[ci] ?? "");
      const cell  = worksheet.getCell(ri + 1, ci + 1);
      cell.value  = val == null ? "" : val;
      if (Object.keys(style).length) cell.style = style;
    }
  }

  worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

  // Apply merged ranges (after writing so top-left cell keeps its value/style)
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
  res.setHeader("Content-Disposition",
    `attachment; filename="${safeName}.xlsx"; filename*=UTF-8''${encName(name + ".xlsx")}`);
  res.send(Buffer.from(buffer));
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
