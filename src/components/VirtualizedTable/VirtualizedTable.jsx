import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Spinner, FloatingLabel, Form } from "react-bootstrap";

const MIN_COL_WIDTH = 100;
const MAX_COL_WIDTH = 400;
const DEFAULT_COL_WIDTH = 160;

function VirtualizedTable({
  data = [],
  headers = [],
  height = "400px",
  tableName = "default", // used as localStorage key namespace
  initialColWidths = null, // server-provided widths (Google Sheets pixel sizes); overridden by localStorage
  sheetName = null,    // displayed in the footer, e.g. "Ozon"
  showSearch = true,   // set false to hide the search input (e.g. when modal has its own controls)
}) {
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const [showRows, setShowRows] = useState(30);
  const [inputValue, setInputValue] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const debounceRef = useRef();

  // ── Zoom (0.5x – 2x, step 0.1) ───────────────────────────────────────────
  const [zoom, setZoom] = useState(1);

  // ── Column widths — loaded from / saved to localStorage ──────────────────
  const storageKey = `table_${tableName}_column_widths`;

  const getInitialWidths = useCallback(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === headers.length) return parsed;
      }
    } catch { /* ignore malformed localStorage value */ }
    // Server may return more widths than data columns (Google Sheets includes empty trailing columns).
    // Slice to headers.length, pad any missing entries with DEFAULT_COL_WIDTH, clamp to [MIN, MAX].
    if (initialColWidths?.length > 0) {
      return Array.from({ length: headers.length }, (_, i) => {
        const w = initialColWidths[i];
        return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, w || DEFAULT_COL_WIDTH));
      });
    }
    return headers.map(() => DEFAULT_COL_WIDTH);
  }, [storageKey, headers, initialColWidths]);

  const [colWidths, setColWidths] = useState(getInitialWidths);

  // Re-initialize widths when headers change (different table loaded into same component)
  useEffect(() => {
    setColWidths(getInitialWidths());
  }, [getInitialWidths]);

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
          } catch { /* ignore localStorage write failures (e.g. private mode quota) */ }
          return prev;
        });
        resizingRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        // click fires synchronously during mouseup processing; reset after it
        setTimeout(() => { preventSortRef.current = false; }, 100);
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
    setShowRows(30);
  };

  // ── Search (existing logic, unchanged) ───────────────────────────────────
  const handleInputChange = (e) => {
    const value = e.target.value;
    setInputValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchTerm(value);
      setShowRows(30);
    }, 350);
  };

  const filteredData = useCallback(() => {
    if (!searchTerm.trim()) return data;
    return data.filter((row) =>
      headers.some((_, i) =>
        row[i]?.toString().toLowerCase().includes(searchTerm.toLowerCase())
      )
    );
  }, [data, headers, searchTerm]);

  const filtered = useMemo(() => filteredData(), [filteredData]);

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
        : av.toString().localeCompare(bv.toString(), undefined, { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir]);

  const totalFiltered = sortedData.length;
  const visibleData = sortedData.slice(0, showRows);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
  // CSS zoom breaks position:sticky in some browsers; fall back to relative when zoomed
  const isZoomed = zoom !== 1;

  return (
    <div
      ref={containerRef}
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
            <div style={{ width: 1, alignSelf: "stretch", background: "#dee2e6", flexShrink: 0, margin: "4px 0" }} />
            {/* Zoom controls: −  100%  + */}
            <div className="d-flex gap-1 align-items-center flex-shrink-0">
              <button
                className="btn btn-outline-secondary btn-sm"
                onClick={() => setZoom((z) => Math.max(+(z - 0.1).toFixed(1), 0.5))}
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
                onClick={() => setZoom((z) => Math.min(+(z + 0.1).toFixed(1), 2))}
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
          {/* CSS zoom scales layout so scrollbars reflect actual content size.
              Applied only when zoom != 1 to avoid unnecessary style recalculations. */}
          <div style={isZoomed ? { zoom } : undefined}>
            <table
              className="table table-sm m-0"
              style={{ tableLayout: "fixed", width: totalTableWidth }}
            >
              <thead>
                <tr className="table-light">
                  {headers.map((header, idx) => (
                    <th
                      key={idx}
                      className="fw-semibold border-end"
                      style={{
                        width: colWidths[idx],
                        // Sticky headers are disabled while zoomed because CSS zoom
                        // can misalign the sticky offset in some browsers
                        position: isZoomed ? "relative" : "sticky",
                        top: isZoomed ? undefined : 0,
                        zIndex: 10,
                        backgroundColor: "white",
                        borderBottom: "2px solid #dee2e6",
                        padding: "10px 20px 10px 12px", // right padding clears resize handle
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
                {visibleData.map((row, rowIndex) => (
                  <tr key={rowIndex} className="align-middle table-hover-row">
                    {headers.map((_, colIndex) => (
                      <td
                        key={colIndex}
                        className="border-end small align-middle"
                        style={{
                          width: colWidths[colIndex],
                          padding: "10px 12px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          backgroundColor:
                            rowIndex % 2 ? "#f8f9fa" : "transparent",
                          boxSizing: "border-box",
                        }}
                        title={row[colIndex]?.toString() || ""}
                      >
                        {row[colIndex] || (
                          <span className="text-muted small">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Footer: sheet name (left) + row count / Show More (right) */}
      {(showRows < totalFiltered || sheetName) && (
        <div className="px-3 py-2 bg-light border-top flex-shrink-0">
          <div className="d-flex justify-content-between align-items-center">
            <small className="text-muted">
              {sheetName ? `Лист: ${sheetName}` : ""}
            </small>
            {showRows < totalFiltered && (
              <div className="d-flex align-items-center gap-3">
                <small className="text-muted">
                  Показаны {showRows.toLocaleString()} из {totalFiltered.toLocaleString()}
                </small>
                <button
                  className="btn btn-primary btn-sm px-4 fw-semibold shadow-sm"
                  onClick={() => setShowRows((prev) => Math.min(prev + 100, totalFiltered))}
                >
                  +{Math.min(100, totalFiltered - showRows).toLocaleString()}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default VirtualizedTable;
