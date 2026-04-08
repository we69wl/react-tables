import 'bootstrap/dist/css/bootstrap.min.css';
import './App.css'

import { useState } from 'react';
import { Container, Row, Col, Button, Modal, Tabs, Tab } from 'react-bootstrap';

function App() {
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState('monitoring');
  const [modalUrl, setModalUrl] = useState('');

  // Ссылки на Google таблицы (замените на свои)
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

  // Обработчик открытия модального окна с iframe
  const handleShowModal = (url, title) => {
    setModalUrl(url);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setModalUrl('');
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
        {/* Tabs с iframe */}
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
                  onClick={() => handleShowModal(tables.monitoring.url, 'Мониторинг цен')}
                >
                  🔍 Открыть в полном окне
                </Button>
              </div>
              <iframe
                src={tables.monitoring.url}
                title="Мониторинг цен"
                width="100%"
                height="500"
                style={{ border: '1px solid #dee2e6', borderRadius: '8px' }}
                allowFullScreen
              />
            </div>
          </Tab>
          
          <Tab eventKey="analytics" title="🔍 Анализ конкурентов">
            <div className="p-3 border rounded bg-light">
              <div className="d-flex justify-content-between align-items-center mb-3">
                <h4>Анализ конкурентов</h4>
                <Button 
                  variant="outline-primary" 
                  size="sm"
                  onClick={() => handleShowModal(tables.analytics.url, 'Анализ конкурентов')}
                >
                  🔍 Открыть в полном окне
                </Button>
              </div>
              <iframe
                src={tables.analytics.url}
                title="Анализ конкурентов"
                width="100%"
                height="500"
                style={{ border: '1px solid #dee2e6', borderRadius: '8px' }}
                allowFullScreen
              />
            </div>
          </Tab>
        </Tabs>

        {/* Кнопка предпросмотра (как у вас была) */}
        <Row className="mt-4">
          <Col>
            <Button variant="primary" onClick={() => handleShowModal(tables.monitoring.url, 'Предпросмотр таблицы')}>
              📊 Предпросмотр таблицы
            </Button>
          </Col>
        </Row>
      </Container>

      {/* Модальное окно с iframe */}
      <Modal 
        show={showModal} 
        onHide={handleCloseModal}
        size="xl"
        fullscreen="lg-down"
        centered
      >
        <Modal.Header closeButton>
          <Modal.Title>📊 Предпросмотр таблицы</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ padding: 0, height: '80vh' }}>
          <iframe
            src={modalUrl}
            title="Таблица предпросмотра"
            width="100%"
            height="100%"
            style={{ border: 'none' }}
            allowFullScreen
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleCloseModal}>
            Закрыть
          </Button>
          <Button variant="primary" onClick={() => window.open(modalUrl, '_blank')}>
            Открыть в новой вкладке
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  )
}

export default App