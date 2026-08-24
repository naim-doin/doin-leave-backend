require('dotenv').config();
const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.DB_URL || 'file:./data.sqlite',
  authToken: process.env.DB_AUTH_TOKEN || undefined
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    dept TEXT NOT NULL,
    gender TEXT NOT NULL CHECK(gender IN ('male','female')),
    role TEXT NOT NULL CHECK(role IN ('employee','manager','hr')),
    manager_id INTEGER REFERENCES employees(id),
    must_reset_password INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    photo TEXT,
    designation TEXT,
    employee_code TEXT,
    joining_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS leave_types (
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    default_total REAL NOT NULL,
    gender_restricted TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS leave_balances (
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type_code TEXT NOT NULL REFERENCES leave_types(code),
    total REAL NOT NULL,
    used REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (employee_id, type_code)
  )`,
  `CREATE TABLE IF NOT EXISTS holidays (
    date TEXT PRIMARY KEY,
    label TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type_code TEXT NOT NULL REFERENCES leave_types(code),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    days REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending_manager','pending_hr','approved','rejected')),
    reason TEXT,
    note TEXT,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES employees(id),
    action TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS balance_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type_code TEXT NOT NULL REFERENCES leave_types(code),
    previous_used REAL NOT NULL,
    new_used REAL NOT NULL,
    previous_total REAL NOT NULL,
    new_total REAL NOT NULL,
    actor_id INTEGER REFERENCES employees(id),
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS document_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    doc_type TEXT NOT NULL CHECK(doc_type IN ('salary_certificate','noc','employment_certificate','other')),
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    expected_date TEXT,
    reject_reason TEXT,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT,
    decided_by INTEGER REFERENCES employees(id)
  )`
];

async function initSchema() {
  try { await db.execute('PRAGMA foreign_keys = ON'); } catch (e) {}
  for (const stmt of SCHEMA) { await db.execute(stmt); }
  const migrations = [
    "ALTER TABLE employees ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE employees ADD COLUMN photo TEXT",
    "ALTER TABLE employees ADD COLUMN designation TEXT",
    "ALTER TABLE employees ADD COLUMN employee_code TEXT",
    "ALTER TABLE employees ADD COLUMN joining_date TEXT"
  ];
  for (const stmt of migrations) {
    try { await db.execute(stmt); } catch (e) { /* column already exists — fine */ }
  }
}

async function get(sql, args = []) {
  const res = await db.execute({ sql, args });
  return res.rows[0] || null;
}
async function all(sql, args = []) {
  const res = await db.execute({ sql, args });
  return res.rows;
}
async function run(sql, args = []) {
  const res = await db.execute({ sql, args });
  return { lastInsertRowid: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : undefined, changes: res.rowsAffected };
}

module.exports = { initSchema, get, all, run };
