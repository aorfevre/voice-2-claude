# Terminal Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web app that lets the user view and control tmux terminal sessions from an iPhone browser, with Claude Code notification support.

**Architecture:** Node.js Express server with WebSocket for live updates. Reads/writes tmux sessions via CLI. Receives Claude Code hook events via HTTP. Vanilla HTML/CSS/JS frontend, mobile-first dark theme.

**Tech Stack:** Node.js, Express, ws (WebSocket), better-sqlite3, vanilla JS frontend

**Spec:** `docs/superpowers/specs/2026-04-02-terminal-remote-design.md`

---

## File Structure

```
voice-2-claude/
├── server/
│   ├── index.js          -- Express + WebSocket server, polling orchestration
│   ├── tmux.js           -- tmux CLI wrapper (list, capture, send-keys, create)
│   ├── db.js             -- SQLite setup, session name CRUD
│   ├── hooks.js          -- Claude Code hook handler, session correlation
│   └── status.js         -- Session status state machine
├── public/
│   ├── index.html        -- Single page app shell
│   ├── style.css         -- Mobile-first dark theme
│   └── app.js            -- Client-side routing, WebSocket, UI rendering
├── package.json
├── .gitignore
└── data/                 -- Created at runtime, gitignored
    └── terminal-remote.db
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `server/index.js` (minimal hello world)

- [ ] **Step 1: Initialize project**

```bash
cd /Users/aorfevre/Developers/voice-2-claude
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install express ws better-sqlite3
```

- [ ] **Step 3: Create .gitignore**

```gitignore
node_modules/
data/
.superpowers/
```

- [ ] **Step 4: Create minimal server**

Create `server/index.js`:

```js
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Terminal Remote running on http://0.0.0.0:${PORT}`);
});
```

- [ ] **Step 5: Add start script to package.json**

Add to `scripts`: `"start": "node server/index.js"`

- [ ] **Step 6: Create empty public/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminal Remote</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app">Terminal Remote</div>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 7: Verify server starts**

Run: `npm start`
Expected: "Terminal Remote running on http://0.0.0.0:3000"
Visit http://localhost:3000 — see "Terminal Remote" text.
Kill the server.

- [ ] **Step 8: Init git and commit**

```bash
git init
git add package.json package-lock.json .gitignore server/index.js public/index.html
git commit -m "feat: scaffold Terminal Remote project"
```

---

### Task 2: tmux CLI Wrapper

**Files:**
- Create: `server/tmux.js`

- [ ] **Step 1: Create tmux.js module**

```js
const { execSync } = require('child_process');

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch (e) {
    return null;
  }
}

