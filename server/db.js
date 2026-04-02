const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'terminal-remote.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    tmux_target TEXT PRIMARY KEY,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

function getName(target) {
  const row = db.prepare('SELECT name FROM sessions WHERE tmux_target = ?').get(target);
  return row ? row.name : null;
}

function setName(target, name) {
  db.prepare('INSERT INTO sessions (tmux_target, name) VALUES (?, ?) ON CONFLICT(tmux_target) DO UPDATE SET name = ?')
    .run(target, name, name);
}

function removeSession(target) {
  db.prepare('DELETE FROM sessions WHERE tmux_target = ?').run(target);
}

function getAllNames() {
  const rows = db.prepare('SELECT tmux_target, name FROM sessions WHERE name IS NOT NULL').all();
  const map = {};
  for (const row of rows) map[row.tmux_target] = row.name;
  return map;
}

module.exports = { getName, setName, removeSession, getAllNames };
