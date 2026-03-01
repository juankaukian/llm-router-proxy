export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequestBody {
  session_id?: string;
  messages: ChatMessage[];
  stream: boolean;
}

export interface Usage {
  input_chars: number;
  output_chars: number;
}

export interface RouterDecision {
  route: 'tool.calculator' | 'llm.small' | 'llm.mid' | 'llm.big';
  confidence: number;
  reason: string;
  model: string;
  fallback_route?: 'llm.small' | 'llm.mid' | 'llm.big';
}

export interface SessionState {
  last_route?: string;
  last_model_used?: string;
  turns: ChatMessage[];
}

export interface ChatJsonResponse {
  model_used: string;
  route: string;
  content: string;
  usage: Usage;
  latency_ms: number;
  decision: RouterDecision;
}

export interface LLMAdapter {
  complete(messages: ChatMessage[], model: string): Promise<{ content: string; usage?: Usage }>;
  stream(messages: ChatMessage[], model: string): AsyncGenerator<string, void, void>;
}

export interface RequestLogEntry {
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
}
