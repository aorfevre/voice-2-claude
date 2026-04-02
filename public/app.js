/* global marked */
const app = document.getElementById('app');
let ws = null;
let reconnectDelay = 1000;

// State
let currentSessionId = null;
let sessions = [];
const sessionMessages = new Map(); // sessionId -> messages[]
let isStreaming = false;
let streamingText = '';
let streamingToolCards = []; // { id, name, input }
let currentToolId = null;
let currentToolName = 'Tool';
let currentToolInput = '';
let showMobileSidebar = false;
const needsAttention = new Set(); // session IDs that finished and need user input

// --- WebSocket ---

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => { reconnectDelay = 1000; };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWsMessage(msg);
  };

  ws.onclose = () => {
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connectWs();
    }, reconnectDelay);
  };
}

function handleWsMessage(msg) {
  if (msg.type === 'sessions_changed') {
    fetchSessions();
    return;
  }

  // Only process messages for the current session
  if (msg.sessionId && msg.sessionId !== currentSessionId) return;

  const sid = msg.sessionId;
  if (!sid) return;

  // Skip user messages from WS — we add them locally before sending
  if (msg.type === 'user') return;

  if (msg.type === 'assistant') {
    // Full assistant message - finalize any streaming state
    finalizeStreaming(sid);
    // Add the full assistant message with content blocks
    const parsed = parseAssistantContent(msg.content);
    getMessages(sid).push({
      type: 'assistant',
      textParts: parsed.textParts,
      toolCards: parsed.toolCards,
    });
    renderMessages();
    return;
  }

  if (msg.type === 'text_delta') {
    isStreaming = true;
    streamingText += msg.text;
    renderMessages();
    return;
  }

  if (msg.type === 'tool_start') {
    // Finalize current streaming text as a text part
    if (streamingText) {
      ensureStreamingMsg(sid);
      const msgs = getMessages(sid);
      const last = msgs[msgs.length - 1];
      if (last && last.type === 'assistant-streaming') {
        last.textParts.push(streamingText);
        streamingText = '';
      }
    }
    currentToolId = msg.id;
    currentToolName = msg.tool || 'Tool';
    currentToolInput = '';
    isStreaming = true;
    renderMessages();
    return;
  }

  if (msg.type === 'tool_delta') {
    currentToolInput += msg.json;
    return;
  }

  if (msg.type === 'block_stop') {
    if (currentToolId) {
      ensureStreamingMsg(sid);
      const msgs = getMessages(sid);
      const last = msgs[msgs.length - 1];
      if (last && last.type === 'assistant-streaming') {
        let parsedInput = currentToolInput;
        try { parsedInput = JSON.parse(currentToolInput); } catch {}
        last.toolCards.push({ id: currentToolId, name: currentToolName, input: parsedInput });
      }
      currentToolId = null;
      currentToolName = 'Tool';
      currentToolInput = '';
      renderMessages();
    }
    return;
  }

  if (msg.type === 'result') {
    finalizeStreaming(sid);
    isStreaming = false;
    streamingText = '';
    streamingToolCards = [];
    renderMessages();
    updateSessionRunning(sid, false);

    // Notify if this session is not currently active
    if (sid !== currentSessionId) {
      needsAttention.add(sid);
      renderSidebar();
    }
    notifySessionDone(sid);
    return;
  }

  if (msg.type === 'status') {
    updateSessionRunning(sid, msg.status === 'running');
    renderSidebar();
    return;
  }

  if (msg.type === 'rate_limit') {
    fetchUsage();
    return;
  }

  if (msg.type === 'error') {
    getMessages(sid).push({ type: 'error', error: msg.error });
    isStreaming = false;
    renderMessages();
    return;
  }
}

function ensureStreamingMsg(sid) {
  const msgs = getMessages(sid);
  const last = msgs[msgs.length - 1];
  if (!last || last.type !== 'assistant-streaming') {
    msgs.push({ type: 'assistant-streaming', textParts: [], toolCards: [] });
  }
}

function guessToolName(id, streamMsg) {
  // The tool_start message should have set the name; fallback
  return streamMsg._lastToolName || 'Tool';
}

