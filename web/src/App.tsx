import { useEffect, useMemo, useState } from 'react';
import type { DecisionCard, DecisionMeta, DiagLine, DiagStatusResponse, DiagSummary, LogResponse, Message } from './types';

const SESSION_KEY = 'llm-router-session-id';

function getOrCreateSessionId(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}

function getApiBase(): string {
  const configured = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8080';
  if (typeof window !== 'undefined') {
    try {
      const parsed = new URL(configured);
      if (parsed.hostname === 'gateway') {
        parsed.hostname = window.location.hostname || 'localhost';
        return parsed.toString().replace(/\/$/, '');
      }
    } catch {
      return configured;
    }
  }
  return configured;
}

function parseSseChunk(raw: string): Array<{ event: string; data: string }> {
  return raw
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const eventLine = lines.find((line) => line.startsWith('event:')) ?? 'event: message';
      const dataLine = lines.find((line) => line.startsWith('data:')) ?? 'data: {}';
      return {
        event: eventLine.slice(6).trim(),
        data: dataLine.slice(5).trim()
      };
    });
}

function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

export function App(): JSX.Element {
  const apiBase = useMemo(() => getApiBase(), []);
  const gatewayApiKey = (import.meta.env.VITE_GATEWAY_API_KEY as string | undefined) ?? '';
  const [sessionId] = useState(() => getOrCreateSessionId());
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamMode, setStreamMode] = useState(true);
  const [cards, setCards] = useState<DecisionCard[]>([]);
  const [diagLines, setDiagLines] = useState<DiagLine[]>([]);
  const [diagSummary, setDiagSummary] = useState<DiagSummary | null>(null);
  const [diagStatus, setDiagStatus] = useState<DiagStatusResponse | null>(null);

  useEffect(() => {
    const streamUrl = gatewayApiKey
      ? `${apiBase}/v1/diag/stream?api_key=${encodeURIComponent(gatewayApiKey)}`
      : `${apiBase}/v1/diag/stream`;
    const es = new EventSource(streamUrl);

    es.addEventListener('diag', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as DiagLine;
        setDiagLines((prev) => [...prev, parsed].slice(-1000));
      } catch {
        // ignore malformed diagnostic lines
      }
    });

    es.addEventListener('diag_done', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as DiagSummary;
        setDiagSummary(parsed);
      } catch {
        // ignore malformed summary
      }
    });

    es.onerror = () => {
      const line: DiagLine = {
        ts: new Date().toISOString(),
        level: 'warn',
        message: 'Diagnostic stream disconnected; retrying...',
        data: {}
      };
      setDiagLines((prev) =>
        [...prev, line].slice(-1000)
      );
    };

    return () => {
      es.close();
    };
  }, [apiBase, gatewayApiKey]);

  useEffect(() => {
    const loadDiagStatus = async (): Promise<void> => {
      try {
        const response = await fetch(`${apiBase}/v1/diag/status`, {
          headers: gatewayApiKey ? { 'x-api-key': gatewayApiKey } : undefined
        });
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as DiagStatusResponse;
        setDiagStatus(data);
      } catch {
        // ignore startup status errors
      }
    };

    void loadDiagStatus();
  }, [apiBase, gatewayApiKey]);

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${apiBase}/v1/logs?session_id=${encodeURIComponent(sessionId)}&limit=200`, {
          headers: gatewayApiKey ? { 'x-api-key': gatewayApiKey } : undefined
        });
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as LogResponse;

        setCards((prev) => {
          const map = new Map(prev.map((card) => [card.request_id, card]));
          for (const entry of body.entries) {
            map.set(entry.request_id, {
              request_id: entry.request_id,
              route: entry.route,
              model_used: entry.model_used,
              confidence: entry.confidence,
              reason: entry.reason,
              fallback_used: entry.fallback_used,
              tool_used: entry.tool_used,
              latency_ms: entry.latency_ms,
              usage: entry.usage,
              ts: entry.ts,
              error: entry.error
            });
          }
          return [...map.values()].sort((a, b) => (a.ts && b.ts ? (a.ts < b.ts ? 1 : -1) : 0));
        });
      } catch {
        // keep polling even if gateway is temporarily unavailable
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [apiBase, sessionId, gatewayApiKey]);

  async function send(): Promise<void> {
    const prompt = input.trim();
    if (!prompt || sending) {
      return;
    }

    const nextMessages: Message[] = [...messages, { role: 'user', content: prompt }];
    setMessages([...nextMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setSending(true);

    if (!streamMode) {
      try {
        const response = await fetch(`${apiBase}/v1/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(gatewayApiKey ? { 'x-api-key': gatewayApiKey } : {}) },
          body: JSON.stringify({ session_id: sessionId, messages: nextMessages, stream: false })
        });
        const data = (await response.json()) as {
          content: string;
          decision: {
            route: string;
            model: string;
            confidence: number;
            reason: string;
            fallback_route?: string;
          };
          usage: { input_chars: number; output_chars: number };
          latency_ms: number;
          model_used: string;
        };

        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: data.content ?? '' };
          return copy;
        });

        const card: DecisionCard = {
          request_id: crypto.randomUUID(),
          route: data.decision?.route ?? 'unknown',
          model_used: data.model_used ?? data.decision?.model ?? 'unknown',
          confidence: data.decision?.confidence ?? 0,
          reason: data.decision?.reason ?? '',
          fallback_used: false,
          tool_used: data.decision?.route === 'tool.calculator',
          latency_ms: data.latency_ms ?? 0,
          usage: data.usage ?? { input_chars: 0, output_chars: 0 }
        };
        setCards((prev) => [card, ...prev]);
      } finally {
        setSending(false);
      }
      return;
    }

    try {
      const response = await fetch(`${apiBase}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(gatewayApiKey ? { 'x-api-key': gatewayApiKey } : {}) },
        body: JSON.stringify({ session_id: sessionId, messages: nextMessages, stream: true })
      });

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to connect stream (${response.status}): ${text}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamContent = '';
      let currentMeta: DecisionMeta | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const split = buffer.split(/\r?\n\r?\n/);
        buffer = split.pop() ?? '';

        for (const event of parseSseChunk(split.join('\n\n'))) {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(event.data) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event.event === 'meta') {
            currentMeta = payload as unknown as DecisionMeta;
            const card: DecisionCard = {
              request_id: String(currentMeta.request_id),
              route: String(currentMeta.route),
              model_used: String(currentMeta.model_used),
              confidence: Number(currentMeta.confidence ?? 0),
              reason: String(currentMeta.reason ?? ''),
              fallback_used: false,
              tool_used: Boolean(currentMeta.tool_used),
              latency_ms: 0,
              usage: { input_chars: 0, output_chars: 0 }
            };
            setCards((prev) => [card, ...prev.filter((c) => c.request_id !== card.request_id)]);
          }

          if (event.event === 'token') {
            const delta = String(payload.delta ?? '');
            streamContent += delta;
            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = { role: 'assistant', content: streamContent };
              return copy;
            });
          }

          if (event.event === 'done') {
            const usage = payload.usage as { input_chars: number; output_chars: number } | undefined;
            const latency = Number(payload.latency_ms ?? 0);
            const finalContent = String(payload.content ?? streamContent);

            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = { role: 'assistant', content: finalContent };
              return copy;
            });

            if (currentMeta) {
              setCards((prev) =>
                prev.map((card) =>
                  card.request_id === currentMeta?.request_id
                    ? {
                        ...card,
                        latency_ms: latency,
                        usage: usage ?? card.usage,
                        fallback_used: Boolean(currentMeta?.fallback_route && currentMeta.route === 'llm.small' && !currentMeta.tool_used)
                      }
                    : card
                )
              );
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stream failed';
      setMessages((prev) => {
        const copy = [...prev];
        if (copy.length === 0) {
          return [{ role: 'assistant', content: message }];
        }
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant' && last.content.trim()) {
          return copy;
        }
        copy[copy.length - 1] = {
          role: 'assistant',
          content: `Stream failed: ${message}`
        };
        return copy;
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="page">
      <header className="header">
        <h1>LLM Router Proxy UI</h1>
        <p>Session: {sessionId}</p>
      </header>

      <section className="panel diagnostics-panel">
        <div className="diag-header">
          <h2>Startup / Diagnostics</h2>
          <span className={`badge ${diagSummary?.startup_ok ? 'ok' : 'fail'}`}>
            {diagSummary ? (diagSummary.startup_ok ? 'OK' : 'FAIL') : 'PENDING'}
          </span>
        </div>

        <div className="diag-console">
          {diagLines.map((line, idx) => (
            <div key={`${line.ts}-${idx}`} className={`diag-line ${line.level}`}>
              [{line.ts}] {line.level.toUpperCase()} {line.message}
              {line.data ? ` ${toText(line.data)}` : ''}
            </div>
          ))}
        </div>

        <h3>Config Status</h3>
        <div className="status-table-wrap">
          <table className="status-table">
            <thead>
              <tr>
                <th>Backend</th>
                <th>Configured</th>
                <th>Reachable</th>
                <th>Missing env</th>
                <th>Notes / Fix</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>OpenAI</td>
                <td>{String(diagStatus?.backends.openai.configured ?? false)}</td>
                <td>{String(diagStatus?.backends.openai.reachable ?? false)}</td>
                <td>{(diagStatus?.backends.openai.missing_env ?? []).join(', ') || '-'}</td>
                <td>{(diagStatus?.backends.openai.notes ?? []).join(' | ') || '-'}</td>
              </tr>
              <tr>
                <td>Ollama</td>
                <td>{String(diagStatus?.backends.ollama.configured ?? false)}</td>
                <td>{String(diagStatus?.backends.ollama.reachable ?? false)}</td>
                <td>{(diagStatus?.backends.ollama.missing_env ?? []).join(', ') || '-'}</td>
                <td>{(diagStatus?.backends.ollama.notes ?? []).join(' | ') || '-'}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {diagStatus && !diagStatus.ok ? (
          <div className="suggestions">
            <strong>Suggestions:</strong>
            <ul>
              {diagStatus.suggestions.map((item, idx) => (
                <li key={`${item}-${idx}`}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <main className="layout">
        <section className="panel chat-panel">
          <h2>Chat</h2>
          <div className="messages">
            {messages.map((msg, idx) => (
              <div key={`${msg.role}-${idx}`} className={`bubble ${msg.role}`}>
                <div className="role">{msg.role}</div>
                <div>{msg.content}</div>
              </div>
            ))}
          </div>

          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything..."
              rows={3}
              disabled={sending}
            />
            <div className="controls">
              <label>
                <input type="checkbox" checked={streamMode} onChange={(e) => setStreamMode(e.target.checked)} />
                Stream
              </label>
              <button onClick={() => void send()} disabled={sending || !input.trim()}>
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </section>

        <section className="panel logs-panel">
          <h2>Routing Decisions</h2>
          <div className="cards">
            {cards.map((card) => (
              <article className="card" key={card.request_id}>
                <div className="row">
                  <strong>{card.route}</strong>
                  <span>{card.model_used}</span>
                </div>
                <div className="row">
                  <span>confidence: {card.confidence.toFixed(2)}</span>
                  <span>latency: {card.latency_ms}ms</span>
                </div>
                <p className="reason">{card.reason}</p>
                <div className="row">
                  <span>tool_used: {String(card.tool_used)}</span>
                  <span>fallback_used: {String(card.fallback_used)}</span>
                </div>
                <div className="row">
                  <span>input_chars: {card.usage.input_chars}</span>
                  <span>output_chars: {card.usage.output_chars}</span>
                </div>
                {card.error ? <div className="error">error: {card.error}</div> : null}
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
