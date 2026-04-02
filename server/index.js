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
const PORT = process.env.PORT || 9000;

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
    lastActivity: status.getStatus(s.target).lastOutputAt || null,
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
    const sessions = tmux.listSessions();
    const hasSession = sessions.some(s => s.target.startsWith(session + ':'));
    if (hasSession) {
      tmux.createWindow(session, cmd);
    } else {
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
      const prev = subscribers.get(ws);
      if (prev?.interval) clearInterval(prev.interval);

      let lastPlain = '';
      const interval = setInterval(() => {
        const plain = tmux.capturePanePlain(msg.target);
        const hash = simpleHash(plain);
        status.onOutputChange(msg.target, hash);
        if (plain !== lastPlain) {
          lastPlain = plain;
          const html = tmux.capturePane(msg.target);
          ws.send(JSON.stringify({ type: 'output', target: msg.target, output: html }));
        }
        ws.send(JSON.stringify({ type: 'status', target: msg.target, status: status.getStatus(msg.target).status }));
      }, 500);

      subscribers.set(ws, { target: msg.target, interval });

      const html = tmux.capturePane(msg.target);
      ws.send(JSON.stringify({ type: 'output', target: msg.target, output: html }));
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

// Session list polling — broadcasts updated sessions to all clients
let lastSessionsJson = '';
setInterval(() => {
  if (wss.clients.size === 0) return;
  const sessionList = tmux.listSessions();
  const names = db.getAllNames();

  const subscribedTargets = new Set();
  for (const [, sub] of subscribers) subscribedTargets.add(sub.target);

  for (const s of sessionList) {
    if (!subscribedTargets.has(s.target)) {
      const plain = tmux.capturePanePlain(s.target);
      status.onOutputChange(s.target, simpleHash(plain));
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
