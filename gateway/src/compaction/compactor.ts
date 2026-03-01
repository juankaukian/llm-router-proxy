import type { ChatMessage } from '../types.js';
import { expectedCostUSD, type PricingEntry } from '../cost/pricing.js';
import { estimateInputTokens, type ModelFamily } from '../cost/tokenEstimator.js';

export interface CompactionLimits {
  keepLastTurns: number;
  keepLastLogLines: number;
  minSavingsTokens: number;
  outputTargetTokens: number;
  maxLatencyMs: number;
}

export interface CompactionBudgetConfig {
  tool: number;
  math: number;
  mid: number;
  big: number;
}

export interface CompactionLLMConfig {
  provider: 'openai' | 'ollama';
  model: string;
  baseUrl?: string;
  openaiApiKey?: string;
}

export interface CompactionTelemetry {
  compacted: boolean;
  compaction_attempted: boolean;
  compaction_applied: boolean;
  compaction_skipped_reason?: 'skipped_threshold' | 'tool_route' | 'code_edit_preserve';
  tokens_before_est: number;
  tokens_after_est: number;
  savings_tokens_est: number;
  expected_cost_savings_est: number;
  compactor_expected_cost_est: number;
  compactor_cost_est: number;
  compactor_timeout_ms: number;
  compactor_latency_ms?: number;
  compaction_reason?: 'over_budget' | 'worth_it';
  compaction_error?: string;
}

export interface CompactionResult {
  messages: ChatMessage[];
  telemetry: CompactionTelemetry;
}

interface CompactionTriggerInput {
  tokensBefore: number;
  routeBudget: number;
  estimatedSavingsTokens: number;
  expectedCostSavingsEst: number;
  compactorExpectedCostEst: number;
  minSavingsTokens: number;
  codeEditPreserve: boolean;
}

const HEAVY_LOG_LINES = 80;

export function resolveRouteBudget(
  route: 'tool.calculator' | 'llm.small' | 'llm.mid' | 'llm.big',
  budgets: CompactionBudgetConfig
): number {
  if (route === 'tool.calculator') {
    return budgets.tool;
  }
  if (route === 'llm.small') {
    return budgets.math;
  }
  if (route === 'llm.mid') {
    return budgets.mid;
  }
  return budgets.big;
}

export function isCodeEditRequest(messages: ChatMessage[]): boolean {
  const user = [...messages].reverse().find((m) => m.role === 'user')?.content.toLowerCase() ?? '';
  const asksEdit = /(edit|refactor|fix|patch|update|change).*(code|function|file|module)/.test(user) || /(edit|refactor|fix)\s+this/.test(user);
  const hasCodeBlock = messages.some((m) => m.content.includes('```'));
  return asksEdit && hasCodeBlock;
}

function isLogAnalysisRequest(messages: ChatMessage[]): boolean {
  const user = [...messages].reverse().find((m) => m.role === 'user')?.content.toLowerCase() ?? '';
  return /(analy[sz]e|investigate|debug|root cause).*(log|trace|stack|error)/.test(user);
}

function userExplicitlyRequestsFullLogs(messages: ChatMessage[]): boolean {
  const user = [...messages].reverse().find((m) => m.role === 'user')?.content.toLowerCase() ?? '';
  return /(full logs|entire logs|complete logs|all logs|do not truncate|unabridged)/.test(user);
}

function looksLikeLargeLogBlock(content: string): boolean {
  const lines = content.split(/\r?\n/);
  if (lines.length < HEAVY_LOG_LINES) {
    return false;
  }
  const withTimestamps = lines.filter((line) => /\d{4}-\d{2}-\d{2}|\bINFO\b|\bWARN\b|\bERROR\b|Exception|Traceback/.test(line)).length;
  return withTimestamps >= Math.max(10, Math.floor(lines.length * 0.2));
}

