import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { OllamaAdapter } from '../src/adapters/ollama.js';
import { maybeCompactContext } from '../src/compaction/compactor.js';
import { estimateOutputTokens } from '../src/cost/outputPredictor.js';
import { expectedCostUSD, findPricingByProviderModel, findPricingEntry, listRoutePricingCandidates, loadPricingConfig } from '../src/cost/pricing.js';
import { estimateInputTokens } from '../src/cost/tokenEstimator.js';
import { RequestRouter } from '../src/router.js';
import { evaluateMath } from '../src/tools/calculator.js';
import type { ChatMessage, CostCandidate, TokenUsage } from '../src/types.js';

type Category = 'math' | 'rewrite' | 'logs' | 'code' | 'reasoning';
type EvalMode = 'baseline' | 'routed';
type EvalExpectType = 'number' | 'json' | 'contains';
type EvalRoute = 'tool.calculator' | 'llm.small' | 'llm.mid' | 'llm.big';
type EvalProvider = 'openai' | 'ollama';
type BudgetAction = 'compacted' | 'reduced_output_tokens' | 'model_switched';

interface EvalCase {
  id: string;
  category: Category;
  messages: ChatMessage[];
  expect: {
    type: EvalExpectType;
    value: unknown;
    epsilon?: number;
  };
}

interface ModelCandidate {
  route: Exclude<EvalRoute, 'tool.calculator'>;
  provider: EvalProvider;
  model: string;
  expected_cost_est: number;
}

interface RunResult {
  case_id: string;
  mode: EvalMode;
  category: Category;
  route: EvalRoute;
  model: string;
  provider?: EvalProvider;
  expected_cost_est: number;
  actual_cost?: number;
  latency_ms: number;
  compacted: boolean;
  savings_tokens_est: number;
  budget_actions: BudgetAction[];
  candidate_costs: CostCandidate[];
  status_code?: number;
  error?: string;
  content?: string;
  actual_usage?: TokenUsage;
  pass: boolean;
  score_detail: string;
}

interface EvalSummary {
  total_cost_baseline: number;
  total_cost_routed: number;
  savings_percent: number;
  avg_latency_baseline_ms: number;
  avg_latency_routed_ms: number;
  p95_latency_baseline_ms: number;
  p95_latency_routed_ms: number;
  route_distribution_routed: Record<string, number>;
  compaction_rate_routed: number;
  avg_compaction_savings_tokens: number;
  count_422: number;
  failures_count: number;
}

