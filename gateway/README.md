# Gateway

Fastify TypeScript API for routing chat requests and exposing startup diagnostics.

## Endpoints

- `POST /v1/chat`
- `GET /v1/logs?session_id=...&limit=200`
- `GET /v1/diag/status`
- `GET /v1/diag/stream` (SSE)
- `GET /health`

## Startup Diagnostics

On boot, gateway runs checks for configured providers:

- OpenAI env + probe (`GET /v1/models` if key exists)
- Ollama env + probe (`GET /api/tags`)
- model configuration verification notes

Diagnostic lines are:

- emitted as JSONL to stdout
- stored in memory (ring buffer)
- streamed to `/v1/diag/stream`

## Security Controls

- Strict request body limit (`MAX_BODY_BYTES`)
- Message count/content size limits
- In-memory rate limits for chat/logs/diagnostics endpoints
- Outbound fetch timeouts
- SSRF guard for `OLLAMA_BASE_URL` (local/private targets only)
- CORS allowlist via `CORS_ORIGIN`
- Optional API-key guard via `GATEWAY_API_KEY`

## Environment Variables

- `PORT`
- `OPENAI_API_KEY`
- `OPENAI_SMALL_MODEL`
- `OPENAI_MID_MODEL`
- `OPENAI_BIG_MODEL`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `CORS_ORIGIN`
- `MAX_BODY_BYTES`
- `MAX_MESSAGES`
- `MAX_CONTENT_CHARS`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_CHAT_MAX`
- `RATE_LIMIT_SSE_MAX`
- `MAX_DIAG_CLIENTS`
- `MAX_CHAT_STREAM_CLIENTS`
- `MAX_SESSION_KEYS`
- `FETCH_TIMEOUT_MS`
- `GATEWAY_API_KEY`

## Local Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm dev
```
