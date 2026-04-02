# Terminal Remote — Design Spec

## Purpose

A web app running on the Mac that lets the user view and interact with their tmux terminal sessions from an iPhone browser. Primarily used to monitor and control Claude Code sessions remotely, with notifications when sessions need attention.

## Users

Single user (the developer). No multi-user auth needed — basic protection only.

## Core Features (POC)

### 1. Session List (Home Screen)

- Lists all tmux sessions and their windows
- Each session shows:
  - Custom name (editable, stored in SQLite)
  - tmux identifier (e.g., `work:1`) as secondary text
  - Status indicator: 🔴 needs input, 🟢 running, ⚪ idle
  - Preview of last terminal output line
  - Working directory and time since last activity
- Small "+ Work" / "+ Perso" buttons in header to create new sessions
  - "+ Work" runs `ccs work --dangerously-skip-permissions` in a new tmux window (`ccs` = Claude Code Sessions, the user's CLI wrapper for managing Claude Code instances)
  - "+ Perso" runs `ccs perso --dangerously-skip-permissions` in a new tmux window

### 2. Terminal View (Tap a Session)

- Scrollable terminal output from the selected tmux pane
- Output refreshed via WebSocket (live updates)
- Back button to return to session list
- Edit button (pencil icon) to rename the session inline

### 3. Input

- Text input field at bottom of terminal view
- iOS native keyboard dictation (🎤) for speech-to-text — no custom STT needed
- Quick action buttons for common responses: "Yes", "No", "Escape"
- Send button submits text to the tmux pane via `tmux send-keys`

### 4. Notifications

- Claude Code HTTP hooks (`Notification`, `Stop`) POST to the web server
- Server pushes status changes to connected clients via WebSocket
- Browser plays a sound when a session transitions to "needs input"
- Session card pulses red in the list

## Architecture

```
iPhone Safari ←—WebSocket—→ Node.js server (:3000) ←—tmux CLI—→ tmux sessions
                               ↑
                    Claude Code hooks (HTTP POST /api/hook)
```

### Backend (Node.js)

- **Express** server on port 3000
- **WebSocket** (ws) for live terminal updates and status push
- **SQLite** (better-sqlite3) for session names
- **tmux integration** via child_process:
  - `tmux list-sessions` / `tmux list-windows` — enumerate sessions
  - `tmux capture-pane -p -t <target>` — read terminal output (pipe through ANSI stripper before sending to client)
  - `tmux send-keys -t <target> "text" Enter` — send input
  - `tmux new-window -t <session>` — create new windows
- **Polling**: capture pane output every 500ms per active viewer, push via WebSocket
- **Hook endpoint**: `POST /api/hook` receives Claude Code hook payloads, updates session status, broadcasts via WebSocket

### Frontend (Single Page App)

- Vanilla HTML/CSS/JS — no framework needed for POC
- Two views: session list and terminal view (client-side routing)
- Mobile-first design (375px primary), works on desktop too
- Dark theme matching the mockups
- `localStorage` not needed — SQLite handles persistence server-side

### Claude Code Hook Configuration

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [{
      "hooks": [{
        "type": "http",
        "url": "http://localhost:3000/api/hook",
        "headers": { "X-Hook-Event": "notification" }
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "http",
        "url": "http://localhost:3000/api/hook",
        "headers": { "X-Hook-Event": "stop" }
      }]
    }]
  }
}
```

### Network Access

- Tailscale for remote access (already installed)
- Server binds to `0.0.0.0:3000` so it's accessible via Tailscale IP
- No TLS needed — Tailscale encrypts the tunnel

## Status Detection — State Machine

Each session has a status that transitions as follows:

```
              hook: Notification
    ┌─────────────────────────────────┐
    │                                 ▼
  IDLE ──output changes──► RUNNING  NEEDS_INPUT
    ▲                        │         │
    │    no output 10s       │         │
    └────────────────────────┘         │
    ▲                                  │
    │  user sends input OR             │
    │  output changes after notify OR  │
    │  hook: Stop                      │
    └──────────────────────────────────┘
```

- **needs_input** — set when Claude Code `Notification` hook fires. Cleared when: (a) user sends input via the web UI, (b) terminal output changes after the notification timestamp, or (c) a `Stop` hook fires.
- **running** — terminal output changed within last 10 seconds
- **idle** — no output change and no pending notification

### Hook-to-Session Correlation

Claude Code hooks include the project directory in their payload. The server maps hooks to tmux sessions by:

1. Each tmux pane has a working directory (`tmux display-message -p -t <target> '#{pane_current_path}'`)
2. When a hook arrives, match its `cwd` field to the tmux pane with the same working directory
3. If multiple panes share a cwd, match by the pane whose output most recently changed (the active Claude Code instance)
4. Fallback: if no match, log and ignore (don't crash)

### Polling Strategy

- **Session list view**: poll last line of each session every 2 seconds (lightweight `tmux capture-pane -p -t <target> -S -1`)
- **Terminal view (single session)**: poll full visible pane every 500ms, diff against previous, send only changes via WebSocket
- **No viewer connected**: no polling (WebSocket disconnect stops it)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all tmux sessions/windows with status and names |
| `GET` | `/api/sessions/:target/output` | Get terminal output for a session |
| `POST` | `/api/sessions/:target/input` | Send text input to a session |
| `PATCH` | `/api/sessions/:target/name` | Rename a session |
| `POST` | `/api/sessions/new` | Create a new work/perso session |
| `POST` | `/api/hook` | Receive Claude Code hook events |

### WebSocket Messages

Server → Client:
```json
{ "type": "output", "target": "work:1", "lines": ["..."], "timestamp": 1234 }
{ "type": "status", "target": "work:1", "status": "needs_input", "preview": "Allow: Edit?" }
{ "type": "sessions", "sessions": [...] }
```

Client → Server:
```json
{ "type": "subscribe", "target": "work:1" }
{ "type": "unsubscribe" }
```

## Data Model (SQLite)

```sql
CREATE TABLE sessions (
  tmux_target TEXT PRIMARY KEY,  -- e.g., "work:1"
  name TEXT,                      -- custom name, nullable
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Error Handling

- **tmux not running**: session list shows empty state with "No tmux sessions found. Start one from Ghostty."
- **Session killed externally**: next poll detects missing target, removes from list, cleans up SQLite
- **WebSocket disconnect**: client auto-reconnects with exponential backoff (1s, 2s, 4s, max 30s)
- **Hook server unreachable**: Claude Code hooks fail silently (no impact on Claude Code itself), status falls back to polling-based detection
- **SQLite locked**: use WAL mode for concurrent read/write safety

## File Structure

```
voice-2-claude/
├── server/
│   ├── index.js          -- Express + WebSocket server
│   ├── tmux.js           -- tmux CLI wrapper
│   ├── db.js             -- SQLite setup and queries
│   └── hooks.js          -- Claude Code hook handler
├── public/
│   ├── index.html         -- Single page app
│   ├── style.css          -- Mobile-first dark theme
│   └── app.js             -- Client-side logic
├── package.json
└── data/
    └── terminal-remote.db -- SQLite database (gitignored)
```

## Out of Scope (POC)

- Text-to-speech (reading output aloud)
- Custom speech-to-text (use native iOS dictation)
- Authentication beyond Tailscale network isolation
- Multiple simultaneous viewers
- Terminal color/ANSI rendering (strip ANSI codes, display plain text for POC)
- Pane splits (window-level only)
