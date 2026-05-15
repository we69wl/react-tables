import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useImperativeHandle,
} from "react";
import { Modal, Button, Spinner } from "react-bootstrap";

import VirtualizedTable from "../VirtualizedTable/VirtualizedTable";
import JsonCodeViewer from "../JsonCodeViewer/JsonCodeViewer";

// React 19: ref is a regular prop, no forwardRef needed
const DEFAULT_NOTICE = "Данный файл является лишь демонстрационным вариантом. Часть данных может быть урезана для сохранения конфиденциальности Заказчика.";

function TableWidget({
  tabs = [],
  apiBase = "/api",
  title = "Таблица",
  label = "Открыть",
  buttonVariant = "primary",
  manual = false,
  noticeText = DEFAULT_NOTICE,
  portalContainer,
  onReady,
  ref,
}) {
  const [show, setShow] = useState(false);

  // Expose open() so the web component can trigger the modal externally (manual mode)
  useImperativeHandle(ref, () => ({ open: () => setShow(true) }), []);

  // Notify the web component that React has committed the first render
  useEffect(() => {
    onReady?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [activeTab, setActiveTab] = useState(tabs[0]?.key ?? "");
  const [tabsState, setTabsState] = useState({});
  const [showSearch, setShowSearch] = useState(false);
  const [xlsxLoading, setXlsxLoading] = useState(false);
  const [viewModes, setViewModes] = useState({});
  const [dlOpen, setDlOpen] = useState(false);
  const loadedTabsRef = useRef(new Set());
  const dlRef = useRef(null);

  // Click-outside uses composedPath() so it works across the shadow DOM boundary
  useEffect(() => {
    if (!dlOpen) return;
    const close = (e) => {
      const path = e.composedPath?.() ?? [];
      if (dlRef.current && !path.includes(dlRef.current)) setDlOpen(false);
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [dlOpen]);

  const currentTab = useMemo(
    () => tabs.find((t) => t.key === activeTab),
    [tabs, activeTab]
  );
  const isJsonTab = !!currentTab?.jsonUrl;
  const viewMode = viewModes[activeTab] ?? (isJsonTab ? "code" : "table");

  const setViewMode = useCallback(
    (mode) => setViewModes((prev) => ({ ...prev, [activeTab]: mode })),
    [activeTab]
  );

  // ── State helpers ─────────────────────────────────────────────────────────
  const setTabLoading = useCallback((key) => {
    setTabsState((prev) => ({
      ...prev,
      [key]: { headers: [], data: [], columnWidths: [], rowHeights: {}, loading: true, error: null },
    }));
  }, []);

  const setTabResult = useCallback((key, json) => {
    setTabsState((prev) => ({
      ...prev,
      [key]: {
        headers: json.headers ?? [],
        data: json.data ?? [],
        columnWidths: json.columnWidths ?? [],
        rowHeights: json.rowHeights ?? {},
        loading: false,
        error: null,
      },
    }));
  }, []);

  const setTabError = useCallback((key, message) => {
    setTabsState((prev) => ({
      ...prev,
      [key]: { headers: [], data: [], columnWidths: [], rowHeights: {}, loading: false, error: message },
    }));
  }, []);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchSheetData = useCallback(
    async (key, spreadsheetId, sheetName) => {
      setTabLoading(key);
      try {
        const res = await fetch(
          `${apiBase}/sheet-data?spreadsheetId=${encodeURIComponent(spreadsheetId)}&sheetName=${encodeURIComponent(sheetName)}`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || body.detail || `HTTP ${res.status}`);
        }
        setTabResult(key, await res.json());
      } catch (e) {
        setTabError(key, e.message);
      }
    },
    [apiBase, setTabLoading, setTabResult, setTabError]
  );

  const fetchJsonData = useCallback(
    async (key, jsonUrl) => {
      setTabLoading(key);
      try {
        const res = await fetch(
          `${apiBase}/json-data?url=${encodeURIComponent(jsonUrl)}`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || body.detail || `HTTP ${res.status}`);
        }
        setTabResult(key, await res.json());
      } catch (e) {
        setTabError(key, e.message);
      }
    },
    [apiBase, setTabLoading, setTabResult, setTabError]
  );

  const fetchTab = useCallback(
    (tab) => {
      if (tab.jsonUrl) fetchJsonData(tab.key, tab.jsonUrl);
      else fetchSheetData(tab.key, tab.spreadsheetId, tab.sheetName);
    },
    [fetchJsonData, fetchSheetData]
  );


  // Lazy-load active tab once per modal open session
  useEffect(() => {
    if (!show) return;
    const tab = tabs.find((t) => t.key === activeTab);
    if (!tab || loadedTabsRef.current.has(tab.key)) return;
    loadedTabsRef.current.add(tab.key);
    fetchTab(tab);
  }, [show, activeTab, tabs, fetchTab]);

  const handleExport = useCallback(async (format) => {
    setXlsxLoading(true);
    try {
      const res = await fetch(`${apiBase}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spreadsheetId: currentTab?.spreadsheetId,
          sheetName: currentTab?.sheetName,
          jsonUrl: currentTab?.jsonUrl,
          format,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || `Ошибка ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${currentTab?.sheetName ?? activeTab}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Ошибка экспорта: ${e.message}`);
    } finally {
      setXlsxLoading(false);
    }
  }, [currentTab, activeTab, apiBase]);

  const handleClose = useCallback(() => {
    setShow(false);
    setTabsState({});
    setViewModes({});
    setShowSearch(false);
    setXlsxLoading(false);
    setDlOpen(false);
    loadedTabsRef.current.clear();
    setActiveTab(tabs[0]?.key ?? "");
  }, [tabs]);

  const handleRefresh = useCallback(
    (tab) => {
      try {
        localStorage.removeItem(`table_${tab.key}_row_heights`);
        localStorage.removeItem(`table_${tab.key}_column_widths`);
      } catch {
        /* ignore */
      }
      loadedTabsRef.current.delete(tab.key);
      fetchTab(tab);
    },
    [fetchTab]
  );

  const {
    headers = [],
    data = [],
    columnWidths = [],
    rowHeights = {},
    loading = false,
    error = null,
  } = tabsState[activeTab] ?? {};

  return (
    <>
      {!manual && (
        <Button variant={buttonVariant} onClick={() => setShow(true)}>
          {label}
        </Button>
      )}

      <Modal
        show={show}
        onHide={handleClose}
        size="xl"
        fullscreen="lg-down"
        centered
        container={portalContainer ?? document.body}
      >
        <Modal.Header closeButton>
          <Modal.Title className="flex-grow-1">{title}</Modal.Title>

          {viewMode === "table" && (
            <button
              type="button"
              className={`btn me-2 ${
                showSearch ? "text-primary" : "text-dark"
              }`}
              onClick={() => setShowSearch((v) => !v)}
              disabled={loading}
              title="Поиск"
              style={{
                outline: "none",
                border: "none",
                opacity: loading ? 0.5 : 1,
              }}
            >
              <i className="bi bi-search" />
            </button>
          )}

          {viewMode === "table" && (
            <button
              type="button"
              className="btn me-2"
              onClick={() => currentTab && handleRefresh(currentTab)}
              disabled={loading}
              title="Обновить данные"
              style={{
                outline: "none",
                border: "none",
                opacity: loading ? 0.5 : 1,
              }}
            >
              <i className="bi bi-arrow-repeat text-dark" />
            </button>
          )}
        </Modal.Header>

        <Modal.Body
          style={{
            padding: 0,
            height: "80vh",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Tab bar — only shown when there are multiple tabs */}
          {tabs.length > 1 && (
            <div
              style={{
                display: "flex",
                borderBottom: "1px solid #dee2e6",
                background: "#f8f9fa",
                flexShrink: 0,
                overflowX: "auto",
                scrollbarWidth: "none",
                msOverflowStyle: "none",
              }}
            >
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    padding: "12px 20px",
                    border: "none",
                    background: activeTab === tab.key ? "#fff" : "transparent",
                    borderBottom:
                      activeTab === tab.key
                        ? "2px solid #0d6efd"
                        : "2px solid transparent",
                    color: activeTab === tab.key ? "#0d6efd" : "#6c757d",
                    fontWeight: activeTab === tab.key ? "500" : "normal",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {/* Disclaimer */}
          {noticeText && (
            <div
              style={{
                padding: "5px 12px",
                background: "#fff5f5",
                borderBottom: "1px solid #f5c6cb",
                flexShrink: 0,
                fontSize: "0.78rem",
                color: "#c0392b",
                textAlign: "center",
              }}
            >
              {noticeText}
            </div>
          )}

          {/* View toggle — only for JSON tabs, sits below the tab bar */}
          {isJsonTab && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 12px",
                borderBottom: "1px solid #dee2e6",
                background: "#f8f9fa",
                flexShrink: 0,
              }}
            >
              <div className="btn-group btn-group-sm" role="group">
                <button
                  type="button"
                  className={`btn btn-sm ${
                    viewMode === "table"
                      ? "btn-secondary"
                      : "btn-outline-secondary"
                  }`}
                  onClick={() => setViewMode("table")}
                >
                  <i className="bi bi-table me-1" />
                  Таблица
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${
                    viewMode === "code"
                      ? "btn-secondary"
                      : "btn-outline-secondary"
                  }`}
                  onClick={() => setViewMode("code")}
                >
                  <i className="bi bi-code-slash me-1" />
                  JSON
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="d-flex flex-column justify-content-center align-items-center flex-grow-1 gap-3 text-danger">
              <div>
                <strong>Ошибка:</strong> {error}
              </div>
              <button
                className="btn btn-outline-danger btn-sm"
                onClick={() => currentTab && handleRefresh(currentTab)}
              >
                Повторить
              </button>
            </div>
          )}

          {!error && (loading || headers.length > 0) && (
            <>
              {isJsonTab && viewMode === "code" ? (
                <JsonCodeViewer headers={headers} data={data} loading={loading} />
              ) : (
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <VirtualizedTable
                    data={data}
                    headers={headers}
                    height="100%"
                    tableName={activeTab}
                    initialColWidths={columnWidths.length ? columnWidths : null}
                    initialRowHeights={
                      Object.keys(rowHeights).length > 0 ? rowHeights : null
                    }
                    showSearch={showSearch}
                    loading={loading}
                  />
                </div>
              )}
            </>
          )}

          {!loading && !error && headers.length === 0 && (
            <div className="d-flex justify-content-center align-items-center flex-grow-1 text-muted">
              Нет данных для отображения
            </div>
          )}

          {currentTab?.dataDescription && (
            <div
              style={{
                padding: "6px 14px",
                background: "#f8f9fa",
                borderTop: "1px solid #dee2e6",
                flexShrink: 0,
                fontSize: "0.78rem",
                color: "#6c757d",
              }}
            >
              {currentTab.dataDescription}
            </div>
          )}
        </Modal.Body>

        <Modal.Footer>
          {headers.length > 0 && !error && (
            <div ref={dlRef} style={{ position: "relative" }} className="me-auto">
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm dropdown-toggle"
                onClick={() => setDlOpen((v) => !v)}
                disabled={xlsxLoading}
              >
                {xlsxLoading
                  ? <Spinner animation="border" size="sm" className="me-1" />
                  : <i className="bi bi-download me-1" />}
                Скачать
              </button>
              {dlOpen && (
                <ul
                  className="dropdown-menu show"
                  style={{ position: "absolute", bottom: "100%", left: 0, zIndex: 1050, marginBottom: "2px" }}
                >
                  <li>
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => { setDlOpen(false); handleExport("csv"); }}
                    >
                      <i className="bi bi-filetype-csv me-2" />CSV
                    </button>
                  </li>
                  {!currentTab?.jsonUrl && (
                    <li>
                      <button
                        type="button"
                        className="dropdown-item"
                        disabled={xlsxLoading}
                        onClick={() => { setDlOpen(false); handleExport("xlsx"); }}
                      >
                        <i className="bi bi-file-earmark-excel me-2" />XLSX
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
          <Button variant="secondary" onClick={handleClose}>
            Закрыть
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}

export default TableWidget;