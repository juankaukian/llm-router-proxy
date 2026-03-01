import { describe, expect, it } from 'vitest';
import { expectedCostUSD } from '../src/cost/pricing.js';
import { chooseCheapestReachableCandidate } from '../src/cost/selector.js';
import { estimateInputTokens } from '../src/cost/tokenEstimator.js';
import { RequestRouter } from '../src/router.js';

describe('token estimator', () => {
  it('falls back to heuristic for unknown families', () => {
    const messages = [{ role: 'user' as const, content: 'a'.repeat(40) }];
    const estimated = estimateInputTokens(messages, 'unknown');
    expect(estimated).toBeGreaterThanOrEqual(10);
    expect(estimated).toBeLessThanOrEqual(20);
  });
});

describe('cost math', () => {
  it('computes expected cost from input/output tokens and per-1m rates', () => {
    const value = expectedCostUSD(1200, 800, {
      logical_route: 'llm.mid',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      in_per_1m: 0.2,
      out_per_1m: 0.8
    });
    expect(value).toBeCloseTo(0.00088, 10);
  });
});

describe('cost-aware selector', () => {
  it('chooses cheaper mid model when both are reachable', () => {
    const inputTokens = 4000;
    const outputTokens = 800;
    const selected = chooseCheapestReachableCandidate({
      candidates: [
        {
          route: 'llm.mid',
          provider: 'openai',
          model: 'mid-expensive',
          expected_cost_est: expectedCostUSD(inputTokens, outputTokens, {
            logical_route: 'llm.mid',
            provider: 'openai',
            model: 'mid-expensive',
            in_per_1m: 1.0,
            out_per_1m: 2.0
          })
        },
        {
          route: 'llm.mid',
          provider: 'openai',
          model: 'mid-cheap',
          expected_cost_est: expectedCostUSD(inputTokens, outputTokens, {
            logical_route: 'llm.mid',
            provider: 'openai',
            model: 'mid-cheap',
            in_per_1m: 0.2,
            out_per_1m: 0.5
          })
        }
      ],
      reachableModels: new Set(['mid-expensive', 'mid-cheap']),
      inputTokens,
      outputTokens
    });
    expect(selected?.model).toBe('mid-cheap');
  });

  it('chooses next cheapest reachable model when cheapest is unreachable', () => {
    const selected = chooseCheapestReachableCandidate({
      candidates: [
        { route: 'llm.mid', provider: 'openai', model: 'mid-cheapest', expected_cost_est: 0.0012 },
        { route: 'llm.mid', provider: 'openai', model: 'mid-next', expected_cost_est: 0.0018 },
        { route: 'llm.mid', provider: 'openai', model: 'mid-expensive', expected_cost_est: 0.0025 }
      ],
      reachableModels: new Set(['mid-next', 'mid-expensive']),
      inputTokens: 1000,
      outputTokens: 200
    });
    expect(selected?.model).toBe('mid-next');
  });
});

describe('routing policy guardrails', () => {
  it('keeps tool-first behavior for arithmetic prompts', () => {
    const router = new RequestRouter({ small: 'small', mid: 'mid', big: 'big' });
    const decision = router.decide([{ role: 'user', content: '37 / 145 = ?' }]);
    expect(decision.route).toBe('tool.calculator');
  });
});
