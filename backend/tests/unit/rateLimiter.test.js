import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/worker/rateLimiter.js';

function virtualClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

describe('rate limiter', () => {
  it('never exceeds N calls in any one-second window', async () => {
    const clock = virtualClock();
    const rl = createRateLimiter({ ratePerSec: 4, ...clock });
    const stamps = [];
    await Promise.all(Array.from({ length: 40 }, async () => {
      await rl.acquire();
      stamps.push(clock.now());
    }));
    for (let i = 0; i + 4 < stamps.length; i++) {
      // 5 consecutive calls must span at least ~1s when the limit is 4/s
      expect(stamps[i + 4] - stamps[i]).toBeGreaterThanOrEqual(999);
    }
    // 40 calls at 4/s take about 9-10 seconds
    expect(clock.now()).toBeGreaterThanOrEqual(9000);
  });

  it('serves waiters in FIFO order', async () => {
    const clock = virtualClock();
    const rl = createRateLimiter({ ratePerSec: 2, ...clock });
    const order = [];
    await Promise.all([0, 1, 2, 3, 4].map((i) => rl.acquire().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('refills after idle time up to capacity', async () => {
    const clock = virtualClock();
    const rl = createRateLimiter({ ratePerSec: 4, capacity: 4, ...clock });
    for (let i = 0; i < 4; i++) await rl.acquire();
    expect(clock.now()).toBe(0); // burst allowed
    await clock.sleep(10000); // idle: bucket refills but is capped at 4
    const before = clock.now();
    for (let i = 0; i < 4; i++) await rl.acquire();
    expect(clock.now()).toBe(before);
    await rl.acquire(); // 5th must wait ~250ms
    expect(clock.now() - before).toBeGreaterThanOrEqual(250);
  });
});
