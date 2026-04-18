import { Modal, Button, Form, Spinner } from "react-bootstrap";
import { useState, useEffect, useCallback } from "react";
import VirtualizedTable from "../VirtualizedTable/VirtualizedTable";

// Импорт CSV файлов из папки assets
import monitoringCsv from "../../assets/csv/Ozon. Отслеживание пиратов - Выгрузка.csv?url";
import analyticsCsv from "../../assets/csv/Ozon. Цены - Ozon.csv?url";

function TableModal({ show, onHide, title, type = "iframe", tablesData }) {
  const [activeModalTab, setActiveModalTab] = useState("monitoring");
  const [loadingModal, setLoadingModal] = useState({
    monitoring: true,
    analytics: true,
  });
  const [csvData, setCsvData] = useState(null);
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [isLoadingCsv, setIsLoadingCsv] = useState(false);

  // Парсинг CSV
  const parseCSV = useCallback(async (url) => {
    setIsLoadingCsv(true);
    try {
      const response = await fetch(url);
      const text = await response.text();
      const lines = text.split("\n").filter((line) => line.trim());

      if (lines.length === 0) return;

      const headers = lines[0]
        .split(",")
        .map((h) => h.replace(/^"|"$/g, "").trim());
      const data = lines
        .slice(1)
        .filter((line) => line.trim())
        .map((line) => {
          const values = [];
          let inQuotes = false;
          let current = "";
          for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') inQuotes = !inQuotes;
            else if (char === "," && !inQuotes) {
              values.push(current.replace(/^"|"$/g, "").trim());
              current = "";
            } else current += char;
          }
          values.push(current.replace(/^"|"$/g, "").trim());
          return values;
        });

      setCsvHeaders(headers);
      setCsvData(data);
    } catch (error) {
      console.error("Ошибка загрузки CSV:", error);
    } finally {
      setIsLoadingCsv(false);
    }
  }, []);

  // Загрузка CSV при открытии модалки И переключении табов (контролируемый useEffect)
  useEffect(() => {
    if (show && type === "custom") {
      setLoadingModal({ monitoring: true, analytics: true });
      const csvUrl =
        activeModalTab === "monitoring" ? monitoringCsv : analyticsCsv;
      parseCSV(csvUrl);
    }
  }, [show, type, activeModalTab, parseCSV]);

  // Сброс данных при закрытии
  useEffect(() => {
    if (!show) {
      setCsvData(null);
      setCsvHeaders([]);
      setActiveModalTab("monitoring");
    }
  }, [show]);

  const handleModalLoad = useCallback((tabKey) => {
    setLoadingModal((prev) => ({ ...prev, [tabKey]: false }));
  }, []);

  // Рендер iframe версии
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

  // Рендер кастомной таблицы
  const renderCustomTable = () => (
    <>
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid #dee2e6",
          background: "#f8f9fa",
          padding: "0 20px",
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => setActiveModalTab("monitoring")}
          style={{
            padding: "12px 20px",
            border: "none",
            background:
              activeModalTab === "monitoring" ? "#fff" : "transparent",
            borderBottom:
              activeModalTab === "monitoring" ? "2px solid #0d6efd" : "none",
            color: activeModalTab === "monitoring" ? "#0d6efd" : "#6c757d",
            fontWeight: activeModalTab === "monitoring" ? "500" : "normal",
            cursor: "pointer",
          }}
        >
          Ozon. Отслеживание пиратов
        </button>
        <button
          onClick={() => setActiveModalTab("analytics")}
          style={{
            padding: "12px 20px",
            border: "none",
            background: activeModalTab === "analytics" ? "#fff" : "transparent",
            borderBottom:
              activeModalTab === "analytics" ? "2px solid #0d6efd" : "none",
            color: activeModalTab === "analytics" ? "#0d6efd" : "#6c757d",
            fontWeight: activeModalTab === "analytics" ? "500" : "normal",
            cursor: "pointer",
          }}
        >
          Ozon. Цены - Ozon
        </button>
      </div>

      {isLoadingCsv && (
        <div className="d-flex justify-content-center align-items-center flex-grow-1">
          <Spinner animation="border" variant="primary" />
          <span className="ms-2">Загрузка данных...</span>
        </div>
      )}

      {!isLoadingCsv && csvData && csvHeaders.length > 0 && (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <VirtualizedTable
            data={csvData} // ✅ СЫрые данные — пусть VirtualizedTable фильтрует!
            headers={csvHeaders}
            height="100%"
          />
        </div>
      )}

      {!isLoadingCsv && (!csvData || csvData.length === 0) && (
        <div className="d-flex justify-content-center align-items-center flex-grow-1 text-muted">
          Нет данных для отображения
        </div>
      )}
    </>
  );

  return (
    <Modal show={show} onHide={onHide} size="xl" fullscreen="lg-down" centered>
      <Modal.Header closeButton>
        <Modal.Title>{title}</Modal.Title>
      </Modal.Header>
      <Modal.Body
        style={{
          padding: 0,
          height: "80vh",
          display: "flex",
          flexDirection: "column"
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