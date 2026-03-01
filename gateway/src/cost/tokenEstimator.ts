import { encode } from 'gpt-tokenizer';
import type { ChatMessage } from '../types.js';

export type ModelFamily = 'openai' | 'ollama' | 'unknown';

function heuristicEstimate(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length + m.role.length + 8, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

export function estimateInputTokens(messages: ChatMessage[], modelFamily: ModelFamily): number {
  if (modelFamily !== 'openai') {
    return heuristicEstimate(messages);
  }

  try {
    const combined = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    const tokens = encode(combined).length;
    return Math.max(1, tokens);
  } catch {
    return heuristicEstimate(messages);
  }
}
