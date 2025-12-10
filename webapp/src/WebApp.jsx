import React, { useEffect, useMemo, useState } from 'react';
import './App.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function formatEuros(cents) {
  if (cents === null || cents === undefined) return '-';
  return (cents / 100).toLocaleString('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  });
}

function WebApp() {
  const [initData, setInitData] = useState('');
  const [session, setSession] = useState({ state: 'loading' });
  const [creators, setCreators] = useState([]);
  const [orders, setOrders] = useState([]);
  const [selectedService, setSelectedService] = useState(null);
  const [orderNote, setOrderNote] = useState('');
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg?.initData) {
      setSession({ state: 'no-tg' });
      return;
    }
    tg.ready();
    tg.expand();
    setInitData(tg.initData);
    bootstrap(tg.initData);
  }, []);

  const userName = useMemo(() => {
    if (session?.user?.displayName) return session.user.displayName;
    if (session?.telegram?.firstName) return session.telegram.firstName;
    if (session?.telegram?.username) return `@${session.telegram.username}`;
    return 'Usuario';
  }, [session]);

  async function apiFetch(path, options = {}) {
    const initOverride = options.initDataOverride;
    const headers = {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': initOverride || initData,
      ...(options.headers || {}),
    };
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      const err = new Error(data?.error || 'Error de red');
      err.code = data?.error;
      throw err;
    }
    return data;
  }

  async function bootstrap(data) {
    try {
      setSession({ state: 'loading' });
      const sessionRes = await apiFetch('/api/session', {
        method: 'POST',
        body: JSON.stringify({ initData: data }),
        initDataOverride: data,
      });
      setSession({ state: 'ready', ...sessionRes });
      await Promise.all([loadCreators(), loadOrders()]);
    } catch (err) {
      setSession({ state: 'error', error: err.message });
    }
  }

  async function loadCreators() {
    const res = await apiFetch('/api/creators');
    setCreators(res.creators || []);
  }

  async function loadOrders() {
    setRefreshing(true);
    try {
      const res = await apiFetch('/api/orders');
      setOrders(res.orders || []);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleAcceptTerms() {
    try {
      await apiFetch('/api/terms/accept', { method: 'POST', body: JSON.stringify({ initData }) });
      setSession(prev => ({ ...prev, user: { ...prev.user, acceptedTermsAt: new Date().toISOString() } }));
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function handleCreateOrder() {
    if (!selectedService) return;
    setCreating(true);
    setMessage('');
    try {
      const res = await apiFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ serviceId: selectedService.id, description: orderNote }),
      });
      setOrderNote('');
      setSelectedService(null);
      setOrders(prev => [res.order, ...(prev || [])]);
      setMessage('Pedido creado y enviado a la creadora.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setCreating(false);
    }
  }

  if (session.state === 'loading') {
    return (
      <div className="app-shell">
        <div className="floating-card">Cargando tu espacio seguro…</div>
      </div>
    );
  }

  if (session.state === 'no-tg') {
    return (
      <div className="app-shell">
        <div className="floating-card">
          <h2>Ábreme desde Telegram</h2>
          <p>Usa el botón “Open WebApp” dentro del bot para ver tu panel.</p>
        </div>
      </div>
    );
  }

  if (session.state === 'error') {
    return (
      <div className="app-shell">
        <div className="floating-card error-card">
          <h2>Algo falló</h2>
          <p>{session.error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="grid-header">
        <div className="hero-card glass">
          <div>
            <p className="eyebrow">Safe Pay Bot</p>
            <h1>Hola, {userName}</h1>
            <p className="muted">
              Gestiona pedidos y servicios desde aquí. Todo sigue pasando en Telegram, pero con un panel más claro.
            </p>
          </div>
          <div className="balance-card">
            <p className="muted">Saldo disponible</p>
            <div className="balance">{formatEuros(session?.user?.balanceCents || 0)}</div>
            <span className="pill">{session?.user?.role === 'creator' ? 'Creadora' : 'Cliente'}</span>
          </div>
        </div>

        {!session?.user?.acceptedTermsAt && (
          <div className="warning-card">
            <div>
              <p className="eyebrow">Términos pendientes</p>
              <p className="muted">
                Debes aceptar los términos para operar. Es el mismo texto que en el bot.
              </p>
            </div>
            <button className="primary-btn" onClick={handleAcceptTerms}>
              Aceptar términos
            </button>
          </div>
        )}
      </div>

      <section className="actions">
        <button className="ghost-btn" onClick={loadOrders} disabled={refreshing}>
          {refreshing ? 'Actualizando…' : 'Refrescar pedidos'}
        </button>
        <button className="ghost-btn" onClick={loadCreators}>
          Actualizar servicios
        </button>
      </section>

      {message && <div className="toast">{message}</div>}

      <div className="grid two">
        <div className="panel glass">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Servicios disponibles</p>
              <h3>Elige y lanza un pedido</h3>
            </div>
            {selectedService && (
              <button className="ghost-btn" onClick={() => setSelectedService(null)}>
                Cancelar selección
              </button>
            )}
          </div>

          <div className="service-grid">
            {creators.map(creator => (
              <div key={creator.id} className="service-card">
                <div className="service-head">
                  <div>
                    <p className="eyebrow">{creator.username ? `@${creator.username}` : 'Creadora'}</p>
                    <h4>{creator.name}</h4>
                  </div>
                  <span className={creator.isAvailable ? 'pill pill-success' : 'pill pill-muted'}>
                    {creator.isAvailable ? 'Disponible' : 'Ocupada'}
                  </span>
                </div>
                <div className="service-list">
                  {creator.services?.length ? (
                    creator.services.map(service => (
                      <button
                        key={service.id}
                        className={`service-row ${selectedService?.id === service.id ? 'active' : ''}`}
                        onClick={() => setSelectedService({ ...service, creator })}
                      >
                        <div>
                          <p className="muted small">{service.type || 'Servicio'}</p>
                          <div className="service-title">{service.name}</div>
                        </div>
                        <div className="service-price">{formatEuros(service.priceCents)}</div>
                      </button>
                    ))
                  ) : (
                    <p className="muted small">Sin servicios activos.</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel glass">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Tu pedido</p>
              <h3>Envía detalles a la creadora</h3>
            </div>
          </div>
          {selectedService ? (
            <div className="order-form">
              <div className="order-summary">
                <p className="muted small">Servicio</p>
                <h4>{selectedService.name}</h4>
                <p className="muted">{selectedService.creator?.name}</p>
                <div className="price-line">
                  <span>Importe</span>
                  <strong>{formatEuros(selectedService.priceCents)}</strong>
                </div>
              </div>
              <label className="field">
                <span>Detalles para la creadora (opcional)</span>
                <textarea
                  value={orderNote}
                  onChange={e => setOrderNote(e.target.value)}
                  placeholder="Ej: horarios preferidos, referencias, idioma…"
                  rows={4}
                />
              </label>
              <button className="primary-btn" onClick={handleCreateOrder} disabled={creating}>
                {creating ? 'Creando…' : 'Crear pedido'}
              </button>
            </div>
          ) : (
            <p className="muted">Selecciona un servicio para rellenar tu pedido.</p>
          )}
        </div>
      </div>

      <div className="panel glass">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Pedidos recientes</p>
            <h3>Seguimiento rápido</h3>
          </div>
        </div>
        {orders.length === 0 ? (
          <p className="muted">Aún no tienes pedidos.</p>
        ) : (
          <div className="order-list">
            {orders.map(order => (
              <div key={order.id} className="order-row">
                <div>
                  <p className="eyebrow">#{order.id} • {order.statusLabel}</p>
                  <div className="order-title">{order.description || 'Pedido sin descripción'}</div>
                  <p className="muted small">
                    {session?.user?.role === 'creator'
                      ? `Cliente: ${order.client?.name || 'N/D'}`
                      : `Creadora: ${order.creator?.name || 'Asignada'}`}
                  </p>
                </div>
                <div className="order-price">
                  <div>{formatEuros(order.amountCents)}</div>
                  {order.feeCents ? <p className="muted small">+ fees {formatEuros(order.feeCents)}</p> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default WebApp;
