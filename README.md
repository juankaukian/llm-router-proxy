# LLM Router Proxy (Gateway + Web)

Docker-first local app with:

- `gateway` (Fastify + TypeScript)
- `web` (React + Vite + TypeScript)

## Repository Layout

- `docker-compose.yml`
- `.env.example`
- `gateway/`
- `web/`
- `LICENSE`
- `CONTRIBUTING.md`

## Quick Start

1. Create local env file (used by compose `env_file`):

```bash
cp .env.example .env
```

2. Fill required values in `.env`:

- `OPENAI_API_KEY` (if using OpenAI)
- optional Ollama vars (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`)

3. Start:

```bash
docker compose up --build
```

4. Open:

- Web UI: `http://localhost:3000`
- Gateway: `http://localhost:8080`

If diagnostics report missing env vars, update `.env` and restart compose.

## API Overview

### `POST /v1/chat`

Request body:

```json
{
  "session_id": "optional",
  "messages": [{ "role": "user", "content": "2 + 2" }],
  "stream": true
}
```

- `stream=false`: JSON response with model/route/content/usage/latency/decision
- `stream=true`: SSE events
  - `meta`
  - `token`
  - `done`

### `GET /v1/logs?session_id=...&limit=200`

Per-session routing logs (newest first).

### `GET /v1/diag/status`

Startup diagnostics status and suggestions.

### `GET /v1/diag/stream`

SSE diagnostics stream: replays startup report, emits `diag_done`, then pushes new diagnostic lines.

### `GET /health`

Always HTTP 200:

```json
{ "ok": true, "details": { "...": "..." } }
```

## Diagnostics UI

On page load, the web app immediately:

- opens diagnostic stream (`/v1/diag/stream`)
- renders startup events in console panel
- fetches `/v1/diag/status`
- shows backend config/reachability table

No chat message is required to see startup diagnostics.

## Security Notes

- Local-first defaults; CORS restricted to local web origins by default.
- `OLLAMA_BASE_URL` is restricted to local/private targets (SSRF guard).
- Request size and message count limits are enforced.
- In-memory rate limits protect `/v1/chat`, `/v1/logs`, `/v1/diag/*`.
- Outbound provider calls use request timeouts.
- Secrets are never returned by diagnostics endpoints; API keys are redacted in startup logs.
- Optional API-key gate:
  - Set `GATEWAY_API_KEY` to require key on API endpoints (except `/health`).
  - Web can send this via `VITE_GATEWAY_API_KEY`.

Do not expose this stack publicly without adding stronger auth and network controls.

## Troubleshooting

- `Stream failed: Failed to fetch`
  - Ensure gateway is running on `:8080`.
  - Hard-refresh web UI after rebuild.
  - Check browser devtools for CORS/network errors.

- OpenAI probe fails
  - Verify `OPENAI_API_KEY` in `.env`.
  - Verify gateway container has internet access.

- Ollama probe fails in Docker on macOS
  - Use `OLLAMA_BASE_URL=http://host.docker.internal:11434`.
  - Confirm from container:
    - `docker compose exec gateway wget -qO- http://host.docker.internal:11434/api/tags`

## Dev Quality Commands

Gateway:

```bash
cd gateway
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Web:

```bash
cd web
pnpm typecheck
pnpm lint
pnpm build
```
