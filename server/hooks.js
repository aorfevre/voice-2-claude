const tmux = require('./tmux');
const status = require('./status');

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
