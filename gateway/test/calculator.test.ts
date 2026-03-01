import { describe, expect, it } from 'vitest';
import { evaluateMath, looksLikeMathOrConversion } from '../src/tools/calculator.js';

describe('calculator', () => {
  it('evaluates arithmetic expression safely', () => {
    expect(evaluateMath('2 + 3 * (4 ^ 2)')).toBe('50');
  });

  it('supports percent expressions', () => {
    expect(evaluateMath('20% of 300')).toBe('60');
  });

  it('supports km <-> mi conversions', () => {
    expect(evaluateMath('10 km to mi')).toBe('6.2137119224 mi');
    expect(evaluateMath('6.2137119224 mi to km')).toBe('10 km');
  });

  it('supports kg <-> lb conversions', () => {
    expect(evaluateMath('2 kg to lb')).toBe('4.4092452436 lb');
    expect(evaluateMath('4.4092452436 lb to kg')).toBe('2 kg');
  });

  it('supports c <-> f conversions', () => {
    expect(evaluateMath('0 c to f')).toBe('32 f');
    expect(evaluateMath('212 f to c')).toBe('100 c');
  });

  it('detects math messages', () => {
    expect(looksLikeMathOrConversion('what is 45% of 180?')).toBe(true);
    expect(looksLikeMathOrConversion('convert 10 km to mi')).toBe(true);
    expect(looksLikeMathOrConversion('write a haiku')).toBe(false);
  });
});
