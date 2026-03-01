import { describe, expect, it } from 'vitest';
import { RequestRouter } from '../src/router.js';

const router = new RequestRouter({
  small: 'small-model',
  mid: 'mid-model',
  big: 'big-model'
});

describe('router heuristics', () => {
  it('routes calculator intents to tool.calculator', () => {
    const decision = router.decide([{ role: 'user', content: 'What is (12 + 8) / 5?' }]);
    expect(decision.route).toBe('tool.calculator');
    expect(decision.fallback_route).toBe('llm.small');
  });

  it('routes complex requests to llm.big', () => {
    const decision = router.decide([
      {
        role: 'user',
        content: 'Analyze the architecture tradeoff and provide formal reasoning in a multi-step plan.'
      }
    ]);
    expect(decision.route).toBe('llm.big');
    expect(decision.model).toBe('big-model');
  });

  it('routes moderate requests to llm.mid', () => {
    const decision = router.decide([{ role: 'user', content: 'Summarize this and compare two options clearly.' }]);
    expect(decision.route).toBe('llm.mid');
    expect(decision.model).toBe('mid-model');
  });

  it('routes simple requests to llm.small', () => {
    const decision = router.decide([{ role: 'user', content: 'Hello there' }]);
    expect(decision.route).toBe('llm.small');
    expect(decision.model).toBe('small-model');
  });
});