interface EvalReport {
  generated_at: string;
  source_file: string;
  summary: EvalSummary;
  runs: RunResult[];
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_SMALL_MODEL = process.env.OPENAI_SMALL_MODEL ?? 'gpt-4o-mini';
const OPENAI_MID_MODEL = process.env.OPENAI_MID_MODEL ?? 'gpt-4.1-mini';
const OPENAI_BIG_MODEL = process.env.OPENAI_BIG_MODEL ?? 'gpt-4.1';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? '';
const PRICING_CONFIG_DIR = process.env.PRICING_CONFIG_DIR ?? process.cwd();
const COMPACTOR_PROVIDER = (process.env.COMPACTOR_PROVIDER ?? (OLLAMA_BASE_URL && OLLAMA_MODEL ? 'ollama' : 'openai')) as EvalProvider;
const COMPACTOR_MODEL = process.env.COMPACTOR_MODEL ?? (COMPACTOR_PROVIDER === 'ollama' ? OLLAMA_MODEL : OPENAI_SMALL_MODEL);
const COMPACTOR_BASE_URL = process.env.COMPACTOR_BASE_URL ?? OLLAMA_BASE_URL;
const COMPACTOR_TIMEOUT_MS = Number(process.env.COMPACTOR_TIMEOUT_MS ?? 20_000);
const COMPACT_KEEP_LAST_TURNS = Number(process.env.COMPACT_KEEP_LAST_TURNS ?? 6);
const COMPACT_KEEP_LAST_LOG_LINES = 120;
const COMPACT_MIN_SAVINGS_TOKENS = Number(process.env.COMPACT_MIN_SAVINGS_TOKENS ?? 1000);
const COMPACTOR_OUTPUT_TOKENS_EST = Number(process.env.COMPACTOR_OUTPUT_TOKENS_EST ?? 600);
const MAX_INPUT_TOKENS_TOOL = Number(process.env.MAX_INPUT_TOKENS_TOOL ?? 8_000);
const MAX_INPUT_TOKENS_MATH = Number(process.env.MAX_INPUT_TOKENS_MATH ?? 12_000);
const MAX_INPUT_TOKENS_MID = Number(process.env.MAX_INPUT_TOKENS_MID ?? 24_000);
const MAX_INPUT_TOKENS_BIG = Number(process.env.MAX_INPUT_TOKENS_BIG ?? 64_000);

function parseArgs(argv: string[]): { file: string } {
  const fallback = 'eval/cases.jsonl';
  const idx = argv.indexOf('--file');
  if (idx === -1 || !argv[idx + 1]) {
    return { file: fallback };
  }
  return { file: argv[idx + 1] as string };
}

async function loadCases(filePath: string): Promise<EvalCase[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  const cases: EvalCase[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = JSON.parse(trimmed) as EvalCase;
    cases.push(parsed);
  }
  return cases;
}

function attemptPlan(route: EvalRoute): EvalRoute[] {
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

function scoreOutput(evalCase: EvalCase, content: string): { pass: boolean; detail: string } {
  if (evalCase.expect.type === 'contains') {
    const needle = String(evalCase.expect.value ?? '');
    const pass = content.toLowerCase().includes(needle.toLowerCase());
    return { pass, detail: pass ? 'contains matched' : `missing substring "${needle}"` };
  }

  if (evalCase.expect.type === 'json') {
    try {
      JSON.parse(content);
      return { pass: true, detail: 'valid JSON' };
    } catch {
      return { pass: false, detail: 'invalid JSON output' };
    }
  }

  const expected = Number(evalCase.expect.value);
  const epsilon = Number(evalCase.expect.epsilon ?? 1e-6);
  const match = content.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return { pass: false, detail: 'no numeric value found in output' };
  }
  const actual = Number(match[0]);
  const pass = Math.abs(actual - expected) <= epsilon;
  return { pass, detail: pass ? `numeric within epsilon (${epsilon})` : `expected ${expected}, got ${actual}` };
}

function parseStatusCode(message: string): number | undefined {
  const match = message.match(/\((\d{3})\)/);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function p95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = path.resolve(args.file);
  const reportPath = path.resolve('eval/report.json');
  const pricingLoad = loadPricingConfig(PRICING_CONFIG_DIR);
  const pricingConfig = pricingLoad.config;

  const openai = OPENAI_API_KEY ? new OpenAIAdapter(OPENAI_API_KEY) : null;
  const ollama = OLLAMA_BASE_URL ? new OllamaAdapter(OLLAMA_BASE_URL.replace(/\/$/, '')) : null;
  const useOllamaSmall = Boolean(ollama && OLLAMA_MODEL);
  const router = new RequestRouter({
    small: useOllamaSmall ? OLLAMA_MODEL : OPENAI_SMALL_MODEL,
    mid: OPENAI_MID_MODEL,
    big: OPENAI_BIG_MODEL
  });

  const reachable = new Set<string>();
  if (openai) {
    reachable.add(OPENAI_SMALL_MODEL);
    reachable.add(OPENAI_MID_MODEL);
    reachable.add(OPENAI_BIG_MODEL);
  }
  if (ollama && OLLAMA_MODEL) {
    const ok = await ollama.health(OLLAMA_MODEL);
    if (ok) {
      reachable.add(OLLAMA_MODEL);
      reachable.add(`${OLLAMA_MODEL}:latest`);
    }
  }

  const buildCandidates = (
    route: Exclude<EvalRoute, 'tool.calculator'>,
    inputTokens: number,
    outputTokens: number
  ): ModelCandidate[] => {
    const priced = listRoutePricingCandidates(pricingConfig, route)
      .map((entry) => ({
        route,
        provider: entry.provider,
        model: entry.model,
        expected_cost_est: expectedCostUSD(inputTokens, outputTokens, entry)
      }))
      .filter((candidate) => (candidate.provider === 'ollama' ? Boolean(ollama) : Boolean(openai)));
    if (priced.length > 0) {
      return priced.sort((a, b) => a.expected_cost_est - b.expected_cost_est);
    }
    if (route === 'llm.small' && useOllamaSmall) {
      return [{ route, provider: 'ollama', model: OLLAMA_MODEL, expected_cost_est: 0 }];
    }
    const model = route === 'llm.small' ? OPENAI_SMALL_MODEL : route === 'llm.mid' ? OPENAI_MID_MODEL : OPENAI_BIG_MODEL;
    return [{ route, provider: 'openai', model, expected_cost_est: 0 }];
  };

  const chooseCandidate = (
    route: Exclude<EvalRoute, 'tool.calculator'>,
    inputTokens: number,
    outputTokens: number,
    forceCheapest: boolean
  ): { selected: ModelCandidate; candidate_costs: CostCandidate[] } => {
    const candidates = buildCandidates(route, inputTokens, outputTokens);
    const candidate_costs: CostCandidate[] = candidates.map((c) => ({
      route: c.route,
      provider: c.provider,
      model: c.model,
      expected_cost_est: c.expected_cost_est
    }));
    const eligible = candidates.filter((c) => reachable.has(c.model));
    const selectedPool = eligible.length > 0 ? eligible : candidates;
    const selected = forceCheapest ? selectedPool[0] : selectedPool.find((c) => c.model === (route === 'llm.small' ? (useOllamaSmall ? OLLAMA_MODEL : OPENAI_SMALL_MODEL) : route === 'llm.mid' ? OPENAI_MID_MODEL : OPENAI_BIG_MODEL)) ?? selectedPool[0];
    if (!selected) {
      throw new Error(`No candidate for route ${route}`);
    }
    return { selected, candidate_costs };
  };

  const runCase = async (evalCase: EvalCase, mode: EvalMode): Promise<RunResult> => {
    const started = performance.now();
    const budgetActions: BudgetAction[] = [];
    let route: EvalRoute = mode === 'baseline' ? 'llm.big' : router.decide(evalCase.messages).route;
    let model = mode === 'baseline' ? OPENAI_BIG_MODEL : '';
    let provider: EvalProvider | undefined = mode === 'baseline' ? 'openai' : undefined;
    let expectedCostEst = 0;
    let actualCost: number | undefined;
    let compacted = false;
    let savingsTokensEst = 0;
    let candidateCosts: CostCandidate[] = [];
    let content = '';
    let actualUsage: TokenUsage | undefined;

    try {
      const stages = mode === 'baseline' ? (['llm.big'] as EvalRoute[]) : attemptPlan(route);

      for (const stage of stages) {
        if (stage === 'tool.calculator') {
          try {
            content = evaluateMath([...evalCase.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
            route = 'tool.calculator';
            model = 'tool.calculator';
            provider = undefined;
            expectedCostEst = 0;
            const score = scoreOutput(evalCase, content);
            return {
              case_id: evalCase.id,
              mode,
              category: evalCase.category,
              route,
              model,
              expected_cost_est: expectedCostEst,
              actual_cost: 0,
              latency_ms: performance.now() - started,
              compacted: false,
              savings_tokens_est: 0,
              budget_actions: budgetActions,
              candidate_costs: [],
              content,
              pass: score.pass,
              score_detail: score.detail
            };
          } catch {
            continue;
          }
        }

        const verbosity = mode === 'baseline' ? 'detailed' : 'normal';
        const stageMessages = [...evalCase.messages];
        const outputTokensEst = estimateOutputTokens(stageMessages, stage, verbosity);
        const inputTokensPre = estimateInputTokens(stageMessages, 'openai');
        const preSelected = chooseCandidate(stage, inputTokensPre, outputTokensEst, mode === 'routed');
        let outgoingMessages = stageMessages;

        if (mode === 'routed') {
          const prePricing = findPricingEntry(pricingConfig, stage, preSelected.selected.provider, preSelected.selected.model);
          const compaction = await maybeCompactContext({
            route: stage,
            messages: stageMessages,
            limits: {
              keepLastTurns: COMPACT_KEEP_LAST_TURNS,
              keepLastLogLines: COMPACT_KEEP_LAST_LOG_LINES,
              minSavingsTokens: COMPACT_MIN_SAVINGS_TOKENS,
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
          outgoingMessages = compaction.messages;
          compacted = compaction.telemetry.compaction_applied;
          savingsTokensEst = compaction.telemetry.savings_tokens_est;
          if (compaction.telemetry.compaction_applied) {
            budgetActions.push('compacted');
          }
        }

        const estimatorFamily = preSelected.selected.provider === 'openai' ? 'openai' : 'ollama';
        const inputTokens = estimateInputTokens(outgoingMessages, estimatorFamily);
        const selected = chooseCandidate(stage, inputTokens, outputTokensEst, mode === 'routed');
        candidateCosts = selected.candidate_costs;
        route = stage;
        model = selected.selected.model;
        provider = selected.selected.provider;
        expectedCostEst = selected.selected.expected_cost_est;

        const completion =
          provider === 'ollama'
            ? await (ollama as OllamaAdapter).complete(outgoingMessages, model, { max_output_tokens: outputTokensEst })
            : await (openai as OpenAIAdapter).complete(outgoingMessages, model, { max_output_tokens: outputTokensEst });
        content = completion.content;
        actualUsage = completion.token_usage;
        const pricingEntry = findPricingEntry(pricingConfig, stage, provider, model);
        if (actualUsage?.input_tokens !== undefined && actualUsage?.output_tokens !== undefined) {
          actualCost = expectedCostUSD(actualUsage.input_tokens, actualUsage.output_tokens, pricingEntry);
        }
        break;
      }

      if (!content) {
        throw new Error('No stage produced output');
      }

      const score = scoreOutput(evalCase, content);
      return {
        case_id: evalCase.id,
        mode,
        category: evalCase.category,
        route,
        model,
        provider,
        expected_cost_est: expectedCostEst,
        actual_cost: actualCost,
        latency_ms: performance.now() - started,
        compacted,
        savings_tokens_est: savingsTokensEst,
        budget_actions: budgetActions,
        candidate_costs: candidateCosts,
        content,
        actual_usage: actualUsage,
        pass: score.pass,
        score_detail: score.detail
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        case_id: evalCase.id,
        mode,
        category: evalCase.category,
        route,
        model: model || 'unknown',
        provider,
        expected_cost_est: expectedCostEst,
        actual_cost: actualCost,
        latency_ms: performance.now() - started,
        compacted,
        savings_tokens_est: savingsTokensEst,
        budget_actions: budgetActions,
        candidate_costs: candidateCosts,
        status_code: parseStatusCode(message),
        error: message,
        pass: false,
        score_detail: 'execution error'
      };
    }
  };

  const cases = await loadCases(file);
  const runs: RunResult[] = [];
  for (const evalCase of cases) {
    const baseline = await runCase(evalCase, 'baseline');
    const routed = await runCase(evalCase, 'routed');
    runs.push(baseline, routed);
  }

  const baselineRuns = runs.filter((r) => r.mode === 'baseline');
  const routedRuns = runs.filter((r) => r.mode === 'routed');
  const totalCostBaseline = baselineRuns.reduce((acc, r) => acc + (r.actual_cost ?? r.expected_cost_est ?? 0), 0);
  const totalCostRouted = routedRuns.reduce((acc, r) => acc + (r.actual_cost ?? r.expected_cost_est ?? 0), 0);
  const savingsPercent = totalCostBaseline > 0 ? ((totalCostBaseline - totalCostRouted) / totalCostBaseline) * 100 : 0;
  const routeDistribution = routedRuns.reduce<Record<string, number>>((acc, run) => {
    acc[run.route] = (acc[run.route] ?? 0) + 1;
    return acc;
  }, {});
  const compactedRuns = routedRuns.filter((r) => r.compacted);
  const count422 = runs.filter((r) => r.status_code === 422).length;
  const failures = runs.filter((r) => Boolean(r.error));

  const summary: EvalSummary = {
    total_cost_baseline: totalCostBaseline,
    total_cost_routed: totalCostRouted,
    savings_percent: savingsPercent,
    avg_latency_baseline_ms: average(baselineRuns.map((r) => r.latency_ms)),
    avg_latency_routed_ms: average(routedRuns.map((r) => r.latency_ms)),
    p95_latency_baseline_ms: p95(baselineRuns.map((r) => r.latency_ms)),
    p95_latency_routed_ms: p95(routedRuns.map((r) => r.latency_ms)),
    route_distribution_routed: routeDistribution,
    compaction_rate_routed: routedRuns.length > 0 ? compactedRuns.length / routedRuns.length : 0,
    avg_compaction_savings_tokens: average(compactedRuns.map((r) => r.savings_tokens_est)),
    count_422: count422,
    failures_count: failures.length
  };

  const report: EvalReport = {
    generated_at: new Date().toISOString(),
    source_file: file,
    summary,
    runs
  };

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.table([
    {
      total_cost_baseline: summary.total_cost_baseline.toFixed(6),
      total_cost_routed: summary.total_cost_routed.toFixed(6),
      savings_percent: `${summary.savings_percent.toFixed(2)}%`,
      avg_latency_baseline_ms: summary.avg_latency_baseline_ms.toFixed(1),
      avg_latency_routed_ms: summary.avg_latency_routed_ms.toFixed(1),
      p95_latency_baseline_ms: summary.p95_latency_baseline_ms.toFixed(1),
      p95_latency_routed_ms: summary.p95_latency_routed_ms.toFixed(1),
      compaction_rate_routed: `${(summary.compaction_rate_routed * 100).toFixed(1)}%`,
      avg_compaction_savings_tokens: summary.avg_compaction_savings_tokens.toFixed(1),
      count_422: summary.count_422,
      failures_count: summary.failures_count
    }
  ]);
  console.table(
    Object.entries(summary.route_distribution_routed).map(([routeKey, count]) => ({
      route: routeKey,
      count
    }))
  );
  console.log(`Wrote ${reportPath}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : 'unknown error';
  console.error(`eval failed: ${message}`);
  process.exit(1);
});
