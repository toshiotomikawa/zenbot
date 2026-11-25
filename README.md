# ZenBot

Discord bot built with Node.js (ES modules), combining HTTP interactions in Express with a minimal Gateway connection.

## Features

- **Slash commands & utilities:** dice roller, D&D 5e condition reference, Epic Games free games, Epic/Fortnite server status, Fortnite item shop/map/profile lookup, X/Twitter post card PNG renderer (`@napi-rs/canvas`), admin channel message purge, and OpenRouter Free diagnostics.
- **Gateway presence & events:** custom presence, deduplicated member join logging, forum auto-reaction, role-gated `@mention` replies via OpenRouter Free, and optional team mention forwarding.
- **MCP OAuth resource server (`/mcp`):** stateless Streamable HTTP MCP server validated with RS256 OAuth Bearer tokens (`jose`), exposing opt-in fail-closed Discord read/write tools for issue threads, research forums, and category-scoped channels/forums.
- **GPT Actions OpenAPI adapter (`/actions`):** Bearer-authenticated REST/OpenAPI 3.0.3 adapter sharing the same fail-closed Discord services, multi-bot identity mention queues, and signed Agent-to-Human (A2H) approval requests.
- **Integrations:** GitHub HMAC-SHA256 webhook for PR-merge task completion (`POST /webhooks/github-events`) and optional X API v2 Filtered Stream mirror (`@FortniteStatus`).

## Quick Start

Requires Node.js 18+.

```bash
npm install
cp .env.example .env
npm run register
npm start
```

Configure all credentials and Discord snowflakes in `.env` (see [`.env.example`](.env.example)). Every optional subsystem (MCP, GPT Actions, Discord read/write, GitHub webhooks, A2H, and X Filtered Stream) is opt-in and fails closed when unconfigured.

## Scripts

- `npm start` — run the bot (`node app.js`).
- `npm run dev` — run with `nodemon`.
- `npm run register` — register slash commands with Discord.
- `npm test` — run the offline unit test suite.
- `npm run fortnite-status-stream-dryrun` — dry-run the X Filtered Stream renderer against local fixtures.
- `npm run mcp-responses-smoke` — read-only smoke test for OpenAI Responses API → MCP connectivity.

## License

[MIT](LICENSE)