function finalizeStreaming(sid) {
  const msgs = getMessages(sid);
  const last = msgs[msgs.length - 1];
  if (last && last.type === 'assistant-streaming') {
    if (streamingText) {
      last.textParts.push(streamingText);
    }
    last.type = 'assistant';
    streamingText = '';
    isStreaming = false;
  }
}

function parseAssistantContent(content) {
  const textParts = [];
  const toolCards = [];
  if (!Array.isArray(content)) {
    textParts.push(String(content));
    return { textParts, toolCards };
  }
  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCards.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return { textParts, toolCards };
}

function getMessages(sid) {
  if (!sessionMessages.has(sid)) sessionMessages.set(sid, []);
  return sessionMessages.get(sid);
}

function updateSessionRunning(sid, running) {
  const s = sessions.find(s => s.id === sid);
  if (s) s.running = running;
}

// --- API ---

async function fetchSessions() {
  try {
    const res = await fetch('/api/sessions');
    sessions = await res.json();
    renderSidebar();
  } catch {}
}

let pendingProfile = 'perso'; // default profile for new sessions

async function createSession(prompt) {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, profile: pendingProfile }),
  });
  const data = await res.json();
  currentSessionId = data.id;
  showMobileSidebar = false;
  isStreaming = false;
  streamingText = '';

  // Add user message immediately
  getMessages(data.id).push({
    type: 'user',
    content: [{ type: 'text', text: prompt }],
  });

  await fetchSessions();
  render();
}

