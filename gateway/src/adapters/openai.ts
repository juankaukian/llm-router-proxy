import type { ChatMessage, LLMAdapter, Usage } from '../types.js';

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

  async complete(messages: ChatMessage[], model: string): Promise<{ content: string; usage?: Usage }> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ model, messages, stream: false })
    });

    if (!response.ok) {
      throw new Error(`OpenAI complete failed (${response.status})`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    return {
      content,
      usage: {
        input_chars: messages.reduce((sum, message) => sum + message.content.length, 0),
        output_chars: content.length
      }
    };
  }

  async *stream(messages: ChatMessage[], model: string): AsyncGenerator<string, void, void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ model, messages, stream: true })
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
          let parsed: { choices?: Array<{ delta?: { content?: string } }> };
          try {
            parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
          } catch {
            continue;
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
