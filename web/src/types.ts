export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;
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

export interface CandidateCost {
  route: 'llm.small' | 'llm.mid' | 'llm.big';
  provider: 'openai' | 'ollama';
  model: string;
  expected_cost_est: number;
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
  input_tokens_est?: number;
  output_tokens_est?: number;
  expected_cost_est?: number;
  candidate_costs?: CandidateCost[];
  chosen_reason?: 'cheapest_by_expected_cost' | 'policy_default';
  max_cost_usd?: number;
  budget_actions?: Array<'compacted' | 'reduced_output_tokens' | 'model_switched'>;
  expected_cost_vs_budget?: string;
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
  input_tokens_est?: number;
  output_tokens_est?: number;
  expected_cost_est?: number;
  candidate_costs?: CandidateCost[];
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
    input_tokens_est?: number;
    output_tokens_est?: number;
    expected_cost_est?: number;
    candidate_costs?: CandidateCost[];
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
