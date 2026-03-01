# Web

React + Vite UI for the local LLM Router gateway.

## What the UI Shows

- Startup diagnostics stream (visible immediately on load)
- Config status from `GET /v1/diag/status`
- Chat panel with streaming assistant tokens (`POST /v1/chat` SSE)
- Routing decision cards with:
  - route/model/confidence/reason
  - token/cost estimates and actual usage/cost
  - budget telemetry (`max_cost_usd`, expected-vs-budget, budget actions)
  - compaction telemetry

## Session Behavior

- Session ID is generated once and stored in browser `localStorage`
- Same `session_id` is sent on each chat request
- Decisions panel is updated by both SSE events and `/v1/logs` polling

## Environment

- `VITE_API_BASE_URL` (default compose value: `http://gateway:8080`)
- `VITE_GATEWAY_API_KEY` (optional; used when gateway API key guard is enabled)

## Local Dev

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm build
pnpm dev
```
