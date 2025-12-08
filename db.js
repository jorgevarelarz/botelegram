import Database from 'better-sqlite3';
import dotenv from 'dotenv';
dotenv.config();

const dbPath = process.env.DATABASE_PATH || './database.db';
const db = new Database(dbPath);

// Crear tablas si no existen
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT,
  role TEXT CHECK(role IN ('client','creator','admin')) NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen TEXT,
  is_available INTEGER NOT NULL DEFAULT 1,
  creator_status TEXT CHECK(creator_status IN ('pending','approved','rejected')) DEFAULT 'approved',
  display_name TEXT,
  photo_file_id TEXT,
  bio TEXT,
  languages TEXT,
  accepted_terms_at TEXT,
  role_confirmed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  creator_id INTEGER,
  amount_cents INTEGER NOT NULL,
  status TEXT CHECK(status IN ('pending','pending_payment','accepted','in_call','completed','cancelled')) NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  type TEXT,
  call_url TEXT,
  eta_minutes INTEGER,
  reminder_sent_at TEXT,
  expires_at TEXT,
  currency TEXT,
  fee_cents INTEGER DEFAULT 0,
  total_cents INTEGER,
  payment_status TEXT,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  rating_at TEXT,
  problem_report TEXT,
  problem_report_at TEXT,
  FOREIGN KEY (client_id) REFERENCES users(id),
  FOREIGN KEY (creator_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT CHECK(status IN ('requested','processed')) NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT CHECK(type IN ('topup','hold','release','withdraw')) NOT NULL,
  amount_cents INTEGER NOT NULL,
  related_order_id INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (related_order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT,
  price_cents INTEGER NOT NULL,
  duration_min INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (creator_id) REFERENCES users(id)
);
`);

// Migration: asegurar columnas nuevas y estado in_call en orders
function ensureOrdersSchema() {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'")
    .get();
  if (!table) return;

  const columns = db.prepare("PRAGMA table_info('orders')").all();
  const hasType = columns.some(c => c.name === 'type');
  const hasCallUrl = columns.some(c => c.name === 'call_url');
  const rawSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'")
    .get();
  const hasInCall = rawSql?.sql?.includes("'in_call'") || false;

  if (hasType && hasCallUrl && hasInCall) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE orders_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      creator_id INTEGER,
      amount_cents INTEGER NOT NULL,
      status TEXT CHECK(status IN ('pending','accepted','in_call','completed','cancelled')) NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      type TEXT,
      call_url TEXT,
      FOREIGN KEY (client_id) REFERENCES users(id),
      FOREIGN KEY (creator_id) REFERENCES users(id)
    );
    INSERT INTO orders_new (id, client_id, creator_id, amount_cents, status, description, created_at, updated_at, type, call_url)
    SELECT id, client_id, creator_id, amount_cents, status, description, created_at, updated_at,
           NULL as type, NULL as call_url
    FROM orders;
    DROP TABLE orders;
    ALTER TABLE orders_new RENAME TO orders;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

ensureOrdersSchema();

// Migration: asegurar columnas de perfil en users
function ensureUsersProfileColumns() {
  const columns = db.prepare("PRAGMA table_info('users')").all();
  const hasDisplay = columns.some(c => c.name === 'display_name');
  const hasPhoto = columns.some(c => c.name === 'photo_file_id');
  const hasLastSeen = columns.some(c => c.name === 'last_seen');
  const hasAvailability = columns.some(c => c.name === 'is_available');
  const hasCreatorStatus = columns.some(c => c.name === 'creator_status');
  const hasBio = columns.some(c => c.name === 'bio');
  const hasLanguages = columns.some(c => c.name === 'languages');
  const hasTerms = columns.some(c => c.name === 'accepted_terms_at');
  const hasRoleConfirmed = columns.some(c => c.name === 'role_confirmed');
  if (
    hasDisplay &&
    hasPhoto &&
    hasLastSeen &&
    hasAvailability &&
    hasCreatorStatus &&
    hasBio &&
    hasLanguages &&
    hasTerms &&
    hasRoleConfirmed
  )
    return;
  if (!hasDisplay) {
    db.prepare('ALTER TABLE users ADD COLUMN display_name TEXT').run();
  }
  if (!hasPhoto) {
    db.prepare('ALTER TABLE users ADD COLUMN photo_file_id TEXT').run();
  }
  if (!hasLastSeen) {
    db.prepare('ALTER TABLE users ADD COLUMN last_seen TEXT').run();
  }
  if (!hasAvailability) {
    db.prepare('ALTER TABLE users ADD COLUMN is_available INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!hasCreatorStatus) {
    db.prepare(
      "ALTER TABLE users ADD COLUMN creator_status TEXT CHECK(creator_status IN ('pending','approved','rejected')) DEFAULT 'approved'"
    ).run();
    // Marcar creadoras existentes como aprobadas
    db.prepare("UPDATE users SET creator_status = 'approved' WHERE role = 'creator'").run();
  }
  if (!hasBio) {
    db.prepare('ALTER TABLE users ADD COLUMN bio TEXT').run();
  }
  if (!hasLanguages) {
    db.prepare('ALTER TABLE users ADD COLUMN languages TEXT').run();
  }
  if (!hasTerms) {
    db.prepare('ALTER TABLE users ADD COLUMN accepted_terms_at TEXT').run();
  }
  if (!hasRoleConfirmed) {
    db.prepare('ALTER TABLE users ADD COLUMN role_confirmed INTEGER NOT NULL DEFAULT 0').run();
  }
}

ensureUsersProfileColumns();

// Migration: recordar si ya se notificó un pending antiguo
function ensureOrdersReminderColumn() {
  const columns = db.prepare("PRAGMA table_info('orders')").all();
  const hasReminder = columns.some(c => c.name === 'reminder_sent_at');
  const hasEta = columns.some(c => c.name === 'eta_minutes');
  const hasExpires = columns.some(c => c.name === 'expires_at');
  const hasRating = columns.some(c => c.name === 'rating');
  const hasRatingAt = columns.some(c => c.name === 'rating_at');
  const hasProblem = columns.some(c => c.name === 'problem_report');
  const hasProblemAt = columns.some(c => c.name === 'problem_report_at');
  const hasCurrency = columns.some(c => c.name === 'currency');
  const hasFee = columns.some(c => c.name === 'fee_cents');
  const hasTotal = columns.some(c => c.name === 'total_cents');
  const hasPaymentStatus = columns.some(c => c.name === 'payment_status');
  const hasPendingPayment =
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get()?.sql?.includes('pending_payment') ||
    false;
  if (!hasReminder) {
    db.prepare('ALTER TABLE orders ADD COLUMN reminder_sent_at TEXT').run();
  }
  if (!hasEta) {
    db.prepare('ALTER TABLE orders ADD COLUMN eta_minutes INTEGER').run();
  }
  if (!hasExpires) {
    db.prepare('ALTER TABLE orders ADD COLUMN expires_at TEXT').run();
  }
  if (!hasCurrency) {
    db.prepare('ALTER TABLE orders ADD COLUMN currency TEXT').run();
  }
  if (!hasFee) {
    db.prepare('ALTER TABLE orders ADD COLUMN fee_cents INTEGER DEFAULT 0').run();
  }
  if (!hasTotal) {
    db.prepare('ALTER TABLE orders ADD COLUMN total_cents INTEGER').run();
  }
  if (!hasPaymentStatus) {
    db.prepare('ALTER TABLE orders ADD COLUMN payment_status TEXT').run();
  }
  if (!hasRating) {
    db.prepare('ALTER TABLE orders ADD COLUMN rating INTEGER').run();
  }
  if (!hasRatingAt) {
    db.prepare('ALTER TABLE orders ADD COLUMN rating_at TEXT').run();
  }
  if (!hasProblem) {
    db.prepare('ALTER TABLE orders ADD COLUMN problem_report TEXT').run();
  }
  if (!hasProblemAt) {
    db.prepare('ALTER TABLE orders ADD COLUMN problem_report_at TEXT').run();
  }
  // Si el enum de status no tiene pending_payment, recrear tabla
  if (!hasPendingPayment) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE orders_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        creator_id INTEGER,
        amount_cents INTEGER NOT NULL,
        status TEXT CHECK(status IN ('pending','pending_payment','accepted','in_call','completed','cancelled')) NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        type TEXT,
        call_url TEXT,
        eta_minutes INTEGER,
        reminder_sent_at TEXT,
        expires_at TEXT,
        currency TEXT,
        fee_cents INTEGER DEFAULT 0,
        total_cents INTEGER,
        payment_status TEXT,
        rating INTEGER,
        rating_at TEXT,
        problem_report TEXT,
        problem_report_at TEXT,
        FOREIGN KEY (client_id) REFERENCES users(id),
        FOREIGN KEY (creator_id) REFERENCES users(id)
      );
      INSERT INTO orders_new (id, client_id, creator_id, amount_cents, status, description, created_at, updated_at, type, call_url, eta_minutes, reminder_sent_at, expires_at, currency, fee_cents, total_cents, payment_status, rating, rating_at, problem_report, problem_report_at)
      SELECT id, client_id, creator_id, amount_cents, status, description, created_at, updated_at, type, call_url, eta_minutes, reminder_sent_at, expires_at, currency, COALESCE(fee_cents,0), total_cents, payment_status, rating, rating_at, problem_report, problem_report_at
      FROM orders;
      DROP TABLE orders;
      ALTER TABLE orders_new RENAME TO orders;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
}

ensureOrdersReminderColumn();

export function findOrCreateUser({ telegramId, username, role = null }) {
  const now = new Date().toISOString();
  let user = db.prepare(
    'SELECT * FROM users WHERE telegram_id = ?'
  ).get(String(telegramId));

  if (!user) {
    // Si no tiene rol aún, marcamos provisionalmente como cliente; luego lo cambiaremos.
    const stmt = db.prepare(
      'INSERT INTO users (telegram_id, username, role, created_at, last_seen) VALUES (?,?,?,?,?)'
    );
    const info = stmt.run(String(telegramId), username || null, role || 'client', now, now);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  } else if (username && user.username !== username) {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, user.id);
    user.username = username;
  }

  return user;
}

export function updateUserRole(userId, role) {
  db.prepare('UPDATE users SET role = ?, role_confirmed = 1 WHERE id = ?').run(role, userId);
}

export function markUserAcceptedTerms(userId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET accepted_terms_at = ? WHERE id = ?').run(now, userId);
}

export function getUserByTelegramId(telegramId) {
  return db
    .prepare('SELECT * FROM users WHERE telegram_id = ?')
    .get(String(telegramId));
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function getCreators({ onlyAvailable = true } = {}) {
  const base = "SELECT * FROM users WHERE role = 'creator' AND creator_status = 'approved'";
  if (onlyAvailable) {
    return db.prepare(`${base} AND is_available = 1`).all();
  }
  return db.prepare(base).all();
}

export function formatCents(amount) {
  return (amount / 100).toFixed(2).replace('.', ',') + ' €';
}

export function changeBalance(userId, deltaCents) {
  const user = getUserById(userId);
  if (!user) throw new Error('Usuario no encontrado');
  const newBalance = user.balance_cents + deltaCents;
  if (newBalance < 0) throw new Error('Saldo insuficiente');
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(newBalance, userId);
  return newBalance;
}

export function createOrder({
  clientId,
  amountCents,
  description,
  type = null,
  etaMinutes = null,
  expiresAt = null,
  currency = 'EUR',
  feeCents = 0,
  totalCents = null,
}) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO orders (client_id, amount_cents, status, description, created_at, updated_at, type, call_url, eta_minutes, expires_at, rating, rating_at, problem_report, problem_report_at, currency, fee_cents, total_cents, payment_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const info = stmt.run(
    clientId,
    amountCents,
    'pending',
    description || null,
    now,
    now,
    type,
    null,
    etaMinutes || null,
    expiresAt || null,
    null,
    null,
    null,
    null,
    currency,
    feeCents || 0,
    totalCents || amountCents,
    null
  );
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
}

export function getOrderById(orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

export function updateOrder(orderId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(orderId);
  db.prepare(`UPDATE orders SET ${sets} WHERE id = ?`).run(...values);
}

export function listUserOrders(userId, role, limit = 10) {
  if (role === 'client') {
    return db.prepare(
      'SELECT * FROM orders WHERE client_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit);
  } else if (role === 'creator') {
    return db.prepare(
      'SELECT * FROM orders WHERE creator_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit);
  }
  return [];
}

export function createTransaction({ userId, type, amountCents, relatedOrderId = null }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO transactions (user_id, type, amount_cents, related_order_id, created_at)
    VALUES (?,?,?,?,?)
  `).run(userId, type, amountCents, relatedOrderId, now);
}

