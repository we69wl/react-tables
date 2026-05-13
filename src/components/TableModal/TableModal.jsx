import { Modal, Button, Spinner } from "react-bootstrap";

const LIMIT = 200;
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import VirtualizedTable from "../VirtualizedTable/VirtualizedTable";
import JsonCodeViewer from "../JsonCodeViewer/JsonCodeViewer";

// Override via VITE_API_URL in .env for non-local deployments
const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001/api";

const DEFAULT_NOTICE = "Данный файл является лишь демонстрационным вариантом. Часть данных может быть урезана для сохранения конфиденциальности Заказчика.";

function TableModal({
  show,
  onHide,
  title,
  type = "iframe",
  tablesData,
  initialTabs,
  noticeText = DEFAULT_NOTICE,
}) {
  const tabs = useMemo(() => initialTabs ?? [], [initialTabs]);

  const [activeModalTab, setActiveModalTab] = useState(tabs[0]?.key ?? "");
  const [loadingModal, setLoadingModal] = useState({});

  // Per-tab data: { [key]: { headers, data, columnWidths, rowHeights, loading, error } }
  const [tabsState, setTabsState] = useState({});

  // Tracks which tabs have already been fetched in this open session
  const loadedTabsRef = useRef(new Set());

  const [showSearch, setShowSearch] = useState(false);

  // "table" | "code" per tab — only relevant for tabs with jsonUrl
  const [viewModes, setViewModes] = useState({});

  const currentTab = useMemo(
    () => tabs.find((t) => t.key === activeModalTab),
    [tabs, activeModalTab]
  );
  const isJsonTab = !!currentTab?.jsonUrl;
  const viewMode = viewModes[activeModalTab] ?? (isJsonTab ? "code" : "table");

  const setViewMode = useCallback(
    (mode) => {
      setViewModes((prev) => ({ ...prev, [activeModalTab]: mode }));
    },
    [activeModalTab]
  );

  const setTabLoading = useCallback((tabKey) => {
    setTabsState((prev) => ({
      ...prev,
      [tabKey]: {
        headers: [],
        data: [],
        columnWidths: [],
        rowHeights: {},
        total: null,
        loading: true,
        loadingMore: false,
        error: null,
      },
    }));
  }, []);

  const setTabLoadingMore = useCallback((tabKey) => {
    setTabsState((prev) => ({
      ...prev,
      [tabKey]: { ...(prev[tabKey] ?? {}), loadingMore: true },
    }));
  }, []);

  const setTabResult = useCallback((tabKey, json) => {
    setTabsState((prev) => ({
      ...prev,
      [tabKey]: {
        headers: json.headers ?? [],
        data: json.data ?? [],
        columnWidths: json.columnWidths ?? [],
        rowHeights: json.rowHeights ?? {},
        total: json.total ?? null,
        loading: false,
        loadingMore: false,
        error: null,
      },
    }));
  }, []);

  const setTabAppendResult = useCallback((tabKey, json) => {
    setTabsState((prev) => {
      const existing = prev[tabKey] ?? {};
      return {
        ...prev,
        [tabKey]: {
          ...existing,
          data: [...(existing.data ?? []), ...(json.data ?? [])],
          total: json.total ?? existing.total ?? null,
          loading: false,
          loadingMore: false,
          error: null,
        },
      };
    });
  }, []);

  const setTabError = useCallback((tabKey, message, append = false) => {
    setTabsState((prev) => ({
      ...prev,
      [tabKey]: append
        ? { ...(prev[tabKey] ?? {}), loading: false, loadingMore: false, error: message }
        : {
            headers: [],
            data: [],
            columnWidths: [],
            rowHeights: {},
            total: null,
            loading: false,
            loadingMore: false,
            error: message,
          },
    }));
  }, []);

  // Fetch sheet data from the Express server
  const fetchSheetData = useCallback(
    async (tabKey, spreadsheetId, sheetName, offset = 0) => {
      if (offset === 0) setTabLoading(tabKey);
      else setTabLoadingMore(tabKey);
      try {
        const res = await fetch(
          `${API_BASE}/sheet-data?spreadsheetId=${encodeURIComponent(spreadsheetId)}&sheetName=${encodeURIComponent(sheetName)}&offset=${offset}&limit=${LIMIT}`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const json = await res.json();
        if (offset === 0) setTabResult(tabKey, json);
        else setTabAppendResult(tabKey, json);
      } catch (e) {
        setTabError(tabKey, e.message, offset > 0);
      }
    },
    [setTabLoading, setTabLoadingMore, setTabResult, setTabAppendResult, setTabError]
  );

  // Fetch JSON file data from the Express server
  const fetchJsonData = useCallback(
    async (tabKey, jsonUrl) => {
      setTabLoading(tabKey);
      try {
        const res = await fetch(
          `${API_BASE}/json-data?url=${encodeURIComponent(jsonUrl)}`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        setTabResult(tabKey, await res.json());
      } catch (e) {
        setTabError(tabKey, e.message);
      }
    },
    [setTabLoading, setTabResult, setTabError]
  );

  const fetchTab = useCallback(
    (tab) => {
      if (tab.jsonUrl) {
        fetchJsonData(tab.key, tab.jsonUrl);
      } else {
        fetchSheetData(tab.key, tab.spreadsheetId, tab.sheetName);
      }
    },
    [fetchJsonData, fetchSheetData]
  );

  // Lazy-load: fetch active tab once per modal open session
  useEffect(() => {
    if (!show || type !== "custom") return;
    const tab = tabs.find((t) => t.key === activeModalTab);
    if (!tab) return;
    if (!loadedTabsRef.current.has(tab.key)) {
      loadedTabsRef.current.add(tab.key);
      fetchTab(tab);
    }
  }, [show, type, activeModalTab, tabs, fetchTab]);

  // Reset state on close; initialize iframe spinners on open
  useEffect(() => {
    if (show) {
      if (type === "iframe" && tablesData) {
        setLoadingModal(
          Object.fromEntries(Object.keys(tablesData).map((k) => [k, true]))
        );
      }
    } else {
      setTabsState({});
      setLoadingModal({});
      setViewModes({});
      loadedTabsRef.current.clear();
      setActiveModalTab(tabs[0]?.key ?? "");
    }
  }, [show, tabs, type, tablesData]);

  // Force re-fetch (bypasses the "already loaded" guard)
  // Also clears localStorage row heights so fresh server heights are applied
  const handleRefresh = useCallback(
    (tab, tableName) => {
      try {
        localStorage.removeItem(`table_${tableName}_row_heights`);
        localStorage.removeItem(`table_${tableName}_column_widths`);
      } catch {
        /* ignore */
      }

      loadedTabsRef.current.delete(tab.key);
      fetchTab(tab);
    },
    [fetchTab]
  );

  const handleModalLoad = useCallback((tabKey) => {
    setLoadingModal((prev) => ({ ...prev, [tabKey]: false }));
  }, []);

  const handleLoadMore = useCallback(() => {
    if (!currentTab || currentTab.jsonUrl) return;
    const currentData = tabsState[currentTab.key]?.data ?? [];
    fetchSheetData(currentTab.key, currentTab.spreadsheetId, currentTab.sheetName, currentData.length);
  }, [currentTab, tabsState, fetchSheetData]);

  // ── Iframe rendering (unchanged) ─────────────────────────────────────────
  const renderIframe = () => (
    <>
      <div className="d-flex border-bottom bg-light p-2">
        <button
          className={`btn flex-fill ${
            activeModalTab === "monitoring"
              ? "btn-primary"
              : "btn-outline-secondary"
          }`}
          onClick={() => setActiveModalTab("monitoring")}
        >
          📈 Мониторинг цен
        </button>
        <button
          className={`btn flex-fill ${
            activeModalTab === "analytics"
              ? "btn-primary"
              : "btn-outline-secondary"
          }`}
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
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
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
              style={{
                border: "none",
                display: loadingModal[key] ? "none" : "block",
              }}
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
    const {
      headers = [],
      data = [],
      columnWidths = [],
      rowHeights = {},
      total = null,
      loading = false,
      loadingMore = false,
      error = null,
    } = tabState;

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
            overflowX: "auto",
            scrollbarWidth: "none",
            msOverflowStyle: "none",
          }}
          className="hide-scrollbar"
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveModalTab(tab.key)}
              style={{
                padding: "12px 20px",
                border: "none",
                background: activeModalTab === tab.key ? "#fff" : "transparent",
                borderBottom:
                  activeModalTab === tab.key ? "2px solid #0d6efd" : "none",
                color: activeModalTab === tab.key ? "#0d6efd" : "#6c757d",
                fontWeight: activeModalTab === tab.key ? "500" : "normal",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

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

        {/* Error */}
        {error && (
          <div className="d-flex flex-column justify-content-center align-items-center flex-grow-1 gap-3 text-danger">
            <div>
              <strong>Ошибка:</strong> {error}
            </div>
            <button
              className="btn btn-outline-danger btn-sm"
              onClick={() =>
                currentTab && handleRefresh(currentTab, activeModalTab)
              }
            >
              Повторить
            </button>
          </div>
        )}

        {/* Data view — table or raw JSON code */}
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
                  tableName={activeModalTab}
                  initialColWidths={columnWidths.length ? columnWidths : null}
                  initialRowHeights={
                    Object.keys(rowHeights).length > 0 ? rowHeights : null
                  }
                  showSearch={showSearch}
                  loading={loading}
                  total={total}
                  onLoadMore={handleLoadMore}
                  loadingMore={loadingMore}
                />
              </div>
            )}
          </>
        )}

        {/* Empty state */}
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
      </>
    );
  };

  return (
    <Modal show={show} onHide={onHide} size="xl" fullscreen="lg-down" centered>
      <Modal.Header closeButton>
        <Modal.Title className="flex-grow-1">{title}</Modal.Title>
        {type === "custom" && viewMode === "table" && (
          <button
            type="button"
            className={`btn me-2 ${showSearch ? "text-primary" : "text-dark"}`}
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
            <i className="bi bi-search" />
          </button>
        )}
        {type === "custom" && viewMode === "table" && (
          <button
            type="button"
            className="btn me-2"
            onClick={() => {
              if (currentTab) handleRefresh(currentTab, activeModalTab);
            }}
            disabled={tabsState[activeModalTab]?.loading}
            title="Обновить данные (высоты строк и ширина колонок сбросятся к исходным)"
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
        style={{
          padding: 0,
          height: "80vh",
          display: "flex",
          flexDirection: "column",
        }}
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
            onClick={() =>
              window.open(tablesData[activeModalTab].url, "_blank")
            }
          >
            Открыть в новой вкладке
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}

export default TableModal;