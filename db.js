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

const existingColumns = new Set(db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name));
for (const [column, type] of [
  ['mileage_start', 'REAL'],
  ['mileage_end', 'REAL'],
]) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE entries ADD COLUMN ${column} ${type}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT
  )
`);

module.exports = db;
