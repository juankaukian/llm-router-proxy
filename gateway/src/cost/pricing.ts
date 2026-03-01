import fs from 'node:fs';
import path from 'node:path';

export type LogicalRoute = 'llm.small' | 'llm.mid' | 'llm.big';
export type PricingProvider = 'openai' | 'ollama';

export interface PricingEntry {
  logical_route: LogicalRoute;
  provider: PricingProvider;
  model: string;
  in_per_1m: number;
  out_per_1m: number;
  context_window?: number;
  in_defined?: boolean;
  out_defined?: boolean;
}

export interface PricingConfig {
  currency: string;
  models: Record<string, PricingEntry>;
}

export interface PricingLoadResult {
  config: PricingConfig;
  warnings: string[];
  loaded: boolean;
  path: string;
}

const DEFAULT_CONFIG: PricingConfig = {
  currency: 'USD',
  models: {}
};

function resolvePricingPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.endsWith('.json')) {
    return trimmed;
  }
  return path.join(trimmed, 'config', 'pricing.json');
}

export function loadPricingConfig(cwd: string): PricingLoadResult {
  const warnings: string[] = [];
  const configPath = resolvePricingPath(cwd);

  if (!fs.existsSync(configPath)) {
    warnings.push('pricing config not found at gateway/config/pricing.json');
    return { config: DEFAULT_CONFIG, warnings, loaded: false, path: configPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    warnings.push('pricing config is not valid JSON');
    return { config: DEFAULT_CONFIG, warnings, loaded: false, path: configPath };
  }

  const candidate = parsed as Partial<PricingConfig>;
  const models = candidate.models ?? {};
  const normalized: Record<string, PricingEntry> = {};

  for (const [key, value] of Object.entries(models)) {
    const entry = value as Partial<PricingEntry>;
    if (!entry.logical_route || !entry.provider || !entry.model) {
      warnings.push(`pricing entry ${key} missing route/provider/model`);
      continue;
    }

    if (!['llm.small', 'llm.mid', 'llm.big'].includes(entry.logical_route)) {
      warnings.push(`pricing entry ${key} has invalid logical_route`);
      continue;
    }
    if (!['openai', 'ollama'].includes(entry.provider)) {
      warnings.push(`pricing entry ${key} has invalid provider`);
      continue;
    }

    const inDefined = entry.in_per_1m !== undefined;
    const outDefined = entry.out_per_1m !== undefined;
    const inValue = Number(entry.in_per_1m ?? 0);
    const outValue = Number(entry.out_per_1m ?? 0);
    if (!inDefined || Number.isNaN(inValue)) {
      warnings.push(`pricing entry ${key} missing or invalid in_per_1m`);
    }
    if (!outDefined || Number.isNaN(outValue)) {
      warnings.push(`pricing entry ${key} missing or invalid out_per_1m`);
    }
    if (inValue < 0 || outValue < 0) {
      warnings.push(`pricing entry ${key} has negative pricing values`);
    }

    normalized[key] = {
      logical_route: entry.logical_route,
      provider: entry.provider,
      model: entry.model,
      in_per_1m: inValue,
      out_per_1m: outValue,
      context_window: entry.context_window ? Number(entry.context_window) : undefined,
      in_defined: inDefined,
      out_defined: outDefined
    };
  }

  return {
    config: {
      currency: candidate.currency ?? 'USD',
      models: normalized
    },
    warnings,
    loaded: true,
    path: configPath
  };
}

export function expectedCostUSD(inputTokens: number, outputTokens: number, entry?: PricingEntry): number {
  if (!entry) {
    return 0;
  }
  return (inputTokens / 1_000_000) * entry.in_per_1m + (outputTokens / 1_000_000) * entry.out_per_1m;
}

export function findPricingEntry(config: PricingConfig, route: LogicalRoute, provider: PricingProvider, model: string): PricingEntry | undefined {
  return Object.values(config.models).find((entry) => entry.logical_route === route && entry.provider === provider && entry.model === model);
}

export function listRoutePricingCandidates(config: PricingConfig, route: LogicalRoute): PricingEntry[] {
  return Object.values(config.models).filter((entry) => entry.logical_route === route);
}

export function findPricingByProviderModel(config: PricingConfig, provider: PricingProvider, model: string): PricingEntry | undefined {
  return Object.values(config.models).find((entry) => entry.provider === provider && entry.model === model);
}
