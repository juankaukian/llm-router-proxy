import type { ChatMessage } from './types.js';

export interface RequestCharMetrics {
  user_chars: number;
  incoming_total_chars: number;
}

export function computeRequestCharMetrics(messages: ChatMessage[]): RequestCharMetrics {
  const userChars = [...messages].reverse().find((m) => m.role === 'user')?.content.length ?? 0;
  const incomingTotalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return {
    user_chars: userChars,
    incoming_total_chars: incomingTotalChars
  };
}

export function exceedsMaxRequestChars(metrics: RequestCharMetrics, maxRequestChars: number): boolean {
  return metrics.incoming_total_chars > maxRequestChars;
}

export function validateMessageShape(messages: ChatMessage[], maxContentChars: number): { ok: true } | { ok: false; error: string } {
  const hasInvalidMessage = messages.some((m) => !m || typeof m.content !== 'string' || !['system', 'user', 'assistant'].includes(m.role));
  if (hasInvalidMessage) {
    return { ok: false, error: 'invalid message format' };
  }

  const oversizedUser = messages.find((m) => m.role === 'user' && m.content.length > maxContentChars);
  if (oversizedUser) {
    return { ok: false, error: 'user_message_too_large' };
  }

  return { ok: true };
}
