const app = document.getElementById('app');
let ws = null;
let currentView = 'list';
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
      <button class="btn-rename" onclick="toggleRename()">\u270F\uFE0F</button>
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
        <input id="cmd-input" type="text" placeholder="Type or tap \uD83C\uDFA4 to dictate..." onkeydown="if(event.key==='Enter')submitInput()">
        <button class="btn-send" onclick="submitInput()">\u2191</button>
      </div>
    </div>
  `;

  const out = document.getElementById('terminal-output');
  if (out) out.scrollTop = out.scrollHeight;
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

setInterval(() => {
  if (currentView === 'list') fetchSessions();
}, 5000);
