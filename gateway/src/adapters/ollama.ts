import type { ChatMessage, LLMAdapter, Usage } from '../types.js';

export class OllamaAdapter implements LLMAdapter {
  constructor(private readonly baseUrl: string) {}

  private async fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 20_000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...(init ?? {}), signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async complete(messages: ChatMessage[], model: string): Promise<{ content: string; usage?: Usage }> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false })
    });

    if (!response.ok) {
      throw new Error(`Ollama complete failed (${response.status})`);
    }

    const data = (await response.json()) as { message?: { content?: string } };
    const content = data.message?.content ?? '';

    return {
      content,
      usage: {
        input_chars: messages.reduce((sum, m) => sum + m.content.length, 0),
        output_chars: content.length
      }
    };
  }

  async *stream(messages: ChatMessage[], model: string): AsyncGenerator<string, void, void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true })
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama stream failed (${response.status})`);
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
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const chunk = line.trim();
        if (!chunk) {
          continue;
        }

        let parsed: { message?: { content?: string }; done?: boolean };
        try {
          parsed = JSON.parse(chunk) as { message?: { content?: string }; done?: boolean };
        } catch {
          continue;
        }
        if (parsed.done) {
          return;
        }

        const delta = parsed.message?.content;
        if (delta) {
          yield delta;
        }
      }
    }
  }

  async health(model?: string): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/api/tags`, undefined, 5_000);
      if (!response.ok) {
        return false;
      }
      if (!model) {
        return true;
      }

      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      return Boolean(data.models?.some((m) => m.name === model));
    } catch {
      return false;
    }
  }
}
