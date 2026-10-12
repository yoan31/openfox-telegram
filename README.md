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

## Requirements

- OpenFox ≥ 2.0.140 (plugin API v2).
- A Telegram bot created with [@BotFather](https://t.me/BotFather) and its token.
- The chat id to send to (your own user id, or a group id such as `-100…`).

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

### Finding your chat id

1. Send any message to your bot.
2. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser.
3. Copy `result[0].message.chat.id`.

### Testing the connection

Use the **`telegram.test`** RPC (or restart the plugin) to send a test message
to the configured chat.

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
- Notifications are de-duplicated per `callId`; a tracked request is dropped once
  it is no longer pending.
- `callback_data` is kept under Telegram's 64-byte limit with a short opaque
  token (the `callId` is looked up locally, never sent to Telegram).

## Development

```bash
npm install
npm test        # vitest
npm run typecheck
npm run build   # tsup -> dist/index.js
```

## License

MIT