function stripAnsi(str) {
  // Comprehensive ANSI/OSC/CSI stripping
  return str
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')   // CSI sequences (including ? prefix)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (BEL or ST terminated)
    .replace(/\x1b[()][AB012]/g, '')               // Character set selection
    .replace(/\x1b\[[\d;]*m/g, '')                 // SGR (color/style) sequences
    .replace(/\x1b[=>NH]/g, '')                     // Misc single-char escapes
    .replace(/\x1b\[[\d;]*[ABCDHJ]/g, '')          // Cursor movement / erase
    .replace(/[\x00-\x08\x0e-\x1f]/g, '');         // Control characters (keep \n \r \t)
}

function listSessions() {
  const raw = exec('tmux list-windows -a -F "#{session_name}:#{window_index} #{window_name} #{pane_current_path}"');
  if (!raw) return [];
  return raw.split('\n').map(line => {
    const [target, ...rest] = line.split(' ');
    const name = rest.slice(0, -1).join(' ');
    const cwd = rest[rest.length - 1];
    return { target, windowName: name, cwd };
  });
}

function capturePane(target, lines) {
  const flag = lines ? `-S -${lines}` : '';
  const raw = exec(`tmux capture-pane -p -t "${target}" ${flag}`);
  return raw ? stripAnsi(raw) : '';
}

function captureLastLine(target) {
  const raw = exec(`tmux capture-pane -p -t "${target}" -S -1`);
  return raw ? stripAnsi(raw).trim() : '';
}

function getPaneCwd(target) {
  return exec(`tmux display-message -p -t "${target}" '#{pane_current_path}'`) || '';
}

function sendKeys(target, text) {
  // Use execFileSync to avoid shell injection — no shell interpolation
  const { execFileSync } = require('child_process');
  execFileSync('tmux', ['send-keys', '-t', target, text, 'Enter'], { timeout: 5000 });
}

function sendSpecialKey(target, key) {
  const { execFileSync } = require('child_process');
  const allowed = ['Escape', 'Enter', 'Up', 'Down', 'Left', 'Right', 'C-c', 'C-d'];
  if (!allowed.includes(key)) return;
  execFileSync('tmux', ['send-keys', '-t', target, key], { timeout: 5000 });
}

function createWindow(session, cmd) {
  execSync(`tmux new-window -t "${session}" -c "$HOME/Developers"`, { timeout: 5000 });
  if (cmd) {
    const target = exec(`tmux display-message -p -t "${session}" '#{session_name}:#{window_index}'`);
    execSync(`tmux send-keys -t "${target}" "${cmd}" Enter`, { timeout: 5000 });
    return target;
  }
}

module.exports = { listSessions, capturePane, captureLastLine, getPaneCwd, sendKeys, sendSpecialKey, createWindow, stripAnsi };
```

- [ ] **Step 2: Verify manually**

```bash
node -e "const t = require('./server/tmux'); console.log(t.listSessions())"
```

Expected: array of session objects (assuming tmux is running).

- [ ] **Step 3: Commit**

```bash
git add server/tmux.js
git commit -m "feat: add tmux CLI wrapper module"
```

---

### Task 3: SQLite Database

**Files:**
- Create: `server/db.js`

- [ ] **Step 1: Create db.js module**

```js
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
```

- [ ] **Step 2: Verify manually**

```bash
node -e "const db = require('./server/db'); db.setName('work:1', 'Test'); console.log(db.getName('work:1'))"
```

Expected: `Test`

- [ ] **Step 3: Commit**

```bash
git add server/db.js
git commit -m "feat: add SQLite database module for session names"
```

---

### Task 4: Status State Machine

**Files:**
- Create: `server/status.js`

- [ ] **Step 1: Create status.js module**

```js
// In-memory status tracking per session
const statuses = new Map(); // target -> { status, notifiedAt, lastOutputHash, lastOutputAt }

function getStatus(target) {
  return statuses.get(target) || { status: 'idle', notifiedAt: null, lastOutputHash: null, lastOutputAt: 0 };
}

function setAllStatuses(targets) {
  // Clean up statuses for sessions that no longer exist
  for (const key of statuses.keys()) {
    if (!targets.includes(key)) statuses.delete(key);
  }
}

function onNotification(target) {
  const s = getStatus(target);
  s.status = 'needs_input';
  s.notifiedAt = Date.now();
  statuses.set(target, s);
  return s;
}

function onStop(target) {
  const s = getStatus(target);
  if (s.status === 'needs_input') {
    s.status = 'idle';
    s.notifiedAt = null;
  }
  statuses.set(target, s);
  return s;
}

function onOutputChange(target, outputHash) {
  const s = getStatus(target);
  const changed = s.lastOutputHash !== outputHash;

  if (changed) {
    s.lastOutputHash = outputHash;
    s.lastOutputAt = Date.now();

    // If output changed after notification, clear needs_input
    if (s.status === 'needs_input' && s.notifiedAt && Date.now() - s.notifiedAt > 2000) {
      s.status = 'running';
      s.notifiedAt = null;
    } else if (s.status !== 'needs_input') {
      s.status = 'running';
    }
  } else {
    // No change — transition to idle after 10s
    if (s.status === 'running' && Date.now() - s.lastOutputAt > 10000) {
      s.status = 'idle';
    }
  }

  statuses.set(target, s);
  return { changed, status: s.status };
}

function onUserInput(target) {
  const s = getStatus(target);
  if (s.status === 'needs_input') {
    s.status = 'running';
    s.notifiedAt = null;
  }
  statuses.set(target, s);
  return s;
}

module.exports = { getStatus, setAllStatuses, onNotification, onStop, onOutputChange, onUserInput };
```

- [ ] **Step 2: Commit**

```bash
git add server/status.js
git commit -m "feat: add session status state machine"
```

---

### Task 5: Hook Handler

**Files:**
- Create: `server/hooks.js`

- [ ] **Step 1: Create hooks.js module**

```js
const tmux = require('./tmux');
const status = require('./status');

// Map a hook payload to a tmux target by matching cwd
function correlateHookToSession(hookPayload) {
  const hookCwd = hookPayload.cwd || hookPayload.project_dir || '';
  if (!hookCwd) return null;

  const sessions = tmux.listSessions();
  let bestMatch = null;
  let bestTime = 0;

  for (const session of sessions) {
    if (session.cwd === hookCwd) {
      const s = status.getStatus(session.target);
      if (!bestMatch || s.lastOutputAt > bestTime) {
        bestMatch = session.target;
        bestTime = s.lastOutputAt;
      }
    }
  }

  return bestMatch;
}

function handleHook(event, payload) {
  const target = correlateHookToSession(payload);
  if (!target) {
    console.log(`Hook ${event}: no matching session for cwd=${payload.cwd || 'unknown'}`);
    return null;
  }

  if (event === 'notification') {
    status.onNotification(target);
    console.log(`Hook: ${target} -> needs_input`);
    return { target, status: 'needs_input' };
  }

  if (event === 'stop') {
    status.onStop(target);
    console.log(`Hook: ${target} -> stop`);
    return { target, status: status.getStatus(target).status };
  }

  return null;
}

module.exports = { handleHook };
```

- [ ] **Step 2: Commit**

```bash
git add server/hooks.js
git commit -m "feat: add Claude Code hook handler with session correlation"
```

---

### Task 6: Express Server with API Routes and WebSocket

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Rewrite server/index.js with full API and WebSocket**

```js
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const tmux = require('./tmux');
const db = require('./db');
const status = require('./status');
const hooks = require('./hooks');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- REST API ---

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/sessions', (req, res) => {
  const sessions = tmux.listSessions();
  const names = db.getAllNames();
  const result = sessions.map(s => ({
    target: s.target,
    name: names[s.target] || null,
    windowName: s.windowName,
    cwd: s.cwd,
    status: status.getStatus(s.target).status,
    preview: tmux.captureLastLine(s.target),
  }));
  status.setAllStatuses(sessions.map(s => s.target));
  res.json(result);
});

