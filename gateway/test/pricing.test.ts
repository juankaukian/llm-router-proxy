import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectedCostUSD, loadPricingConfig } from '../src/cost/pricing.js';

describe('pricing config loading', () => {
  it('loads pricing from PRICING_CONFIG_DIR style directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-load-'));
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'pricing.json'),
      JSON.stringify({
        currency: 'USD',
        models: {
          small: {
            logical_route: 'llm.small',
            provider: 'openai',
            model: 'gpt-4o-mini',
            in_per_1m: 0.15,
            out_per_1m: 0.6
          }
        }
      }),
      'utf8'
    );

    const loaded = loadPricingConfig(tempDir);
    expect(loaded.loaded).toBe(true);
    expect(loaded.warnings).toHaveLength(0);
    expect(Object.keys(loaded.config.models)).toHaveLength(1);
    expect(loaded.config.models.small?.in_per_1m).toBe(0.15);
  });

  it('warns when pricing entry omits in/out fields', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-warn-'));
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'pricing.json'),
      JSON.stringify({
        currency: 'USD',
        models: {
          mid: {
            logical_route: 'llm.mid',
            provider: 'openai',
            model: 'gpt-4.1-mini'
          }
        }
      }),
      'utf8'
    );

    const loaded = loadPricingConfig(tempDir);
    expect(loaded.loaded).toBe(true);
    expect(loaded.warnings.some((w) => w.includes('in_per_1m'))).toBe(true);
    expect(loaded.warnings.some((w) => w.includes('out_per_1m'))).toBe(true);
  });
});

describe('pricing cost math', () => {
  it('computes expected cost correctly', () => {
    const expected = expectedCostUSD(2500, 750, {
      logical_route: 'llm.mid',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      in_per_1m: 0.4,
      out_per_1m: 1.6
    });
    expect(expected).toBeCloseTo(0.0022, 10);
  });
});

