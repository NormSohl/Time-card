const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'timecard.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clock_in TEXT NOT NULL,
    clock_out TEXT,
    note TEXT,
    mileage_start REAL,
    mileage_end REAL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS billings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_start TEXT NOT NULL,
    cycle_end TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    total_hours_ms INTEGER NOT NULL,
    total_mileage REAL NOT NULL,
    total_expense REAL NOT NULL,
    content TEXT NOT NULL
  )
`);

// Adds any columns from `columns` that are missing on `table` (schema
// migrations for databases created before that column existed).
function addMissingColumns(table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [column, type] of columns) {
    if (!existing.has(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

addMissingColumns('entries', [
  ['mileage_start', 'REAL'],
  ['mileage_end', 'REAL'],
  ['billing_id', 'INTEGER'],
]);
addMissingColumns('expenses', [['billing_id', 'INTEGER']]);

module.exports = db;
