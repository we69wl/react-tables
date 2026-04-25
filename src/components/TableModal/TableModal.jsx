import { Modal, Button, Spinner } from "react-bootstrap";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import VirtualizedTable from "../VirtualizedTable/VirtualizedTable";

// Override via VITE_API_URL in .env for non-local deployments
const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

function TableModal({ show, onHide, title, type = "iframe", tablesData, initialTabs }) {
  const tabs = useMemo(() => initialTabs ?? [], [initialTabs]);

  const [activeModalTab, setActiveModalTab] = useState(tabs[0]?.key ?? "");
  const [loadingModal, setLoadingModal] = useState({});

  // Per-tab data: { [key]: { headers, data, columnWidths, loading, error } }
  const [tabsState, setTabsState] = useState({});

  // Tracks which tabs have already been fetched in this open session
  const loadedTabsRef = useRef(new Set());

  const [showSearch, setShowSearch] = useState(false);

  // Fetch sheet data from the Express server
  const fetchSheetData = useCallback(async (tabKey, spreadsheetId, sheetName) => {
    setTabsState((prev) => ({
      ...prev,
      [tabKey]: { headers: [], data: [], columnWidths: [], loading: true, error: null },
    }));
    try {
      const res = await fetch(
        `${API_BASE}/api/sheet-data?spreadsheetId=${encodeURIComponent(spreadsheetId)}&sheetName=${encodeURIComponent(sheetName)}`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setTabsState((prev) => ({
        ...prev,
        [tabKey]: {
          headers: json.headers ?? [],
          data: json.data ?? [],
          columnWidths: json.columnWidths ?? [],
          loading: false,
          error: null,
        },
      }));
    } catch (e) {
      setTabsState((prev) => ({
        ...prev,
        [tabKey]: { headers: [], data: [], columnWidths: [], loading: false, error: e.message },
      }));
    }
  }, []);

  // Lazy-load: fetch active tab once per modal open session
  useEffect(() => {
    if (!show || type !== "custom") return;
    const tab = tabs.find((t) => t.key === activeModalTab);
    if (!tab) return;
    if (!loadedTabsRef.current.has(tab.key)) {
      loadedTabsRef.current.add(tab.key);
      fetchSheetData(tab.key, tab.spreadsheetId, tab.sheetName);
    }
  }, [show, type, activeModalTab, tabs, fetchSheetData]);

  // Reset all state when modal closes
  useEffect(() => {
    if (!show) {
      setTabsState({});
      loadedTabsRef.current.clear();
      setActiveModalTab(tabs[0]?.key ?? "");
    }
  }, [show, tabs]);

  // Force re-fetch (bypasses the "already loaded" guard)
  const handleRefresh = useCallback(
    (tab) => {
      loadedTabsRef.current.delete(tab.key);
      fetchSheetData(tab.key, tab.spreadsheetId, tab.sheetName);
    },
    [fetchSheetData]
  );

  const handleModalLoad = useCallback((tabKey) => {
    setLoadingModal((prev) => ({ ...prev, [tabKey]: false }));
  }, []);

  // ── Iframe rendering (unchanged) ─────────────────────────────────────────
  const renderIframe = () => (
    <>
      <div className="d-flex border-bottom bg-light p-2">
        <button
          className={`btn flex-fill ${activeModalTab === "monitoring" ? "btn-primary" : "btn-outline-secondary"}`}
          onClick={() => setActiveModalTab("monitoring")}
        >
          📈 Мониторинг цен
        </button>
        <button
          className={`btn flex-fill ${activeModalTab === "analytics" ? "btn-primary" : "btn-outline-secondary"}`}
          onClick={() => setActiveModalTab("analytics")}
        >
          🔍 Анализ конкурентов
        </button>
      </div>
      <div style={{ flex: 1, position: "relative", minHeight: "400px" }}>
        {Object.entries(tablesData).map(([key, table]) => (
          <div
            key={key}
            style={{
              position: "absolute",
              top: 0, left: 0, right: 0, bottom: 0,
              display: activeModalTab === key ? "block" : "none",
            }}
          >
            {loadingModal[key] && (
              <div className="d-flex justify-content-center align-items-center h-100 bg-light">
                <Spinner animation="border" variant="primary" />
                <span className="ms-2">Загрузка таблицы...</span>
              </div>
            )}
            <iframe
              src={table.url}
              title={table.title}
              width="100%"
              height="100%"
              style={{ border: "none", display: loadingModal[key] ? "none" : "block" }}
              onLoad={() => handleModalLoad(key)}
              allowFullScreen
            />
          </div>
        ))}
      </div>
    </>
  );

  // ── Custom table rendering (server-fetched data) ──────────────────────────
  const renderCustomTable = () => {
    const tabState = tabsState[activeModalTab] ?? {};
    const { headers = [], data = [], columnWidths = [], loading = false, error = null } = tabState;
    const currentTab = tabs.find((t) => t.key === activeModalTab);

    return (
      <>
        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid #dee2e6",
            background: "#f8f9fa",
            padding: "0 20px",
            flexShrink: 0,
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveModalTab(tab.key)}
              style={{
                padding: "12px 20px",
                border: "none",
                background: activeModalTab === tab.key ? "#fff" : "transparent",
                borderBottom: activeModalTab === tab.key ? "2px solid #0d6efd" : "none",
                color: activeModalTab === tab.key ? "#0d6efd" : "#6c757d",
                fontWeight: activeModalTab === tab.key ? "500" : "normal",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Loading */}
        {loading && (
          <div className="d-flex justify-content-center align-items-center flex-grow-1">
            <Spinner animation="border" variant="primary" />
            <span className="ms-2">Загрузка данных...</span>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
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

        {/* Table — pass server column widths as initial widths */}
        {!loading && !error && headers.length > 0 && (
          <div style={{ flex: 1, overflow: "hidden" }}>
            <VirtualizedTable
              data={data}
              headers={headers}
              height="100%"
              tableName={activeModalTab}
              initialColWidths={columnWidths.length ? columnWidths : null}
              sheetName={currentTab?.sheetName}
              showSearch={showSearch}
            />
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && headers.length === 0 && (
          <div className="d-flex justify-content-center align-items-center flex-grow-1 text-muted">
            Нет данных для отображения
          </div>
        )}
      </>
    );
  };

  return (
    <Modal show={show} onHide={onHide} size="xl" fullscreen="lg-down" centered>
      <Modal.Header closeButton>
        <Modal.Title className="flex-grow-1">{title}</Modal.Title>
        {type === "custom" && (
          <button
            type="button"
            className="btn me-2"
            onClick={() => {
              setShowSearch(!showSearch);
            }}
            disabled={tabsState[activeModalTab]?.loading}
            title="Отобразить панель поиска"
            aria-label="Поиск"
            style={{
              opacity: tabsState[activeModalTab]?.loading ? 0.5 : 1,
              outline: "none",
              border: "none",
            }}
          >
            <i className="bi bi-search text-dark" />
          </button>
        )}
        {type === "custom" && (
          <button
            type="button"
            className="btn me-2"
            onClick={() => {
              const tab = tabs.find((t) => t.key === activeModalTab);
              if (tab) handleRefresh(tab);
            }}
            disabled={tabsState[activeModalTab]?.loading}
            title="Обновить данные"
            aria-label="Обновить"
            style={{
              opacity: tabsState[activeModalTab]?.loading ? 0.5 : 1,
              outline: "none",
              border: "none",
            }}
          >
            <i className="bi bi-arrow-repeat text-dark" />
          </button>
        )}
      </Modal.Header>
      <Modal.Body
        style={{ padding: 0, height: "80vh", display: "flex", flexDirection: "column" }}
      >
        {type === "iframe" ? renderIframe() : renderCustomTable()}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide}>
          Закрыть
        </Button>
        {type === "iframe" && tablesData[activeModalTab] && (
          <Button
            variant="primary"
            onClick={() => window.open(tablesData[activeModalTab].url, "_blank")}
          >
            Открыть в новой вкладке
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}

export default TableModal;
