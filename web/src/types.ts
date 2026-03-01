export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;
}

export interface Usage {
  input_chars: number;
  output_chars: number;
}

export interface DecisionMeta {
  request_id: string;
  session_id: string;
  route: string;
  model_used: string;
  confidence: number;
  reason: string;
  fallback_route?: string;
  tool_used: boolean;
}

export interface DecisionCard {
  request_id: string;
  route: string;
  model_used: string;
  confidence: number;
  reason: string;
  fallback_used: boolean;
  tool_used: boolean;
  latency_ms: number;
  usage: Usage;
  ts?: string;
  error?: string | null;
}

export interface LogResponse {
  session_id: string;
  entries: Array<{
    ts: string;
    request_id: string;
    session_id: string;
    user_excerpt: string;
    route: string;
    model_used: string;
    confidence: number;
    reason: string;
    fallback_used: boolean;
    tool_used: boolean;
    latency_ms: number;
    usage: Usage;
    error: string | null;
  }>;
}

export interface DiagLine {
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

export interface DiagSummary {
  startup_ok: boolean;
  summary: {
    openai_ok: boolean;
    ollama_ok: boolean;
    missing_env: string[];
  };
}

export interface DiagStatusResponse {
  ok: boolean;
  backends: {
    openai: {
      configured: boolean;
      reachable: boolean;
      models: { small: string; mid: string; big: string };
      notes: string[];
      missing_env: string[];
    };
    ollama: {
      configured: boolean;
      reachable: boolean;
      model: string | null;
      notes: string[];
      missing_env: string[];
    };
  };
  last_startup_report: DiagLine[];
  suggestions: string[];
}
