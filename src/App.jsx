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
  
  // Состояние загрузки для iframe в модалке
  const [loadingModal, setLoadingModal] = useState(true);

  // Ссылки на Google таблицы
  const tables = {
    monitoring: {
      title: 'Мониторинг цен',
      url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTtUkLDhq_C83DBNdZrJouNv4kvOSMGBdBPrvlcrGJqh-WAyeVycMGbDKhdbJ7uxLnSVTu1ogO8NvL3/pubhtml?widget=false&amp;headers=false'
    },
    analytics: {
      title: 'Анализ конкурентов',
      url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSh4juL254OaBTBuinUJ6wxm0c2YaQbnu_aCCR46qttolPH1y9-YCq9Ic-XoE1ZNxiDVXTjsX9LhLor/pubhtml?widget=false&amp;headers=false'
    }
  };

  // Обработчик загрузки iframe на странице
  const handleTabLoad = (tabKey) => {
    setLoadingTab(prev => ({ ...prev, [tabKey]: false }));
  };

  // Обработчик загрузки iframe в модалке
  const handleModalLoad = () => {
    setLoadingModal(false);
  };

  // Открытие модального окна
  const handleShowModal = (tabKey) => {
    setActiveModalTab(tabKey);
    setLoadingModal(true); // Сбрасываем лоадер при открытии
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setLoadingModal(true);
  };

  // Переключение вкладки в модалке
  const switchModalTab = (tabKey) => {
    setActiveModalTab(tabKey);
    setLoadingModal(true); // Показываем лоадер при переключении
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

      {/* МОДАЛЬНОЕ ОКНО С ЛИСТАЛКОЙ ТАБЛИЦ */}
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
          {/* Вкладки для переключения таблиц */}
          <div style={{ 
            display: 'flex', 
            borderBottom: '1px solid #dee2e6',
            background: '#f8f9fa',
            padding: '0 20px',
            flexShrink: 0
          }}>
            <button
              onClick={() => switchModalTab('monitoring')}
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
              onClick={() => switchModalTab('analytics')}
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
          
          {/* Iframe с лоадером */}
          <div style={{ flex: 1, position: 'relative' }}>
            {loadingModal && (
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
              key={activeModalTab}
              src={tables[activeModalTab].url}
              title={tables[activeModalTab].title}
              width="100%"
              height="100%"
              style={{ 
                border: 'none',
                display: loadingModal ? 'none' : 'block'
              }}
              onLoad={handleModalLoad}
              allowFullScreen
            />
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