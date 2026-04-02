import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 9000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Active sessions: sessionId -> { abortController, messages, running, cwd, claudeSessionId }
const activeSessions = new Map();

// WebSocket clients
const wsClients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(data);
  }
}

function broadcastToSession(sessionId, msg) {
  const data = JSON.stringify({ ...msg, sessionId });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(data);
  }
}

// Transform SDK messages for the frontend
function transformMessage(msg, sessionId) {
  if (msg.type === 'assistant') {
    return {
      type: 'assistant',
      content: msg.message.content,
      sessionId,
    };
  }

  if (msg.type === 'user' && !msg.isReplay) {
    return {
      type: 'user',
      content: msg.message.content,
      sessionId,
    };
  }

  if (msg.type === 'stream_event') {
    const evt = msg.event;
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      return { type: 'text_delta', text: evt.delta.text, sessionId };
    }
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      return { type: 'tool_start', tool: evt.content_block.name, id: evt.content_block.id, sessionId };
    }
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
      return { type: 'tool_delta', json: evt.delta.partial_json, sessionId };
    }
    if (evt.type === 'content_block_stop') {
      return { type: 'block_stop', sessionId };
    }
    return null;
  }

  if (msg.type === 'result') {
    return {
      type: 'result',
      result: msg.result,
      cost: msg.total_cost_usd,
      sessionId,
      duration: msg.duration_ms,
      session_id: msg.session_id,
    };
  }

  return null;
}

async function runQuery(sessionId, prompt, isResume) {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  const abortController = new AbortController();
  session.abortController = abortController;
  session.running = true;

  broadcastToSession(sessionId, { type: 'status', status: 'running' });

  try {
    // Map profile to CCS instance config dir
    const profileConfigDir = session.profile
      ? `/Users/aorfevre/.ccs/instances/${session.profile}`
      : undefined;

    const opts = {
      abortController,
      cwd: session.cwd || '/Users/aorfevre/Developers',
      allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      env: {
        ...process.env,
        ...(profileConfigDir ? { CLAUDE_CONFIG_DIR: profileConfigDir } : {}),
      },
    };

    if (isResume && session.claudeSessionId) {
      opts.resume = session.claudeSessionId;
    }

    const conversation = query({ prompt, options: opts });

    for await (const msg of conversation) {
      if (abortController.signal.aborted) break;

      const transformed = transformMessage(msg, sessionId);
      if (transformed) {
        // Only store full messages (not streaming deltas)
        if (transformed.type === 'assistant' || transformed.type === 'user' || transformed.type === 'result') {
          session.messages.push(transformed);
        }
        broadcastToSession(sessionId, transformed);
      }

      // Capture the Claude session ID from assistant or result messages
      if (msg.session_id) {
        session.claudeSessionId = msg.session_id;
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(`Query error for session ${sessionId}:`, err);
      broadcastToSession(sessionId, {
        type: 'error',
        error: err.message,
      });
    }
  } finally {
    session.running = false;
    session.abortController = null;
    broadcastToSession(sessionId, { type: 'status', status: 'idle' });
  }
}

// --- REST API ---

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/sessions', (_req, res) => {
  const dbSessions = db.getAllSessions();
  const result = dbSessions.map(s => ({
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    created_at: s.created_at,
    running: activeSessions.get(s.id)?.running || false,
    messageCount: activeSessions.get(s.id)?.messages?.length || 0,
  }));
  res.json(result);
});

app.post('/api/sessions', (req, res) => {
  const { prompt, name, cwd, profile } = req.body;
  const sessionId = randomUUID();
  const sessionCwd = cwd || '/Users/aorfevre/Developers';
  const sessionProfile = profile || 'perso'; // 'work' or 'perso'
  const sessionName = name || prompt?.slice(0, 50) || 'New Session';

  db.createSession(sessionId, sessionName, sessionCwd);

  activeSessions.set(sessionId, {
    messages: [],
    abortController: null,
    running: false,
    cwd: sessionCwd,
    claudeSessionId: null,
    profile: sessionProfile,
  });

  // Start the query in background
  if (prompt) {
    runQuery(sessionId, prompt, false);
  }

  broadcast({ type: 'sessions_changed' });
  res.json({ id: sessionId, name: sessionName });
});

app.post('/api/sessions/:id/message', (req, res) => {
  const { id } = req.params;
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  let session = activeSessions.get(id);
  if (!session) {
    const dbSession = db.getSession(id);
    if (!dbSession) {
      return res.status(404).json({ error: 'Session not found' });
    }
    session = {
      messages: [],
      abortController: null,
      running: false,
      cwd: dbSession.cwd,
      claudeSessionId: null,
    };
    activeSessions.set(id, session);
  }

  if (session.running) {
    return res.status(409).json({ error: 'Session is currently running' });
  }

  // Add user message
  const userMsg = { type: 'user', content: [{ type: 'text', text: prompt }], sessionId: id };
  session.messages.push(userMsg);
  broadcastToSession(id, userMsg);

  // Run query in background (resume if we have a Claude session ID)
  runQuery(id, prompt, !!session.claudeSessionId);

  res.json({ ok: true });
});

app.patch('/api/sessions/:id/name', (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  db.setName(id, name);
  broadcast({ type: 'sessions_changed' });
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  const session = activeSessions.get(id);
  if (session?.abortController) {
    session.abortController.abort();
  }
  activeSessions.delete(id);
  db.deleteSession(id);
  broadcast({ type: 'sessions_changed' });
  res.json({ ok: true });
});

app.get('/api/sessions/:id/messages', (req, res) => {
  const { id } = req.params;
  const session = activeSessions.get(id);
  if (!session) {
    return res.json({ messages: [], running: false });
  }
  res.json({ messages: session.messages, running: session.running });
});

// --- WebSocket ---

wss.on('connection', (ws) => {
  wsClients.add(ws);

  ws.on('close', () => {
    wsClients.delete(ws);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'abort' && msg.sessionId) {
      const session = activeSessions.get(msg.sessionId);
      if (session?.abortController) {
        session.abortController.abort();
      }
    }
  });
});

// --- Start ---

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Agent Server running on http://0.0.0.0:${PORT}`);
});
