import type { CostCandidate } from '../types.js';

export interface CostSelectionContext {
  candidates: CostCandidate[];
  reachableModels: Set<string>;
  inputTokens: number;
  outputTokens: number;
  modelContextLimits?: Record<string, number>;
}

export function chooseCheapestReachableCandidate(ctx: CostSelectionContext): CostCandidate | undefined {
  const filtered = ctx.candidates.filter((candidate) => {
    if (!ctx.reachableModels.has(candidate.model)) {
      return false;
    }
    const limit = ctx.modelContextLimits?.[candidate.model];
    if (limit && ctx.inputTokens + ctx.outputTokens > limit) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return undefined;
  }

  return filtered.reduce((cheapest, next) => (next.expected_cost_est < cheapest.expected_cost_est ? next : cheapest));
}
