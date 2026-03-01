# Gateway

Fastify TypeScript API that routes chat requests, estimates cost, applies optional context compaction, and exposes diagnostics/logging endpoints.

## Core Routing Policy

The stage order is fixed:

1. `tool.calculator`
2. `llm.small`
3. `llm.mid`
4. `llm.big`

Cost-aware selection only happens among candidates in the current stage.

## Endpoints

- `POST /v1/chat`
- `GET /v1/logs?session_id=...&limit=200`
- `GET /v1/diag/status`
- `GET /v1/diag/stream` (SSE)
- `GET /health`

## `POST /v1/chat`

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

Optional fields:

- `max_cost_usd`: budget cap for expected cost
- `prefer_cheapest`: if false, prefer stage default model unless budget pressure overrides
- `verbosity`: `brief|normal|detailed`

Responses:

- `stream=false`: JSON with `model_used`, `route`, `content`, `usage`, `latency_ms`, `decision`
- `stream=true`: SSE with `meta`, `token`, `done`

If budget cannot be met in-tier after optimization, returns `422` with `expected_cost_est`, `max_cost_usd`, and `suggestions`.

## Limits and Validation

- `MAX_BODY_BYTES`: raw HTTP payload limit
- `MAX_MESSAGES`: max messages array length
- `MAX_CONTENT_CHARS`: max chars per user message (`413`)
- `MAX_REQUEST_CHARS`: max total incoming chars across all messages (`413`)

## Cost, Pricing, and Usage

Pricing config is loaded from `PRICING_CONFIG_DIR`:

- if value ends with `.json`, treated as direct file path
- otherwise `${PRICING_CONFIG_DIR}/config/pricing.json`

Pricing entry shape (per model):

- `logical_route`: `llm.small|llm.mid|llm.big`
- `provider`: `openai|ollama`
- `model`
- `in_per_1m`, `out_per_1m`
- optional `context_window`

Telemetry fields include:

- costs: `expected_cost_est`, `candidate_costs`, `chosen_reason`, `actual_cost`
- budget: `max_cost_usd`, `expected_cost_vs_budget`, `budget_actions`
- usage: `input_tokens_est`, `output_tokens_est`, `actual_usage`
- char usage: `usage.input_chars_user`, `usage.input_chars_total`, `usage.input_chars`

## Compaction Behavior

Free pruning always runs:

- keep latest system message
- keep last `COMPACT_KEEP_LAST_TURNS` turns
- trim large logs to last 120 lines unless explicitly requested otherwise
- dedupe repetitive assistant text

LLM compaction is conditional and reports:

- `compaction_attempted`, `compaction_applied`, `compaction_skipped_reason`
- `tokens_before_est`, `tokens_after_est`, `savings_tokens_est`
- `compactor_timeout_ms`, `compactor_latency_ms`, `compactor_cost_est`

`COMPACTOR_TIMEOUT_MS` controls compactor fetch timeout. When compaction is skipped, `compactor_timeout_ms` is `0`.

## Diagnostics

### `GET /v1/diag/status`

Returns:

- backend configured/reachable state
- pricing loaded/missing entry status
- startup report lines
- suggestions

### `GET /v1/diag/stream`

SSE stream:

- replay startup lines as `event: diag`
- emit `event: diag_done`
- continue streaming diagnostics

### `GET /health`

Always returns HTTP 200 with current diagnostic health status in body.

## Logs

`GET /v1/logs` returns newest-first per-session entries from in-memory ring buffer (max 500 per session).

Each entry includes route/model/cost/usage/compaction/budget/error fields.

## Security Controls

- Request size + rate limits
- CORS allowlist (`CORS_ORIGIN`)
- Optional API key guard (`GATEWAY_API_KEY`)
- SSRF guard for `OLLAMA_BASE_URL`
- Redacted secrets in diagnostics/logs

## Evaluation Harness

Run benchmark evaluation:

```bash
docker compose run --rm gateway pnpm eval
```

- Cases: `eval/cases.jsonl`
- Report: `eval/report.json`

Modes:

- baseline: forced `llm.big`, no compaction, detailed verbosity
- routed: normal policy, compaction enabled, normal verbosity

## Environment Variables

### Provider/Auth

- `OPENAI_API_KEY`
- `OPENAI_SMALL_MODEL`, `OPENAI_MID_MODEL`, `OPENAI_BIG_MODEL`
- `OLLAMA_BASE_URL`, `OLLAMA_MODEL`
- `GATEWAY_API_KEY`

### Limits/Networking

- `PORT`, `CORS_ORIGIN`
- `MAX_BODY_BYTES`, `MAX_MESSAGES`, `MAX_CONTENT_CHARS`, `MAX_REQUEST_CHARS`
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_CHAT_MAX`, `RATE_LIMIT_SSE_MAX`
- `MAX_DIAG_CLIENTS`, `MAX_CHAT_STREAM_CLIENTS`, `MAX_SESSION_KEYS`
- `FETCH_TIMEOUT_MS`

### Cost/Compaction/Pricing

- `MAX_OUTPUT_TOKENS_SMALL`, `MAX_OUTPUT_TOKENS_MID`, `MAX_OUTPUT_TOKENS_BIG`
- `MAX_INPUT_TOKENS_TOOL`, `MAX_INPUT_TOKENS_MATH`, `MAX_INPUT_TOKENS_MID`, `MAX_INPUT_TOKENS_BIG`
- `COMPACT_KEEP_LAST_TURNS`, `COMPACT_MIN_SAVINGS_TOKENS`
- `COMPACTOR_PROVIDER`, `COMPACTOR_MODEL`, `COMPACTOR_BASE_URL`
- `COMPACTOR_OUTPUT_TOKENS_EST`, `COMPACTOR_TIMEOUT_MS`
- `PRICING_CONFIG_DIR`

## Local Dev

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm dev
```