app.get('/api/sessions/:target/output', (req, res) => {
  const target = decodeURIComponent(req.params.target);
  const output = tmux.capturePane(target);
  res.json({ target, output });
});

app.post('/api/sessions/:target/input', (req, res) => {
  const target = decodeURIComponent(req.params.target);
  const { text, special } = req.body;
  if (special) {
    tmux.sendSpecialKey(target, special);
  } else if (text) {
    tmux.sendKeys(target, text);
  }
  status.onUserInput(target);
  broadcast({ type: 'status', target, status: status.getStatus(target).status });
  res.json({ ok: true });
});

app.patch('/api/sessions/:target/name', (req, res) => {
  const target = decodeURIComponent(req.params.target);
  const { name } = req.body;
  db.setName(target, name);
  broadcast({ type: 'sessions_changed' });
  res.json({ ok: true });
});

app.post('/api/sessions/new', (req, res) => {
  const { type } = req.body; // 'work' or 'perso'
  const session = type === 'perso' ? 'perso' : 'work';
  const cmd = type === 'perso'
    ? 'ccs perso --dangerously-skip-permissions'
    : 'ccs work --dangerously-skip-permissions';

  try {
    // Ensure session exists, create if not
    const sessions = tmux.listSessions();
    const hasSession = sessions.some(s => s.target.startsWith(session + ':'));
    if (hasSession) {
      tmux.createWindow(session, cmd);
    } else {
      // Create new tmux session
      const { execSync } = require('child_process');
      execSync(`tmux new-session -d -s "${session}" -c "$HOME/Developers"`, { timeout: 5000 });
      execSync(`tmux send-keys -t "${session}" "${cmd}" Enter`, { timeout: 5000 });
    }
    broadcast({ type: 'sessions_changed' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/hook', (req, res) => {
  const event = req.headers['x-hook-event'] || 'unknown';
  const result = hooks.handleHook(event, req.body);
  if (result) {
    broadcast({ type: 'status', target: result.target, status: result.status });
  }
  res.json({ ok: true });
});

// --- WebSocket ---

const subscribers = new Map(); // ws -> { target, interval }

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'subscribe') {
      // Stop previous subscription
      const prev = subscribers.get(ws);
      if (prev?.interval) clearInterval(prev.interval);

      // Poll this session every 500ms — use full pane hash consistently
      let lastOutput = '';
      const interval = setInterval(() => {
        const output = tmux.capturePane(msg.target);
        const hash = simpleHash(output);
        const { changed } = status.onOutputChange(msg.target, hash);
        if (output !== lastOutput) {
          lastOutput = output;
          ws.send(JSON.stringify({ type: 'output', target: msg.target, output }));
        }
        // Send status updates
        ws.send(JSON.stringify({ type: 'status', target: msg.target, status: status.getStatus(msg.target).status }));
      }, 500);

      subscribers.set(ws, { target: msg.target, interval });

      // Send initial output immediately
      const output = tmux.capturePane(msg.target);
      ws.send(JSON.stringify({ type: 'output', target: msg.target, output }));
    }

    if (msg.type === 'unsubscribe') {
      const sub = subscribers.get(ws);
      if (sub?.interval) clearInterval(sub.interval);
      subscribers.delete(ws);
    }
  });

  ws.on('close', () => {
    const sub = subscribers.get(ws);
    if (sub?.interval) clearInterval(sub.interval);
    subscribers.delete(ws);
  });
});

