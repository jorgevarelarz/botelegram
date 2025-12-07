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
  display_name TEXT,
  photo_file_id TEXT
);

CREATE TABLE IF NOT EXISTS orders (
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
  if (hasDisplay && hasPhoto) return;
  if (!hasDisplay) {
    db.prepare('ALTER TABLE users ADD COLUMN display_name TEXT').run();
  }
  if (!hasPhoto) {
    db.prepare('ALTER TABLE users ADD COLUMN photo_file_id TEXT').run();
  }
}

ensureUsersProfileColumns();

export function findOrCreateUser({ telegramId, username, role = null }) {
  const now = new Date().toISOString();
  let user = db.prepare(
    'SELECT * FROM users WHERE telegram_id = ?'
  ).get(String(telegramId));

  if (!user) {
    // Si no tiene rol aún, marcamos provisionalmente como cliente; luego lo cambiaremos.
    const stmt = db.prepare(
      'INSERT INTO users (telegram_id, username, role, created_at) VALUES (?,?,?,?)'
    );
    const info = stmt.run(String(telegramId), username || null, role || 'client', now);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  } else if (username && user.username !== username) {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, user.id);
    user.username = username;
  }

  return user;
}

export function updateUserRole(userId, role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

export function getUserByTelegramId(telegramId) {
  return db
    .prepare('SELECT * FROM users WHERE telegram_id = ?')
    .get(String(telegramId));
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function getCreators() {
  return db.prepare("SELECT * FROM users WHERE role = 'creator'").all();
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

export function createOrder({ clientId, amountCents, description, type = null }) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO orders (client_id, amount_cents, status, description, created_at, updated_at, type, call_url)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const info = stmt.run(
    clientId,
    amountCents,
    'pending',
    description || null,
    now,
    now,
    type,
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

export function updateUserProfile(userId, { displayName, photoFileId }) {
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
