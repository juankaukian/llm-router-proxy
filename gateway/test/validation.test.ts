import { describe, expect, it } from 'vitest';
import { computeRequestCharMetrics, exceedsMaxRequestChars, validateMessageShape } from '../src/validation.js';

describe('ingress validation', () => {
  it('rejects user message above MAX_CONTENT_CHARS', () => {
    const result = validateMessageShape(
      [
        { role: 'user', content: 'x'.repeat(8001) }
      ],
      8000
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('user_message_too_large');
    }
  });

  it('accepts messages when each user message is within MAX_CONTENT_CHARS', () => {
    const result = validateMessageShape(
      [
        { role: 'user', content: 'x'.repeat(7900) },
        { role: 'assistant', content: 'y'.repeat(7900) },
        { role: 'user', content: 'z'.repeat(7900) }
      ],
      8000
    );
    expect(result.ok).toBe(true);
  });
});

describe('char metrics evidence', () => {
  it('can exceed 8000 total chars even when each message is below 8000', () => {
    const messages = [
      { role: 'system' as const, content: 's'.repeat(1000) },
      { role: 'user' as const, content: 'u'.repeat(7900) },
      { role: 'assistant' as const, content: 'a'.repeat(5200) }
    ];
    const metrics = computeRequestCharMetrics(messages);
    expect(metrics.user_chars).toBe(7900);
    expect(metrics.incoming_total_chars).toBe(14100);
    expect(metrics.incoming_total_chars).toBeGreaterThan(8000);
    expect(exceedsMaxRequestChars(metrics, 12000)).toBe(true);
  });
});
