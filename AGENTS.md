# AGENTS.md — openfox-telegram

## Purpose

OpenFox plugin that bridges "waiting for the user" states to Telegram:
`ask_user` questions (via the `turn.completed` hook) and path/dangerous-command
confirmations (via REST polling), with interactive inline-button replies routed
back to the OpenFox REST API.

## Stack

- TypeScript, ESM, tsup, vitest 3.x
- peerDep: `openfox >=2.0.140 <3`
- No runtime dependency (uses global `fetch`)

## Commands

```bash
npm run build      # tsup -> dist/index.js
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

## Project Map

```
src/
├── index.ts            # Entry point: register(), settings schema, hook, RPCs, deactivate()
├── bridge.ts           # TelegramBridge: outgoing notifications + incoming routing
├── format.ts           # Message formatting, callback_data encode/decode, keyboards
├── telegram-client.ts  # Minimal Telegram Bot API client (injectable fetch)
├── openfox-client.ts   # OpenFox REST client (/api/sessions, /answer, /confirm-path)
├── settings.ts         # Settings normalization + defaults
└── types.ts            # Shared types
```

## Where to Look What

- **Change what gets sent to Telegram** → `src/format.ts`
- **Change notification/polling/routing logic** → `src/bridge.ts`
- **Add a Telegram API call** → `src/telegram-client.ts`
- **Change an OpenFox endpoint call** → `src/openfox-client.ts`
- **Add a setting** → `src/index.ts` (SETTINGS_SCHEMA) + `src/settings.ts`

## Conventions

- `apiVersion: 2`, capabilities: `settings`, `hooks`, `rpc`, `notifications`
- ESM build only via tsup; `openfox` is externalized
- `.test.ts` files are co-located in `src/`; network is always mocked
- The plugin's host contract is declared locally in `src/index.ts` so typecheck
  does not depend on the installed `openfox` exporting `openfox/plugin`

## Known Gotchas

- `dist/index.js` is the entry point loaded by OpenFox, not `src/`.
- Path confirmations are **not** exposed as a plugin hook in OpenFox 2.0.x —
  they must be polled from `GET /api/sessions`
  (`pendingConfirmationsBySession`). Questions are read from
  `GET /api/sessions/:id` (`pendingQuestions`).
- `callback_data` is capped at 64 bytes → the bridge sends a short opaque token,
  never the `callId`.
- Background loops (`confirmationLoop`, `updatesLoop`) are started in `register()`
  and stopped in `deactivate()`; never start them twice.
- **Do not install this plugin from its own directory** through
  `POST /api/plugins/install {path}` — the host deletes the target before
  copying, which is the source itself. Install it via `plugins.txt`
  (`./sync.sh install-plugins`) or from a GitHub/Forgejo URL.

## Do Not Read / Do Not Touch

- `node_modules/`, `dist/`, `.git/`

## Further Reading

- [README.md](README.md) — overview and configuration

---

> After any change affecting structure, a command, a convention, or a primary
> flow, update this file in the same commit. If any information here is
> inaccurate, fix it.
