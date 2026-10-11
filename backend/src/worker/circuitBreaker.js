// Circuit breaker: detects a sustained enrichment-API outage so the engine can pause the job instead of burning attempts.

/** Trips when the rolling window is full and the failure ratio reaches the threshold. */
export function createCircuitBreaker({ window, failureRatio }) {
  // Sliding window of the most recent call outcomes (0 = success, 1 = failure).
  const outcomes = [];
  let tripped = false;

  return {
    // Call after every enrichment API response. Once `window` outcomes are
    // collected, the breaker trips if failures/window >= failureRatio. It stays
    // tripped until reset() so the engine can pause the job.
    record(success) {
      outcomes.push(success ? 0 : 1);
      if (outcomes.length > window) outcomes.shift();
      if (outcomes.length === window) {
        const failures = outcomes.reduce((a, b) => a + b, 0);
        if (failures / window >= failureRatio) tripped = true;
      }
    },
    get tripped() {
      return tripped;
    },
    // Clear history after the API recovers so old failures don't re-trip it.
    reset() {
      outcomes.length = 0;
      tripped = false;
    },
  };
}
