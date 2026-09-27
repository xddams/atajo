# Atajo

Personal AI assistant MVP on **Cloudflare Workers** — chat-first, memory shelves, reminders, confirm-gated connectors.

Inspired by personal-assistant product patterns (MAPA checklist §8); **not** a Zapia clone. No proprietary binaries. No Lovable.

## MAPA §8 → Atajo MVP

| Checklist item | Implementation |
|----------------|----------------|
| Chat thread + empty state + composer | HOME chat UI (`public/`), `/api/chat` |
| Auth + session | Email/password + HttpOnly cookie session in D1 |
| HTTP gateway | Hono on Workers (`/api/*`) |
| WebSocket progress | `/api/chat/ws` |
| Scheduled jobs | D1 reminders + Cron Trigger `* * * * *` |
| Connectors | Stub registry: whatsapp, google, places, ifood, share_file |
| Radar-lite | `/api/radar/lite` — speaks only when something is due/pending |

## Stack

- Cloudflare Workers + Wrangler + TypeScript
- Hono
- D1 (users, sessions, messages, memory_shelves, reminders, pending_actions)
- Workers AI (tool loop) with heuristic fallback for reminders/memory
- Static assets (chat UI)

## Auth note

MVP uses **simple email/password sessions** stored in D1 (PBKDF2 via Web Crypto). For production, prefer **Cloudflare Access** in front of the Worker (Zero Trust) and treat Access JWT / service tokens as the identity source — keep the same per-user D1 rows keyed by Access email/`sub`.

## Local run

```bash
npm install
npx wrangler d1 migrations apply atajo-db --local
npm run dev
```

Open http://localhost:8787

Create an account on the sign-in screen, then try:

- `Remind me in 1 minute to stretch`
- `Remember that I prefer short replies`
- `Send a WhatsApp to Mom saying I'll be late` → confirm card (stub / not connected)

## Deploy

1. Create a remote D1 database and put its id in `wrangler.jsonc`:

```bash
npx wrangler d1 create atajo-db
# paste database_id into wrangler.jsonc d1_databases[0].database_id
npx wrangler d1 migrations apply atajo-db --remote
```

2. Optional secrets:

```bash
npx wrangler secret put TAVILY_API_KEY   # live web_search
npx wrangler secret put SESSION_SECRET  # optional
```

3. Deploy:

```bash
npm run deploy
# or: npx wrangler deploy
```

For live Workers AI in local/dev, set `"remote": true` under `ai` in `wrangler.jsonc` and `wrangler login`. Without it, reminder/memory/confirm heuristics still work. Cron fires due reminders every minute on deploy (locally: `curl http://127.0.0.1:8787/cdn-cgi/local/scheduled`).

## Tool registry

Working: `memory_read` / `memory_write`, `reminder_create` / `reminder_list`, `request_external_action` / `list_pending_actions`, `web_search` (Tavily or stub).

Stubs (`not_connected`): `whatsapp`, `google`, `places`, `ifood`, `share_file`.

## Repo layout

```
src/index.ts          Worker entry (fetch + scheduled)
src/auth/             sessions
src/chat/             system prompt + tool loop
src/db/               D1 queries
src/tools/registry.ts tool catalog
src/reminders/cron.ts reminder fire + radar-lite
public/               chat SPA
migrations/           D1 SQL
```

## License

Private / unpublished unless you choose otherwise.
