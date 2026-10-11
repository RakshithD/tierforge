// Worker engine: drives a job from PENDING to a terminal state by claiming units, calling the
// enrichment API under a rate limit, retrying with backoff and pausing when the API is down.

import { callEnrich } from './enrichClient.js';
import { backoffDelay } from './backoff.js';
import { createCircuitBreaker } from './circuitBreaker.js';
import { createRateLimiter } from './rateLimiter.js';
import { claim, reapExpiredLeases, saveFailure, saveRetry, saveSuccess } from './claim.js';

// Default sleep; injectable via createEngine for tests.
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Human-readable explanation stored on the job when the breaker pauses or fails it.
export const BREAKER_REASON = (cfg) =>
  `Enrichment API appears unavailable (≥${Math.round(cfg.breakerFailureRatio * 100)}% failures over last ${cfg.breakerWindow} calls)`;

/**
 * Worker engine. Dependencies are injected so tests can swap the DB, the
 * enrichment call, the clock and the logger.
 */
export function createEngine({
  db,
  config,
  enrich = (store) =>
    callEnrich(store, { baseUrl: config.enrichmentApiUrl, timeoutMs: config.requestTimeoutMs }),
  limiter = createRateLimiter({ ratePerSec: config.rateLimitPerSec }),
  sleep = defaultSleep,
  pollMs = 250,
  idleMs = 2000,
  log = (...a) => console.log('[worker]', ...a),
}) {
  /**
   * Enrich one claimed unit and persist the outcome.
   * Breaker accounting: a success or a definite 4xx rejection means the API is
   * reachable (recorded as success); only transient errors count as failures.
   * A retry waits for whichever is longer: the server's Retry-After or our backoff.
   */
  async function processUnit(unit, breaker) {
    await limiter.acquire();
    const result = await enrich(unit);
    try {
      if (result.ok) {
        breaker.record(true);
        if (!(await saveSuccess(db, unit.id, unit.attempt_token, result.data))) {
          log(`stale success discarded for enrichment ${unit.id}`);
        }
      } else if (!result.retryable) {
        breaker.record(true); // API answered; the request itself was bad
        if (!(await saveFailure(db, unit.id, unit.attempt_token, result.error))) {
          log(`stale failure discarded for enrichment ${unit.id}`);
        }
      } else {
        breaker.record(false);
        const delay = Math.max(
          result.retryAfterMs ?? 0,
          backoffDelay(unit.attempts, { baseMs: config.backoffBaseMs, maxMs: config.backoffMaxMs }),
        );
        const status = await saveRetry(db, unit.id, unit.attempt_token, result.error, delay, config.maxAttempts);
        if (status === null) log(`stale retry discarded for enrichment ${unit.id}`);
      }
    } catch (err) {
      // Unit stays IN_PROGRESS; the lease reaper will return it to the queue.
      log(`failed to persist outcome for enrichment ${unit.id}: ${err.message}`);
    }
  }

  // Units still waiting or running. Zero (with nothing in flight) means the job is done.
  async function unfinishedCount(jobId) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM enrichments
       WHERE job_id = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
      [jobId],
    );
    return rows[0].n;
  }

  // Set the terminal job status: FAILED if the breaker gave up, COMPLETED if every
  // store enriched, otherwise COMPLETED_WITH_FAILURES.
  async function finishJob(jobId, trippedReason) {
    const { rows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed FROM enrichments WHERE job_id = $1`,
      [jobId],
    );
    const status = trippedReason ? 'FAILED' : rows[0].failed === 0 ? 'COMPLETED' : 'COMPLETED_WITH_FAILURES';
    await db.query(
      'UPDATE jobs SET status = $2, failure_reason = $3, finished_at = now() WHERE id = $1',
      [jobId, status, trippedReason ?? null],
    );
    log(`job ${jobId} finished: ${status}`);
    return status;
  }

  /**
   * Breaker tripped: mark the job PAUSED and probe the API until it answers again.
   * Returns true if the API recovered (job back to RUNNING), false if we gave up
   * (PAUSE_MAX_MS of continuous outage) or were asked to stop.
   */
  async function waitForRecovery(jobId, shouldStop) {
    const reason = BREAKER_REASON(config);
    await db.query(`UPDATE jobs SET status = 'PAUSED', failure_reason = $2 WHERE id = $1`, [jobId, reason]);
    log(`job ${jobId} paused: ${reason}; probing every ${config.pauseProbeMs}ms`);
    const deadline = Date.now() + config.pauseMaxMs;
    while (Date.now() < deadline && !shouldStop()) {
      await sleep(config.pauseProbeMs);
      const { rows } = await db.query(
        `SELECT s.store_id, s.store_name, s.address, s.city, s.state
         FROM enrichments e JOIN stores s ON s.id = e.store_pk
         WHERE e.job_id = $1 AND e.status = 'PENDING' ORDER BY e.id LIMIT 1`,
        [jobId],
      );
      if (!rows[0]) return true; // nothing left to probe with; let the main loop settle the job
      await limiter.acquire();
      const probe = await enrich(rows[0]);
      // Any definite answer (success or a 4xx rejection) means the API is reachable.
      if (probe.ok || !probe.retryable) {
        await db.query(
          `UPDATE jobs SET status = 'RUNNING', failure_reason = NULL WHERE id = $1`,
          [jobId],
        );
        log(`job ${jobId} resumed: enrichment API is back`);
        return true;
      }
    }
    return false;
  }

  /**
   * Process one job to a terminal state (or until shouldStop). Returns the job status.
   * Each loop iteration: honour shutdown -> reap expired leases -> handle a tripped
   * breaker (pause/probe) -> claim new units up to the in-flight cap -> finish if drained.
   */
  async function runJob(jobId, shouldStop = () => false) {
    await db.query(
      `UPDATE jobs SET status = 'RUNNING', failure_reason = NULL, started_at = COALESCE(started_at, now()) WHERE id = $1`,
      [jobId],
    );
    const breaker = createCircuitBreaker({
      window: config.breakerWindow,
      failureRatio: config.breakerFailureRatio,
    });
    const inFlight = new Set();

    for (;;) {
      if (shouldStop()) {
        // Graceful shutdown: let in-flight calls settle, leave the job RUNNING for the next worker.
        await Promise.allSettled([...inFlight]);
        log(`job ${jobId} paused for shutdown`);
        return 'RUNNING';
      }
      await reapExpiredLeases(db, jobId, config.maxAttempts);

      if (breaker.tripped) {
        // Let running calls finish before pausing so no outcome is lost.
        await Promise.allSettled([...inFlight]);
        if (!(await waitForRecovery(jobId, shouldStop))) {
          if (shouldStop()) return 'PAUSED';
          return finishJob(jobId, `${BREAKER_REASON(config)}; no recovery within ${Math.round(config.pauseMaxMs / 60000)} min`);
        }
        breaker.reset();
        continue;
      }

      // Fill free in-flight slots; the rate limiter inside processUnit throttles actual API calls.
      const units = await claim(db, jobId, config.maxInFlight - inFlight.size, config.leaseSeconds);
      for (const unit of units) {
        const p = processUnit(unit, breaker)
          .catch((err) => log(`unit ${unit.id} crashed: ${err.message}`))
          .finally(() => inFlight.delete(p));
        inFlight.add(p);
      }

      if (inFlight.size === 0 && (await unfinishedCount(jobId)) === 0) {
        return finishJob(jobId, null);
      }
      await sleep(pollMs);
    }
  }

  // Oldest job that still has work (resumes RUNNING/PAUSED jobs after a restart).
  async function nextJobId() {
    const { rows } = await db.query(
      `SELECT id FROM jobs WHERE status IN ('PENDING', 'RUNNING', 'PAUSED') ORDER BY id LIMIT 1`,
    );
    return rows[0]?.id ?? null;
  }

  /** Main loop: pick the oldest unfinished job, run it, repeat. */
  async function runForever(shouldStop = () => false) {
    while (!shouldStop()) {
      try {
        const jobId = await nextJobId();
        if (jobId === null) {
          await sleep(idleMs);
          continue;
        }
        log(`starting job ${jobId}`);
        await runJob(jobId, shouldStop);
      } catch (err) {
        log(`engine error: ${err.message}`);
        await sleep(idleMs);
      }
    }
  }

  return { runJob, runForever, nextJobId };
}