// Session list polling (2s) — use full pane hash (same as subscriber loop) to avoid hash mismatch
// Also broadcast updated session list to all clients via WebSocket
let lastSessionsJson = '';
setInterval(() => {
  if (wss.clients.size === 0) return;
  const sessionList = tmux.listSessions();
  const names = db.getAllNames();

  // Update status for all sessions using full pane output hash
  const subscribedTargets = new Set();
  for (const [, sub] of subscribers) subscribedTargets.add(sub.target);

  for (const s of sessionList) {
    // Only poll sessions not already being polled by a subscriber (avoid double-polling)
    if (!subscribedTargets.has(s.target)) {
      const output = tmux.capturePane(s.target);
      status.onOutputChange(s.target, simpleHash(output));
    }
  }

  status.setAllStatuses(sessionList.map(s => s.target));

  const result = sessionList.map(s => ({
    target: s.target,
    name: names[s.target] || null,
    windowName: s.windowName,
    cwd: s.cwd,
    status: status.getStatus(s.target).status,
    preview: tmux.captureLastLine(s.target),
    lastActivity: status.getStatus(s.target).lastOutputAt || null,
  }));

  const json = JSON.stringify(result);
  if (json !== lastSessionsJson) {
    lastSessionsJson = json;
    broadcast({ type: 'sessions', sessions: result });
  }
}, 2000);

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Terminal Remote running on http://0.0.0.0:${PORT}`);
});
```

- [ ] **Step 2: Verify server starts and API works**

```bash
npm start &
curl http://localhost:3000/api/health
curl http://localhost:3000/api/sessions
kill %1
```

Expected: `{"status":"ok"}` and a JSON array of sessions.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: add full Express API, WebSocket, and polling"
```

