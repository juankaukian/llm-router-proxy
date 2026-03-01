# Web

React + Vite UI for chat, routing decisions, and startup diagnostics.

## Features

- Startup diagnostics stream panel visible on initial page load
- Config status table from `/v1/diag/status`
- Chat panel with streaming assistant responses
- Routing decision cards per request
- Session UUID persisted in browser localStorage

## Environment

- `VITE_API_BASE_URL`
- `VITE_GATEWAY_API_KEY` (optional, if gateway API key protection is enabled)

## Local Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm build
pnpm dev
```
