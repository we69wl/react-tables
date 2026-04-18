import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Spinner, FloatingLabel, Form } from "react-bootstrap";

function VirtualizedTable({ data = [], headers = [], height = "400px" }) {
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const [showRows, setShowRows] = useState(30);
  const [inputValue, setInputValue] = useState(""); // 🆕 Значение INPUТа
  const [searchTerm, setSearchTerm] = useState(""); // 🆕 Значение ПОИСКА
  const debounceRef = useRef();

  const handleInputChange = (e) => {
    const value = e.target.value;
    setInputValue(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchTerm(value);
      setShowRows(30); // 🆕 Сброс на первую страницу
    }, 350);
  };

  const filteredData = useCallback(() => {
    if (!searchTerm.trim()) return data;
    return data.filter((row) =>
      headers.some((_, colIndex) =>
        row[colIndex]
          ?.toString()
          .toLowerCase()
          .includes(searchTerm.toLowerCase())
      )
    );
  }, [data, headers, searchTerm]);

  const filtered = useMemo(() => filteredData(), [filteredData]);
  const totalFiltered = filtered.length;
  const visibleData = filtered.slice(0, showRows);
  const handleShowMore = () =>
    setShowRows((prev) => Math.min(prev + 100, totalFiltered));

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

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

  return (
    <div
      ref={containerRef}
      className="w-100 h-100 d-flex flex-column border rounded shadow-sm overflow-hidden"
      style={{ height }}
    >
      {/* Поиск */}
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
                  right: "36px", // ✅ 36px вместо 40px — не перекрывает крестик!
                  transform: "translateY(-50%)",
                  zIndex: 5,
                }}
              >
                <Spinner animation="border" variant="primary" size="sm" />
              </div>
            )}
            {searchTerm && ( // ✅ searchTerm вместо inputValue
              <i
                className="bi bi-x-circle position-absolute text-muted pointer"
                style={{
                  top: "50%",
                  right: "12px",
                  transform: "translateY(-50%)",
                  cursor: "pointer",
                  zIndex: 10, // ✅ zIndex выше спиннера!
                }}
                onClick={() => (setSearchTerm(""), setInputValue(""))}
              />
            )}
          </div>
        </div>
      </div>
      {/* ========== ТАБЛИЦА ИЛИ ПУСТАЯ КОРОБКА ========== */}
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
        <>
          {/* ✅ СКРОЛЛИРУЕМАЯ ТАБЛИЦА */}
          <div
            className="flex-grow-1 position-relative overflow-auto"
            style={{ scrollbarWidth: "thin" }}
          >
            <table className="table table-sm m-0 w-100">
              <thead>
                <tr className="table-light sticky-top bg-white shadow-sm">
                  {headers.map((header, idx) => (
                    <th
                      key={idx}
                      className="text-truncate fw-semibold border-end p-3 position-sticky"
                      style={{
                        top: 0,
                        zIndex: 10,
                        minWidth: "160px",
                        maxWidth: "280px",
                        backgroundColor: "white",
                        borderBottom: "2px solid #dee2e6 !important",
                      }}
                      title={header}
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleData &&
                  visibleData.map((row, rowIndex) => (
                    <tr key={rowIndex} className={`align-middle table-hover-row`}>
                      {headers.map((header, colIndex) => (
                        <td
                          key={colIndex}
                          className="border-end small p-3 align-middle"
                          style={{
                            minWidth: "160px",
                            maxWidth: "280px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            backgroundColor:
                              rowIndex % 2 ? "#f8f9fa" : "transparent",
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
        </>
      )}

      {/* Футер */}
      {showRows < totalFiltered && (
        <div className="p-3 bg-light border-top flex-shrink-0">
          <div className="d-flex justify-content-between align-items-center">
            <small className="text-muted">
              Показаны {showRows.toLocaleString()} из{" "}
              {totalFiltered.toLocaleString()}
            </small>
            <button
              className="btn btn-primary btn-sm px-4 fw-semibold shadow-sm"
              onClick={handleShowMore}
            >
              +{Math.min(100, totalFiltered - showRows).toLocaleString()}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default VirtualizedTable;