function trimLogsWithLineNumbers(content: string, keepLastLines: number): string {
  const lines = content.split(/\r?\n/);
  if (lines.length <= keepLastLines) {
    return content;
  }
  const start = lines.length - keepLastLines;
  const kept = lines.slice(start).map((line, idx) => `L${start + idx + 1}: ${line}`);
  return `[log truncated: kept last ${keepLastLines} of ${lines.length} lines]\n${kept.join('\n')}`;
}

function dedupeAssistant(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let lastAssistant = '';
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const normalized = msg.content.trim();
      if (!normalized) {
        continue;
      }
      if (normalized === lastAssistant || (lastAssistant && normalized.length > 180 && normalized.includes(lastAssistant.slice(0, 160)))) {
        continue;
      }
      lastAssistant = normalized;
    }
    out.push(msg);
  }
  return out;
}

export function freePruneMessages(messages: ChatMessage[], keepLastTurns: number, keepLastLogLines: number): ChatMessage[] {
  const latestSystem = [...messages].reverse().find((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const keepCount = Math.max(1, keepLastTurns * 2);
  const tail = nonSystem.slice(-keepCount);
  const fullLogsRequested = userExplicitlyRequestsFullLogs(messages);
  const logAnalysis = isLogAnalysisRequest(messages);

  const processed = tail.map((msg) => {
    if (!fullLogsRequested && looksLikeLargeLogBlock(msg.content)) {
      return {
        ...msg,
        content: trimLogsWithLineNumbers(msg.content, keepLastLogLines)
      };
    }
    if (logAnalysis && msg.content.split(/\r?\n/).length > keepLastLogLines) {
      return {
        ...msg,
        content: trimLogsWithLineNumbers(msg.content, keepLastLogLines)
      };
    }
    return msg;
  });

  const pruned = dedupeAssistant(processed);
  return latestSystem ? [latestSystem, ...pruned] : pruned;
}

export function shouldRunLlmCompaction(input: CompactionTriggerInput): { run: boolean; reason?: 'over_budget' | 'worth_it' } {
  if (input.codeEditPreserve) {
    return { run: false };
  }
  if (input.tokensBefore > input.routeBudget) {
    return { run: true, reason: 'over_budget' };
  }
  if (input.estimatedSavingsTokens >= input.minSavingsTokens) {
    return { run: true, reason: 'worth_it' };
  }
  if (input.compactorExpectedCostEst > 0 && input.expectedCostSavingsEst >= input.compactorExpectedCostEst * 1.5) {
    return { run: true, reason: 'worth_it' };
  }
  return { run: false };
}

function modelFamilyForProvider(provider: 'openai' | 'ollama'): ModelFamily {
  return provider === 'openai' ? 'openai' : 'ollama';
}

function parseCompactorTextToBlock(text: string): string {
  const template = {
    Goal: 'unknown',
    Constraints: 'unknown',
    Decisions: 'unknown',
    'Current state': 'unknown',
    'Important artifacts (endpoints, env var names, file paths)': 'unknown',
    'Open questions': 'unknown'
  } as const;
  type TemplateKey = keyof typeof template;
  const templateKeys = Object.keys(template) as TemplateKey[];

  const lines = text.split(/\r?\n/);
  let currentKey: TemplateKey | null = null;
  const captured = Object.fromEntries(templateKeys.map((k) => [k, [] as string[]])) as Record<TemplateKey, string[]>;
  for (const line of lines) {
    const key = templateKeys.find((k) => line.toLowerCase().startsWith(`${k.toLowerCase()}:`));
    if (key) {
      currentKey = key;
      const value = line.slice(key.length + 1).trim();
      if (value) {
        captured[key].push(value);
      }
      continue;
    }
    if (currentKey) {
      captured[currentKey].push(line);
    }
  }

  return [
    'Goal:',
    (captured['Goal'].join('\n').trim() || template['Goal']),
    '',
    'Constraints:',
    (captured['Constraints'].join('\n').trim() || template['Constraints']),
    '',
    'Decisions:',
    (captured['Decisions'].join('\n').trim() || template['Decisions']),
    '',
    'Current state:',
    (captured['Current state'].join('\n').trim() || template['Current state']),
    '',
    'Important artifacts (endpoints, env var names, file paths):',
    (captured['Important artifacts (endpoints, env var names, file paths)'].join('\n').trim() ||
      template['Important artifacts (endpoints, env var names, file paths)']),
    '',
    'Open questions:',
    (captured['Open questions'].join('\n').trim() || template['Open questions'])
  ].join('\n');
}

async function callCompactor(messages: ChatMessage[], config: CompactionLLMConfig, timeoutMs: number, requestSignal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('compactor timeout')), timeoutMs);
  const onAbort = () => controller.abort(new Error('request cancelled'));
  if (requestSignal) {
    if (requestSignal.aborted) {
      onAbort();
    } else {
      requestSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  try {
    if (config.provider === 'openai') {
      if (!config.openaiApiKey) {
        throw new Error('COMPACTOR_PROVIDER=openai but OPENAI_API_KEY missing');
      }
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openaiApiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          messages
        })
      });
      if (!response.ok) {
        throw new Error(`OpenAI compactor failed (${response.status})`);
      }
      const parsed = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return parsed.choices?.[0]?.message?.content ?? '';
    }

    if (!config.baseUrl) {
      throw new Error('COMPACTOR_PROVIDER=ollama but COMPACTOR_BASE_URL missing');
    }
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages
      })
    });
    if (!response.ok) {
      throw new Error(`Ollama compactor failed (${response.status})`);
    }
    const parsed = (await response.json()) as { message?: { content?: string } };
    return parsed.message?.content ?? '';
  } finally {
    if (requestSignal) {
      requestSignal.removeEventListener('abort', onAbort);
    }
    clearTimeout(timer);
  }
}

