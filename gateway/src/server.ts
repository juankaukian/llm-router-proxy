import 'dotenv/config';
import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { URL } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { OpenAIAdapter } from './adapters/openai.js';
import { OllamaAdapter } from './adapters/ollama.js';
import { RequestRouter } from './router.js';
import { evaluateMath } from './tools/calculator.js';
import type { ChatMessage, ChatRequestBody, ChatJsonResponse, RequestLogEntry, RouterDecision, SessionState, Usage } from './types.js';

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
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_CHAT_MAX = Number(process.env.RATE_LIMIT_CHAT_MAX ?? 60);
const RATE_LIMIT_SSE_MAX = Number(process.env.RATE_LIMIT_SSE_MAX ?? 20);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 8_000);
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY ?? '';

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
  last_startup_report: DiagLine[];
  suggestions: string[];
}

const useOllamaSmall = Boolean(OLLAMA_BASE_URL && OLLAMA_MODEL);
const openai = OPENAI_API_KEY ? new OpenAIAdapter(OPENAI_API_KEY) : null;
const ollama = useOllamaSmall ? new OllamaAdapter((OLLAMA_BASE_URL as string).replace(/\/$/, '')) : null;

const router = new RequestRouter({
  small: useOllamaSmall ? (OLLAMA_MODEL as string) : OPENAI_SMALL_MODEL,
  mid: OPENAI_MID_MODEL,
  big: OPENAI_BIG_MODEL
});

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
  last_startup_report: [],
  suggestions: []
};

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
    error: args.error
  };
}

function mustGetAdapter(route: 'llm.small' | 'llm.mid' | 'llm.big'): { model: string; adapter: 'openai' | 'ollama' } {
  if (route === 'llm.small' && ollama && OLLAMA_MODEL) {
    const validation = isAllowedOllamaBaseUrl(OLLAMA_BASE_URL);
    if (!validation.ok) {
      throw new Error(`Ollama base URL blocked: ${validation.reason ?? 'invalid URL'}`);
    }
    return { model: OLLAMA_MODEL, adapter: 'ollama' };
  }

  if (!openai) {
    throw new Error('OpenAI not configured (missing OPENAI_API_KEY)');
  }

  if (route === 'llm.small') {
    return { model: OPENAI_SMALL_MODEL, adapter: 'openai' };
  }
  if (route === 'llm.mid') {
    return { model: OPENAI_MID_MODEL, adapter: 'openai' };
  }
  return { model: OPENAI_BIG_MODEL, adapter: 'openai' };
}

async function runStartupDiagnostics(): Promise<void> {
  const report: DiagLine[] = [];
  const suggestions: string[] = [];

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
          addStartupLine(report, 'info', 'OpenAI probe succeeded', { probe: 'GET /v1/models' });

          const parsed = (await response.json()) as { data?: Array<{ id?: string }> };
          const ids = new Set((parsed.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)));
          for (const modelName of [OPENAI_SMALL_MODEL, OPENAI_MID_MODEL, OPENAI_BIG_MODEL]) {
            const found = ids.has(modelName);
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

app.post<{ Body: ChatRequestBody }>('/v1/chat', async (request, reply) => {
  const start = Date.now();
  const requestId = crypto.randomUUID();

  const body = request.body;
  const messages = body?.messages;
  const stream = Boolean(body?.stream);
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
  const hasInvalidMessage = messages.some(
    (m) => !m || typeof m.content !== 'string' || !['system', 'user', 'assistant'].includes(m.role) || m.content.length > MAX_CONTENT_CHARS
  );
  if (hasInvalidMessage) {
    reply.code(400);
    return { error: `invalid message format or content too large (max ${MAX_CONTENT_CHARS} chars)` };
  }

  const userText = getLastUser(messages);
  const userExcerpt = userText.slice(0, 150);
  const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);

  let route = 'unknown';
  let modelUsed = 'unknown';
  let confidence = 0;
  let reason = '';
  let fallbackRoute: RouterDecision['fallback_route'];
  let fallbackUsed = false;
  let toolUsed = false;
  let error: string | null = null;
  let finalContent = '';

  try {
    const session = getSession(sessionId);
    const decision = router.decide(messages, session);
    route = decision.route;
    modelUsed = decision.model;
    confidence = decision.confidence;
    reason = decision.reason;
    fallbackRoute = decision.fallback_route;
    let effectiveDecision: RouterDecision = { ...decision };

    let effectiveRoute: RouterDecision['route'] = decision.route;
    let effectiveMessages = buildMessages(messages, session);

    if (effectiveRoute === 'tool.calculator') {
      try {
        finalContent = evaluateMath(userText);
        toolUsed = true;

        const usage: Usage = { input_chars: inputChars, output_chars: finalContent.length };
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
            tool_used: true
          });
          safeSseWrite(reply.raw, 'token', { delta: finalContent });
          safeSseWrite(reply.raw, 'done', { content: finalContent, usage, latency_ms: latencyMs });
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
            error
          })
        );

        return reply;
      } catch {
        effectiveRoute = 'llm.small';
        route = 'llm.small';
        fallbackUsed = true;
        const fallback = mustGetAdapter('llm.small');
        modelUsed = fallback.model;
        reason = `${reason} Calculator parse failed; fell back to llm.small.`;
        effectiveDecision = {
          route: 'llm.small',
          confidence,
          reason,
          model: fallback.model,
          fallback_route: fallbackRoute
        };
        effectiveMessages = buildMessages(
          [
            {
              role: 'system',
              content: 'Solve the user math question. Return only the answer followed by brief steps.'
            },
            ...messages
          ],
          session
        );
      }
    }

    const llm = mustGetAdapter(effectiveRoute as 'llm.small' | 'llm.mid' | 'llm.big');
    modelUsed = llm.model;
    if (!fallbackUsed) {
      effectiveDecision = {
        ...effectiveDecision,
        route: effectiveRoute,
        model: llm.model
      };
    }

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
        tool_used: toolUsed
      });

      const streamSource =
        llm.adapter === 'ollama'
          ? (ollama as OllamaAdapter).stream(effectiveMessages, llm.model)
          : (openai as OpenAIAdapter).stream(effectiveMessages, llm.model);

      for await (const delta of streamSource) {
        finalContent += delta;
        if (!safeSseWrite(reply.raw, 'token', { delta })) {
          break;
        }
      }

      const usage: Usage = { input_chars: inputChars, output_chars: finalContent.length };
      const latencyMs = Date.now() - start;
      persistSession(sessionId, route, modelUsed, userText, finalContent);
      safeSseWrite(reply.raw, 'done', { content: finalContent, usage, latency_ms: latencyMs });
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
          usage,
          error
        })
      );

      return reply;
    }

    const completion =
      llm.adapter === 'ollama'
        ? await (ollama as OllamaAdapter).complete(effectiveMessages, llm.model)
        : await (openai as OpenAIAdapter).complete(effectiveMessages, llm.model);

    finalContent = completion.content;
    const usage = completion.usage ?? { input_chars: inputChars, output_chars: finalContent.length };
    const latencyMs = Date.now() - start;
    persistSession(sessionId, route, modelUsed, userText, finalContent);

    const response: ChatJsonResponse = {
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
        error
      })
    );

    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    error = truncateError(message);
    const latencyMs = Date.now() - start;
    const usage: Usage = { input_chars: inputChars, output_chars: finalContent.length };

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
        tool_used: toolUsed
      });
      safeSseWrite(reply.raw, 'done', { content: finalContent, usage, latency_ms: latencyMs });
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
