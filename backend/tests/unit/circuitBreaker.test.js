import { describe, expect, it } from 'vitest';
import { createCircuitBreaker } from '../../src/worker/circuitBreaker.js';

const make = () => createCircuitBreaker({ window: 30, failureRatio: 0.9 });

describe('circuit breaker', () => {
  it('trips when a full window is >= 90% failures', () => {
    const b = make();
    for (let i = 0; i < 29; i++) b.record(false);
    expect(b.tripped).toBe(false); // window not yet full
    b.record(false);
    expect(b.tripped).toBe(true);
  });

  it('does not trip at a healthy ~12% failure rate', () => {
    const b = make();
    for (let i = 0; i < 1000; i++) b.record(i % 8 !== 0);
    expect(b.tripped).toBe(false);
  });

  it('only counts the rolling window', () => {
    const b = make();
    for (let i = 0; i < 20; i++) b.record(false);
    for (let i = 0; i < 100; i++) b.record(true);
    expect(b.tripped).toBe(false);
  });

  it('resets per job', () => {
    const b = make();
    for (let i = 0; i < 30; i++) b.record(false);
    expect(b.tripped).toBe(true);
    b.reset();
    expect(b.tripped).toBe(false);
  });
});
