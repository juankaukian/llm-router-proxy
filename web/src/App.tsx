import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  SendHorizonal,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
  TriangleAlert,
  UserRound,
  XCircle
} from 'lucide-react';
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

function levelClass(level: DiagLine['level']): string {
  if (level === 'error') {
    return 'text-rose-300';
  }
  if (level === 'warn') {
    return 'text-amber-300';
  }
  return 'text-cyan-300';
}

function routeClass(route: string): string {
  if (route === 'tool.calculator') {
    return 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40';
  }
  if (route === 'llm.big') {
    return 'bg-violet-500/20 text-violet-300 border-violet-400/40';
  }
  if (route === 'llm.mid') {
    return 'bg-sky-500/20 text-sky-300 border-sky-400/40';
  }
  return 'bg-indigo-500/20 text-indigo-300 border-indigo-400/40';
}

function boolBadge(value: boolean): string {
  return value
    ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
    : 'border-slate-500/40 bg-slate-700/30 text-slate-300';
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
  const [diagAutoScroll, setDiagAutoScroll] = useState(true);

  const diagConsoleRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);

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
      setDiagLines((prev) => [...prev, line].slice(-1000));
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

  useEffect(() => {
    if (!diagAutoScroll) {
      return;
    }
    const el = diagConsoleRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [diagLines, diagAutoScroll]);

  useEffect(() => {
    const el = messageListRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages]);

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
    <div className="mx-auto min-h-full max-w-[1380px] px-3 py-3 text-slate-100 md:px-5 lg:px-6">
      <header className="mb-3 rounded-2xl border border-slate-700/60 bg-surface-900/85 px-4 py-2.5 shadow-soft backdrop-blur md:px-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-accent-500/40 bg-accent-500/20 p-2">
              <Sparkles className="h-4 w-4 text-accent-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight md:text-[1.35rem]">LLM Router Proxy UI</h1>
              <p className="text-xs text-slate-400 md:text-sm">Session: {sessionId}</p>
            </div>
          </div>

          <div
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
              diagSummary?.startup_ok
                ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300'
                : diagSummary
                  ? 'border-rose-400/40 bg-rose-500/10 text-rose-300'
                  : 'border-slate-500/40 bg-slate-700/40 text-slate-300'
            }`}
          >
            <Activity className="h-3.5 w-3.5" />
            {diagSummary ? (diagSummary.startup_ok ? 'System OK' : 'System FAIL') : 'Diagnostics Pending'}
          </div>
        </div>
      </header>

      <section className="mb-3 animate-fadeUp rounded-2xl border border-slate-700/60 bg-surface-900/80 p-3.5 shadow-panel backdrop-blur">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-slate-200">
            <TerminalSquare className="h-4 w-4 text-cyan-300" />
            Startup / Diagnostics
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDiagAutoScroll((prev) => !prev)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-600/80 bg-slate-800/70 px-2 py-1 text-xs text-slate-300 transition hover:border-slate-500 hover:text-white"
            >
              {diagAutoScroll ? <PauseCircle className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
              {diagAutoScroll ? 'Pause' : 'Resume'}
            </button>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium ${
                diagSummary?.startup_ok
                  ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                  : diagSummary
                    ? 'border-rose-400/40 bg-rose-500/15 text-rose-300'
                    : 'border-slate-500/40 bg-slate-700/40 text-slate-300'
              }`}
            >
              {diagSummary?.startup_ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <TriangleAlert className="h-3.5 w-3.5" />}
              {diagSummary ? (diagSummary.startup_ok ? 'OK' : 'FAIL') : 'PENDING'}
            </span>
          </div>
        </div>

        <div ref={diagConsoleRef} className="mb-3 max-h-52 overflow-auto rounded-xl border border-slate-700 bg-[#050b18] p-3 font-mono text-[12px] leading-5">
          {diagLines.length === 0 ? (
            <div className="text-slate-500">Waiting for diagnostic events...</div>
          ) : (
            diagLines.map((line, idx) => (
              <div key={`${line.ts}-${idx}`} className="mb-1">
                <span className="text-slate-500">[{line.ts}]</span>{' '}
                <span className={`font-semibold ${levelClass(line.level)}`}>{line.level.toUpperCase()}</span>{' '}
                <span className="text-slate-200">{line.message}</span>
                {line.data ? <span className="text-slate-400"> {toText(line.data)}</span> : null}
              </div>
            ))
          )}
        </div>

        <h3 className="mb-2 text-sm font-semibold text-slate-200">Config Status</h3>
        <div className="overflow-x-auto rounded-xl border border-slate-700/80">
          <table className="min-w-full text-left text-xs text-slate-300 md:text-sm">
            <thead className="bg-slate-800/60 text-slate-200">
              <tr>
                <th className="px-3 py-2">Backend</th>
                <th className="px-3 py-2">Configured</th>
                <th className="px-3 py-2">Reachable</th>
                <th className="px-3 py-2">Missing env</th>
                <th className="px-3 py-2">Notes / Fix</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-700/80 bg-slate-900/50 even:bg-slate-800/40">
                <td className="px-3 py-2">OpenAI</td>
                <td className="px-3 py-2">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 ${boolBadge(Boolean(diagStatus?.backends.openai.configured))}`}>
                    {String(diagStatus?.backends.openai.configured ?? false)}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 ${boolBadge(Boolean(diagStatus?.backends.openai.reachable))}`}>
                    {String(diagStatus?.backends.openai.reachable ?? false)}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-400">{(diagStatus?.backends.openai.missing_env ?? []).join(', ') || '-'}</td>
                <td className="px-3 py-2 text-slate-400">{(diagStatus?.backends.openai.notes ?? []).join(' | ') || '-'}</td>
              </tr>
              <tr className="border-t border-slate-700/80 bg-slate-900/50 even:bg-slate-800/40">
                <td className="px-3 py-2">Ollama</td>
                <td className="px-3 py-2">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 ${boolBadge(Boolean(diagStatus?.backends.ollama.configured))}`}>
                    {String(diagStatus?.backends.ollama.configured ?? false)}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 ${boolBadge(Boolean(diagStatus?.backends.ollama.reachable))}`}>
                    {String(diagStatus?.backends.ollama.reachable ?? false)}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-400">{(diagStatus?.backends.ollama.missing_env ?? []).join(', ') || '-'}</td>
                <td className="px-3 py-2 text-slate-400">{(diagStatus?.backends.ollama.notes ?? []).join(' | ') || '-'}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {diagStatus && !diagStatus.ok ? (
          <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            <div className="mb-1 flex items-center gap-2 font-medium">
              <ShieldAlert className="h-4 w-4" />
              Suggestions
            </div>
            <ul className="list-disc pl-5 text-xs md:text-sm">
              {diagStatus.suggestions.map((item, idx) => (
                <li key={`${item}-${idx}`}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <main className="grid gap-3 lg:grid-cols-[1.12fr_0.88fr]">
        <section className="rounded-2xl border border-slate-700/60 bg-surface-900/80 p-3.5 shadow-panel backdrop-blur">
          <h2 className="mb-2.5 text-[15px] font-semibold tracking-tight text-slate-200">Chat</h2>
          <div ref={messageListRef} className="max-h-[55vh] min-h-[41vh] overflow-auto pr-1">
            <div className="space-y-2">
              {messages.map((msg, idx) => (
                <div
                  key={`${msg.role}-${idx}`}
                  className={`animate-fadeUp rounded-xl border px-3 py-2 ${
                    msg.role === 'user'
                      ? 'ml-auto max-w-[88%] border-accent-400/40 bg-accent-500/10 text-slate-100'
                      : 'max-w-[92%] border-slate-600/70 bg-slate-800/65 text-slate-100'
                  }`}
                >
                  <div className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-300">
                    {msg.role === 'user' ? <UserRound className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                    {msg.role}
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-6 text-slate-100">{msg.content}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-2.5 space-y-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything..."
              rows={3}
              disabled={sending}
              className="w-full resize-y rounded-xl border border-slate-600/80 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-accent-400 focus:ring-2 focus:ring-accent-500/30"
            />
            <div className="flex items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={streamMode}
                  onChange={(e) => setStreamMode(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-500 bg-slate-800 text-accent-500 focus:ring-accent-500/30"
                />
                Stream
              </label>

              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || !input.trim()}
                className="inline-flex items-center gap-2 rounded-xl border border-accent-400/40 bg-accent-500/20 px-4 py-2 text-sm font-medium text-accent-200 transition hover:bg-accent-500/30 disabled:cursor-not-allowed disabled:border-slate-600/50 disabled:bg-slate-700/40 disabled:text-slate-500"
              >
                {sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <SendHorizonal className="h-4 w-4" />}
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-700/60 bg-surface-900/80 p-3.5 shadow-panel backdrop-blur">
          <h2 className="mb-2.5 text-[15px] font-semibold tracking-tight text-slate-200">Routing Decisions</h2>
          <div className="max-h-[64vh] space-y-2 overflow-auto pr-1">
            {cards.map((card) => (
              <article
                className="animate-fadeUp rounded-xl border border-slate-700/80 bg-slate-900/70 p-3 shadow-inner shadow-black/20"
                key={card.request_id}
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${routeClass(card.route)}`}>{card.route}</span>
                  <span className="rounded-full border border-slate-600/60 bg-slate-800/80 px-2 py-0.5 text-[11px] text-slate-200">
                    {card.model_used}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${boolBadge(card.tool_used)}`}>tool {String(card.tool_used)}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${boolBadge(card.fallback_used)}`}>
                    fallback {String(card.fallback_used)}
                  </span>
                </div>

                <div className="mb-2">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
                    <span className="inline-flex items-center gap-1">
                      <Activity className="h-3 w-3" /> confidence
                    </span>
                    <span>{(card.confidence * 100).toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-800">
                    <div
                      className="h-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-accent-500 transition-all"
                      style={{ width: `${Math.max(6, Math.min(100, card.confidence * 100))}%` }}
                    />
                  </div>
                </div>

                <p className="mb-2 text-sm text-slate-300">{card.reason}</p>

                <div className="grid grid-cols-2 gap-2 text-xs text-slate-400">
                  <div className="inline-flex items-center gap-1">
                    <Clock3 className="h-3 w-3" /> latency: {card.latency_ms}ms
                  </div>
                  <div className="text-right">input_chars: {card.usage.input_chars}</div>
                  <div className="text-right col-span-2">output_chars: {card.usage.output_chars}</div>
                </div>

                {card.error ? (
                  <div className="mt-2 inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/15 px-2 py-1 text-xs text-rose-200">
                    <XCircle className="h-3.5 w-3.5" />
                    error: {card.error}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