---

### Task 7: Frontend — HTML Shell and CSS

**Files:**
- Modify: `public/index.html`
- Create: `public/style.css`

- [ ] **Step 1: Write index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Terminal Remote</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app"></div>
  <audio id="notify-sound" preload="auto">
    <source src="data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQ==" type="audio/wav">
  </audio>
  <script src="app.js"></script>
</body>
</html>
```

Note: The audio element uses a tiny placeholder. We'll use the Web Audio API for the actual notification sound in app.js.

- [ ] **Step 2: Write style.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --bg: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #010409;
  --border: #21262d;
  --text: #f0f6fc;
  --text-secondary: #8b949e;
  --text-muted: #484f58;
  --blue: #58a6ff;
  --green: #3fb950;
  --red: #f85149;
  --purple: #a78bfa;
}

html, body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  height: 100%;
  overflow: hidden;
}

#app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* Header */
.header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.header h1 {
  font-size: 20px;
  font-weight: 700;
}

.header-buttons {
  display: flex;
  gap: 6px;
}

.btn-new {
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid;
}

.btn-new-work {
  background: rgba(31, 111, 235, 0.13);
  border-color: rgba(31, 111, 235, 0.4);
  color: var(--blue);
}

.btn-new-perso {
  background: rgba(139, 92, 246, 0.13);
  border-color: rgba(139, 92, 246, 0.4);
  color: var(--purple);
}

/* Session List */
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 20px 20px;
}

.session-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 0.2s;
}

.session-card:active {
  border-color: var(--blue);
}

.session-card.needs-input {
  background: #1c1216;
  border-color: rgba(248, 81, 73, 0.27);
}

.session-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.needs_input {
  background: var(--red);
  box-shadow: 0 0 8px rgba(248, 81, 73, 0.53);
  animation: pulse 1.5s infinite;
}

.status-dot.running { background: var(--green); }
.status-dot.idle { background: var(--text-muted); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.session-name {
  font-size: 16px;
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.status-badge.needs_input { background: rgba(248, 81, 73, 0.2); color: var(--red); }
.status-badge.running { background: rgba(63, 185, 80, 0.13); color: var(--green); }
.status-badge.idle { background: rgba(72, 79, 88, 0.2); color: var(--text-secondary); }

.session-meta {
  color: var(--text-muted);
  font-size: 11px;
  margin-bottom: 8px;
}

.session-preview {
  color: var(--text-secondary);
  font-size: 13px;
  font-family: 'SF Mono', 'Menlo', monospace;
  background: var(--bg-secondary);
  padding: 8px 10px;
  border-radius: 6px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.empty-state {
  text-align: center;
  color: var(--text-secondary);
  padding: 60px 20px;
}

/* Terminal View */
.terminal-header {
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.btn-back {
  color: var(--blue);
  font-size: 14px;
  cursor: pointer;
  background: none;
  border: none;
}

.terminal-title {
  font-size: 16px;
  font-weight: 600;
  flex: 1;
}

.btn-rename {
  color: var(--blue);
  font-size: 14px;
  cursor: pointer;
  background: none;
  border: none;
}

.terminal-output {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #c9d1d9;
  background: var(--bg-tertiary);
  white-space: pre-wrap;
  word-break: break-all;
  -webkit-overflow-scrolling: touch;
}

.terminal-input-area {
  border-top: 1px solid var(--border);
  padding: 12px 16px;
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.quick-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.btn-quick {
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid;
}

.btn-yes { background: rgba(63, 185, 80, 0.13); border-color: rgba(63, 185, 80, 0.4); color: var(--green); }
.btn-no { background: rgba(248, 81, 73, 0.13); border-color: rgba(248, 81, 73, 0.4); color: var(--red); }
.btn-esc { background: var(--border); border-color: #30363d; color: var(--text-secondary); }

.input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.input-row input {
  flex: 1;
  background: var(--bg);
  border: 1px solid #30363d;
  border-radius: 10px;
  padding: 10px 14px;
  color: var(--text);
  font-size: 14px;
  outline: none;
}

.input-row input:focus {
  border-color: var(--blue);
}

.btn-send {
  background: #1f6feb;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: none;
  color: white;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* Rename modal */
.rename-bar {
  padding: 12px 20px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.rename-bar label {
  color: var(--text-secondary);
  font-size: 11px;
  text-transform: uppercase;
  display: block;
  margin-bottom: 6px;
}

.rename-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.rename-row input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--blue);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--text);
  font-size: 14px;
  outline: none;
}

.btn-save {
  background: #1f6feb;
  padding: 8px 12px;
  border-radius: 8px;
  color: white;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: none;
}
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/style.css
git commit -m "feat: add HTML shell and mobile-first dark theme CSS"
```