async function sendMessage(prompt) {
  if (!currentSessionId) return;

  // Add user message immediately
  getMessages(currentSessionId).push({
    type: 'user',
    content: [{ type: 'text', text: prompt }],
  });
  isStreaming = false;
  streamingText = '';
  renderMessages();

  await fetch(`/api/sessions/${currentSessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
}

async function renameSession(id, name) {
  await fetch(`/api/sessions/${id}/name`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  fetchSessions();
}

async function deleteSession(id) {
  await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  if (currentSessionId === id) {
    currentSessionId = null;
  }
  sessionMessages.delete(id);
  await fetchSessions();
  render();
}

async function loadSessionMessages(id) {
  try {
    const res = await fetch(`/api/sessions/${id}/messages`);
    const data = await res.json();
    if (data.messages && data.messages.length > 0) {
      sessionMessages.set(id, data.messages);
    }
  } catch {}
}

function abortSession(id) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'abort', sessionId: id }));
  }
}

// --- Rendering ---

function render() {
  const isMobile = window.innerWidth < 768;

  // On mobile, show sidebar unless user clicked + Work/Perso (pendingProfile set)
  if (isMobile && !currentSessionId && !showMobileSidebar && !pendingProfile) {
    showMobileSidebar = true;
  }

  app.innerHTML = `
    <div class="layout">
      <div class="sidebar ${isMobile && showMobileSidebar ? 'mobile-visible' : ''}">
        ${renderSidebarHtml()}
      </div>
      <div class="chat-panel">
        ${currentSessionId ? renderChatHtml() : renderEmptyHtml()}
      </div>
    </div>
  `;

  bindEvents();
  scrollToBottom();
}

function renderSidebarHtml() {
  return `
    <div class="sidebar-header">
      <h1>Claude</h1>
      <div style="display:flex;gap:4px;">
        <button class="btn-new-session btn-work" onclick="onNewSession('work')">+ Work</button>
        <button class="btn-new-session btn-perso" onclick="onNewSession('perso')">+ Perso</button>
      </div>
    </div>
    <div class="session-list" id="session-list">
      ${sessions.length === 0 ? '<div style="text-align:center;color:var(--text-muted);padding:40px 16px;font-size:14px;">No sessions yet.<br>Start one with the + New button.</div>' : ''}
      ${sessions.map(s => `
        <div class="session-item ${s.id === currentSessionId ? 'active' : ''} ${needsAttention.has(s.id) ? 'attention' : ''}" data-id="${s.id}">
          <div class="session-item-name">${needsAttention.has(s.id) ? '<span class="attention-dot"></span> ' : ''}${escapeHtml(s.name || 'Untitled')}</div>
          <div class="session-item-meta">
            ${s.running ? '<span class="session-running-dot"></span> Running' : ''}
            ${!s.running && needsAttention.has(s.id) ? '<span style="color:var(--red)">Needs input</span>' : ''}
            ${!s.running && !needsAttention.has(s.id) && s.messageCount ? s.messageCount + ' messages' : ''}
            ${!s.running && !needsAttention.has(s.id) && !s.messageCount ? 'Empty' : ''}
          </div>
          <button class="session-rename" data-rename="${s.id}" title="Rename">&#9998;</button>
          <button class="session-delete" data-delete="${s.id}" title="Delete">&times;</button>
        </div>
      `).join('')}
    </div>
    <div class="sidebar-footer" id="sidebar-usage">
      ${renderUsageHtml()}
    </div>
  `;
}

let usageData = {};

async function fetchUsage() {
  try {
    const res = await fetch('/api/usage');
    usageData = await res.json();
    const el = document.getElementById('sidebar-usage');
    if (el) el.innerHTML = renderUsageHtml();
  } catch {}
}

function renderUsageHtml() {
  const profiles = ['work', 'perso'];
  const bars = profiles.map(p => {
    const info = usageData[p];
    if (!info || info.utilization == null) {
      return `<div class="usage-row"><span class="usage-label">${p}</span><span class="usage-value">--</span></div>`;
    }
    const pct = Math.round(info.utilization * 100);
    const color = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--orange)' : 'var(--blue)';
    return `
      <div class="usage-row">
        <span class="usage-label">${p}</span>
        <div class="usage-bar"><div class="usage-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="usage-value">${pct}%</span>
      </div>
    `;
  }).join('');
  return `<div class="usage-title">Usage</div>${bars}`;
}

function renderChatHtml() {
  const session = sessions.find(s => s.id === currentSessionId);
  const name = session?.name || 'Untitled';
  const running = session?.running || false;
  const msgs = getMessages(currentSessionId);

  return `
    <div class="chat-header">
      <button class="btn-back-mobile" onclick="onBackMobile()">&#8592; Back</button>
      <div class="chat-header-name editable" onclick="onRenameSession()">${escapeHtml(name)}</div>
    </div>
    <div class="messages" id="messages">
      ${msgs.map(m => renderMessageHtml(m)).join('')}
      ${isStreaming && streamingText ? renderStreamingHtml() : ''}
    </div>
    <div class="input-area">
      <div id="attachments-preview" class="attachments-preview"></div>
      <div class="input-row">
        <textarea id="chat-input" rows="2" placeholder="Send a message... (paste images here)" ${running ? 'disabled' : ''}></textarea>
        ${running
          ? '<button class="btn-abort" onclick="onAbort()" title="Stop">&#9632;</button>'
          : '<button class="btn-send" id="btn-send" title="Send">&#8593;</button>'}
      </div>
    </div>
  `;
}

function renderEmptyHtml() {
  if (showProjectPicker) {
    const label = pendingProfile.charAt(0).toUpperCase() + pendingProfile.slice(1);
    const breadcrumb = projectData.current.replace(/^\/Users\/[^/]+\/Developers\/?/, '') || 'Developers';

    return `
      <div class="project-picker">
        <h2>New ${label} session</h2>
        <div class="project-breadcrumb">
          ${projectData.parent ? `<button class="btn-browse-up" onclick="onBrowseDir('${projectData.parent}')">&#8592; Back</button>` : ''}
          <span class="breadcrumb-path">📁 ${escapeHtml(breadcrumb)}</span>
        </div>
        <div class="project-list">
          ${projectData.dirs.map(p => `
            <div class="project-item ${p.hasGit ? 'is-repo' : ''}" onclick="${p.hasGit ? `onPickProject('${p.path}')` : `onBrowseDir('${p.path}')`}">
              <span class="project-icon">${p.hasGit ? '📦' : '📁'}</span>
              <div class="project-info">
                <span class="project-name">${escapeHtml(p.name)}</span>
                ${p.hasGit ? '<span class="project-tag">git repo</span>' : '<span class="project-tag folder">folder</span>'}
              </div>
            </div>
          `).join('')}
          ${projectData.dirs.length === 0 ? '<div style="color:var(--text-muted);padding:20px;text-align:center;">No subdirectories</div>' : ''}
        </div>
        <div class="project-picker-actions">
          <button class="btn-pick-current" onclick="onPickProject('${projectData.current}')">Use this folder: ${escapeHtml(breadcrumb)}</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="chat-empty">
      <div class="chat-empty-icon">&#9678;</div>
      <div class="chat-empty-text">Select or create a session</div>
    </div>
  `;
}

function renderMessageHtml(msg) {
  if (msg.type === 'user') {
    const text = Array.isArray(msg.content)
      ? msg.content.map(b => b.text || '').join('')
      : String(msg.content);
    return `<div class="message user"><div class="message-bubble">${escapeHtml(text)}</div></div>`;
  }

  if (msg.type === 'assistant' || msg.type === 'assistant-streaming') {
    const textParts = msg.textParts || [];
    const toolCards = msg.toolCards || [];

    // Combine all text parts
    const fullText = textParts.filter(t => t).join('\n\n');

    // If there's only tools and no text, show a compact tool summary
    if (!fullText && toolCards.length > 0) {
      const toolNames = [...new Set(toolCards.map(t => t.name))];
      return `<div class="tool-summary">${toolNames.map(n => `<span class="tool-pill">${escapeHtml(n)}</span>`).join('')} <span class="tool-count">${toolCards.length} actions</span></div>`;
    }

    // If there's text, show it with an optional compact tool count
    let html = '<div class="message assistant"><div class="message-bubble">';
    if (toolCards.length > 0) {
      html += `<div class="tool-summary-inline">${toolCards.length} tool${toolCards.length > 1 ? 's' : ''} used</div>`;
    }
    html += renderMarkdown(fullText);
    html += '</div></div>';
    return html;
  }

  if (msg.type === 'result') {
    return '';
  }

  if (msg.type === 'error') {
    return `<div class="message assistant"><div class="message-bubble" style="border-color:var(--red);color:var(--red);">Error: ${escapeHtml(msg.error)}</div></div>`;
  }

  return '';
}

function renderStreamingHtml() {
  return `<div class="message assistant"><div class="message-bubble"><span class="streaming-cursor">${renderMarkdown(streamingText)}</span></div></div>`;
}

function renderToolCardHtml(tool) {
  const summary = getToolSummary(tool);
  const body = typeof tool.input === 'string' ? escapeHtml(tool.input) : escapeHtml(JSON.stringify(tool.input, null, 2));
  return `
    <div class="tool-card" onclick="this.classList.toggle('expanded')">
      <div class="tool-card-header">
        <span class="tool-card-icon">&#9881;</span>
        <span class="tool-card-name">${escapeHtml(tool.name)}</span>
        <span class="tool-card-summary">${escapeHtml(summary)}</span>
        <span class="tool-card-chevron">&#9656;</span>
      </div>
      <div class="tool-card-body">${body}</div>
    </div>
  `;
}

function getToolSummary(tool) {
  if (!tool.input) return '';
  const inp = typeof tool.input === 'string' ? tool.input : tool.input;
  if (typeof inp === 'object') {
    if (inp.file_path) return inp.file_path.replace(/.*\//, '');
    if (inp.command) return inp.command.slice(0, 60);
    if (inp.pattern) return inp.pattern;
    if (inp.query) return inp.query.slice(0, 60);
  }
  return '';
}

function renderMarkdown(text) {
  try {
    return marked.parse(text, { breaks: true });
  } catch {
    return escapeHtml(text);
  }
}

// --- Sidebar-only re-render ---
function renderSidebar() {
  const list = document.getElementById('session-list');
  if (!list) return;
  const parent = list.parentElement;
  if (parent) {
    parent.innerHTML = renderSidebarHtml();
    bindSidebarEvents();
  }
}

// --- Messages-only re-render ---
function renderMessages() {
  const el = document.getElementById('messages');
  if (!el) return;

  const msgs = getMessages(currentSessionId);
  let html = msgs.map(m => renderMessageHtml(m)).join('');
  if (isStreaming && streamingText) {
    html += renderStreamingHtml();
  }
  el.innerHTML = html;
  scrollToBottom();
}

function scrollToBottom() {
  const el = document.getElementById('messages');
  if (el) {
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }
}

// --- Events ---

function bindEvents() {
  bindSidebarEvents();
  bindChatEvents();
}

function bindSidebarEvents() {
  document.querySelectorAll('.session-item[data-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.session-delete')) return;
      openSession(el.dataset.id);
    });
  });

  document.querySelectorAll('.session-rename[data-rename]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.dataset.rename;
      const session = sessions.find(s => s.id === id);
      const name = prompt('Rename session:', session?.name || '');
      if (name !== null && name.trim()) {
        renameSession(id, name.trim());
      }
    });
  });

  document.querySelectorAll('.session-delete[data-delete]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this session?')) {
        deleteSession(el.dataset.delete);
      }
    });
  });
}

let pendingAttachments = []; // { type: 'image', data: base64, name: string }

function bindChatEvents() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('btn-send');

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitInput();
      }
    });

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 300) + 'px';
    });

    // Paste handler for images and rich text
    input.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          const reader = new FileReader();
          reader.onload = () => {
            pendingAttachments.push({ type: 'image', data: reader.result, name: file.name || 'image.png' });
            renderAttachments();
          };
          reader.readAsDataURL(file);
        }
      }
    });

    input.focus();
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', submitInput);
  }
}

function renderAttachments() {
  const el = document.getElementById('attachments-preview');
  if (!el) return;
  el.innerHTML = pendingAttachments.map((a, i) => `
    <div class="attachment-thumb">
      <img src="${a.data}" alt="${escapeHtml(a.name)}">
      <button class="attachment-remove" onclick="removeAttachment(${i})">&times;</button>
    </div>
  `).join('');
}

window.removeAttachment = (idx) => {
  pendingAttachments.splice(idx, 1);
  renderAttachments();
};

function submitInput() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text && pendingAttachments.length === 0) return;

  input.value = '';
  input.style.height = 'auto';

  // Include attachments with the message
  const attachments = [...pendingAttachments];
  pendingAttachments = [];
  renderAttachments();

  if (currentSessionId) {
    sendMessage(text);
  } else {
    createSession(text);
  }
}

async function openSession(id) {
  currentSessionId = id;
  needsAttention.delete(id);
  showMobileSidebar = false;
  isStreaming = false;
  streamingText = '';

  // Load messages from server if we don't have them
  if (!sessionMessages.has(id) || sessionMessages.get(id).length === 0) {
    await loadSessionMessages(id);
  }

  render();
}

// Global handlers
let projectData = { current: '', parent: null, dirs: [] };
let showProjectPicker = false;

async function fetchProjects(dir) {
  try {
    const url = dir ? `/api/projects?path=${encodeURIComponent(dir)}` : '/api/projects';
    const res = await fetch(url);
    projectData = await res.json();
  } catch {
    projectData = { current: '', parent: null, dirs: [] };
  }
}

window.onNewSession = async (profile) => {
  pendingProfile = profile || 'perso';
  await fetchProjects();
  showProjectPicker = true;
  showMobileSidebar = false;
  render();
};

window.onBrowseDir = async (dir) => {
  await fetchProjects(dir);
  render();
};

window.onPickProject = async (projectPath) => {
  showProjectPicker = false;
  const projectName = projectPath.split('/').pop();
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: pendingProfile, cwd: projectPath, name: `${projectName}` }),
  });
  const data = await res.json();
  currentSessionId = data.id;
  isStreaming = false;
  streamingText = '';
  await fetchSessions();
  render();
  const input = document.getElementById('chat-input');
  if (input) input.focus();
};

window.onBackMobile = () => {
  currentSessionId = null;
  showMobileSidebar = true;
  render();
};

window.onAbort = () => {
  if (currentSessionId) abortSession(currentSessionId);
};

window.onRenameSession = () => {
  const session = sessions.find(s => s.id === currentSessionId);
  if (!session) return;
  const name = prompt('Rename session:', session.name || '');
  if (name !== null && name.trim()) {
    renameSession(currentSessionId, name.trim());
  }
};

function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str ?? '');
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Notifications ---

function notifySessionDone(sid) {
  playNotificationSound();

  // Browser notification
  if (Notification.permission === 'granted') {
    const session = sessions.find(s => s.id === sid);
    const name = session?.name || 'Session';
    new Notification('Claude finished', { body: `${name} needs your attention`, tag: sid });
  }
}

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

// --- Init ---

connectWs();
render();
fetchSessions().then(() => render());
fetchUsage();
setInterval(fetchUsage, 30000); // refresh usage every 30s

// Request browser notification permission
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

window.addEventListener('resize', () => render());
