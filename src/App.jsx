import 'bootstrap/dist/css/bootstrap.min.css';
import './App.css'

import { useState } from 'react';
import { Container, Row, Col, Button, Modal, Tabs, Tab, Spinner } from 'react-bootstrap';

function App() {
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState('monitoring');
  const [activeModalTab, setActiveModalTab] = useState('monitoring');

  // Состояния загрузки для iframe на странице
  const [loadingTab, setLoadingTab] = useState({
    monitoring: true,
    analytics: true
  });

  // Состояния загрузки для iframe в модалке
  const [loadingModal, setLoadingModal] = useState({
    monitoring: true,
    analytics: true
  });

  // Базовые ID таблиц
  const sheetIds = {
    monitoring: '2PACX-1vTtUkLDhq_C83DBNdZrJouNv4kvOSMGBdBPrvlcrGJqh-WAyeVycMGbDKhdbJ7uxLnSVTu1ogO8NvL3',
    analytics: '2PACX-1vSh4juL254OaBTBuinUJ6wxm0c2YaQbnu_aCCR46qttolPH1y9-YCq9Ic-XoE1ZNxiDVXTjsX9LhLor'
  };

  // Параметры для всех таблиц (общие)
  const DEFAULT_PARAMS = {
    gid: '0',
    single: 'true',
    widget: 'false',
    chrome: 'false',
    headers: 'false'
  };

  // Функция построения чистого URL
  const buildSheetUrl = (sheetId, customParams = {}) => {
    const url = new URL(`https://docs.google.com/spreadsheets/d/e/${sheetId}/pubhtml`);
    const params = { ...DEFAULT_PARAMS, ...customParams };
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    return url.toString();
  };

  // Готовые URL для таблиц
  const tables = {
    monitoring: {
      title: 'Мониторинг цен',
      url: buildSheetUrl(sheetIds.monitoring)
    },
    analytics: {
      title: 'Анализ конкурентов',
      url: buildSheetUrl(sheetIds.analytics)
    }
  };

  // Обработчик загрузки iframe на странице
  const handleTabLoad = (tabKey) => {
    setLoadingTab(prev => ({ ...prev, [tabKey]: false }));
  };

  // Обработчик загрузки iframe в модалке
  const handleModalLoad = (tabKey) => {
    setLoadingModal(prev => ({ ...prev, [tabKey]: false }));
  };

  // Открытие модального окна
  const handleShowModal = (tabKey) => {
    setActiveModalTab(tabKey);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
  };

  return (
    <>
      <Container className="mt-5">
        <Row>
          <Col>
            <h2>📊 Таблицы аналитики</h2>
            <p className="text-muted">Выберите таблицу для просмотра</p>
          </Col>
        </Row>

        {/* ТАБЫ НА СТРАНИЦЕ */}
        <Tabs
          activeKey={activeTab}
          onSelect={(k) => setActiveTab(k)}
          className="mb-3"
          fill
        >
          <Tab eventKey="monitoring" title="📈 Мониторинг цен">
            <div className="p-3 border rounded bg-light">
              <div className="d-flex justify-content-between align-items-center mb-3">
                <h4>Мониторинг цен</h4>
                <Button 
                  variant="outline-primary" 
                  size="sm"
                  onClick={() => handleShowModal('monitoring')}
                >
                  🔍 Открыть в полном окне (с листалкой)
                </Button>
              </div>
              <div style={{ position: 'relative', minHeight: '500px' }}>
                {loadingTab.monitoring && (
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    background: '#f8f9fa',
                    borderRadius: '8px',
                    zIndex: 1
                  }}>
                    <Spinner animation="border" variant="primary" />
                    <span className="ms-2">Загрузка таблицы...</span>
                  </div>
                )}
                <iframe
                  src={tables.monitoring.url}
                  title="Мониторинг цен"
                  width="100%"
                  height="500"
                  style={{ 
                    border: '1px solid #dee2e6', 
                    borderRadius: '8px',
                    display: loadingTab.monitoring ? 'none' : 'block'
                  }}
                  onLoad={() => handleTabLoad('monitoring')}
                  allowFullScreen
                />
              </div>
            </div>
          </Tab>
          
          <Tab eventKey="analytics" title="🔍 Анализ конкурентов">
            <div className="p-3 border rounded bg-light">
              <div className="d-flex justify-content-between align-items-center mb-3">
                <h4>Анализ конкурентов</h4>
                <Button 
                  variant="outline-primary" 
                  size="sm"
                  onClick={() => handleShowModal('analytics')}
                >
                  🔍 Открыть в полном окне (с листалкой)
                </Button>
              </div>
              <div style={{ position: 'relative', minHeight: '500px' }}>
                {loadingTab.analytics && (
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    background: '#f8f9fa',
                    borderRadius: '8px',
                    zIndex: 1
                  }}>
                    <Spinner animation="border" variant="primary" />
                    <span className="ms-2">Загрузка таблицы...</span>
                  </div>
                )}
                <iframe
                  src={tables.analytics.url}
                  title="Анализ конкурентов"
                  width="100%"
                  height="500"
                  style={{ 
                    border: '1px solid #dee2e6', 
                    borderRadius: '8px',
                    display: loadingTab.analytics ? 'none' : 'block'
                  }}
                  onLoad={() => handleTabLoad('analytics')}
                  allowFullScreen
                />
              </div>
            </div>
          </Tab>
        </Tabs>

        {/* Дополнительная кнопка */}
        <Row className="mt-4">
          <Col>
            <Button variant="primary" onClick={() => handleShowModal('monitoring')}>
              📊 Открыть модальное окно (можно листать таблицы)
            </Button>
          </Col>
        </Row>
      </Container>

      {/* МОДАЛЬНОЕ ОКНО — ОБА IFRAME ЗАГРУЖАЮТСЯ ОДИН РАЗ */}
      <Modal 
        show={showModal} 
        onHide={handleCloseModal}
        size="xl"
        fullscreen="lg-down"
        centered
      >
        <Modal.Header closeButton>
          <Modal.Title>📊 Предпросмотр таблицы — переключайте вкладки</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ padding: 0, height: '80vh', display: 'flex', flexDirection: 'column' }}>
          {/* Вкладки */}
          <div style={{ 
            display: 'flex', 
            borderBottom: '1px solid #dee2e6',
            background: '#f8f9fa',
            padding: '0 20px',
            flexShrink: 0
          }}>
            <button
              onClick={() => setActiveModalTab('monitoring')}
              style={{
                padding: '12px 20px',
                border: 'none',
                background: activeModalTab === 'monitoring' ? '#fff' : 'transparent',
                borderBottom: activeModalTab === 'monitoring' ? '2px solid #0d6efd' : 'none',
                color: activeModalTab === 'monitoring' ? '#0d6efd' : '#6c757d',
                fontWeight: activeModalTab === 'monitoring' ? '500' : 'normal',
                cursor: 'pointer'
              }}
            >
              📈 Мониторинг цен
            </button>
            <button
              onClick={() => setActiveModalTab('analytics')}
              style={{
                padding: '12px 20px',
                border: 'none',
                background: activeModalTab === 'analytics' ? '#fff' : 'transparent',
                borderBottom: activeModalTab === 'analytics' ? '2px solid #0d6efd' : 'none',
                color: activeModalTab === 'analytics' ? '#0d6efd' : '#6c757d',
                fontWeight: activeModalTab === 'analytics' ? '500' : 'normal',
                cursor: 'pointer'
              }}
            >
              🔍 Анализ конкурентов
            </button>
          </div>
          
          {/* ОБА IFRAME ЗДЕСЬ, но виден только активный */}
          <div style={{ flex: 1, position: 'relative' }}>
            {/* Iframe Мониторинг цен */}
            <div style={{ 
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: activeModalTab === 'monitoring' ? 'block' : 'none'
            }}>
              {loadingModal.monitoring && (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  background: '#fff',
                  zIndex: 1
                }}>
                  <Spinner animation="border" variant="primary" />
                  <span className="ms-2">Загрузка таблицы...</span>
                </div>
              )}
              <iframe
                src={tables.monitoring.url}
                title="Мониторинг цен"
                width="100%"
                height="100%"
                style={{ 
                  border: 'none',
                  display: loadingModal.monitoring ? 'none' : 'block'
                }}
                onLoad={() => handleModalLoad('monitoring')}
                allowFullScreen
              />
            </div>

            {/* Iframe Анализ конкурентов */}
            <div style={{ 
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: activeModalTab === 'analytics' ? 'block' : 'none'
            }}>
              {loadingModal.analytics && (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  background: '#fff',
                  zIndex: 1
                }}>
                  <Spinner animation="border" variant="primary" />
                  <span className="ms-2">Загрузка таблицы...</span>
                </div>
              )}
              <iframe
                src={tables.analytics.url}
                title="Анализ конкурентов"
                width="100%"
                height="100%"
                style={{ 
                  border: 'none',
                  display: loadingModal.analytics ? 'none' : 'block'
                }}
                onLoad={() => handleModalLoad('analytics')}
                allowFullScreen
              />
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleCloseModal}>
            Закрыть
          </Button>
          <Button variant="primary" onClick={() => window.open(tables[activeModalTab].url, '_blank')}>
            Открыть в новой вкладке
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  )
}

export default App