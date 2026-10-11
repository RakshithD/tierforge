// Retry backoff helper used by the worker engine to space out retries of failed enrichment calls.

/** Capped exponential backoff with equal jitter: delay in [0.5, 1.0] * min(max, base * 2^(attempts-1)). */
// Doubles the wait after each failed attempt (baseMs, 2x, 4x, ... up to maxMs).
// The random jitter spreads retries out so many failing units don't all retry in lock-step.
// `rng` is injectable so tests can make the result deterministic.
export function backoffDelay(attempts, { baseMs, maxMs }, rng = Math.random) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp * (0.5 + rng() * 0.5));
}
