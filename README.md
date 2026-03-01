# LLM Router Proxy (Gateway + Web)

Local-first LLM routing gateway with a companion web UI.

- `gateway`: Fastify + TypeScript API for routing, cost-aware model selection, diagnostics, and logs
- `web`: React + Vite UI for chat, live startup diagnostics, and per-request routing/cost telemetry

## What It Does

For each chat request, the gateway selects a route using a tiered policy and then picks an eligible model inside that tier.

Routing policy (fixed order):

1. `tool.calculator` (deterministic math/unit conversion)
2. `llm.small`
3. `llm.mid`
4. `llm.big`

Cost optimization is applied only within the allowed stage (never across stages).

## Architecture

```text
Browser UI (web:3000)
   |  HTTP + SSE
   v
Gateway API (gateway:8080)
   |
   +--> Router decision (tool -> small -> mid -> big)
   |
   +--> Tool: calculator (+ - * / () ^, %, units km/mi kg/lb c/f)
   |
   +--> LLM adapters
          |- OpenAI (small/mid/big)
          |- Ollama (optional, typically llm.small)
   |
   +--> Compaction + cost estimation + pricing lookup
   |
   +--> In-memory logs + diagnostics stream/status
```

## Quickstart

1. Create env file:

```bash
cp .env.example .env
```

2. Set required values:

- `OPENAI_API_KEY` for OpenAI routes
- optional `OLLAMA_BASE_URL` + `OLLAMA_MODEL` for local small-model routing

3. Start:

```bash
docker compose up --build
```

4. Open:

- UI: `http://localhost:3000`
- Gateway: `http://localhost:8080`

If diagnostics report missing config, update `.env` and restart.

## Docker Compose Notes

- Gateway uses `env_file: ./.env`
- Published ports:
  - gateway: `8080:8080`
  - web: `3000:80`

## Environment Variables

Use `.env.example` as the template. Grouped summary:

### Provider/Auth

- `OPENAI_API_KEY`
- `OPENAI_SMALL_MODEL`, `OPENAI_MID_MODEL`, `OPENAI_BIG_MODEL`
- `OLLAMA_BASE_URL`, `OLLAMA_MODEL`
- `GATEWAY_API_KEY` (optional request guard)

### Routing, Output, Budget

- `MAX_OUTPUT_TOKENS_SMALL`, `MAX_OUTPUT_TOKENS_MID`, `MAX_OUTPUT_TOKENS_BIG`
- `MAX_INPUT_TOKENS_TOOL`, `MAX_INPUT_TOKENS_MATH`, `MAX_INPUT_TOKENS_MID`, `MAX_INPUT_TOKENS_BIG`

### Compaction

- `COMPACT_KEEP_LAST_TURNS`
- `COMPACT_MIN_SAVINGS_TOKENS`
- `COMPACTOR_PROVIDER`, `COMPACTOR_MODEL`, `COMPACTOR_BASE_URL`
- `COMPACTOR_OUTPUT_TOKENS_EST`
- `COMPACTOR_TIMEOUT_MS`

### Limits / Ops / Networking

- `PORT`, `CORS_ORIGIN`
- `MAX_BODY_BYTES`, `MAX_MESSAGES`, `MAX_CONTENT_CHARS`, `MAX_REQUEST_CHARS`
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_CHAT_MAX`, `RATE_LIMIT_SSE_MAX`
- `MAX_DIAG_CLIENTS`, `MAX_CHAT_STREAM_CLIENTS`, `MAX_SESSION_KEYS`
- `FETCH_TIMEOUT_MS`, `LOG_TRACE_USAGE`

### Pricing

- `PRICING_CONFIG_DIR` (directory or direct JSON path)

#### `.env` snippet (placeholders only)

```env
OPENAI_API_KEY=replace_me
OPENAI_SMALL_MODEL=gpt-4o-mini
OPENAI_MID_MODEL=gpt-4.1-mini
OPENAI_BIG_MODEL=gpt-4.1

OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=llama3:latest

