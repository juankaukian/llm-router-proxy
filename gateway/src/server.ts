import 'dotenv/config';
import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { URL } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { OpenAIAdapter } from './adapters/openai.js';
import { OllamaAdapter } from './adapters/ollama.js';
import { maybeCompactContext } from './compaction/compactor.js';
import { estimateOutputTokens } from './cost/outputPredictor.js';
import { expectedCostUSD, findPricingByProviderModel, findPricingEntry, listRoutePricingCandidates, loadPricingConfig } from './cost/pricing.js';
import { chooseCheapestReachableCandidate } from './cost/selector.js';
import { estimateInputTokens } from './cost/tokenEstimator.js';
import { RequestRouter } from './router.js';
import { evaluateMath } from './tools/calculator.js';
import { computeRequestCharMetrics, exceedsMaxRequestChars, validateMessageShape } from './validation.js';
import type { ChatMessage, ChatRequestBody, ChatJsonResponse, CostCandidate, RequestLogEntry, RouterDecision, SessionState, TokenUsage, Usage } from './types.js';

const PORT = Number(process.env.PORT ?? 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_SMALL_MODEL = process.env.OPENAI_SMALL_MODEL ?? 'gpt-4o-mini';
const OPENAI_MID_MODEL = process.env.OPENAI_MID_MODEL ?? 'gpt-4.1-mini';
const OPENAI_BIG_MODEL = process.env.OPENAI_BIG_MODEL ?? 'gpt-4.1';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 65_536);
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES ?? 40);
const MAX_CONTENT_CHARS = Number(process.env.MAX_CONTENT_CHARS ?? 8_000);
const MAX_REQUEST_CHARS = Number(process.env.MAX_REQUEST_CHARS ?? 32_000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_CHAT_MAX = Number(process.env.RATE_LIMIT_CHAT_MAX ?? 60);
const RATE_LIMIT_SSE_MAX = Number(process.env.RATE_LIMIT_SSE_MAX ?? 20);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 8_000);
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY ?? '';
const PRICING_CONFIG_DIR = process.env.PRICING_CONFIG_DIR ?? process.cwd();
const MAX_INPUT_TOKENS_TOOL = Number(process.env.MAX_INPUT_TOKENS_TOOL ?? 8_000);
const MAX_INPUT_TOKENS_MATH = Number(process.env.MAX_INPUT_TOKENS_MATH ?? 12_000);
const MAX_INPUT_TOKENS_MID = Number(process.env.MAX_INPUT_TOKENS_MID ?? 24_000);
const MAX_INPUT_TOKENS_BIG = Number(process.env.MAX_INPUT_TOKENS_BIG ?? 64_000);
const COMPACT_KEEP_LAST_TURNS = Number(process.env.COMPACT_KEEP_LAST_TURNS ?? 6);
const COMPACT_KEEP_LAST_LOG_LINES = 120;
const COMPACT_MIN_SAVINGS_TOKENS = Number(process.env.COMPACT_MIN_SAVINGS_TOKENS ?? 1000);
const COMPACTOR_OUTPUT_TOKENS_EST = Number(process.env.COMPACTOR_OUTPUT_TOKENS_EST ?? 600);
const COMPACTOR_TIMEOUT_MS = Number(process.env.COMPACTOR_TIMEOUT_MS ?? 20000);
const LOG_TRACE_USAGE = process.env.LOG_TRACE_USAGE === 'true';

type DiagLevel = 'info' | 'warn' | 'error';
interface DiagLine {
  ts: string;
  level: DiagLevel;
  message: string;
  data?: Record<string, unknown>;
}

interface BackendStatus {
  configured: boolean;
  reachable: boolean;
  notes: string[];
  missing_env: string[];
}

interface DiagStatus {
  ok: boolean;
  backends: {
    openai: BackendStatus & { models: { small: string; mid: string; big: string } };
    ollama: BackendStatus & { model: string | null };
  };
  pricing: {
    loaded: boolean;
    path: string;
    currency: string;
    warnings: string[];
    missing_entries: Array<{ route: 'llm.small' | 'llm.mid' | 'llm.big'; provider: 'openai' | 'ollama'; model: string }>;
    example_cost_1k_in_1k_out: Array<{
      route: 'llm.small' | 'llm.mid' | 'llm.big';
      provider: 'openai' | 'ollama';
      model: string;
      in_per_1m: number;
      out_per_1m: number;
      expected_cost_usd: number;
    }>;
  };
  last_startup_report: DiagLine[];
  suggestions: string[];
}

const useOllamaSmall = Boolean(OLLAMA_BASE_URL && OLLAMA_MODEL);
const COMPACTOR_PROVIDER = (process.env.COMPACTOR_PROVIDER ?? (useOllamaSmall ? 'ollama' : 'openai')) as 'openai' | 'ollama';
const COMPACTOR_MODEL = process.env.COMPACTOR_MODEL ?? (useOllamaSmall ? (OLLAMA_MODEL ?? OPENAI_SMALL_MODEL) : OPENAI_SMALL_MODEL);
const COMPACTOR_BASE_URL = process.env.COMPACTOR_BASE_URL ?? OLLAMA_BASE_URL ?? '';
const openai = OPENAI_API_KEY ? new OpenAIAdapter(OPENAI_API_KEY) : null;
const ollama = useOllamaSmall ? new OllamaAdapter((OLLAMA_BASE_URL as string).replace(/\/$/, '')) : null;

const router = new RequestRouter({
  small: useOllamaSmall ? (OLLAMA_MODEL as string) : OPENAI_SMALL_MODEL,
  mid: OPENAI_MID_MODEL,
  big: OPENAI_BIG_MODEL
});
const pricingLoad = loadPricingConfig(PRICING_CONFIG_DIR);
const pricingConfig = pricingLoad.config;

const sessions = new Map<string, SessionState>();
const logsBySession = new Map<string, RequestLogEntry[]>();
const LOG_BUFFER_MAX = 500;
const DIAG_BUFFER_MAX = 1000;
const MAX_DIAG_CLIENTS = Number(process.env.MAX_DIAG_CLIENTS ?? 50);
const MAX_CHAT_STREAM_CLIENTS = Number(process.env.MAX_CHAT_STREAM_CLIENTS ?? 100);
const MAX_SESSION_KEYS = Number(process.env.MAX_SESSION_KEYS ?? 500);

const diagnosticsBuffer: DiagLine[] = [];
let lastStartupReport: DiagLine[] = [];
const diagClients = new Set<ServerResponse>();
const chatStreamClients = new Set<ServerResponse>();
const rateLimits = new Map<string, { count: number; resetAt: number }>();
let startupSummary: {
  startup_ok: boolean;
  summary: { openai_ok: boolean; ollama_ok: boolean; missing_env: string[] };
} = {
  startup_ok: false,
  summary: { openai_ok: false, ollama_ok: false, missing_env: [] }
};

const diagStatus: DiagStatus = {
  ok: false,
  backends: {
    openai: {
      configured: false,
      reachable: false,
      models: { small: OPENAI_SMALL_MODEL, mid: OPENAI_MID_MODEL, big: OPENAI_BIG_MODEL },
      notes: [],
      missing_env: []
    },
    ollama: {
      configured: false,
      reachable: false,
      model: OLLAMA_MODEL ?? null,
      notes: [],
      missing_env: []
    }
  },
  pricing: {
    loaded: pricingLoad.loaded,
    path: pricingLoad.path,
    currency: pricingConfig.currency,
    warnings: pricingLoad.warnings,
    missing_entries: [],
    example_cost_1k_in_1k_out: []
  },
  last_startup_report: [],
  suggestions: []
};
const reachableModels = new Set<string>();

const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES });
const allowedOrigins = CORS_ORIGIN.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) {
      cb(null, true);
      return;
    }
    if (allowedOrigins.includes(origin)) {
      cb(null, true);
      return;
    }
    cb(new Error('Origin not allowed'), false);
  }
});

app.addHook('preHandler', async (request, reply) => {
  cleanupRateLimits();

  if (GATEWAY_API_KEY && request.url !== '/health') {
    const headerKey = request.headers['x-api-key'];
    const queryKey = typeof (request.query as Record<string, unknown> | undefined)?.api_key === 'string'
      ? ((request.query as Record<string, unknown>).api_key as string)
      : '';
    const provided = typeof headerKey === 'string' ? headerKey : queryKey;
    if (provided !== GATEWAY_API_KEY) {
      reply.code(401);
      return { error: 'Unauthorized' };
    }
  }

  return undefined;
});

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseHeaders(origin?: string): Record<string, string> {
  const headerOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? '*';
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': headerOrigin,
    Vary: 'Origin'
  };
}

