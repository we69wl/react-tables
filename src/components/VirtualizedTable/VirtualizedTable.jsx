import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Spinner, FloatingLabel, Form } from "react-bootstrap";

const MIN_COL_WIDTH = 100;
const MAX_COL_WIDTH = 1000;
const DEFAULT_COL_WIDTH = 160;

const MIN_ROW_HEIGHT = 30;
const MAX_ROW_HEIGHT = 300;
const DEFAULT_ROW_HEIGHT = 36;

// ── Skeleton ──────────────────────────────────────────────────────────────────

const SKELETON_STYLES = `
  @keyframes tw-shimmer {
    0%   { background-position: -200% 0; }
    100% { background-position:  200% 0; }
  }
  .tw-skel {
    background: linear-gradient(90deg, #e8e8e8 25%, #f4f4f4 50%, #e8e8e8 75%);
    background-size: 200% 100%;
    animation: tw-shimmer 1.4s ease-in-out infinite;
    border-radius: 4px;
  }
`;

const SKEL_ROWS = [
  [72, 48, 85, 60, 38],
  [55, 80, 42, 90, 65],
  [88, 35, 70, 52, 78],
  [45, 75, 60, 38, 92],
  [78, 55, 82, 48, 65],
  [60, 88, 35, 75, 50],
  [85, 42, 68, 90, 45],
  [38, 70, 78, 55, 80],
  [92, 58, 45, 72, 35],
  [50, 65, 88, 40, 70],
  [68, 42, 75, 85, 52],
  [35, 90, 55, 65, 80],
  [80, 52, 38, 78, 60],
  [62, 72, 90, 45, 42],
  [48, 38, 65, 82, 70],
  [75, 85, 50, 35, 88],
  [40, 68, 72, 92, 55],
  [88, 45, 58, 70, 38],
  [58, 78, 35, 55, 82],
  [70, 35, 92, 48, 65],
  [42, 92, 68, 75, 50],
  [82, 60, 45, 38, 72],
  [65, 50, 80, 58, 45],
  [35, 72, 55, 88, 62],
  [90, 40, 78, 42, 75],
];

