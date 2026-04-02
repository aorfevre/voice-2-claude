const app = document.getElementById('app');
let ws = null;
let currentTarget = null;
let sessions = [];
let terminalOutput = '';
let renaming = false;
let reconnectDelay = 1000;

function isDesktop() { return window.innerWidth >= 768; }

// --- WebSocket ---

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    if (currentTarget) {
      ws.send(JSON.stringify({ type: 'subscribe', target: currentTarget }));
    }
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'output' && msg.target === currentTarget) {
      terminalOutput = msg.output;
      renderTerminalOutput();
    }

    if (msg.type === 'status') {
      const prev = sessions.find(s => s.target === msg.target);
      if (prev && prev.status !== 'needs_input' && msg.status === 'needs_input') {
        playNotificationSound();
      }
      if (prev) prev.status = msg.status;
      renderSidebar();
      updateTerminalStatus();
    }

    if (msg.type === 'sessions') {
      for (const s of msg.sessions) {
        const prev = sessions.find(p => p.target === s.target);
        if (prev && prev.status !== 'needs_input' && s.status === 'needs_input') {
          playNotificationSound();
        }
      }
      sessions = msg.sessions;
      render();
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
  render();
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

// --- Rendering ---

function render() {
  if (isDesktop()) {
    renderDesktop();
  } else {
    if (currentTarget) {
      renderMobileTerminal();
    } else {
      renderMobileList();
    }
  }
}

// --- Sidebar HTML (shared between desktop sidebar and mobile list) ---

function sessionListHtml(compact) {
  const statusLabel = { needs_input: 'NEEDS INPUT', running: 'RUNNING', idle: 'IDLE' };
  if (sessions.length === 0) {
    return '<div class="empty-state">No tmux sessions found.<br>Start one from Ghostty.</div>';
  }
  return sessions.map(s => `
    <div class="session-card ${s.status === 'needs_input' ? 'needs-input' : ''} ${s.target === currentTarget ? 'active' : ''}" onclick="openSession('${s.target}')">
      <div class="session-card-header">
        <div class="status-dot ${s.status}"></div>
        <div class="session-name">${s.name || s.target}</div>
        <span class="status-badge ${s.status}">${statusLabel[s.status] || 'IDLE'}</span>
      </div>
      <div class="session-meta">${s.target}${s.cwd ? ' \u2022 ' + s.cwd.replace(/.*\//, '~/') : ''}${s.lastActivity ? ' \u2022 ' + timeAgo(s.lastActivity) : ''}</div>
      ${compact ? '' : `<div class="session-preview">${escapeHtml(s.preview || '\u276f _')}</div>`}
    </div>
  `).join('');
}

function terminalHtml() {
  const session = sessions.find(s => s.target === currentTarget);
  const name = session?.name || currentTarget || '';
  const s = session?.status || 'idle';

  return `
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
    <div class="terminal-output" id="terminal-output">${terminalOutput}</div>
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
}

// --- Desktop Layout ---

function renderDesktop() {
  app.innerHTML = `
    <div class="desktop-layout">
      <div class="sidebar">
        <div class="header">
          <h1>Terminal Remote</h1>
          <div class="header-buttons">
            <button class="btn-new btn-new-work" onclick="createSession('work')">+ W</button>
            <button class="btn-new btn-new-perso" onclick="createSession('perso')">+ P</button>
          </div>
        </div>
        <div class="session-list" id="sidebar-list">
          ${sessionListHtml(true)}
        </div>
      </div>
      <div class="terminal-panel">
        ${currentTarget ? terminalHtml() : '<div class="terminal-empty">Select a session</div>'}
      </div>
    </div>
  `;

  const out = document.getElementById('terminal-output');
  if (out) out.scrollTop = out.scrollHeight;
  if (renaming) document.getElementById('rename-input')?.focus();
}

// --- Mobile Layout ---

function renderMobileList() {
  app.innerHTML = `
    <div class="header">
      <h1>Terminal Remote</h1>
      <div class="header-buttons">
        <button class="btn-new btn-new-work" onclick="createSession('work')">+ Work</button>
        <button class="btn-new btn-new-perso" onclick="createSession('perso')">+ Perso</button>
      </div>
    </div>
    <div class="session-list">
      ${sessionListHtml(false)}
    </div>
  `;
}

function renderMobileTerminal() {
  app.innerHTML = terminalHtml();
  const out = document.getElementById('terminal-output');
  if (out) out.scrollTop = out.scrollHeight;
  if (renaming) document.getElementById('rename-input')?.focus();
}

// --- Sidebar-only update (avoids re-rendering terminal) ---

function renderSidebar() {
  if (isDesktop()) {
    const list = document.getElementById('sidebar-list');
    if (list) list.innerHTML = sessionListHtml(true);
  }
}

// --- Actions ---

function openSession(target) {
  currentTarget = target;
  renaming = false;
  terminalOutput = '';
  render();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'subscribe', target }));
  }
}

function goBack() {
  currentTarget = null;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'unsubscribe' }));
  }
  fetchSessions();
}

function renderTerminalOutput() {
  const el = document.getElementById('terminal-output');
  if (!el) return;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  el.innerHTML = terminalOutput;
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

function updateTerminalStatus() {
  const session = sessions.find(s => s.target === currentTarget);
  if (!session) return;
  const dots = document.querySelectorAll('.terminal-header .status-dot');
  dots.forEach(d => { d.className = `status-dot ${session.status}`; });
}

function toggleRename() {
  renaming = !renaming;
  render();
}

function saveRename() {
  const input = document.getElementById('rename-input');
  if (input && input.value.trim()) {
    renameSess(currentTarget, input.value.trim());
    renaming = false;
    const s = sessions.find(s => s.target === currentTarget);
    if (s) s.name = input.value.trim();
    render();
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

// Re-render on resize (mobile <-> desktop transition)
window.addEventListener('resize', () => render());

// Refresh session list periodically
setInterval(() => fetchSessions(), 5000);
