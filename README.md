# OpenFox Telegram bridge plugin

`openfox-telegram` forwards OpenFox's *waiting for the user* states to a
Telegram chat and lets you answer them with inline buttons — no need to keep
the OpenFox tab focused.

## What it does

- **Agent questions (`ask_user`)** — when a turn ends with
  `waiting_for_user`, the pending question is sent to Telegram. `choice`
  questions become one button per option, `confirm` questions become
  Yes/No, `text` questions are answered by simply replying in the chat.
- **Path / command confirmations** — OpenFox asks before touching paths outside
  the workdir, sensitive files, or running dangerous commands. The plugin polls
  the local REST API and sends each new confirmation with
  **Approve / Deny / Always allow** buttons.
- **Interactive replies** — a button press is routed back to OpenFox
  (`POST /api/sessions/:id/answer` or `/confirm-path`) and the Telegram message
  is edited to show the outcome.
- **Answered in OpenFox** — if you answer directly in OpenFox instead, the
  plugin notices on its next poll and deletes the Telegram message (falling back
  to a "Répondu sur OpenFox" edit if deletion is not possible).

## Requirements

- OpenFox ≥ 2.0.56 (plugin API v2).
- A Telegram bot created with [@BotFather](https://t.me/BotFather) and its token.
- The chat id to send to (your own user id, or a group id such as `-100…`).

## Installation

From OpenFox, open **Settings → Plugins** and install either:

- from the curated registry (search for **Telegram**), or
- by GitHub URL: `https://github.com/yoan31/openfox-telegram`.

Then enable the plugin — no server restart is required.

## Configuration

After enabling the plugin, open **Settings → Plugins → Telegram**:

| Setting                  | Description                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| **Bot token**            | Token from BotFather (`123456:ABC-DEF…`). Stored as a secret.                |
| **Chat id**              | Target chat (e.g. `123456789` or `-1001234567890`).                          |
| **Allowed user ids**     | Optional comma-separated ids allowed to answer. Empty = anyone in the chat.  |
| **OpenFox base URL**     | Local server, default `http://127.0.0.1:10369`.                              |
| **OpenFox session token**| Only needed when network auth is enabled on the server.                     |
| **Poll interval (s)**    | How often confirmations are checked (minimum 5s).                            |
| **Notify on questions**  | Forward `ask_user` questions.                                                |
| **Notify on confirmations** | Forward path/dangerous-command confirmations.                            |
| **Interactive replies**  | Show inline buttons and accept Telegram replies.                             |
| **Clear on external answer** | Delete the Telegram message once the request is answered directly in OpenFox. |
| **Include session link**  | Add a clickable link to the session in OpenFox.                             |
| **Include session state** | Show whether the session is running, waiting, blocked or completed.         |
| **Test the connection**  | Button: sends a test message and checks the OpenFox server.                  |

### Finding your chat id

1. Send any message to your bot.
2. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser.
3. Copy `result[0].message.chat.id`.

### Testing the connection

Click **Test the connection** at the bottom of the settings form. It probes the
OpenFox sessions endpoint first (read-only) and, only when that succeeds, sends
a test message to the configured chat (resolving the bot via `getMe`). The
outcome is reported as a notification on success, or as an inline error under
the button on failure — so a partial failure never leaves a success message in
the chat.

The underlying **`telegram.test`** RPC does the same when called directly: it
resolves to `{ ok: true }` on success and **throws** an `Error` (with the
failing side's message) when the test fails.

## How it works

```
turn.completed (reason=waiting_for_user) ─┐
                                          ├─► Telegram message + inline keyboard
GET /api/sessions (poll, confirmations) ──┘
                                                    │
Telegram callback_query / text reply ───────────────┘
        │
        ├─► POST /api/sessions/:id/answer        (questions)
        └─► POST /api/sessions/:id/confirm-path  (confirmations)
```

Notes:

- Path confirmations have **no plugin hook** in OpenFox, so they are detected by
  polling the REST API at the configured interval. Questions use the
  `turn.completed` hook.
- Notifications are de-duplicated per `callId`. Each poll checks the tracked
  requests against OpenFox: a confirmation absent from the bulk
  `pendingConfirmationsBySession` payload, or a question absent from its
  session's `GET /api/sessions/:id` response, was answered elsewhere — its
  Telegram message is deleted and the request dropped from tracking. A session
  that no longer exists (404) is cleared too; a session that stays unreadable is
  dropped after 24 h. When a message is edited instead of deleted, its inline
  buttons are removed.
- `callback_data` is kept under Telegram's 64-byte limit with a short opaque
  token (the `callId` is looked up locally, never sent to Telegram).
- Messages carry a clickable link to the session and its current state. The
  link is built from the configured **OpenFox base URL** and the session's
  `projectId`; a forwarded notification is shown as "En attente" and, on the
  final edit, the state is re-read from `GET /api/sessions/:id/status` (one
  request per finalization, skipped on the initial send).

## Development

```bash
npm install
npm test        # vitest
npm run typecheck
npm run build   # tsup -> dist/index.js
```

## Changelog

### 1.0.3

- Show a clickable link to the session (`/p/<projectId>/s/<sessionId>`) and its
  state in question and confirmation messages. A forwarded notification is shown
  as "En attente" (the session is waiting for the user), and the final edit after
  an answer re-reads the state via `GET /api/sessions/:id/status` so it reflects
  the real post-answer state, falling back to the remembered value. Two new
  settings — **Include session link** and **Include session state** (both on by
  default) — control this independently.

### 1.0.2

- Delete the Telegram message when the request is answered directly in OpenFox
  (new **Clear on external answer** setting, on by default), with an edit
  fallback when deletion is not possible.

### 1.0.1

- Added a **Test the connection** button to the settings form: it probes the
  OpenFox sessions endpoint (read-only) then sends a test message to the chat,
  reporting the result as a notification on success or an inline error on
  failure.

## License

MIT
