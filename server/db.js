import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'terminal-remote.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    cwd TEXT DEFAULT '/Users/aorfevre/Developers',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

export function createSession(id, name, cwd = '/Users/aorfevre/Developers') {
  db.prepare('INSERT OR REPLACE INTO sessions (id, name, cwd) VALUES (?, ?, ?)').run(id, name, cwd);
}

export function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

export function getAllSessions() {
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all();
}

export function setName(id, name) {
  db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
}

export function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