function clientKey(request: { ip: string; headers: Record<string, unknown> }): string {
  const forwarded = typeof request.headers['x-forwarded-for'] === 'string' ? request.headers['x-forwarded-for'].split(',')[0]?.trim() : '';
  return forwarded || request.ip || 'unknown';
}

function checkRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  const existing = rateLimits.get(key);
  if (!existing || now > existing.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (existing.count >= limit) {
    return false;
  }
  existing.count += 1;
  rateLimits.set(key, existing);
  return true;
}

function cleanupRateLimits(): void {
  const now = Date.now();
  for (const [key, value] of rateLimits.entries()) {
    if (value.resetAt <= now) {
      rateLimits.delete(key);
    }
  }
}

function truncateError(message: string): string {
  return message.slice(0, 180);
}

function safeSseWrite(target: ServerResponse, event: string, data: unknown): boolean {
  if (target.writableEnded || target.destroyed) {
    return false;
  }
  try {
    target.write(sse(event, data));
    return true;
  } catch {
    return false;
  }
}

function isAllowedOllamaBaseUrl(value: string | undefined): { ok: boolean; reason?: string } {
  if (!value) {
    return { ok: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'Invalid URL format' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'Only http/https protocols are allowed' };
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === 'host.docker.internal' || host === '127.0.0.1' || host === '::1';
  const isPrivateIpv4 =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);

  if (!isLoopback && !isPrivateIpv4) {
    return { ok: false, reason: 'Only local/private Ollama base URLs are allowed' };
  }

  return { ok: true };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function emitDiag(line: DiagLine): void {
  diagnosticsBuffer.push(line);
  if (diagnosticsBuffer.length > DIAG_BUFFER_MAX) {
    diagnosticsBuffer.splice(0, diagnosticsBuffer.length - DIAG_BUFFER_MAX);
  }

  process.stdout.write(`${JSON.stringify({ ...line, kind: 'diag' })}\n`);

  for (const client of diagClients) {
    if (client.writableEnded || client.destroyed) {
      diagClients.delete(client);
      continue;
    }
    try {
      client.write(sse('diag', line));
    } catch {
      diagClients.delete(client);
    }
  }
}

function addStartupLine(report: DiagLine[], level: DiagLevel, message: string, data?: Record<string, unknown>): void {
  const line: DiagLine = { ts: new Date().toISOString(), level, message, data };
  report.push(line);
  emitDiag(line);
}

function redactValue(value: string): string {
  if (!value) {
    return '';
  }
  if (value.length <= 6) {
    return '***redacted***';
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function getSession(sessionId?: string): SessionState | undefined {
  if (!sessionId) {
    return undefined;
  }
  return sessions.get(sessionId);
}

function enforceMapLimit<T>(map: Map<string, T>, limit: number): void {
  while (map.size > limit) {
    const oldestKey = map.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    map.delete(oldestKey);
  }
}

function persistSession(sessionId: string | undefined, route: string, modelUsed: string, user: string, assistant: string): void {
  if (!sessionId) {
    return;
  }

  const existing: SessionState = sessions.get(sessionId) ?? { turns: [] };
  const userTurn: ChatMessage = { role: 'user', content: user };
  const assistantTurn: ChatMessage = { role: 'assistant', content: assistant };
  const turns = [...existing.turns, userTurn, assistantTurn].slice(-6);

  sessions.set(sessionId, {
    last_route: route,
    last_model_used: modelUsed,
    turns
  });
  enforceMapLimit(sessions, MAX_SESSION_KEYS);
}

function buildMessages(messages: ChatMessage[], session?: SessionState): ChatMessage[] {
  if (!session || session.turns.length === 0) {
    return messages;
  }

  const summary = session.turns
    .map((turn, idx) => `${idx + 1}. ${turn.role}: ${turn.content.slice(0, 220)}`)
    .join('\n');

  return [
    {
      role: 'system',
      content:
        'Session context summary (last 6 turns):\n' +
        summary +
        '\nUse this context only when relevant, and avoid repeating the summary verbatim.'
    },
    ...messages
  ];
}

function makeUsage(inputCharsUser: number, inputCharsTotal: number, outputChars: number): Usage {
  return {
    input_chars_user: inputCharsUser,
    input_chars_total: inputCharsTotal,
    input_chars: inputCharsTotal,
    output_chars: outputChars
  };
}

function getLastUser(messages: ChatMessage[]): string {
  return [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
}

function pushLog(entry: RequestLogEntry): void {
  const list = logsBySession.get(entry.session_id) ?? [];
  list.push(entry);
  if (list.length > LOG_BUFFER_MAX) {
    list.splice(0, list.length - LOG_BUFFER_MAX);
  }
  logsBySession.set(entry.session_id, list);
  enforceMapLimit(logsBySession, MAX_SESSION_KEYS);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  if (LOG_TRACE_USAGE) {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'trace',
        kind: 'usage_lengths',
        request_id: entry.request_id,
        session_id: entry.session_id,
        input_chars_user: entry.usage.input_chars_user,
        input_chars_total: entry.usage.input_chars_total,
        max_content_chars: MAX_CONTENT_CHARS,
        max_request_chars: MAX_REQUEST_CHARS
      })}\n`
    );
  }
}

function makeLogEntry(args: {
  requestId: string;
  sessionId: string;
  userExcerpt: string;
  route: string;
  modelUsed: string;
  confidence: number;
  reason: string;
  fallbackUsed: boolean;
  toolUsed: boolean;
  latencyMs: number;
  usage: Usage;
  inputTokensEst?: number;
  outputTokensEst?: number;
  expectedCostEst?: number;
  candidateCosts?: CostCandidate[];
  chosenReason?: 'cheapest_by_expected_cost' | 'policy_default';
  maxCostUsd?: number;
  budgetActions?: Array<'compacted' | 'reduced_output_tokens' | 'model_switched'>;
  expectedCostVsBudget?: string;
  actualUsage?: TokenUsage;
  actualCost?: number;
  compacted?: boolean;
  tokensBeforeEst?: number;
  tokensAfterEst?: number;
  savingsTokensEst?: number;
  expectedCostSavingsEst?: number;
  compactorExpectedCostEst?: number;
  compactorCostEst?: number;
  compactorTimeoutMs?: number;
  compactorLatencyMs?: number;
  compactionReason?: 'over_budget' | 'worth_it';
  compactionAttempted?: boolean;
  compactionApplied?: boolean;
  compactionSkippedReason?: 'skipped_threshold' | 'tool_route' | 'code_edit_preserve';
  compactionError?: string;
  error: string | null;
}): RequestLogEntry {
  return {
    ts: new Date().toISOString(),
    request_id: args.requestId,
    session_id: args.sessionId,
    user_excerpt: args.userExcerpt,
    route: args.route,
    model_used: args.modelUsed,
    confidence: args.confidence,
    reason: args.reason,
    fallback_used: args.fallbackUsed,
    tool_used: args.toolUsed,
    latency_ms: args.latencyMs,
    usage: args.usage,
    input_tokens_est: args.inputTokensEst,
    output_tokens_est: args.outputTokensEst,
    expected_cost_est: args.expectedCostEst,
    candidate_costs: args.candidateCosts,
    chosen_reason: args.chosenReason,
    max_cost_usd: args.maxCostUsd,
    budget_actions: args.budgetActions,
    expected_cost_vs_budget: args.expectedCostVsBudget,
    actual_usage: args.actualUsage,
    actual_cost: args.actualCost,
    compacted: args.compacted,
    tokens_before_est: args.tokensBeforeEst,
    tokens_after_est: args.tokensAfterEst,
    savings_tokens_est: args.savingsTokensEst,
    expected_cost_savings_est: args.expectedCostSavingsEst,
    compactor_expected_cost_est: args.compactorExpectedCostEst,
    compactor_cost_est: args.compactorCostEst,
    compactor_timeout_ms: args.compactorTimeoutMs,
    compactor_latency_ms: args.compactorLatencyMs,
    compaction_reason: args.compactionReason,
    compaction_attempted: args.compactionAttempted,
    compaction_applied: args.compactionApplied,
    compaction_skipped_reason: args.compactionSkippedReason,
    compaction_error: args.compactionError,
    error: args.error
  };
}

interface ModelExecutionCandidate {
  route: 'llm.small' | 'llm.mid' | 'llm.big';
  provider: 'openai' | 'ollama';
  model: string;
  expected_cost_est: number;
  context_window?: number;
}

function defaultRouteCandidate(route: 'llm.small' | 'llm.mid' | 'llm.big'): ModelExecutionCandidate {
  if (route === 'llm.small' && ollama && OLLAMA_MODEL) {
    const validation = isAllowedOllamaBaseUrl(OLLAMA_BASE_URL);
    if (!validation.ok) {
      throw new Error(`Ollama base URL blocked: ${validation.reason ?? 'invalid URL'}`);
    }
    const pricing = findPricingEntry(pricingConfig, route, 'ollama', OLLAMA_MODEL);
    return {
      route,
      provider: 'ollama',
      model: OLLAMA_MODEL,
      expected_cost_est: 0,
      context_window: pricing?.context_window
    };
  }

  if (!openai) {
    throw new Error('OpenAI not configured (missing OPENAI_API_KEY)');
  }

  const model = route === 'llm.small' ? OPENAI_SMALL_MODEL : route === 'llm.mid' ? OPENAI_MID_MODEL : OPENAI_BIG_MODEL;
  const pricing = findPricingEntry(pricingConfig, route, 'openai', model);
  return {
    route,
    provider: 'openai',
    model,
    expected_cost_est: 0,
    context_window: pricing?.context_window
  };
}

function buildCandidatesForRoute(route: 'llm.small' | 'llm.mid' | 'llm.big', inputTokens: number, outputTokens: number): ModelExecutionCandidate[] {
  const pricingCandidates = listRoutePricingCandidates(pricingConfig, route)
    .map((entry) => ({
      route,
      provider: entry.provider,
      model: entry.model,
      expected_cost_est: expectedCostUSD(inputTokens, outputTokens, entry),
      context_window: entry.context_window
    }))
    .filter((candidate) => !(candidate.provider === 'ollama' && !ollama));

  if (pricingCandidates.length > 0) {
    return pricingCandidates;
  }

  const fallback = defaultRouteCandidate(route);
  const fallbackPrice = findPricingEntry(pricingConfig, route, fallback.provider, fallback.model);
  return [
    {
      ...fallback,
      expected_cost_est: expectedCostUSD(inputTokens, outputTokens, fallbackPrice),
      context_window: fallbackPrice?.context_window
    }
  ];
}

function chooseCandidate(
  route: 'llm.small' | 'llm.mid' | 'llm.big',
  inputTokens: number,
  outputTokens: number,
  options?: { preferCheapest?: boolean }
): {
  selected: ModelExecutionCandidate;
  candidateCosts: CostCandidate[];
  chosenReason: 'cheapest_by_expected_cost' | 'policy_default';
} {
  const candidates = buildCandidatesForRoute(route, inputTokens, outputTokens);
  if (candidates.length === 0) {
    throw new Error(`No candidates available for route ${route}`);
  }
  const candidateCosts: CostCandidate[] = candidates.map((candidate) => ({
    route: candidate.route,
    model: candidate.model,
    provider: candidate.provider,
    expected_cost_est: candidate.expected_cost_est
  }))
    .sort((a, b) => a.expected_cost_est - b.expected_cost_est);

  const modelContextLimits = Object.fromEntries(candidates.map((c) => [c.model, c.context_window ?? 0]));
  const chosenCheapest =
    chooseCheapestReachableCandidate({
      candidates: candidateCosts,
      reachableModels,
      inputTokens,
      outputTokens,
      modelContextLimits
    }) ?? candidateCosts[0];
  const defaultCandidate = defaultRouteCandidate(route);
  const defaultChosen = candidateCosts.find((candidate) => candidate.model === defaultCandidate.model && candidate.provider === defaultCandidate.provider);
  const defaultEligible =
    defaultChosen &&
    reachableModels.has(defaultChosen.model) &&
    !((modelContextLimits[defaultChosen.model] ?? 0) > 0 && inputTokens + outputTokens > (modelContextLimits[defaultChosen.model] ?? 0))
      ? defaultChosen
      : undefined;

  const selectedCost = options?.preferCheapest === false ? defaultEligible ?? chosenCheapest : chosenCheapest;
  if (!selectedCost) {
    throw new Error(`No cost candidate selected for route ${route}`);
  }

  const selected = candidates.find((candidate) => candidate.model === selectedCost.model && candidate.provider === selectedCost.provider) ?? candidates[0];
  if (!selected) {
    throw new Error(`Selected candidate not found for route ${route}`);
  }
  const chosenReason: 'cheapest_by_expected_cost' | 'policy_default' = options?.preferCheapest === false && defaultEligible ? 'policy_default' : 'cheapest_by_expected_cost';
  return { selected, candidateCosts, chosenReason };
}

function estimateMaxOutputTokensForBudget(
  budgetUsd: number,
  inputTokens: number,
  entry: { in_per_1m: number; out_per_1m: number }
): number {
  const inputCost = (inputTokens / 1_000_000) * entry.in_per_1m;
  const remaining = budgetUsd - inputCost;
  if (remaining <= 0) {
    return 1;
  }
  if (entry.out_per_1m <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(1, Math.floor((remaining * 1_000_000) / entry.out_per_1m));
}

function formatExpectedVsBudget(expectedCostEst: number, maxCostUsd?: number): string | undefined {
  if (maxCostUsd === undefined) {
    return undefined;
  }
  return `$${expectedCostEst.toFixed(6)} / $${maxCostUsd.toFixed(6)}`;
}

type BudgetAction = 'compacted' | 'reduced_output_tokens' | 'model_switched';

function pushBudgetAction(actions: BudgetAction[], action: BudgetAction): BudgetAction[] {
  return actions.includes(action) ? actions : [...actions, action];
}

async function runStartupDiagnostics(): Promise<void> {
  const report: DiagLine[] = [];
  const suggestions: string[] = [];
  reachableModels.clear();
  const missingPricingEntries: Array<{ route: 'llm.small' | 'llm.mid' | 'llm.big'; provider: 'openai' | 'ollama'; model: string }> = [];

  const openaiConfigured = Boolean(OPENAI_SMALL_MODEL || OPENAI_MID_MODEL || OPENAI_BIG_MODEL);
  const ollamaConfigured = Boolean(OLLAMA_BASE_URL && OLLAMA_MODEL);
  const ollamaBaseUrlValidation = isAllowedOllamaBaseUrl(OLLAMA_BASE_URL);

  diagStatus.backends.openai = {
    configured: openaiConfigured,
    reachable: false,
    models: {
      small: OPENAI_SMALL_MODEL,
      mid: OPENAI_MID_MODEL,
      big: OPENAI_BIG_MODEL
    },
    notes: [],
    missing_env: []
  };

  diagStatus.backends.ollama = {
    configured: ollamaConfigured,
    reachable: false,
    model: OLLAMA_MODEL ?? null,
    notes: [],
    missing_env: []
  };

  addStartupLine(report, 'info', 'Startup diagnostics started', { port: PORT });
  diagStatus.pricing = {
    loaded: pricingLoad.loaded,
    path: pricingLoad.path,
    currency: pricingConfig.currency,
    warnings: [...pricingLoad.warnings],
    missing_entries: [],
    example_cost_1k_in_1k_out: Object.values(pricingConfig.models).map((entry) => ({
      route: entry.logical_route,
      provider: entry.provider,
      model: entry.model,
      in_per_1m: entry.in_per_1m,
      out_per_1m: entry.out_per_1m,
      expected_cost_usd: expectedCostUSD(1000, 1000, entry)
    }))
  };

  if (pricingLoad.warnings.length > 0) {
    for (const warning of pricingLoad.warnings) {
      addStartupLine(report, 'warn', 'Pricing config warning', { warning });
      suggestions.push('Fix pricing config validation warnings and restart gateway.');
    }
  }
  if (pricingLoad.loaded) {
    addStartupLine(report, 'info', 'Pricing config loaded', {
      currency: pricingConfig.currency,
      entries: Object.keys(pricingConfig.models).length,
      path: pricingLoad.path
    });
  } else {
    addStartupLine(report, 'warn', 'Pricing config not loaded', {
      path: pricingLoad.path
    });
  }
  addStartupLine(report, 'info', 'Compactor configured', {
    provider: COMPACTOR_PROVIDER,
    model: COMPACTOR_MODEL,
    base_url: COMPACTOR_PROVIDER === 'ollama' ? COMPACTOR_BASE_URL : undefined
  });

  if (openaiConfigured) {
    addStartupLine(report, 'info', 'OpenAI backend configured', {
      models: diagStatus.backends.openai.models,
      api_key_present: Boolean(OPENAI_API_KEY),
      api_key_redacted: OPENAI_API_KEY ? redactValue(OPENAI_API_KEY) : null
    });

    if (!OPENAI_API_KEY) {
      diagStatus.backends.openai.missing_env.push('OPENAI_API_KEY');
      diagStatus.backends.openai.notes.push('Set OPENAI_API_KEY to enable OpenAI routes.');
      addStartupLine(report, 'warn', 'Missing required env for OpenAI probe', { missing_env: ['OPENAI_API_KEY'] });
      suggestions.push('Add OPENAI_API_KEY in env_file and restart gateway.');
    } else {
      try {
        const response = await fetchWithTimeout('https://api.openai.com/v1/models', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`
          }
        }, FETCH_TIMEOUT_MS);

        if (!response.ok) {
          diagStatus.backends.openai.notes.push(`Probe failed HTTP ${response.status}`);
          addStartupLine(report, 'error', 'OpenAI probe failed', { status: response.status });
          suggestions.push('Verify OPENAI_API_KEY and outbound internet access for gateway container.');
        } else {
          diagStatus.backends.openai.reachable = true;
          reachableModels.add(OPENAI_SMALL_MODEL);
          reachableModels.add(OPENAI_MID_MODEL);
          reachableModels.add(OPENAI_BIG_MODEL);
          addStartupLine(report, 'info', 'OpenAI probe succeeded', { probe: 'GET /v1/models' });

          const parsed = (await response.json()) as { data?: Array<{ id?: string }> };
          const ids = new Set((parsed.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)));
          for (const modelName of [OPENAI_SMALL_MODEL, OPENAI_MID_MODEL, OPENAI_BIG_MODEL]) {
            const found = ids.has(modelName);
            if (found) {
              reachableModels.add(modelName);
            }
            addStartupLine(report, found ? 'info' : 'warn', 'OpenAI model configured', {
              model: modelName,
              verified_in_models_list: found
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown probe error';
        diagStatus.backends.openai.notes.push(`Probe exception: ${message}`);
        addStartupLine(report, 'error', 'OpenAI probe exception', { error: truncateError(message) });
        suggestions.push('Check network connectivity from gateway container to api.openai.com.');
      }
    }
  } else {
    diagStatus.backends.openai.notes.push('OpenAI backend not configured.');
    addStartupLine(report, 'warn', 'OpenAI backend not configured', {
      info: 'Set OPENAI_*_MODEL values to enable OpenAI routing.'
    });
  }

  if (ollamaConfigured) {
    if (!ollamaBaseUrlValidation.ok) {
      diagStatus.backends.ollama.notes.push(ollamaBaseUrlValidation.reason ?? 'Invalid OLLAMA_BASE_URL');
      addStartupLine(report, 'error', 'Ollama base URL rejected by SSRF guard', {
        base_url: OLLAMA_BASE_URL,
        reason: ollamaBaseUrlValidation.reason
      });
      suggestions.push('Set OLLAMA_BASE_URL to a local/private address (localhost, host.docker.internal, or RFC1918 IP).');
    }

    addStartupLine(report, 'info', 'Ollama backend configured', {
      base_url: OLLAMA_BASE_URL,
      model: OLLAMA_MODEL
    });

    try {
      if (!ollamaBaseUrlValidation.ok) {
        throw new Error(ollamaBaseUrlValidation.reason ?? 'Invalid OLLAMA_BASE_URL');
      }
      const tagsUrl = `${(OLLAMA_BASE_URL as string).replace(/\/$/, '')}/api/tags`;
      const response = await fetchWithTimeout(tagsUrl, { method: 'GET' }, FETCH_TIMEOUT_MS);

      if (!response.ok) {
        diagStatus.backends.ollama.notes.push(`Probe failed HTTP ${response.status}`);
        addStartupLine(report, 'error', 'Ollama probe failed', { status: response.status, url: tagsUrl });
        suggestions.push('Verify OLLAMA_BASE_URL is reachable from Docker (for Mac host use http://host.docker.internal:11434).');
      } else {
        diagStatus.backends.ollama.reachable = true;
        if (OLLAMA_MODEL) {
          reachableModels.add(OLLAMA_MODEL);
          reachableModels.add(`${OLLAMA_MODEL}:latest`);
        }
        addStartupLine(report, 'info', 'Ollama probe succeeded', { url: tagsUrl });
        const data = (await response.json()) as { models?: Array<{ name?: string }> };
        const names = (data.models ?? []).map((m) => m.name ?? '');
        const target = OLLAMA_MODEL as string;
        const found = names.some((n) => n === target || n === `${target}:latest` || `${n}:latest` === target);
        addStartupLine(report, found ? 'info' : 'warn', 'Ollama model configured', {
          model: target,
          verified_in_tags: found
        });
        if (!found) {
          diagStatus.backends.ollama.notes.push(`Model ${target} not found in /api/tags`);
          suggestions.push(`Pull or set an existing Ollama model (current: ${target}).`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown probe error';
      diagStatus.backends.ollama.notes.push(`Probe exception: ${message}`);
      addStartupLine(report, 'error', 'Ollama probe exception', { error: truncateError(message), base_url: OLLAMA_BASE_URL });
      suggestions.push('Check OLLAMA_BASE_URL and Docker host networking for Ollama.');
    }
  } else {
    addStartupLine(report, 'warn', 'Ollama backend not fully configured', {
      info: 'Optional backend disabled. Set OLLAMA_BASE_URL and OLLAMA_MODEL to enable.'
    });
  }

  const configuredModelChecks: Array<{ route: 'llm.small' | 'llm.mid' | 'llm.big'; provider: 'openai' | 'ollama'; model: string }> = [];
  if (useOllamaSmall && OLLAMA_MODEL) {
    configuredModelChecks.push({ route: 'llm.small', provider: 'ollama', model: OLLAMA_MODEL });
  } else {
    configuredModelChecks.push({ route: 'llm.small', provider: 'openai', model: OPENAI_SMALL_MODEL });
  }
  configuredModelChecks.push({ route: 'llm.mid', provider: 'openai', model: OPENAI_MID_MODEL });
  configuredModelChecks.push({ route: 'llm.big', provider: 'openai', model: OPENAI_BIG_MODEL });

  for (const check of configuredModelChecks) {
    const pricingEntry = findPricingEntry(pricingConfig, check.route, check.provider, check.model);
    const found = Boolean(pricingEntry);
    addStartupLine(report, found ? 'info' : 'warn', 'Pricing entry check', {
      route: check.route,
      provider: check.provider,
      model: check.model,
      found
    });
    if (!found) {
      missingPricingEntries.push(check);
      suggestions.push(`Add pricing entry for ${check.route} (${check.provider}:${check.model}) in gateway/config/pricing.json.`);
      continue;
    }

    if (check.provider === 'openai' && pricingEntry) {
      const inDefined = pricingEntry.in_defined === true;
      const outDefined = pricingEntry.out_defined === true;
      if (!inDefined || !outDefined) {
        addStartupLine(report, 'warn', 'OpenAI pricing entry missing in/out rate fields', {
          route: check.route,
          model: check.model,
          in_defined: inDefined,
          out_defined: outDefined
        });
      }
      if (pricingEntry.in_per_1m < 0 || pricingEntry.out_per_1m < 0) {
        addStartupLine(report, 'error', 'OpenAI pricing entry contains negative values', {
          route: check.route,
          model: check.model,
          in_per_1m: pricingEntry.in_per_1m,
          out_per_1m: pricingEntry.out_per_1m
        });
      }
    }
  }
  diagStatus.pricing.missing_entries = missingPricingEntries;

  const missingEnv = [...diagStatus.backends.openai.missing_env, ...diagStatus.backends.ollama.missing_env];
  const openaiOk = !diagStatus.backends.openai.configured || diagStatus.backends.openai.reachable;
  const ollamaOk = !diagStatus.backends.ollama.configured || diagStatus.backends.ollama.reachable;
  const ok = openaiOk && ollamaOk && missingEnv.length === 0;

  startupSummary = {
    startup_ok: ok,
    summary: {
      openai_ok: openaiOk,
      ollama_ok: ollamaOk,
      missing_env: missingEnv
    }
  };

  if (!ok && suggestions.length === 0) {
    suggestions.push('Review /v1/diag/status and set missing env vars in env_file, then restart.');
  }

  diagStatus.ok = ok;
  diagStatus.suggestions = Array.from(new Set(suggestions));
  diagStatus.last_startup_report = report;
  lastStartupReport = report;

  addStartupLine(report, ok ? 'info' : 'warn', 'Startup diagnostics completed', startupSummary.summary);
}

app.get('/health', async () => {
  return {
    ok: diagStatus.ok,
    details: {
      backends: diagStatus.backends,
      startup_summary: startupSummary.summary
    }
  };
});

app.get('/v1/diag/status', async (request, reply) => {
  const key = clientKey({ ip: request.ip, headers: request.headers as Record<string, unknown> });
  if (!checkRateLimit(`diag-status:${key}`, RATE_LIMIT_CHAT_MAX)) {
    reply.code(429);
    return { error: 'Too Many Requests' };
  }
  return {
    ok: diagStatus.ok,
    backends: diagStatus.backends,
    pricing: diagStatus.pricing,
    last_startup_report: diagStatus.last_startup_report,
    suggestions: diagStatus.suggestions
  };
});

app.get('/v1/diag/stream', async (request, reply) => {
  const key = clientKey({ ip: request.ip, headers: request.headers as Record<string, unknown> });
  if (!checkRateLimit(`diag-stream:${key}`, RATE_LIMIT_SSE_MAX)) {
    reply.code(429);
    return { error: 'Too Many Requests' };
  }
  if (diagClients.size >= MAX_DIAG_CLIENTS) {
    reply.code(503);
    return { error: 'Diagnostic stream capacity reached' };
  }

  reply.hijack();
  reply.raw.writeHead(200, sseHeaders(request.headers.origin));

  for (const line of lastStartupReport) {
    if (!safeSseWrite(reply.raw, 'diag', line)) {
      reply.raw.end();
      return reply;
    }
  }
  safeSseWrite(reply.raw, 'diag_done', startupSummary);

  diagClients.add(reply.raw);

  request.raw.on('close', () => {
    diagClients.delete(reply.raw);
  });

  return reply;
});

app.get<{ Querystring: { session_id?: string; limit?: string } }>('/v1/logs', async (request, reply) => {
  const key = clientKey({ ip: request.ip, headers: request.headers as Record<string, unknown> });
  if (!checkRateLimit(`logs:${key}`, RATE_LIMIT_CHAT_MAX)) {
    reply.code(429);
    return { error: 'Too Many Requests' };
  }

  const sessionId = request.query.session_id;
  if (!sessionId) {
    reply.code(400);
    return { error: 'session_id is required' };
  }

  const limitRaw = Number(request.query.limit ?? '200');
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 200;

  const list = logsBySession.get(sessionId) ?? [];
  return {
    session_id: sessionId,
    entries: [...list].reverse().slice(0, limit)
  };
});

function buildAttemptPlan(route: RouterDecision['route']): Array<'tool.calculator' | 'llm.small' | 'llm.mid' | 'llm.big'> {
  if (route === 'tool.calculator') {
    return ['tool.calculator', 'llm.small', 'llm.mid', 'llm.big'];
  }
  if (route === 'llm.small') {
    return ['llm.small', 'llm.mid', 'llm.big'];
  }
  if (route === 'llm.mid') {
    return ['llm.mid', 'llm.big'];
  }
  return ['llm.big'];
}

app.post<{ Body: ChatRequestBody }>('/v1/chat', async (request, reply) => {
  const start = Date.now();
  const requestId = crypto.randomUUID();

  const body = request.body;
  const messages = body?.messages;
  const stream = Boolean(body?.stream);
  const maxCostUsd = Number.isFinite(Number(body?.max_cost_usd)) && Number(body?.max_cost_usd) > 0 ? Number(body?.max_cost_usd) : undefined;
  const preferCheapest = body?.prefer_cheapest !== false;
  const verbosity: 'brief' | 'normal' | 'detailed' = body?.verbosity === 'brief' || body?.verbosity === 'detailed' ? body.verbosity : 'normal';
  const key = clientKey({ ip: request.ip, headers: request.headers as Record<string, unknown> });
  if (!checkRateLimit(`chat:${stream ? 'stream' : 'sync'}:${key}`, stream ? RATE_LIMIT_SSE_MAX : RATE_LIMIT_CHAT_MAX)) {
    reply.code(429);
    return { error: 'Too Many Requests' };
  }
  if (stream && chatStreamClients.size >= MAX_CHAT_STREAM_CLIENTS) {
    reply.code(503);
    return { error: 'Chat stream capacity reached' };
  }
  const sessionId = body?.session_id ?? 'anonymous';

  if (!Array.isArray(messages) || messages.length === 0) {
    reply.code(400);
    return { error: 'messages must be a non-empty array' };
  }
  if (messages.length > MAX_MESSAGES) {
    reply.code(400);
    return { error: `messages exceeds maximum of ${MAX_MESSAGES}` };
  }
  const shapeCheck = validateMessageShape(messages, MAX_CONTENT_CHARS);
  if (!shapeCheck.ok && shapeCheck.error === 'invalid message format') {
    reply.code(400);
    return { error: 'invalid message format' };
  }
  if (!shapeCheck.ok && shapeCheck.error === 'user_message_too_large') {
    reply.code(413);
    return { error: 'User message exceeds maximum content length', max_content_chars: MAX_CONTENT_CHARS };
  }

  const charMetrics = computeRequestCharMetrics(messages);
  if (exceedsMaxRequestChars(charMetrics, MAX_REQUEST_CHARS)) {
    reply.code(413);
    return { error: 'Request exceeds maximum total character length', max_request_chars: MAX_REQUEST_CHARS };
  }

  const userText = getLastUser(messages);
  const userExcerpt = userText.slice(0, 150);
  const inputCharsUser = charMetrics.user_chars;
  const inputCharsIncomingTotal = charMetrics.incoming_total_chars;
  const inputTokensEstBase = estimateInputTokens(messages, 'openai');

  let route = 'unknown';
  let modelUsed = 'unknown';
  let confidence = 0;
  let reason = '';
  let fallbackRoute: RouterDecision['fallback_route'] = undefined;
  let fallbackUsed = false;
  let toolUsed = false;
  let error: string | null = null;
  let finalContent = '';
  let inputTokensEst = inputTokensEstBase;
  let outputTokensEst = 0;
  let expectedCostEst = 0;
  let candidateCosts: CostCandidate[] = [];
  let chosenReason: 'cheapest_by_expected_cost' | 'policy_default' | undefined;
  let budgetActions: Array<'compacted' | 'reduced_output_tokens' | 'model_switched'> = [];
  let expectedCostVsBudget: string | undefined;
  let actualUsage: TokenUsage | undefined;
  let actualCost: number | undefined;
  let compacted = false;
  let tokensBeforeEst = inputTokensEstBase;
  let tokensAfterEst = inputTokensEstBase;
  let savingsTokensEst = 0;
  let expectedCostSavingsEst = 0;
  let compactorExpectedCostEst = 0;
  let compactorCostEst = 0;
  let compactorTimeoutMs = COMPACTOR_TIMEOUT_MS;
  let compactorLatencyMs: number | undefined;
  let compactionReason: 'over_budget' | 'worth_it' | undefined;
  let compactionAttempted = false;
  let compactionApplied = false;
  let compactionSkippedReason: 'skipped_threshold' | 'tool_route' | 'code_edit_preserve' | undefined;
  let compactionError: string | undefined;
  let outgoingInputCharsTotal = inputCharsIncomingTotal;

  try {
    const session = getSession(sessionId);
    const decision = router.decide(messages, session);
    route = decision.route;
    modelUsed = decision.model;
    confidence = decision.confidence;
    reason = decision.reason;
    fallbackRoute = decision.fallback_route;
    let effectiveDecision: RouterDecision = { ...decision };
    const attemptPlan = buildAttemptPlan(decision.route);
    const baseMessages = buildMessages(messages, session);

    if (attemptPlan[0] === 'tool.calculator') {
      try {
        finalContent = evaluateMath(userText);
        toolUsed = true;
        route = 'tool.calculator';
        modelUsed = 'tool.calculator';
        outputTokensEst = 0;
        inputTokensEst = 0;
        expectedCostEst = 0;
        candidateCosts = [];
        chosenReason = undefined;
        compacted = false;
        tokensBeforeEst = 0;
        tokensAfterEst = 0;
        savingsTokensEst = 0;
        expectedCostSavingsEst = 0;
        compactorExpectedCostEst = 0;
        compactorCostEst = 0;
        compactorTimeoutMs = 0;
        compactorLatencyMs = 0;
        compactionReason = undefined;
        compactionAttempted = false;
        compactionApplied = false;
        compactionSkippedReason = 'tool_route';
        compactionError = undefined;
        expectedCostVsBudget = formatExpectedVsBudget(0, maxCostUsd);
        effectiveDecision = {
          ...effectiveDecision,
          route: 'tool.calculator',
          model: 'tool.calculator',
          input_tokens_est: 0,
          output_tokens_est: 0,
          expected_cost_est: 0,
          candidate_costs: [],
          chosen_reason: undefined,
          max_cost_usd: maxCostUsd,
          budget_actions: [],
          expected_cost_vs_budget: expectedCostVsBudget,
          compacted: false,
          tokens_before_est: 0,
          tokens_after_est: 0,
          savings_tokens_est: 0,
          expected_cost_savings_est: 0,
          compactor_expected_cost_est: 0,
          compactor_cost_est: 0,
          compactor_timeout_ms: 0,
          compactor_latency_ms: 0,
          compaction_attempted: false,
          compaction_applied: false,
          compaction_skipped_reason: 'tool_route'
        };

        outgoingInputCharsTotal = inputCharsIncomingTotal;
        const usage = makeUsage(inputCharsUser, outgoingInputCharsTotal, finalContent.length);
        const latencyMs = Date.now() - start;
        persistSession(sessionId, route, modelUsed, userText, finalContent);

        if (stream) {
          reply.hijack();
          chatStreamClients.add(reply.raw);
          request.raw.on('close', () => {
            chatStreamClients.delete(reply.raw);
          });
          reply.raw.writeHead(200, sseHeaders(request.headers.origin));

          safeSseWrite(reply.raw, 'meta', {
            request_id: requestId,
            session_id: sessionId,
            route,
            model_used: modelUsed,
            confidence,
            reason,
            fallback_route: fallbackRoute,
            tool_used: true,
            input_tokens_est: inputTokensEst,
            output_tokens_est: outputTokensEst,
            expected_cost_est: expectedCostEst,
            candidate_costs: candidateCosts,
            chosen_reason: chosenReason,
            max_cost_usd: maxCostUsd,
            budget_actions: budgetActions,
            expected_cost_vs_budget: expectedCostVsBudget,
            compacted,
            tokens_before_est: tokensBeforeEst,
            tokens_after_est: tokensAfterEst,
            savings_tokens_est: savingsTokensEst,
            expected_cost_savings_est: expectedCostSavingsEst,
            compactor_expected_cost_est: compactorExpectedCostEst,
            compactor_cost_est: compactorCostEst,
            compactor_timeout_ms: compactorTimeoutMs,
            compactor_latency_ms: compactorLatencyMs,
            compaction_reason: compactionReason,
            compaction_attempted: compactionAttempted,
            compaction_applied: compactionApplied,
            compaction_skipped_reason: compactionSkippedReason,
            compaction_error: compactionError
          });
          safeSseWrite(reply.raw, 'token', { delta: finalContent });
          safeSseWrite(reply.raw, 'done', {
            content: finalContent,
            usage,
            latency_ms: latencyMs,
            actual_usage: actualUsage,
            actual_cost: actualCost,
            compacted,
            tokens_before_est: tokensBeforeEst,
            tokens_after_est: tokensAfterEst,
            savings_tokens_est: savingsTokensEst,
            expected_cost_savings_est: expectedCostSavingsEst,
            compactor_expected_cost_est: compactorExpectedCostEst,
            compactor_cost_est: compactorCostEst,
            compactor_timeout_ms: compactorTimeoutMs,
            compactor_latency_ms: compactorLatencyMs,
            compaction_reason: compactionReason,
            compaction_attempted: compactionAttempted,
            compaction_applied: compactionApplied,
            compaction_skipped_reason: compactionSkippedReason,
            compaction_error: compactionError
          });
          reply.raw.end();
          chatStreamClients.delete(reply.raw);
        } else {
          const payload: ChatJsonResponse = {
            model_used: modelUsed,
            route,
            content: finalContent,
            usage,
            latency_ms: latencyMs,
            decision: effectiveDecision
          };
          pushLog(
            makeLogEntry({
              requestId,
              sessionId,
              userExcerpt,
              route,
              modelUsed,
              confidence,
              reason,
              fallbackUsed,
              toolUsed,
              latencyMs,
              usage,
              inputTokensEst,
              outputTokensEst,
              expectedCostEst,
              candidateCosts,
              chosenReason,
              maxCostUsd,
              budgetActions,
              expectedCostVsBudget,
              actualUsage,
              actualCost,
              compacted,
              tokensBeforeEst,
              tokensAfterEst,
              savingsTokensEst,
              expectedCostSavingsEst,
              compactorExpectedCostEst,
              compactorCostEst,
              compactorTimeoutMs,
              compactorLatencyMs,
              compactionReason,
              compactionAttempted,
              compactionApplied,
              compactionSkippedReason,
              compactionError,
              error
            })
          );
          return payload;
        }

        pushLog(
          makeLogEntry({
            requestId,
            sessionId,
            userExcerpt,
            route,
            modelUsed,
            confidence,
            reason,
            fallbackUsed,
            toolUsed,
            latencyMs,
            usage,
            inputTokensEst,
            outputTokensEst,
            expectedCostEst,
            candidateCosts,
            chosenReason,
            maxCostUsd,
            budgetActions,
            expectedCostVsBudget,
            actualUsage,
            actualCost,
            compacted,
            tokensBeforeEst,
            tokensAfterEst,
            savingsTokensEst,
            expectedCostSavingsEst,
            compactorExpectedCostEst,
            compactorCostEst,
            compactorTimeoutMs,
            compactorLatencyMs,
            compactionReason,
            compactionAttempted,
            compactionApplied,
            compactionSkippedReason,
            compactionError,
            error
          })
        );
        return reply;
      } catch {
        fallbackUsed = true;
        reason = `${reason} Calculator parse failed; fell back to llm.small.`;
      }
    }

    let completionUsage = makeUsage(inputCharsUser, outgoingInputCharsTotal, 0);
    let llmSucceeded = false;
    const llmStages = attemptPlan.filter((step): step is 'llm.small' | 'llm.mid' | 'llm.big' => step !== 'tool.calculator');

    for (let stageIndex = 0; stageIndex < llmStages.length; stageIndex += 1) {
      const stageRoute = llmStages[stageIndex] as 'llm.small' | 'llm.mid' | 'llm.big';
      const stageBaseMessages =
        decision.route === 'tool.calculator' && stageRoute === 'llm.small'
          ? buildMessages(
              [
                {
                  role: 'system',
                  content: 'Solve the user math question. Return only the answer followed by brief steps.'
                },
                ...messages
              ],
              session
            )
          : baseMessages;

      outputTokensEst = estimateOutputTokens(stageBaseMessages, stageRoute, verbosity);
      const preInputTokensEst = estimateInputTokens(stageBaseMessages, 'openai');
      const preSelected = chooseCandidate(stageRoute, preInputTokensEst, outputTokensEst, { preferCheapest });
      const prePricing = findPricingEntry(pricingConfig, stageRoute, preSelected.selected.provider, preSelected.selected.model);
      const compaction = await maybeCompactContext({
        route: stageRoute,
        messages: stageBaseMessages,
        limits: {
          keepLastTurns: COMPACT_KEEP_LAST_TURNS,
          keepLastLogLines: COMPACT_KEEP_LAST_LOG_LINES,
          minSavingsTokens:
            maxCostUsd !== undefined && preSelected.selected.expected_cost_est > maxCostUsd
              ? 1
              : COMPACT_MIN_SAVINGS_TOKENS,
          outputTargetTokens: COMPACTOR_OUTPUT_TOKENS_EST,
          maxLatencyMs: COMPACTOR_TIMEOUT_MS
        },
        budgets: {
          tool: MAX_INPUT_TOKENS_TOOL,
          math: MAX_INPUT_TOKENS_MATH,
          mid: MAX_INPUT_TOKENS_MID,
          big: MAX_INPUT_TOKENS_BIG
        },
        downstreamInputPricePer1M: prePricing?.in_per_1m ?? 0,
        estimatorFamily: preSelected.selected.provider === 'openai' ? 'openai' : 'ollama',
        compactorConfig: {
          provider: COMPACTOR_PROVIDER,
          model: COMPACTOR_MODEL,
          baseUrl: COMPACTOR_BASE_URL,
          openaiApiKey: OPENAI_API_KEY
        },
        compactorPricing: findPricingByProviderModel(pricingConfig, COMPACTOR_PROVIDER, COMPACTOR_MODEL)
      });
      const stageMessages = compaction.messages;
      outgoingInputCharsTotal = stageMessages.reduce((sum, m) => sum + m.content.length, 0);
      compacted = compaction.telemetry.compacted;
      tokensBeforeEst = compaction.telemetry.tokens_before_est;
      tokensAfterEst = compaction.telemetry.tokens_after_est;
      savingsTokensEst = compaction.telemetry.savings_tokens_est;
      expectedCostSavingsEst = compaction.telemetry.expected_cost_savings_est;
      compactorExpectedCostEst = compaction.telemetry.compactor_expected_cost_est;
      compactorCostEst = compaction.telemetry.compactor_cost_est;
      compactorTimeoutMs = compaction.telemetry.compactor_timeout_ms;
      compactorLatencyMs = compaction.telemetry.compactor_latency_ms;
      compactionReason = compaction.telemetry.compaction_reason;
      compactionAttempted = compaction.telemetry.compaction_attempted;
      compactionApplied = compaction.telemetry.compaction_applied;
      compactionSkippedReason = compaction.telemetry.compaction_skipped_reason;
      compactionError = compaction.telemetry.compaction_error;

      const routeFamily = preSelected.selected.provider === 'openai' ? 'openai' : 'ollama';
      inputTokensEst = estimateInputTokens(stageMessages, routeFamily);
      tokensAfterEst = inputTokensEst;
      savingsTokensEst = Math.max(0, tokensBeforeEst - tokensAfterEst);
      expectedCostSavingsEst = (savingsTokensEst / 1_000_000) * (prePricing?.in_per_1m ?? 0);
      if (compactionApplied) {
        budgetActions = pushBudgetAction(budgetActions, 'compacted');
      }

      let selectedForStage = chooseCandidate(stageRoute, inputTokensEst, outputTokensEst, { preferCheapest });
      candidateCosts = selectedForStage.candidateCosts;
      chosenReason = selectedForStage.chosenReason;
      let llm = selectedForStage.selected;
      expectedCostEst = llm.expected_cost_est;

      if (maxCostUsd !== undefined && expectedCostEst > maxCostUsd) {
        const pricingForSelected = findPricingEntry(pricingConfig, stageRoute, llm.provider, llm.model);
        if (pricingForSelected) {
          const reducedOutputTokens = estimateMaxOutputTokensForBudget(maxCostUsd, inputTokensEst, pricingForSelected);
          if (reducedOutputTokens < outputTokensEst) {
            outputTokensEst = Math.max(1, reducedOutputTokens);
            budgetActions = pushBudgetAction(budgetActions, 'reduced_output_tokens');
            selectedForStage = chooseCandidate(stageRoute, inputTokensEst, outputTokensEst, { preferCheapest: true });
            candidateCosts = selectedForStage.candidateCosts;
            chosenReason = selectedForStage.chosenReason;
            llm = selectedForStage.selected;
            expectedCostEst = llm.expected_cost_est;
          }
        }

        if (expectedCostEst > maxCostUsd) {
          const cheapestAfterReduction = chooseCandidate(stageRoute, inputTokensEst, outputTokensEst, { preferCheapest: true });
          if (cheapestAfterReduction.selected.model !== llm.model || cheapestAfterReduction.selected.provider !== llm.provider) {
            budgetActions = pushBudgetAction(budgetActions, 'model_switched');
          }
          selectedForStage = cheapestAfterReduction;
          candidateCosts = selectedForStage.candidateCosts;
          chosenReason = selectedForStage.chosenReason;
          llm = selectedForStage.selected;
          expectedCostEst = llm.expected_cost_est;
        }
      }

      expectedCostVsBudget = formatExpectedVsBudget(expectedCostEst, maxCostUsd);
      route = stageRoute;
      modelUsed = llm.model;

      if (stageIndex > 0 || decision.route === 'tool.calculator') {
        fallbackUsed = true;
      }

      effectiveDecision = {
        ...effectiveDecision,
        route: stageRoute,
        model: llm.model,
        reason,
        input_tokens_est: inputTokensEst,
        output_tokens_est: outputTokensEst,
        expected_cost_est: expectedCostEst,
        candidate_costs: candidateCosts,
        chosen_reason: chosenReason,
        max_cost_usd: maxCostUsd,
        budget_actions: budgetActions,
        expected_cost_vs_budget: expectedCostVsBudget,
        compacted,
        tokens_before_est: tokensBeforeEst,
        tokens_after_est: tokensAfterEst,
        savings_tokens_est: savingsTokensEst,
        expected_cost_savings_est: expectedCostSavingsEst,
        compactor_expected_cost_est: compactorExpectedCostEst,
        compactor_cost_est: compactorCostEst,
        compactor_timeout_ms: compactorTimeoutMs,
        compactor_latency_ms: compactorLatencyMs,
        compaction_reason: compactionReason,
        compaction_attempted: compactionAttempted,
        compaction_applied: compactionApplied,
        compaction_skipped_reason: compactionSkippedReason,
        compaction_error: compactionError
      };

      if (maxCostUsd !== undefined && expectedCostEst > maxCostUsd) {
        const suggestions = [
          'Increase max_cost_usd for this request.',
          'Set verbosity="brief" to lower output token target.',
          'Use a shorter prompt/context to reduce input tokens.'
        ];
        const budgetError = {
          error: 'Request exceeds max_cost_usd for available in-tier candidates',
          request_id: requestId,
          expected_cost_est: expectedCostEst,
          max_cost_usd: maxCostUsd,
          route: stageRoute,
          suggestions
        };
        pushLog(
          makeLogEntry({
            requestId,
            sessionId,
            userExcerpt,
            route: stageRoute,
            modelUsed: llm.model,
            confidence,
            reason,
            fallbackUsed,
            toolUsed,
            latencyMs: Date.now() - start,
            usage: makeUsage(inputCharsUser, outgoingInputCharsTotal, finalContent.length),
            inputTokensEst,
            outputTokensEst,
            expectedCostEst,
            candidateCosts,
            chosenReason,
            maxCostUsd,
            budgetActions,
            expectedCostVsBudget,
            actualUsage,
            actualCost,
            compacted,
            tokensBeforeEst,
            tokensAfterEst,
            savingsTokensEst,
            expectedCostSavingsEst,
            compactorExpectedCostEst,
            compactorCostEst,
            compactorTimeoutMs,
            compactorLatencyMs,
            compactionReason,
            compactionAttempted,
            compactionApplied,
            compactionSkippedReason,
            compactionError,
            error: budgetError.error
          })
        );
        reply.code(422);
        return budgetError;
      }

      try {
        if (stream) {
          reply.hijack();
          chatStreamClients.add(reply.raw);
          request.raw.on('close', () => {
            chatStreamClients.delete(reply.raw);
          });
          reply.raw.writeHead(200, sseHeaders(request.headers.origin));

          safeSseWrite(reply.raw, 'meta', {
            request_id: requestId,
            session_id: sessionId,
            route,
            model_used: modelUsed,
            confidence,
            reason,
            fallback_route: fallbackRoute,
            tool_used: toolUsed,
            input_tokens_est: inputTokensEst,
            output_tokens_est: outputTokensEst,
            expected_cost_est: expectedCostEst,
            candidate_costs: candidateCosts,
            chosen_reason: chosenReason,
            max_cost_usd: maxCostUsd,
            budget_actions: budgetActions,
            expected_cost_vs_budget: expectedCostVsBudget,
            compacted,
            tokens_before_est: tokensBeforeEst,
            tokens_after_est: tokensAfterEst,
            savings_tokens_est: savingsTokensEst,
            expected_cost_savings_est: expectedCostSavingsEst,
            compactor_expected_cost_est: compactorExpectedCostEst,
            compactor_cost_est: compactorCostEst,
            compactor_timeout_ms: compactorTimeoutMs,
            compactor_latency_ms: compactorLatencyMs,
            compaction_reason: compactionReason,
            compaction_attempted: compactionAttempted,
            compaction_applied: compactionApplied,
            compaction_skipped_reason: compactionSkippedReason,
            compaction_error: compactionError
          });

          const streamSource =
            llm.provider === 'ollama'
              ? (ollama as OllamaAdapter).stream(stageMessages, llm.model, (usage) => {
                  actualUsage = usage;
                }, { max_output_tokens: outputTokensEst })
              : (openai as OpenAIAdapter).stream(stageMessages, llm.model, (usage) => {
                  actualUsage = usage;
                }, { max_output_tokens: outputTokensEst });

          for await (const delta of streamSource) {
            finalContent += delta;
            if (!safeSseWrite(reply.raw, 'token', { delta })) {
              break;
            }
          }

          completionUsage = makeUsage(inputCharsUser, outgoingInputCharsTotal, finalContent.length);
          const pricing = findPricingEntry(pricingConfig, stageRoute, llm.provider, llm.model);
          if (actualUsage?.input_tokens !== undefined && actualUsage?.output_tokens !== undefined) {
            actualCost = expectedCostUSD(actualUsage.input_tokens, actualUsage.output_tokens, pricing);
          }
          const latencyMs = Date.now() - start;
          persistSession(sessionId, route, modelUsed, userText, finalContent);
          safeSseWrite(reply.raw, 'done', {
            content: finalContent,
            usage: completionUsage,
            latency_ms: latencyMs,
            actual_usage: actualUsage,
            actual_cost: actualCost,
            compacted,
            tokens_before_est: tokensBeforeEst,
            tokens_after_est: tokensAfterEst,
            savings_tokens_est: savingsTokensEst,
            expected_cost_savings_est: expectedCostSavingsEst,
            compactor_expected_cost_est: compactorExpectedCostEst,
            compactor_cost_est: compactorCostEst,
            compactor_timeout_ms: compactorTimeoutMs,
            compactor_latency_ms: compactorLatencyMs,
            compaction_reason: compactionReason,
            compaction_attempted: compactionAttempted,
            compaction_applied: compactionApplied,
            compaction_skipped_reason: compactionSkippedReason,
            compaction_error: compactionError
          });
          reply.raw.end();
          chatStreamClients.delete(reply.raw);

          pushLog(
            makeLogEntry({
              requestId,
              sessionId,
              userExcerpt,
              route,
              modelUsed,
              confidence,
              reason,
              fallbackUsed,
              toolUsed,
              latencyMs,
              usage: completionUsage,
              inputTokensEst,
              outputTokensEst,
              expectedCostEst,
              candidateCosts,
              chosenReason,
              maxCostUsd,
              budgetActions,
              expectedCostVsBudget,
              actualUsage,
              actualCost,
              compacted,
              tokensBeforeEst,
              tokensAfterEst,
              savingsTokensEst,
              expectedCostSavingsEst,
              compactorExpectedCostEst,
              compactorCostEst,
              compactorTimeoutMs,
              compactorLatencyMs,
              compactionReason,
              compactionAttempted,
              compactionApplied,
              compactionSkippedReason,
              compactionError,
              error
            })
          );
          return reply;
        }

        const completion =
          llm.provider === 'ollama'
            ? await (ollama as OllamaAdapter).complete(stageMessages, llm.model, { max_output_tokens: outputTokensEst })
            : await (openai as OpenAIAdapter).complete(stageMessages, llm.model, { max_output_tokens: outputTokensEst });

        finalContent = completion.content;
        completionUsage = makeUsage(inputCharsUser, outgoingInputCharsTotal, finalContent.length);
        actualUsage = completion.token_usage;
        const pricing = findPricingEntry(pricingConfig, stageRoute, llm.provider, llm.model);
        if (actualUsage?.input_tokens !== undefined && actualUsage?.output_tokens !== undefined) {
          actualCost = expectedCostUSD(actualUsage.input_tokens, actualUsage.output_tokens, pricing);
        }
        llmSucceeded = true;
        break;
      } catch (candidateErr) {
        reason = `${reason} Candidate ${llm.model} failed (${truncateError(candidateErr instanceof Error ? candidateErr.message : 'error')}).`;
      }
    }

    if (!llmSucceeded && !stream) {
      throw new Error('No reachable model candidate succeeded.');
    }

    const latencyMs = Date.now() - start;
    persistSession(sessionId, route, modelUsed, userText, finalContent);
    effectiveDecision = {
      ...effectiveDecision,
      actual_usage: actualUsage,
      actual_cost: actualCost,
      chosen_reason: chosenReason,
      max_cost_usd: maxCostUsd,
      budget_actions: budgetActions,
      expected_cost_vs_budget: expectedCostVsBudget,
      compacted,
      tokens_before_est: tokensBeforeEst,
      tokens_after_est: tokensAfterEst,
      savings_tokens_est: savingsTokensEst,
      expected_cost_savings_est: expectedCostSavingsEst,
      compactor_expected_cost_est: compactorExpectedCostEst,
      compactor_cost_est: compactorCostEst,
      compactor_timeout_ms: compactorTimeoutMs,
      compactor_latency_ms: compactorLatencyMs,
      compaction_reason: compactionReason,
      compaction_attempted: compactionAttempted,
      compaction_applied: compactionApplied,
      compaction_skipped_reason: compactionSkippedReason,
      compaction_error: compactionError
    };

    const response: ChatJsonResponse = {
      model_used: modelUsed,
      route,
      content: finalContent,
      usage: completionUsage,
      latency_ms: latencyMs,
      decision: effectiveDecision
    };

    pushLog(
      makeLogEntry({
        requestId,
        sessionId,
        userExcerpt,
        route,
        modelUsed,
        confidence,
        reason,
        fallbackUsed,
        toolUsed,
        latencyMs,
        usage: completionUsage,
        inputTokensEst,
        outputTokensEst,
        expectedCostEst,
        candidateCosts,
        chosenReason,
        maxCostUsd,
        budgetActions,
        expectedCostVsBudget,
        actualUsage,
        actualCost,
        compacted,
        tokensBeforeEst,
        tokensAfterEst,
        savingsTokensEst,
        expectedCostSavingsEst,
        compactorExpectedCostEst,
        compactorCostEst,
        compactorTimeoutMs,
        compactorLatencyMs,
        compactionReason,
        compactionAttempted,
        compactionApplied,
        compactionSkippedReason,
        compactionError,
        error
      })
    );

    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    error = truncateError(message);
    const latencyMs = Date.now() - start;
    const usage = makeUsage(inputCharsUser, outgoingInputCharsTotal, finalContent.length);

    pushLog(
      makeLogEntry({
        requestId,
        sessionId,
        userExcerpt,
        route,
        modelUsed,
        confidence,
        reason,
        fallbackUsed,
        toolUsed,
        latencyMs,
        usage,
        inputTokensEst,
        outputTokensEst,
        expectedCostEst,
        candidateCosts,
        chosenReason,
        maxCostUsd,
        budgetActions,
        expectedCostVsBudget,
        actualUsage,
        actualCost,
        compacted,
        tokensBeforeEst,
        tokensAfterEst,
        savingsTokensEst,
        expectedCostSavingsEst,
        compactorExpectedCostEst,
        compactorCostEst,
        compactorTimeoutMs,
        compactorLatencyMs,
        compactionReason,
        compactionAttempted,
        compactionApplied,
        compactionSkippedReason,
        compactionError,
        error
      })
    );

    if (stream) {
      reply.hijack();
      chatStreamClients.add(reply.raw);
      request.raw.on('close', () => {
        chatStreamClients.delete(reply.raw);
      });
      reply.raw.writeHead(200, sseHeaders(request.headers.origin));
      safeSseWrite(reply.raw, 'meta', {
        request_id: requestId,
        session_id: sessionId,
        route,
        model_used: modelUsed,
        confidence,
        reason,
        fallback_route: fallbackRoute,
        tool_used: toolUsed,
        input_tokens_est: inputTokensEst,
        output_tokens_est: outputTokensEst,
        expected_cost_est: expectedCostEst,
        candidate_costs: candidateCosts,
        chosen_reason: chosenReason,
        max_cost_usd: maxCostUsd,
        budget_actions: budgetActions,
        expected_cost_vs_budget: expectedCostVsBudget,
        compacted,
        tokens_before_est: tokensBeforeEst,
        tokens_after_est: tokensAfterEst,
        savings_tokens_est: savingsTokensEst,
        expected_cost_savings_est: expectedCostSavingsEst,
        compactor_expected_cost_est: compactorExpectedCostEst,
        compactor_cost_est: compactorCostEst,
        compactor_timeout_ms: compactorTimeoutMs,
        compactor_latency_ms: compactorLatencyMs,
        compaction_reason: compactionReason,
        compaction_attempted: compactionAttempted,
        compaction_applied: compactionApplied,
        compaction_skipped_reason: compactionSkippedReason,
        compaction_error: compactionError
      });
      safeSseWrite(reply.raw, 'done', {
        content: finalContent,
        usage,
        latency_ms: latencyMs,
        actual_usage: actualUsage,
        actual_cost: actualCost,
        compacted,
        tokens_before_est: tokensBeforeEst,
        tokens_after_est: tokensAfterEst,
        savings_tokens_est: savingsTokensEst,
        expected_cost_savings_est: expectedCostSavingsEst,
        compactor_expected_cost_est: compactorExpectedCostEst,
        compactor_cost_est: compactorCostEst,
        compactor_timeout_ms: compactorTimeoutMs,
        compactor_latency_ms: compactorLatencyMs,
        compaction_reason: compactionReason,
        compaction_attempted: compactionAttempted,
        compaction_applied: compactionApplied,
        compaction_skipped_reason: compactionSkippedReason,
        compaction_error: compactionError
      });
      reply.raw.end();
      chatStreamClients.delete(reply.raw);
      return reply;
    }

    reply.code(500);
    return { error: 'Internal server error', request_id: requestId };
  }
});

await runStartupDiagnostics();
setInterval(cleanupRateLimits, RATE_LIMIT_WINDOW_MS).unref();

app.listen({ host: '0.0.0.0', port: PORT }).then(() => {
  process.stdout.write(`Gateway listening on :${PORT}\n`);
});
