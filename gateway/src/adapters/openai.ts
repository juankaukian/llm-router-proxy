import type { ChatMessage, LLMAdapter, TokenUsage, Usage } from '../types.js';

export class OpenAIAdapter implements LLMAdapter {
  constructor(private readonly apiKey: string, private readonly baseUrl = 'https://api.openai.com/v1') {}

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async complete(
    messages: ChatMessage[],
    model: string,
    options?: { max_output_tokens?: number }
  ): Promise<{ content: string; usage?: Usage; token_usage?: TokenUsage }> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ model, messages, stream: false, max_completion_tokens: options?.max_output_tokens })
    });

    if (!response.ok) {
      throw new Error(`OpenAI complete failed (${response.status})`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    const inputCharsTotal = messages.reduce((sum, message) => sum + message.content.length, 0);
    const inputCharsUser = [...messages].reverse().find((message) => message.role === 'user')?.content.length ?? 0;
    return {
      content,
      usage: {
        input_chars_user: inputCharsUser,
        input_chars_total: inputCharsTotal,
        input_chars: inputCharsTotal,
        output_chars: content.length
      },
      token_usage: {
        input_tokens: data.usage?.prompt_tokens,
        output_tokens: data.usage?.completion_tokens
      }
    };
  }

  async *stream(
    messages: ChatMessage[],
    model: string,
    onUsage?: (usage: TokenUsage) => void,
    options?: { max_output_tokens?: number }
  ): AsyncGenerator<string, void, void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: options?.max_output_tokens
      })
    });

    if (!response.ok || !response.body) {
      throw new Error(`OpenAI stream failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const lines = frame.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            continue;
          }
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            return;
          }
          let parsed: {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
          } catch {
            continue;
          }
          if (parsed.usage && onUsage) {
            onUsage({
              input_tokens: parsed.usage.prompt_tokens,
              output_tokens: parsed.usage.completion_tokens
            });
          }
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            yield delta;
          }
        }
      }
    }
  }
}
