const { execSync, execFileSync } = require('child_process');

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch (e) {
    return null;
  }
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b\[[\d;]*m/g, '')
    .replace(/\x1b[=>NH]/g, '')
    .replace(/\x1b\[[\d;]*[ABCDHJ]/g, '')
    .replace(/[\x00-\x08\x0e-\x1f]/g, '');
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
  execFileSync('tmux', ['send-keys', '-t', target, text, 'Enter'], { timeout: 5000 });
}

function sendSpecialKey(target, key) {
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
