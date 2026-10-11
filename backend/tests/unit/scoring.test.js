import { describe, expect, it } from 'vitest';
import { calculateScore, tierFor, validateScoringConfig } from '../../src/services/scoringService.js';

const cfg = {
  footfall_bar: 15000, footfall_weight: 50,
  revenue_bar: 150000, revenue_weight: 30,
  size_bar: 8000, size_weight: 20,
  large_threshold: 70, medium_threshold: 40,
};
const score = (m, c = cfg) => calculateScore(m, c);

describe('scoring formula', () => {
  it('matches the worked example', () => {
    const cases = [
      [{ footfall: 40000, revenue: 400000, size_sqft: 18000 }, 100, 'Large'],
      [{ footfall: 20000, revenue: 100000, size_sqft: 5000 }, 50, 'Medium'],
      [{ footfall: 2000, revenue: 20000, size_sqft: 9000 }, 20, 'Small'],
    ];
    for (const [m, s, t] of cases) {
      expect(score(m)).toBe(s);
      expect(tierFor(s, cfg)).toBe(t);
    }
  });

  it('is inclusive at each bar', () => {
    expect(score({ footfall: 15000, revenue: 0, size_sqft: 0 })).toBe(50);
    expect(score({ footfall: 14999, revenue: 0, size_sqft: 0 })).toBe(0);
    expect(score({ footfall: 0, revenue: 150000, size_sqft: 0 })).toBe(30);
    expect(score({ footfall: 0, revenue: 0, size_sqft: 8000 })).toBe(20);
  });

  it('handles none / all bars cleared', () => {
    expect(score({ footfall: 0, revenue: 0, size_sqft: 0 })).toBe(0);
    expect(score({ footfall: 1e9, revenue: 1e9, size_sqft: 1e9 })).toBe(100);
  });

  it('supports weights 100/0/0', () => {
    const c = { ...cfg, footfall_weight: 100, revenue_weight: 0, size_weight: 0 };
    expect(score({ footfall: 15000, revenue: 0, size_sqft: 0 }, c)).toBe(100);
    expect(score({ footfall: 0, revenue: 1e9, size_sqft: 1e9 }, c)).toBe(0);
  });

  it('puts tier boundaries exactly at the thresholds', () => {
    expect(tierFor(70, cfg)).toBe('Large');
    expect(tierFor(69, cfg)).toBe('Medium');
    expect(tierFor(40, cfg)).toBe('Medium');
    expect(tierFor(39, cfg)).toBe('Small');
  });
});

describe('scoring validation', () => {
  it('accepts a valid config', () => {
    const { value, errors } = validateScoringConfig(cfg);
    expect(errors).toEqual([]);
    expect(value.footfall_bar).toBe(15000);
  });

  it('rejects weights that do not sum to 100', () => {
    const { errors } = validateScoringConfig({ ...cfg, size_weight: 10 });
    expect(errors.map((e) => e.field)).toContain('weights');
  });

  it('rejects negative bars', () => {
    const { errors } = validateScoringConfig({ ...cfg, revenue_bar: -1 });
    expect(errors.map((e) => e.field)).toContain('revenue_bar');
  });

  it('rejects medium > large', () => {
    const { errors } = validateScoringConfig({ ...cfg, medium_threshold: 80 });
    expect(errors.map((e) => e.field)).toContain('medium_threshold');
  });

  it('rejects missing and non-numeric fields', () => {
    const { errors } = validateScoringConfig({ ...cfg, footfall_bar: 'abc', size_bar: undefined });
    expect(errors.map((e) => e.field)).toEqual(expect.arrayContaining(['footfall_bar', 'size_bar']));
  });
});
