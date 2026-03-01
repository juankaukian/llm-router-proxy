export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequestBody {
  session_id?: string;
  messages: ChatMessage[];
  stream: boolean;
  max_cost_usd?: number;
  prefer_cheapest?: boolean;
  verbosity?: 'brief' | 'normal' | 'detailed';
}

export interface Usage {
  input_chars_user: number;
  input_chars_total: number;
  input_chars: number;
  output_chars: number;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface CostCandidate {
  route: 'llm.small' | 'llm.mid' | 'llm.big';
  provider: 'openai' | 'ollama';
  model: string;
  expected_cost_est: number;
}

export interface RouterDecision {
  route: 'tool.calculator' | 'llm.small' | 'llm.mid' | 'llm.big';
  confidence: number;
  reason: string;
  model: string;
  fallback_route?: 'llm.small' | 'llm.mid' | 'llm.big';
  input_tokens_est?: number;
  output_tokens_est?: number;
  expected_cost_est?: number;
  candidate_costs?: CostCandidate[];
  chosen_reason?: 'cheapest_by_expected_cost' | 'policy_default';
  max_cost_usd?: number;
  budget_actions?: Array<'compacted' | 'reduced_output_tokens' | 'model_switched'>;
  expected_cost_vs_budget?: string;
  actual_usage?: TokenUsage;
  actual_cost?: number;
  compacted?: boolean;
  tokens_before_est?: number;
  tokens_after_est?: number;
  savings_tokens_est?: number;
  expected_cost_savings_est?: number;
  compactor_expected_cost_est?: number;
  compactor_cost_est?: number;
  compactor_timeout_ms?: number;
  compactor_latency_ms?: number;
  compaction_reason?: 'over_budget' | 'worth_it';
  compaction_attempted?: boolean;
  compaction_applied?: boolean;
  compaction_skipped_reason?: 'skipped_threshold' | 'tool_route' | 'code_edit_preserve';
  compaction_error?: string;
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
  complete(
    messages: ChatMessage[],
    model: string,
    options?: { max_output_tokens?: number }
  ): Promise<{ content: string; usage?: Usage; token_usage?: TokenUsage }>;
  stream(
    messages: ChatMessage[],
    model: string,
    onUsage?: (usage: TokenUsage) => void,
    options?: { max_output_tokens?: number }
  ): AsyncGenerator<string, void, void>;
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
  input_tokens_est?: number;
  output_tokens_est?: number;
  expected_cost_est?: number;
  candidate_costs?: CostCandidate[];
  chosen_reason?: 'cheapest_by_expected_cost' | 'policy_default';
  max_cost_usd?: number;
  budget_actions?: Array<'compacted' | 'reduced_output_tokens' | 'model_switched'>;
  expected_cost_vs_budget?: string;
  actual_usage?: TokenUsage;
  actual_cost?: number;
  compacted?: boolean;
  tokens_before_est?: number;
  tokens_after_est?: number;
  savings_tokens_est?: number;
  expected_cost_savings_est?: number;
  compactor_expected_cost_est?: number;
  compactor_cost_est?: number;
  compactor_timeout_ms?: number;
  compactor_latency_ms?: number;
  compaction_reason?: 'over_budget' | 'worth_it';
  compaction_attempted?: boolean;
  compaction_applied?: boolean;
  compaction_skipped_reason?: 'skipped_threshold' | 'tool_route' | 'code_edit_preserve';
  compaction_error?: string;
  error: string | null;
}
