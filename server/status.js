const statuses = new Map();

function getStatus(target) {
  return statuses.get(target) || { status: 'idle', notifiedAt: null, lastOutputHash: null, lastOutputAt: 0 };
}

function setAllStatuses(targets) {
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

    if (s.status === 'needs_input' && s.notifiedAt && Date.now() - s.notifiedAt > 2000) {
      s.status = 'running';
      s.notifiedAt = null;
    } else if (s.status !== 'needs_input') {
      s.status = 'running';
    }
  } else {
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