function TableSkeleton({ height, showSearch }) {
  return (
    <>
      <style>{SKELETON_STYLES}</style>
      <div
        className="w-100 h-100 d-flex flex-column border rounded shadow-sm overflow-hidden"
        style={{ height }}
      >
        {showSearch && (
          <div className="p-3 bg-light border-bottom flex-shrink-0">
            <div className="tw-skel" style={{ height: 38, borderRadius: 6 }} />
          </div>
        )}
        <div className="flex-grow-1 overflow-hidden">
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                {[72, 48, 85, 60, 38].map((w, i) => (
                  <th
                    key={i}
                    style={{
                      padding: "12px 16px",
                      borderBottom: "2px solid #dee2e6",
                      background: "white",
                      position: "sticky",
                      top: 0,
                      zIndex: 10,
                    }}
                  >
                    <div className="tw-skel" style={{ height: 14, width: `${w}%` }} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SKEL_ROWS.map((cols, rowIdx) => (
                <tr
                  key={rowIdx}
                  style={{ backgroundColor: rowIdx % 2 ? "#f8f9fa" : "transparent" }}
                >
                  {cols.map((w, colIdx) => (
                    <td
                      key={colIdx}
                      style={{ padding: "10px 16px", borderBottom: "1px solid #f0f0f0" }}
                    >
                      <div
                        className="tw-skel"
                        style={{
                          height: 13,
                          width: `${w}%`,
                          animationDelay: `${((rowIdx + colIdx * 2) % 6) * 0.07}s`,
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Footer skeleton — mirrors the real footer (count text + load-more button) */}
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid #dee2e6",
            background: "#f8f9fa",
            flexShrink: 0,
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div className="tw-skel" style={{ height: 12, width: "18%", animationDelay: "0.25s" }} />
        </div>
      </div>
    </>
  );
}

// ── Row resize styles ─────────────────────────────────────────────────────────

// CSS styles for row resize handle (using ::after pseudo-element)
const ROW_RESIZE_STYLES = `
  .resizable-row {
    position: relative;
  }
  .resizable-row::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 4px;
    cursor: ns-resize;
    background-color: transparent;
    z-index: 10;
    pointer-events: auto;
  }
`;

const SHOW_ROWS_STEP = 30;

function VirtualizedTable({
  data = [],
  headers = [],
  height = "400px",
  tableName = "default", // used as localStorage key namespace
  initialColWidths = null, // server-provided widths (Google Sheets pixel sizes); overridden by localStorage
  initialRowHeights = null, // server-provided heights (Google Sheets pixel sizes); overridden by localStorage
  showSearch = true, // set false to hide the search input (e.g. when modal has its own controls)
  loading = false,
}) {
  const inputRef = useRef(null);
  const [inputValue, setInputValue] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const debounceRef = useRef();
  const resizingRowRef = useRef(null); // { dataIndex, startY, startHeight }

  // ── Client-side pagination ────────────────────────────────────────────────
  const [showRows, setShowRows] = useState(SHOW_ROWS_STEP);

  // Reset pagination when switching to a different table
  useEffect(() => {
    setShowRows(SHOW_ROWS_STEP);
  }, [tableName]);

  // ── Zoom (0.5x – 2x, step 0.1) ───────────────────────────────────────────
  // Implemented via font-size + padding scaling to preserve position:sticky on headers.
  const [zoom, setZoom] = useState(1);

  // ── Column widths — loaded from / saved to localStorage ──────────────────
  const storageKey = `table_${tableName}_column_widths`;

  const getInitialWidths = useCallback(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === headers.length)
          return parsed;
      }
    } catch {
      /* ignore malformed localStorage value */
    }
    // Server may return more widths than data columns (Google Sheets includes empty trailing columns).
    // Slice to headers.length, pad any missing entries with DEFAULT_COL_WIDTH, clamp to [MIN, MAX].
    if (initialColWidths?.length > 0) {
      return Array.from({ length: headers.length }, (_, i) => {
        const w = initialColWidths[i];
        return Math.min(
          MAX_COL_WIDTH,
          Math.max(MIN_COL_WIDTH, w || DEFAULT_COL_WIDTH)
        );
      });
    }
    return headers.map(() => DEFAULT_COL_WIDTH);
  }, [storageKey, headers, initialColWidths]);

  const [colWidths, setColWidths] = useState(getInitialWidths);

  // Re-initialize widths when headers change (different table loaded into same component)
  useEffect(() => {
    setColWidths(getInitialWidths());
  }, [getInitialWidths]);

  // ── Row heights — loaded from / saved to localStorage ──────────────────
  // Stored as object: { dataIndex: height, ... }
  // Keys are indices in the original `data` array, so heights follow rows during sort/filter
  // Priority: localStorage > initialRowHeights (from Google Sheets) > DEFAULT_ROW_HEIGHT
  const rowHeightsStorageKey = `table_${tableName}_row_heights`;

  const getInitialRowHeights = useCallback(() => {
    // 1. Priority: localStorage (user's custom heights)
    try {
      const saved = localStorage.getItem(rowHeightsStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed === "object" && parsed !== null) return parsed;
      }
    } catch {
      /* ignore malformed localStorage value */
    }

    // 2. Then: initialRowHeights from Google Sheets API
    if (initialRowHeights && typeof initialRowHeights === "object") {
      return initialRowHeights;
    }

    // 3. Default: empty object (will use DEFAULT_ROW_HEIGHT for all rows)
    return {};
  }, [rowHeightsStorageKey, initialRowHeights]);

  const [rowHeights, setRowHeights] = useState(getInitialRowHeights);

  // Reset row heights when table changes
  useEffect(() => {
    // Re-initialize with the same logic (localStorage > initialRowHeights > default)
    setRowHeights(getInitialRowHeights());
  }, [tableName, getInitialRowHeights]);

  // ── Column resize via drag ────────────────────────────────────────────────
  const [isResizing, setIsResizing] = useState(false);
  const resizingRef = useRef(null); // { colIndex, startX, startWidth }
  // Ref (not state) so the click handler reads the current value synchronously,
  // before React has a chance to commit the setIsResizing(false) update.
  const preventSortRef = useRef(false);

  const handleResizeMouseDown = useCallback(
    (e, colIndex) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      preventSortRef.current = true;
      resizingRef.current = {
        colIndex,
        startX: e.clientX,
        startWidth: colWidths[colIndex],
      };

      const onMouseMove = (moveE) => {
        const r = resizingRef.current;
        if (!r) return;
        const newWidth = Math.max(
          MIN_COL_WIDTH,
          Math.min(MAX_COL_WIDTH, r.startWidth + moveE.clientX - r.startX)
        );
        setColWidths((prev) => {
          const next = [...prev];
          next[r.colIndex] = newWidth;
          return next;
        });
      };

      const onMouseUp = () => {
        setIsResizing(false);
        // Persist final widths to localStorage when drag ends
        setColWidths((prev) => {
          try {
            localStorage.setItem(storageKey, JSON.stringify(prev));
          } catch {
            /* ignore localStorage write failures (e.g. private mode quota) */
          }
          return prev;
        });
        resizingRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        // click fires synchronously during mouseup processing; reset after it
        setTimeout(() => {
          preventSortRef.current = false;
        }, 100);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [colWidths, storageKey]
  );

  // ── Sorting ───────────────────────────────────────────────────────────────
  const [sortCol, setSortCol] = useState(null); // column index, or null = unsorted
  const [sortDir, setSortDir] = useState("asc");

  const handleSortClick = (colIndex) => {
    if (isResizing || preventSortRef.current) return;
    if (sortCol === colIndex) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(colIndex);
      setSortDir("asc");
    }
  };

  // ── Search (existing logic, unchanged) ───────────────────────────────────
  const handleInputChange = (e) => {
    const value = e.target.value;
    setInputValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchTerm(value);
    }, 350);
  };

  const filtered = useMemo(() => {
    if (!searchTerm.trim()) return data;
    return data.filter((row) =>
      headers.some((_, i) =>
        row[i]?.toString().toLowerCase().includes(searchTerm.toLowerCase())
      )
    );
  }, [data, headers, searchTerm]);

  // Sort applied on top of search-filtered data
  const sortedData = useMemo(() => {
    if (sortCol === null) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sortCol] ?? "";
      const bv = b[sortCol] ?? "";
      const an = parseFloat(av);
      const bn = parseFloat(bv);
      // Auto-detect numeric columns; fall back to locale string comparison
      const isNum = av !== "" && bv !== "" && !isNaN(an) && !isNaN(bn);
      const cmp = isNum
        ? an - bn
        : av
            .toString()
            .localeCompare(bv.toString(), undefined, { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir]);

  const totalFiltered = sortedData.length;
  // When searching show all matches; otherwise paginate client-side
  const visibleData = searchTerm ? sortedData : sortedData.slice(0, showRows);

  // ── Row resize via drag ───────────────────────────────────────────────────
  const handleRowResizeMouseDown = useCallback(
    (e, rowIndex) => {
      // Check if click was near the bottom edge of the row (in the handle area)
      const trElement = e.currentTarget;
      const rect = trElement.getBoundingClientRect();
      const distanceFromBottom = rect.bottom - e.clientY;

      // Allow drag if click is within 10px of the bottom edge (handle area)
      if (distanceFromBottom > 10) return;

      e.preventDefault();
      e.stopPropagation();

      // Get the row from visibleData and find its index in the original data
      const row = visibleData[rowIndex];
      const dataIndex = data.indexOf(row);
      // Fallback: if row not found in data (e.g., after sort/filter), use visible index
      const safeIndex = dataIndex !== -1 ? dataIndex : rowIndex;

      const currentHeight = rowHeights[safeIndex] || DEFAULT_ROW_HEIGHT;

      resizingRowRef.current = {
        dataIndex: safeIndex,
        startY: e.clientY,
        startHeight: currentHeight,
        trElement,
      };

      const onMouseMove = (moveE) => {
        const r = resizingRowRef.current;
        if (!r) return;

        const newHeight = Math.max(
          MIN_ROW_HEIGHT,
          Math.min(MAX_ROW_HEIGHT, r.startHeight + moveE.clientY - r.startY)
        );

        setRowHeights((prev) => {
          const next = { ...prev };
          next[r.dataIndex] = newHeight;
          return next;
        });

        if (r.trElement) {
          r.trElement.style.height = `${newHeight}px`;
        }
      };

      const onMouseUp = () => {
        setRowHeights((prev) => {
          try {
            localStorage.setItem(rowHeightsStorageKey, JSON.stringify(prev));
          } catch {
            /* ignore localStorage write failures */
          }
          return prev;
        });
        resizingRowRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [visibleData, data, rowHeights, rowHeightsStorageKey]
  );

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (loading && headers.length === 0) {
    return <TableSkeleton height={height} showSearch={showSearch} />;
  }

  if (headers.length === 0) {
    return (
      <div
        className="d-flex justify-content-center align-items-center p-5 text-muted bg-light rounded border"
        style={{ height }}
      >
        Заголовки не загружены
      </div>
    );
  }

  const totalTableWidth = colWidths.reduce((s, w) => s + w, 0);

  // Scaled padding helpers — proportional to zoom level
  const thPadding = `${Math.round(zoom * 10)}px ${Math.round(
    zoom * 20
  )}px ${Math.round(zoom * 10)}px ${Math.round(zoom * 12)}px`;
  const tdPadding = `${Math.round(zoom * 10)}px ${Math.round(zoom * 12)}px`;

  return (
    <>
      <style>{ROW_RESIZE_STYLES}</style>
      <div
        className="w-100 h-100 d-flex flex-column border rounded shadow-sm overflow-hidden"
        style={{ height }}
      >
        {/* Toolbar: search + zoom controls */}
        {showSearch && (
          <div className="p-3 bg-light border-bottom flex-shrink-0">
            <div className="d-flex gap-2 align-items-center">
              <div className="flex-grow-1 position-relative">
                <FloatingLabel
                  controlId="searchInput"
                  label="Поиск по таблице"
                  className="mb-0"
                >
                  <Form.Control
                    ref={inputRef}
                    type="text"
                    placeholder="Поиск по таблице"
                    value={inputValue}
                    onChange={handleInputChange}
                  />
                </FloatingLabel>
                {inputValue !== searchTerm && inputValue && (
                  <div
                    className="position-absolute"
                    style={{
                      top: "50%",
                      right: "36px",
                      transform: "translateY(-50%)",
                      zIndex: 5,
                    }}
                  >
                    <Spinner animation="border" variant="primary" size="sm" />
                  </div>
                )}
                {searchTerm && (
                  <i
                    className="bi bi-x-circle position-absolute text-muted"
                    style={{
                      top: "50%",
                      right: "12px",
                      transform: "translateY(-50%)",
                      cursor: "pointer",
                      zIndex: 10,
                    }}
                    onClick={() => {
                      setSearchTerm("");
                      setInputValue("");
                    }}
                  />
                )}
              </div>

              {/* Divider between search and zoom */}
              <div
                style={{
                  width: 1,
                  alignSelf: "stretch",
                  background: "#dee2e6",
                  flexShrink: 0,
                  margin: "4px 0",
                }}
              />
              {/* Zoom controls: −  100%  + */}
              <div className="d-flex gap-1 align-items-center flex-shrink-0">
                <button
                  className="btn btn-outline-secondary btn-sm"
                  onClick={() =>
                    setZoom((z) => Math.max(+(z - 0.1).toFixed(1), 0.5))
                  }
                  title="Zoom out"
                >
                  −
                </button>
                <button
                  className="btn btn-outline-secondary btn-sm px-2"
                  onClick={() => setZoom(1)}
                  title="Reset zoom"
                  style={{ minWidth: "46px" }}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  className="btn btn-outline-secondary btn-sm"
                  onClick={() =>
                    setZoom((z) => Math.min(+(z + 0.1).toFixed(1), 2))
                  }
                  title="Zoom in"
                >
                  +
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Empty state */}
        {totalFiltered === 0 ? (
          <div className="flex-grow-1 d-flex flex-column justify-content-center align-items-center text-muted bg-light">
            <div className="text-center">
              <div className="fs-1 mb-3 opacity-50">📭</div>
              <h5 className="fw-semibold">Ничего не найдено</h5>
              <p className="small mb-0">Попробуйте изменить поисковый запрос</p>
              {searchTerm && (
                <button
                  className="btn btn-link btn-sm mt-2"
                  onClick={() => {
                    setSearchTerm("");
                    setInputValue("");
                  }}
                >
                  ✕ Очистить поиск
                </button>
              )}
            </div>
          </div>
        ) : (
          <div
            className="flex-grow-1 overflow-auto"
            style={{ scrollbarWidth: "thin" }}
          >
            <table
              className="table table-sm m-0"
              style={{
                tableLayout: "fixed",
                width: totalTableWidth,
                fontSize: `${zoom}rem`,
              }}
            >
              <thead>
                <tr className="table-light">
                  {headers.map((header, idx) => (
                    <th
                      key={idx}
                      className="fw-semibold border-end"
                      style={{
                        width: colWidths[idx],
                        position: "sticky",
                        top: 0,
                        zIndex: 10,
                        backgroundColor: "white",
                        borderBottom: "2px solid #dee2e6",
                        padding: thPadding,
                        cursor: "pointer",
                        userSelect: "none",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        textOverflow: "ellipsis",
                        boxSizing: "border-box",
                      }}
                      title={header}
                      onClick={() => handleSortClick(idx)}
                    >
                      {header}
                      {/* Sort direction indicator */}
                      {sortCol === idx && (
                        <span
                          className="ms-1 text-primary"
                          style={{ fontSize: "0.75em" }}
                        >
                          {sortDir === "asc" ? "↑" : "↓"}
                        </span>
                      )}
                      {/* Drag handle — sits over the right edge of the header cell */}
                      <span
                        style={{
                          position: "absolute",
                          right: 0,
                          top: 0,
                          bottom: 0,
                          width: "5px",
                          cursor: "col-resize",
                          zIndex: 20,
                        }}
                        onMouseDown={(e) => handleResizeMouseDown(e, idx)}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleData.map((row, rowIndex) => {
                  const dataIndex = data.indexOf(row);
                  const rowHeight = rowHeights[dataIndex] || DEFAULT_ROW_HEIGHT;

                  return (
                    <tr
                      key={rowIndex}
                      className="align-middle table-hover-row resizable-row"
                      style={{
                        height: `${rowHeight}px`,
                      }}
                      onMouseDown={(e) => handleRowResizeMouseDown(e, rowIndex)}
                    >
                      {headers.map((_, colIndex) => (
                        <td
                          key={colIndex}
                          className="border-end small align-middle"
                          style={{
                            position: "relative",
                            width: colWidths[colIndex],
                            padding: tdPadding,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            backgroundColor:
                              rowIndex % 2 ? "#f8f9fa" : "transparent",
                            boxSizing: "border-box",
                          }}
                          title={row[colIndex]?.toString() || ""}
                        >
                          {row[colIndex] != null && row[colIndex] !== "" ? (
                            row[colIndex]
                          ) : (
                            <span className="text-muted small">—</span>
                          )}
                          {/* Column resize handle — mirrors the one in <th> */}
                          <span
                            style={{
                              position: "absolute",
                              right: 0,
                              top: 0,
                              bottom: 0,
                              width: "5px",
                              cursor: "col-resize",
                              zIndex: 1,
                            }}
                            onMouseDown={(e) =>
                              handleResizeMouseDown(e, colIndex)
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer: row count + client-side load more */}
        {data.length > 0 && (
          <div className="px-3 py-2 bg-light border-top flex-shrink-0">
            <div className="d-flex justify-content-end align-items-center gap-3">
              <small className="text-muted">
                {searchTerm
                  ? `Найдено ${sortedData.length.toLocaleString()}`
                  : `Загружено ${Math.min(showRows, sortedData.length).toLocaleString()} из ${sortedData.length.toLocaleString()}`}
              </small>
              {!searchTerm && showRows < sortedData.length && (
                <button
                  className="btn btn-primary btn-sm px-4 fw-semibold shadow-sm"
                  onClick={() => setShowRows((n) => n + SHOW_ROWS_STEP)}
                >
                  Загрузить ещё
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default VirtualizedTable;