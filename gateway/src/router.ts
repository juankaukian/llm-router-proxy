import { looksLikeMathOrConversion } from './tools/calculator.js';
import type { ChatMessage, RouterDecision, SessionState } from './types.js';

export interface RouterModels {
  small: string;
  mid: string;
  big: string;
}

const BIG_HINTS = ['architecture', 'tradeoff', 'reasoning', 'multi-step', 'debug deeply', 'formal', 'prove'];
const MID_HINTS = ['summarize', 'compare', 'explain', 'plan', 'outline', 'rewrite'];

export class RequestRouter {
  constructor(private readonly models: RouterModels) {}

  decide(messages: ChatMessage[], session?: SessionState): RouterDecision {
    const userText = [...messages].reverse().find((m) => m.role === 'user')?.content.trim() ?? '';
    const lower = userText.toLowerCase();

    if (looksLikeMathOrConversion(userText)) {
      return {
        route: 'tool.calculator',
        confidence: 0.95,
        reason: 'Math/percent/unit intent detected; deterministic tool first.',
        model: 'tool.calculator',
        fallback_route: 'llm.small'
      };
    }

    const bigScore = BIG_HINTS.reduce((acc, h) => acc + (lower.includes(h) ? 1 : 0), 0);
    const midScore = MID_HINTS.reduce((acc, h) => acc + (lower.includes(h) ? 1 : 0), 0);
    const lengthBoost = Math.min(2, Math.floor(userText.length / 250));
    const previousBigBoost = session?.last_route === 'llm.big' ? 1 : 0;

    if (bigScore + lengthBoost + previousBigBoost >= 2) {
      return {
        route: 'llm.big',
        confidence: 0.82,
        reason: 'High complexity prompt routed to reasoning model.',
        model: this.models.big,
        fallback_route: 'llm.mid'
      };
    }

    if (midScore >= 1 || userText.length > 120) {
      return {
        route: 'llm.mid',
        confidence: 0.74,
        reason: 'Moderate complexity prompt routed to mid-tier model.',
        model: this.models.mid,
        fallback_route: 'llm.small'
      };
    }

    return {
      route: 'llm.small',
      confidence: 0.78,
      reason: 'Short general query routed to cheapest suitable model.',
      model: this.models.small,
      fallback_route: 'llm.mid'
    };
  }
}
