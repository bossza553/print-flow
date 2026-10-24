import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  machine TEXT,
  pin TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  code TEXT,
  pages INTEGER,
  color TEXT NOT NULL DEFAULT '4สี',
  default_qty INTEGER NOT NULL DEFAULT 1000,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  book_id INTEGER NOT NULL REFERENCES books(id),
  quantity INTEGER NOT NULL,
  color TEXT NOT NULL,
  note TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,          -- waiting | working | done | cancelled
  machine TEXT,
  worker_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,            -- created | start | finish | cancel
  stage TEXT,
  user_id INTEGER REFERENCES users(id),
  machine TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  sub_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_stage ON jobs(stage, status);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id);
`);

// ---- seed first-run users so the app is usable immediately ----
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const ins = db.prepare('INSERT INTO users (name, role, machine, pin) VALUES (?, ?, ?, ?)');
  const seed = [
    ['ผู้ดูแลระบบ', 'admin',   null,    '1234'],
    ['ช่างตัด',     'cutter',  null,    '1111'],
    ['ช่างพิมพ์ 2สี','printer', '2สี',   '2222'],
    ['ช่างพิมพ์ 4สี','printer', '4สี',   '4444'],
    ['ช่างพิมพ์ 6สี','printer', '6สี',   '6666'],
    ['ช่างพิมพ์ 8สี เครื่อง 1','printer','8สี-1','8881'],
    ['ช่างพิมพ์ 8สี เครื่อง 2','printer','8สี-2','8882'],
    ['ช่างพับ',     'folder',  null,    '5555'],
    ['เก็บ-ไส-ตัด', 'binder',  null,    '7777'],
    ['ห่อ / ส่งคลัง','wrapper', null,    '9999'],
  ];
  for (const row of seed) ins.run(...row);
  console.log('[db] seeded default users (PINs are listed in README.md — change them in the admin screen)');
}

export function newToken() {
  return randomBytes(24).toString('hex');
}

export { DATA_DIR };