---

### Task 8: Frontend — Client-Side JavaScript

**Files:**
- Create: `public/app.js`

- [ ] **Step 1: Write app.js**

```js
const app = document.getElementById('app');
let ws = null;
let currentView = 'list'; // 'list' or 'terminal'
let currentTarget = null;
let sessions = [];
let terminalOutput = '';
let renaming = false;
let reconnectDelay = 1000;

// --- WebSocket ---

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    if (currentView === 'terminal' && currentTarget) {
      ws.send(JSON.stringify({ type: 'subscribe', target: currentTarget }));
    }
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'output' && msg.target === currentTarget) {
      terminalOutput = msg.output;
      if (currentView === 'terminal') renderTerminalOutput();
    }

    if (msg.type === 'status') {
      const prev = sessions.find(s => s.target === msg.target);
      if (prev && prev.status !== 'needs_input' && msg.status === 'needs_input') {
        playNotificationSound();
      }
      if (prev) prev.status = msg.status;
      if (currentView === 'list') renderSessionList();
      if (currentView === 'terminal') updateTerminalStatus();
    }

    if (msg.type === 'sessions') {
      // Check for new needs_input before replacing
      for (const s of msg.sessions) {
        const prev = sessions.find(p => p.target === s.target);
        if (prev && prev.status !== 'needs_input' && s.status === 'needs_input') {
          playNotificationSound();
        }
      }
      sessions = msg.sessions;
      if (currentView === 'list') renderSessionList();
    }

    if (msg.type === 'sessions_changed') {
      fetchSessions();
    }
  };

  ws.onclose = () => {
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connectWs();
    }, reconnectDelay);
  };
}

// --- API ---

async function fetchSessions() {
  const res = await fetch('/api/sessions');
  sessions = await res.json();
  if (currentView === 'list') renderSessionList();
}

async function sendInput(text) {
  await fetch(`/api/sessions/${encodeURIComponent(currentTarget)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function sendSpecial(key) {
  await fetch(`/api/sessions/${encodeURIComponent(currentTarget)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ special: key }),
  });
}

async function renameSess(target, name) {
  await fetch(`/api/sessions/${encodeURIComponent(target)}/name`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  fetchSessions();
}

async function createSession(type) {
  await fetch('/api/sessions/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
  });
  fetchSessions();
}

// --- Notification Sound ---

function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.value = 0.3;
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) {}
}

// --- Views ---

function renderSessionList() {
  const statusLabel = { needs_input: 'NEEDS INPUT', running: 'RUNNING', idle: 'IDLE' };

  app.innerHTML = `
    <div class="header">
      <h1>Terminal Remote</h1>
      <div class="header-buttons">
        <button class="btn-new btn-new-work" onclick="createSession('work')">+ Work</button>
        <button class="btn-new btn-new-perso" onclick="createSession('perso')">+ Perso</button>
      </div>
    </div>
    <div class="session-list">
      ${sessions.length === 0 ? '<div class="empty-state">No tmux sessions found.<br>Start one from Ghostty.</div>' : ''}
      ${sessions.map(s => `
        <div class="session-card ${s.status === 'needs_input' ? 'needs-input' : ''}" onclick="openSession('${s.target}')">
          <div class="session-card-header">
            <div class="status-dot ${s.status}"></div>
            <div class="session-name">${s.name || s.target}</div>
            <span class="status-badge ${s.status}">${statusLabel[s.status] || 'IDLE'}</span>
          </div>
          <div class="session-meta">${s.target}${s.cwd ? ' \u2022 ' + s.cwd.replace(/.*\//, '~/') : ''}${s.lastActivity ? ' \u2022 ' + timeAgo(s.lastActivity) : ''}</div>
          <div class="session-preview">${escapeHtml(s.preview || '\u276f _')}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function openSession(target) {
  currentView = 'terminal';
  currentTarget = target;
  renaming = false;
  terminalOutput = '';
  renderTerminal();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'subscribe', target }));
  }
}

function goBack() {
  currentView = 'list';
  currentTarget = null;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'unsubscribe' }));
  }
  fetchSessions();
}

function renderTerminal() {
  const session = sessions.find(s => s.target === currentTarget);
  const name = session?.name || currentTarget;
  const s = session?.status || 'idle';

  app.innerHTML = `
    <div class="terminal-header">
      <button class="btn-back" onclick="goBack()">\u2190 Back</button>
      <span class="terminal-title">${escapeHtml(name)}</span>
      <button class="btn-rename" onclick="toggleRename()">✏️</button>
      <div class="status-dot ${s}"></div>
    </div>
    ${renaming ? `
      <div class="rename-bar">
        <label>Session Name</label>
        <div class="rename-row">
          <input id="rename-input" type="text" value="${escapeHtml(name)}" onkeydown="if(event.key==='Enter')saveRename()">
          <button class="btn-save" onclick="saveRename()">Save</button>
        </div>
      </div>
    ` : ''}
    <div class="terminal-output" id="terminal-output">${escapeHtml(terminalOutput)}</div>
    <div class="terminal-input-area">
      <div class="quick-actions">
        <button class="btn-quick btn-yes" onclick="sendInput('y')">Yes</button>
        <button class="btn-quick btn-no" onclick="sendInput('n')">No</button>
        <button class="btn-quick btn-esc" onclick="sendSpecial('Escape')">Escape</button>
      </div>
      <div class="input-row">
        <input id="cmd-input" type="text" placeholder="Type or tap 🎤 to dictate..." onkeydown="if(event.key==='Enter')submitInput()">
        <button class="btn-send" onclick="submitInput()">\u2191</button>
      </div>
    </div>
  `;

  // Auto-scroll to bottom
  const out = document.getElementById('terminal-output');
  if (out) out.scrollTop = out.scrollHeight;

  // Focus rename input if renaming
  if (renaming) document.getElementById('rename-input')?.focus();
}

function renderTerminalOutput() {
  const el = document.getElementById('terminal-output');
  if (!el) return;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  el.textContent = terminalOutput;
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

function updateTerminalStatus() {
  // Re-render header status dot
  const session = sessions.find(s => s.target === currentTarget);
  if (!session) return;
  const dots = app.querySelectorAll('.terminal-header .status-dot');
  dots.forEach(d => { d.className = `status-dot ${session.status}`; });
}

function toggleRename() {
  renaming = !renaming;
  renderTerminal();
}

function saveRename() {
  const input = document.getElementById('rename-input');
  if (input && input.value.trim()) {
    renameSess(currentTarget, input.value.trim());
    renaming = false;
    // Update local session name
    const s = sessions.find(s => s.target === currentTarget);
    if (s) s.name = input.value.trim();
    renderTerminal();
  }
}

function submitInput() {
  const input = document.getElementById('cmd-input');
  if (input && input.value.trim()) {
    sendInput(input.value);
    input.value = '';
    input.focus();
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  return Math.floor(diff / 3600) + 'h ago';
}

// --- Init ---

connectWs();
fetchSessions();

// Refresh session list every 5s as fallback (primary updates come via WebSocket)
setInterval(() => {
  if (currentView === 'list') fetchSessions();
}, 5000);
```

- [ ] **Step 2: Verify the full app works**

```bash
npm start
```

Open http://localhost:3000 in a browser. Verify:
- Session list shows tmux sessions
- Tap a session to see terminal output
- Type text and press send — it appears in the tmux session
- Back button returns to list
- Quick action buttons work (Yes/No/Escape)

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: add client-side SPA with session list, terminal view, and WebSocket"
```

---

### Task 9: Integration Test and Polish

**Files:**
- Possibly tweak any file based on manual testing

- [ ] **Step 1: Start server and test full flow**

```bash
npm start
```

Test checklist:
1. Session list loads with all tmux sessions
2. Status dots show correct colors
3. Tap a session — terminal output streams live
4. Type "hello" in input — appears in tmux session
5. Quick actions (Yes/No/Escape) send correct keys
6. Rename a session — name persists after page reload
7. "+ Work" button creates a new tmux window with `ccs work`
8. "+ Perso" button creates a new tmux window with `ccs perso`
9. Back button returns to session list
10. Open on iPhone via Tailscale IP — mobile layout works

- [ ] **Step 2: Fix any issues found during testing**

- [ ] **Step 3: Commit fixes**

```bash
git add -A
git commit -m "fix: polish and integration fixes from manual testing"
```

---

### Task 10: Claude Code Hook Configuration

**Files:**
- Modify: `~/.claude/settings.json` (add hook entries)

- [ ] **Step 1: Read current settings**

Read `~/.claude/settings.json` to understand existing hook configuration.

- [ ] **Step 2: Add Terminal Remote hooks**

Add to the hooks section (merge with existing hooks, don't replace):

The hook handler receives the payload on stdin as JSON. Read stdin to extract `cwd`/`session_id`. Create a small helper script at `server/hook-notify.sh`:

```bash
#!/bin/bash
# Reads Claude Code hook JSON from stdin, forwards to Terminal Remote server
INPUT=$(cat)
curl -s -X POST http://localhost:3000/api/hook \
  -H 'Content-Type: application/json' \
  -H "X-Hook-Event: $1" \
  -d "$INPUT" &
```

Then add to settings.json (merge with existing hooks, don't replace):

```json
{
  "hooks": {
    "Notification": [{
      "hooks": [{
        "type": "command",
        "command": "bash /Users/aorfevre/Developers/voice-2-claude/server/hook-notify.sh notification",
        "timeout": 5000
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "bash /Users/aorfevre/Developers/voice-2-claude/server/hook-notify.sh stop",
        "timeout": 5000
      }]
    }]
  }
}
```

Note: Command hooks receive the hook payload on stdin as JSON (which includes `cwd`/`session_id`). The helper script forwards this JSON body to our server. The `&` on curl backgrounds it to avoid blocking Claude Code.

Also update `hooks.js` to handle stdin-based payloads — the JSON body will include a `cwd` or `project_dir` field that Claude Code provides.

- [ ] **Step 3: Verify hooks fire**

Start the Terminal Remote server, then trigger a notification in Claude Code. Check the server logs for hook receipt.

- [ ] **Step 4: Commit**

No git commit needed — settings.json is not in the project repo.

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Project scaffolding | package.json, .gitignore, server/index.js, public/index.html |
| 2 | tmux CLI wrapper | server/tmux.js |
| 3 | SQLite database | server/db.js |
| 4 | Status state machine | server/status.js |
| 5 | Hook handler | server/hooks.js |
| 6 | Express + WebSocket server | server/index.js (rewrite) |
| 7 | HTML + CSS | public/index.html, public/style.css |
| 8 | Client-side JS | public/app.js |
| 9 | Integration test | All files |
| 10 | Claude Code hooks | ~/.claude/settings.json |
