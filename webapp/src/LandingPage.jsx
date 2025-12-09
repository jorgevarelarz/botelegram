import React, { useEffect } from 'react';
import './LandingPage.css';

const LandingPage = () => {
  const envUsername = (import.meta.env.VITE_BOT_USERNAME || '').replace('@', '');
  const envUrl = import.meta.env.VITE_BOT_URL || (envUsername ? `https://t.me/${envUsername}` : '');
  const botUrl = envUrl || 'https://t.me/';
  const ctaLabel = envUsername ? `Abrir @${envUsername}` : 'Abrir el bot en Telegram';

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      if (tg.themeParams?.bg_color) {
        document.body.style.backgroundColor = tg.themeParams.bg_color;
      }
    }
  }, []);

  return (
    <div className="landing-container">
      <header className="landing-header">
        <h1>Safe Pay Bot</h1>
        <p>Pagos custodiados y chat anónimo sin salir de Telegram.</p>
      </header>

      <main className="landing-main">
        <section className="hero">
          <p className="tag">Web App para Telegram</p>
          <h2>Transacciones seguras, sin complicaciones.</h2>
          <p>
            Bloqueamos el saldo del cliente y solo se libera a la creadora cuando el trabajo está completado y confirmado.
            Tranquilidad para todos, con seguimiento en tiempo real.
          </p>
          <a href={botUrl} className="cta-button" target="_blank" rel="noopener noreferrer">
            {ctaLabel}
          </a>
          <p className="hint">Ábrelo desde Telegram para disfrutar de la experiencia completa.</p>
        </section>

        <section className="features">
          <h3>Características Principales</h3>
          <div className="feature-cards">
            <div className="card">
              <div className="pill">Custodia</div>
              <h4>Pagos Seguros</h4>
              <p>El dinero queda retenido de forma segura hasta que el pedido se completa. Sin sorpresas.</p>
            </div>
            <div className="card">
              <div className="pill">Privacidad</div>
              <h4>Chat Anónimo</h4>
              <p>Comunícate con la otra parte sin revelar tu identidad de Telegram.</p>
            </div>
            <div className="card">
              <div className="pill">Automatización</div>
              <h4>Gestión Fácil</h4>
              <p>Un bot intuitivo para gestionar pedidos y servicios sin salir de Telegram.</p>
            </div>
          </div>
        </section>

        <section className="how-it-works">
          <h3>¿Cómo Funciona?</h3>
          <div className="steps">
            <div className="step">
              <span>1</span>
              <p>El cliente elige un servicio y el bot retiene el pago con comisión incluida.</p>
            </div>
            <div className="step">
              <span>2</span>
              <p>La creadora acepta el pedido y entrega el servicio dentro del chat anónimo.</p>
            </div>
            <div className="step">
              <span>3</span>
              <p>El cliente confirma y el bot libera el pago a la creadora.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <p>&copy; {new Date().getFullYear()} Safe Pay Bot. Todos los derechos reservados.</p>
      </footer>
    </div>
  );
};

export default LandingPage;
