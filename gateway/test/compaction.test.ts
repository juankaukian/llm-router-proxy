import { describe, expect, it, vi } from 'vitest';
import { freePruneMessages, isCodeEditRequest, maybeCompactContext, shouldRunLlmCompaction } from '../src/compaction/compactor.js';
import type { ChatMessage } from '../src/types.js';

const baseArgs = {
  route: 'llm.mid' as const,
  limits: {
    keepLastTurns: 6,
    keepLastLogLines: 120,
    minSavingsTokens: 1000,
    outputTargetTokens: 300,
    maxLatencyMs: 20_000
  },
  budgets: {
    tool: 8000,
    math: 12000,
    mid: 24000,
    big: 64000
  },
  downstreamInputPricePer1M: 1.2,
  estimatorFamily: 'unknown' as const,
  compactorConfig: {
    provider: 'ollama' as const,
    model: 'test-model',
    baseUrl: 'http://localhost:11434'
  }
};

describe('compaction trigger rules', () => {
  it('triggers when over budget', () => {
    const result = shouldRunLlmCompaction({
      tokensBefore: 9000,
      routeBudget: 4000,
      estimatedSavingsTokens: 200,
      expectedCostSavingsEst: 0.0001,
      compactorExpectedCostEst: 0.001,
      minSavingsTokens: 1000,
      codeEditPreserve: false
    });
    expect(result.run).toBe(true);
    expect(result.reason).toBe('over_budget');
  });

  it('does not trigger when code edit with code blocks should be preserved', () => {
    const result = shouldRunLlmCompaction({
      tokensBefore: 9000,
      routeBudget: 2000,
      estimatedSavingsTokens: 5000,
      expectedCostSavingsEst: 0.01,
      compactorExpectedCostEst: 0.001,
      minSavingsTokens: 1000,
      codeEditPreserve: true
    });
    expect(result.run).toBe(false);
  });

  it('savings below threshold skips compactor call', async () => {
    const invokeCompactor = vi.fn(async () => 'should-not-run');
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

    const result = await maybeCompactContext({
      ...baseArgs,
      messages,
      invokeCompactor
    });

    expect(invokeCompactor).not.toHaveBeenCalled();
    expect(result.telemetry.compaction_attempted).toBe(false);
    expect(result.telemetry.compaction_skipped_reason).toBe('skipped_threshold');
    expect(result.telemetry.compactor_timeout_ms).toBe(0);
  });

  it('triggers on expected cost savings ratio even below token threshold', () => {
    const result = shouldRunLlmCompaction({
      tokensBefore: 800,
      routeBudget: 4000,
      estimatedSavingsTokens: 300,
      expectedCostSavingsEst: 0.003,
      compactorExpectedCostEst: 0.001,
      minSavingsTokens: 1000,
      codeEditPreserve: false
    });
    expect(result.run).toBe(true);
    expect(result.reason).toBe('worth_it');
  });
});

describe('free pruning behavior', () => {
  it('preserves last N turns', () => {
    const messages = [
      { role: 'system' as const, content: 's' },
      { role: 'user' as const, content: 'u1' },
      { role: 'assistant' as const, content: 'a1' },
      { role: 'user' as const, content: 'u2' },
      { role: 'assistant' as const, content: 'a2' },
      { role: 'user' as const, content: 'u3' },
      { role: 'assistant' as const, content: 'a3' },
      { role: 'user' as const, content: 'u4' },
      { role: 'assistant' as const, content: 'a4' }
    ];
    const pruned = freePruneMessages(messages, 2, 100);
    const nonSystem = pruned.filter((m) => m.role !== 'system');
    expect(nonSystem.map((m) => m.content)).toEqual(['u3', 'a3', 'u4', 'a4']);
  });

  it('detects code edit requests with code blocks', () => {
    const messages = [
      { role: 'user' as const, content: 'Please refactor this code block.' },
      { role: 'assistant' as const, content: '```ts\nconst x = 1;\n```' }
    ];
    expect(isCodeEditRequest(messages)).toBe(true);
  });
});

describe('compactor execution and apply behavior', () => {
  it('compactor success applies smaller outgoing messages and sets compacted=true', async () => {
    const long = 'x'.repeat(8_000);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: `Previous context:\n${long}` },
      { role: 'assistant', content: `Verbose response:\n${long}` },
      { role: 'user', content: 'Please continue with the fix using prior context.' }
    ];
    const invokeCompactor = vi.fn(async () => `Goal:\nA\nConstraints:\nB\nDecisions:\nC\nCurrent state:\nD\nImportant artifacts (endpoints, env var names, file paths):\nE\nOpen questions:\nF`);

    const result = await maybeCompactContext({
      ...baseArgs,
      messages,
      invokeCompactor
    });

    expect(invokeCompactor).toHaveBeenCalledTimes(1);
    expect(result.telemetry.compaction_attempted).toBe(true);
    expect(result.telemetry.compaction_applied).toBe(true);
    expect(result.telemetry.compacted).toBe(true);
    expect(result.telemetry.tokens_after_est).toBeLessThan(result.telemetry.tokens_before_est);
    expect(result.messages.some((m) => m.content.startsWith('Compacted context:'))).toBe(true);
  });

  it('compactor can complete without abort when request continues', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(20_000) }
    ];
    const invokeCompactor = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return `Goal:\nA\nConstraints:\nB\nDecisions:\nC\nCurrent state:\nD\nImportant artifacts (endpoints, env var names, file paths):\nE\nOpen questions:\nF`;
    });

    const result = await maybeCompactContext({
      ...baseArgs,
      messages,
      limits: { ...baseArgs.limits, maxLatencyMs: 500 },
      invokeCompactor
    });

    expect(invokeCompactor).toHaveBeenCalledTimes(1);
    expect(result.telemetry.compaction_error).toBeUndefined();
    expect(result.telemetry.compacted).toBe(true);
  });

  it('passes COMPACTOR_TIMEOUT_MS value into compactor invocation', async () => {
    const invokeCompactor = vi.fn(async (messagesArg: ChatMessage[], configArg: unknown, timeoutArg: number, requestSignalArg?: AbortSignal) => {
      void messagesArg;
      void configArg;
      void timeoutArg;
      void requestSignalArg;
      return `Goal:\nA\nConstraints:\nB\nDecisions:\nC\nCurrent state:\nD\nImportant artifacts (endpoints, env var names, file paths):\nE\nOpen questions:\nF`;
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(20_000) }
    ];

    const result = await maybeCompactContext({
      ...baseArgs,
      messages,
      limits: { ...baseArgs.limits, maxLatencyMs: 12345 },
      invokeCompactor
    });

    expect(invokeCompactor).toHaveBeenCalled();
    const timeoutArg = invokeCompactor.mock.calls[0]?.[2];
    expect(timeoutArg).toBe(12345);
    expect(result.telemetry.compaction_attempted).toBe(true);
    expect(result.telemetry.compactor_timeout_ms).toBe(12345);
  });
});