export function createWithdrawalRequest(userId, amountCents) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO withdrawals (user_id, amount_cents, status, created_at)
    VALUES (?,?, 'requested', ?)
  `);
  const info = stmt.run(userId, amountCents, now);
  return db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(info.lastInsertRowid);
}

export function listPendingWithdrawals() {
  return db.prepare(`
    SELECT w.*, u.username, u.telegram_id
    FROM withdrawals w
    JOIN users u ON w.user_id = u.id
    WHERE w.status = 'requested'
    ORDER BY w.created_at ASC
  `).all();
}

export function markWithdrawalProcessed(withdrawalId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE withdrawals
    SET status = 'processed', processed_at = ?
    WHERE id = ?
  `).run(now, withdrawalId);
}

export function updateUserProfile(userId, { displayName, photoFileId, bio, languages }) {
  const sets = [];
  const values = [];
  if (displayName !== undefined) {
    sets.push('display_name = ?');
    values.push(displayName || null);
  }
  if (photoFileId !== undefined) {
    sets.push('photo_file_id = ?');
    values.push(photoFileId || null);
  }
  if (bio !== undefined) {
    sets.push('bio = ?');
    values.push(bio || null);
  }
  if (languages !== undefined) {
    sets.push('languages = ?');
    values.push(languages || null);
  }
  if (!sets.length) return;
  values.push(userId);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

// ---------- Services ----------

export function createService({ creatorId, name, description, type, priceCents, durationMin }) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO services (creator_id, name, description, type, price_cents, duration_min, created_at)
    VALUES (?,?,?,?,?,?,?)
  `);
  const info = stmt.run(
    creatorId,
    name,
    description || null,
    type || null,
    priceCents,
    durationMin || null,
    now
  );
  return db.prepare('SELECT * FROM services WHERE id = ?').get(info.lastInsertRowid);
}

export function listServicesByCreator(creatorId, includeInactive = false) {
  if (includeInactive) {
    return db
      .prepare('SELECT * FROM services WHERE creator_id = ? ORDER BY created_at DESC')
      .all(creatorId);
  }
  return db
    .prepare(
      'SELECT * FROM services WHERE creator_id = ? AND is_active = 1 ORDER BY created_at DESC'
    )
    .all(creatorId);
}

export function setServiceActive(serviceId, isActive) {
  db.prepare('UPDATE services SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, serviceId);
}

export function deleteService(serviceId) {
  db.prepare('DELETE FROM services WHERE id = ?').run(serviceId);
}

export function getServiceById(serviceId) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
}

// ---------- Presencia y notificaciones ----------

export function touchLastSeen(userId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, userId);
}

export function listActiveOrdersByCreator(creatorId) {
  return db
    .prepare(
      "SELECT * FROM orders WHERE creator_id = ? AND status IN ('accepted','in_call') ORDER BY created_at DESC"
    )
    .all(creatorId);
}

export function listStalePendingOrders(minutesThreshold) {
  const cutoff = new Date(Date.now() - minutesThreshold * 60 * 1000).toISOString();
  return db
    .prepare(
      `
      SELECT * FROM orders
      WHERE status = 'pending'
        AND created_at <= ?
        AND (reminder_sent_at IS NULL OR reminder_sent_at = '')
      ORDER BY created_at ASC
    `
    )
    .all(cutoff);
}

export function listExpiredPendingOrders() {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
      SELECT * FROM orders
      WHERE status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at <= ?
      ORDER BY created_at ASC
    `
    )
    .all(now);
}