PRICING_CONFIG_DIR=/app
COMPACTOR_TIMEOUT_MS=20000
```

## API

### `POST /v1/chat`

Request body:

```json
{
  "session_id": "optional",
  "messages": [{ "role": "user", "content": "2 + 2" }],
  "stream": true,
  "max_cost_usd": 0.002,
  "prefer_cheapest": true,
  "verbosity": "normal"
}
```

Optional request fields:

- `max_cost_usd`: per-request budget ceiling (expected cost)
- `prefer_cheapest`: when `false`, policy-default model is preferred unless budget pressure forces cheaper in-tier model
- `verbosity`: `brief|normal|detailed` (affects output-token estimate)

#### Non-stream response (`stream=false`)

```json
{
  "model_used": "...",
  "route": "...",
  "content": "...",
  "usage": {
    "input_chars_user": 10,
    "input_chars_total": 120,
    "input_chars": 120,
    "output_chars": 80
  },
  "latency_ms": 1234,
  "decision": { "...telemetry..." }
}
```

#### Stream response (`stream=true`, SSE)

Events:

- `event: meta` (routing + telemetry)
- `event: token` (`{ "delta": "..." }`)
- `event: done` (`content`, `usage`, `latency_ms`, costs/compaction telemetry)

#### 422 budget response

If expected cost remains above budget after optimizations:

```json
{
  "error": "Request exceeds max_cost_usd for available in-tier candidates",
  "request_id": "...",
  "expected_cost_est": 0.0005,
  "max_cost_usd": 0.0001,
  "route": "llm.mid",
  "suggestions": ["..."]
}
```

### `GET /v1/logs?session_id=...&limit=200`

Returns latest entries (newest-first) from in-memory per-session ring buffer.

### `GET /v1/diag/status`

Returns startup/backend/pricing diagnostics summary with suggestions.

### `GET /v1/diag/stream`

SSE stream:

- replays startup diagnostic lines as `event: diag`
- emits `event: diag_done`
- then pushes new diagnostic lines live

### `GET /health`

Always HTTP 200; `ok` reflects startup diagnostic health.

## Cost / Budget / Compaction Behavior

### Cost metrics

- `expected_cost_est`: estimated from token estimates + pricing
- `actual_cost`: computed when provider token usage is available

### Budget actions

When `max_cost_usd` is set and estimate is over budget, gateway attempts in this order:

1. compaction (if it helps per compactor rules)
2. reduce output token target
3. switch to cheaper model within the same allowed tier

If still over budget: returns `422`.

### Compaction

Free pruning always runs before optional LLM compaction:

- keep latest system message
- keep last `COMPACT_KEEP_LAST_TURNS` turns
- dedupe repetitive assistant verbosity
- trim large log-like blocks to last `120` lines unless user asks for full logs

LLM compaction runs when trigger conditions match (over budget / token savings / cost-savings ratio).

Compaction telemetry fields include:

- `compacted`, `compaction_attempted`, `compaction_applied`, `compaction_skipped_reason`
- `tokens_before_est`, `tokens_after_est`, `savings_tokens_est`
- `compactor_timeout_ms`, `compactor_latency_ms`, `compactor_cost_est`, `compaction_error`

## Validation Limits

- `MAX_CONTENT_CHARS`: enforced per **user** message (`413`)
- `MAX_REQUEST_CHARS`: enforced on total incoming chars across all messages (`413`)
- `MAX_BODY_BYTES`: Fastify body parser limit

## Diagnostics UI Behavior

On page load, web immediately:

- opens `/v1/diag/stream`
- fetches `/v1/diag/status`
- polls `/v1/logs` for active session

No chat message is needed to view startup diagnostics.

## Observability Fields (decision/logs)

Common fields:

- route/model: `route`, `model_used`, `fallback_used`, `tool_used`
- costs: `expected_cost_est`, `candidate_costs`, `chosen_reason`, `actual_cost`
- budget: `max_cost_usd`, `expected_cost_vs_budget`, `budget_actions`
- usage: `input_tokens_est`, `output_tokens_est`, `actual_usage`
- compaction: `compacted`, `tokens_before_est`, `tokens_after_est`, `savings_tokens_est`, `compaction_*`

`usage.input_chars` semantics:

- `input_chars_user`: last user message chars
- `input_chars_total`: outgoing provider payload chars
- `input_chars`: alias of `input_chars_total`

## Evaluation Harness

Run:

```bash
docker compose run --rm gateway pnpm eval
```

Inputs/outputs:

- cases: `gateway/eval/cases.jsonl`
- report: `gateway/eval/report.json`

Mode behavior:

- baseline: forced `llm.big`, compaction disabled, detailed verbosity
- routed: normal router + compaction, normal verbosity

Summary includes total cost, latency stats, route distribution, compaction rate, `422` count, and failures.

## Security Notes

- Local-first by default; do not expose publicly without stronger auth/network controls.
- Optional API key gate via `GATEWAY_API_KEY`.
- `OLLAMA_BASE_URL` is validated to local/private targets.
- Never commit `.env`; use `.env.example`.
- Diagnostics redact secrets (API keys are not returned raw).

## Troubleshooting

- Missing pricing entries:
  - check `/v1/diag/status` suggestions
  - ensure `gateway/config/pricing.json` contains configured route/provider/model entries

- Provider unreachable:
  - OpenAI: verify `OPENAI_API_KEY` and egress
  - Ollama on macOS Docker: use `http://host.docker.internal:11434`

- Compactor timeout:
  - increase `COMPACTOR_TIMEOUT_MS`
  - verify `COMPACTOR_PROVIDER` connectivity

- `413` errors:
  - per-user message too large (`MAX_CONTENT_CHARS`) or total request too large (`MAX_REQUEST_CHARS`)

- `422` errors:
  - request budget too low for in-tier candidates even after optimization

## Verified On

These commands were used to validate docs/examples and build behavior:

```bash
docker compose run --rm gateway pnpm eval
docker run --rm -e CI=true --env-file ./.env -v "$PWD/gateway":/app -w /app node:20-alpine sh -lc "npm i -g pnpm >/dev/null && pnpm install --no-frozen-lockfile >/dev/null && pnpm build >/dev/null && node dist/scripts/eval.js --file eval/cases.jsonl"
```