export async function maybeCompactContext(args: {
  route: 'tool.calculator' | 'llm.small' | 'llm.mid' | 'llm.big';
  messages: ChatMessage[];
  limits: CompactionLimits;
  budgets: CompactionBudgetConfig;
  downstreamInputPricePer1M: number;
  estimatorFamily: ModelFamily;
  compactorConfig: CompactionLLMConfig;
  compactorPricing?: PricingEntry;
  requestSignal?: AbortSignal;
  invokeCompactor?: (messages: ChatMessage[], config: CompactionLLMConfig, timeoutMs: number, requestSignal?: AbortSignal) => Promise<string>;
}): Promise<CompactionResult> {
  const tokensBeforeEst = estimateInputTokens(args.messages, args.estimatorFamily);
  const freePruned = freePruneMessages(args.messages, args.limits.keepLastTurns, args.limits.keepLastLogLines);
  const afterFreeEst = estimateInputTokens(freePruned, args.estimatorFamily);

  const routeBudget = resolveRouteBudget(args.route, args.budgets);
  const target = Math.max(120, Math.min(Math.floor(routeBudget * 0.6), Math.floor(afterFreeEst * 0.4)));
  const estimatedSavingsTokens = Math.max(0, afterFreeEst - target);
  const compactorCostEst = expectedCostUSD(afterFreeEst, args.limits.outputTargetTokens, args.compactorPricing);
  const expectedCostSavingsEst = (estimatedSavingsTokens / 1_000_000) * args.downstreamInputPricePer1M;
  const codeEditPreserve = isCodeEditRequest(args.messages);
  const trigger = shouldRunLlmCompaction({
    tokensBefore: afterFreeEst,
    routeBudget,
    estimatedSavingsTokens,
    expectedCostSavingsEst,
    compactorExpectedCostEst: compactorCostEst,
    minSavingsTokens: args.limits.minSavingsTokens,
    codeEditPreserve
  });

  if (!trigger.run || args.route === 'tool.calculator') {
    const skippedReason =
      args.route === 'tool.calculator'
        ? 'tool_route'
        : codeEditPreserve
          ? 'code_edit_preserve'
          : 'skipped_threshold';
    return {
      messages: freePruned,
      telemetry: {
        compacted: false,
        compaction_attempted: false,
        compaction_applied: false,
        compaction_skipped_reason: skippedReason,
        tokens_before_est: tokensBeforeEst,
        tokens_after_est: afterFreeEst,
        savings_tokens_est: Math.max(0, tokensBeforeEst - afterFreeEst),
        expected_cost_savings_est: expectedCostSavingsEst,
        compactor_expected_cost_est: compactorCostEst,
        compactor_cost_est: compactorCostEst,
        compactor_timeout_ms: 0
      }
    };
  }

  const contextText = freePruned
    .map((m, idx) => `${idx + 1}. [${m.role}]\n${m.content}`)
    .join('\n\n');

  const compactorMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Compact the conversation context into this exact structure, never inventing facts. ' +
        'If unknown, write unknown. Keep key log lines with line numbers when logs are present. ' +
        'If code blocks are the target of edits, keep them verbatim.',
    },
    {
      role: 'user',
      content:
        `Create a concise context block from this conversation:\n\n${contextText}\n\n` +
        'Output exactly:\n' +
        'Goal:\n' +
        'Constraints:\n' +
        'Decisions:\n' +
        'Current state:\n' +
        'Important artifacts (endpoints, env var names, file paths):\n' +
        'Open questions:'
    }
  ];

  const start = Date.now();
  try {
    const invokeCompactor = args.invokeCompactor ?? callCompactor;
    const compactedText = await invokeCompactor(compactorMessages, args.compactorConfig, args.limits.maxLatencyMs, args.requestSignal);
    const structured = parseCompactorTextToBlock(compactedText);
    const latestUser = [...freePruned].reverse().find((m) => m.role === 'user');
    const latestSystem = [...freePruned].reverse().find((m) => m.role === 'system');
    const compactedMessages: ChatMessage[] = [
      ...(latestSystem ? [latestSystem] : []),
      {
        role: 'system',
        content: `Compacted context:\n${structured}`
      },
      ...(latestUser ? [latestUser] : [])
    ];
    const afterEst = estimateInputTokens(compactedMessages, args.estimatorFamily);
    return {
      messages: compactedMessages,
      telemetry: {
        compacted: true,
        compaction_attempted: true,
        compaction_applied: true,
        tokens_before_est: tokensBeforeEst,
        tokens_after_est: afterEst,
        savings_tokens_est: Math.max(0, tokensBeforeEst - afterEst),
        expected_cost_savings_est: expectedCostSavingsEst,
        compactor_expected_cost_est: compactorCostEst,
        compactor_cost_est: compactorCostEst,
        compactor_timeout_ms: args.limits.maxLatencyMs,
        compactor_latency_ms: Date.now() - start,
        compaction_reason: trigger.reason
      }
    };
  } catch (err) {
    return {
      messages: freePruned,
      telemetry: {
        compacted: false,
        compaction_attempted: true,
        compaction_applied: false,
        tokens_before_est: tokensBeforeEst,
        tokens_after_est: afterFreeEst,
        savings_tokens_est: Math.max(0, tokensBeforeEst - afterFreeEst),
        expected_cost_savings_est: expectedCostSavingsEst,
        compactor_expected_cost_est: compactorCostEst,
        compactor_cost_est: compactorCostEst,
        compactor_timeout_ms: args.limits.maxLatencyMs,
        compactor_latency_ms: Date.now() - start,
        compaction_reason: trigger.reason,
        compaction_error: err instanceof Error ? err.message.slice(0, 180) : 'Compactor failed'
      }
    };
  }
}

export function compactorEstimatorFamily(config: CompactionLLMConfig): ModelFamily {
  return modelFamilyForProvider(config.provider);
}