export function setOrderRating(orderId, rating) {
  const now = new Date().toISOString();
  db.prepare('UPDATE orders SET rating = ?, rating_at = ? WHERE id = ?').run(rating, now, orderId);
}

export function setOrderProblem(orderId, text) {
  const now = new Date().toISOString();
  db.prepare('UPDATE orders SET problem_report = ?, problem_report_at = ? WHERE id = ?').run(text, now, orderId);
}

export function markOrderReminderSent(orderId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE orders SET reminder_sent_at = ? WHERE id = ?').run(now, orderId);
}

export function expirePendingOrder(orderId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', now, orderId);
}

// ---------- Admin / listas ----------

export function listUsers(limit = 20) {
  return db
    .prepare(
      `SELECT id, telegram_id, username, role, balance_cents, created_at, is_available
       FROM users
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit);
}

export function findUserByUsername(username) {
  if (!username) return null;
  const clean = username.replace(/^@/, '');
  return db.prepare('SELECT * FROM users WHERE username = ?').get(clean);
}

export function setUserAvailability(userId, isAvailable) {
  db.prepare('UPDATE users SET is_available = ? WHERE id = ?').run(isAvailable ? 1 : 0, userId);
}

export function setCreatorStatus(userId, status) {
  db.prepare('UPDATE users SET creator_status = ? WHERE id = ?').run(status, userId);
}

export function listPendingCreators() {
  return db
    .prepare("SELECT * FROM users WHERE role = 'creator' AND creator_status = 'pending'")
    .all();
}

export function listTransactions(limit = 20) {
  return db
    .prepare(
      `SELECT t.*, u.username, u.telegram_id
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC
       LIMIT ?`
    )
    .all(limit);
}

export function listTransactionsByUser(userId, limit = 10) {
  return db
    .prepare(
      `SELECT * FROM transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userId, limit);
}

export function resetDatabase() {
  db.exec(`
    DELETE FROM transactions;
    DELETE FROM withdrawals;
    DELETE FROM services;
    DELETE FROM orders;
    DELETE FROM users;
  `);
}
