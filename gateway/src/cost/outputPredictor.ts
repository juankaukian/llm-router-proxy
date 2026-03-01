import type { ChatMessage } from '../types.js';

const OUTPUT_ROUTE_DEFAULTS: Record<string, number> = {
  'llm.small': Number(process.env.MAX_OUTPUT_TOKENS_SMALL ?? 350),
  'llm.mid': Number(process.env.MAX_OUTPUT_TOKENS_MID ?? 700),
  'llm.big': Number(process.env.MAX_OUTPUT_TOKENS_BIG ?? 1400)
};

export function estimateOutputTokens(
  messages: ChatMessage[],
  route: 'llm.small' | 'llm.mid' | 'llm.big',
  verbosity: 'brief' | 'normal' | 'detailed' = 'normal'
): number {
  const userText = [...messages].reverse().find((m) => m.role === 'user')?.content.toLowerCase() ?? '';

  let base = 200;
  if (/answer only|only the answer|just the answer|solve/.test(userText)) {
    base = 20;
  } else if (/summary|summarize|tl;dr/.test(userText)) {
    base = 300;
  } else if (/explain|why|walk me through/.test(userText)) {
    base = 600;
  } else if (/code|function|typescript|python|javascript|sql|regex/.test(userText)) {
    base = 1200;
  } else if (userText.length < 120) {
    base = 200;
  }

  if (verbosity === 'brief') {
    base = Math.max(20, Math.floor(base * 0.5));
  } else if (verbosity === 'detailed') {
    base = Math.max(base, Math.ceil(base * 1.5));
  }

  const routeCap = OUTPUT_ROUTE_DEFAULTS[route] ?? base;
  return Math.max(1, Math.min(base, routeCap));
}
