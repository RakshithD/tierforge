// Rate limiter that keeps outgoing enrichment calls under the upstream API quota.

/**
 * Token bucket with a FIFO queue. `acquire()` resolves when a token is available.
 * Clock and sleep are injectable so tests can run on virtual time.
 *
 * `capacity` bounds the burst. The default of 1 means a 4/s limiter never emits
 * more than ~4 calls in any one-second window (a larger bucket can emit
 * capacity + rate calls in one window, which would breach the upstream 5/s limit).
 */
export function createRateLimiter({
  ratePerSec,
  capacity = 1,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let tokens = capacity;   // tokens currently available (fractional)
  let last = now();        // time of the last refill
  let tail = Promise.resolve(); // end of the FIFO chain of waiting acquire() calls

  // Add tokens in proportion to elapsed time, never exceeding `capacity`.
  const refill = () => {
    const t = now();
    tokens = Math.min(capacity, tokens + ((t - last) / 1000) * ratePerSec);
    last = t;
  };

  // Wait until a whole token is available, then consume it (1e-9 absorbs float error).
  const take = async () => {
    for (;;) {
      refill();
      if (tokens >= 1 - 1e-9) {
        tokens -= 1;
        return;
      }
      await sleep(Math.max(1, Math.ceil(((1 - tokens) / ratePerSec) * 1000)));
    }
  };

  return {
    // Chaining on `tail` makes callers take tokens strictly in arrival order, one at a time.
    acquire() {
      const p = tail.then(take);
      tail = p.catch(() => {});
      return p;
    },
  };
}
