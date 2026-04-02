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
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// --- Messages ---

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  )
`);

export function addMessage(sessionId, msg) {
  db.prepare('INSERT INTO messages (session_id, type, data) VALUES (?, ?, ?)').run(sessionId, msg.type, JSON.stringify(msg));
}

export function getMessages(sessionId) {
  const rows = db.prepare('SELECT data FROM messages WHERE session_id = ? ORDER BY id ASC').all(sessionId);
  return rows.map(r => JSON.parse(r.data));
}

// --- Session metadata ---

export function setClaudeSessionId(id, claudeSessionId) {
  db.exec(`ALTER TABLE sessions ADD COLUMN claude_session_id TEXT`).catch?.(() => {});
  db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, id);
}

export function setProfile(id, profile) {
  db.exec(`ALTER TABLE sessions ADD COLUMN profile TEXT`).catch?.(() => {});
  db.prepare('UPDATE sessions SET profile = ? WHERE id = ?').run(profile, id);
}

// Add columns if missing (migrations)
try { db.exec('ALTER TABLE sessions ADD COLUMN claude_session_id TEXT'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN profile TEXT'); } catch {}
