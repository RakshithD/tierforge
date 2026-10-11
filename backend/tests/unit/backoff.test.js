import { describe, expect, it } from 'vitest';
import { backoffDelay } from '../../src/worker/backoff.js';

const opts = { baseMs: 1000, maxMs: 30000 };

describe('backoffDelay', () => {
  it('grows exponentially (no jitter at rng=1)', () => {
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, opts, () => 1))).toEqual([1000, 2000, 4000, 8000]);
  });

  it('is capped at max', () => {
    expect(backoffDelay(20, opts, () => 1)).toBe(30000);
  });

  it('keeps jitter within [0.5, 1.0] of the exponential value', () => {
    expect(backoffDelay(3, opts, () => 0)).toBe(2000);
    expect(backoffDelay(3, opts, () => 0.5)).toBe(3000);
    let seed = 42;
    const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 200; i++) {
      const d = backoffDelay(4, opts, rng);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });
});
