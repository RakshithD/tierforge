// Data-access layer for enrichment work units: claiming, saving outcomes and recovering expired leases.
// Each claim carries an attempt_token so late results from stale workers are ignored.

/**
 * Atomically move up to `limit` due PENDING units to IN_PROGRESS with a fresh token and lease.
 *
 * - `FOR UPDATE SKIP LOCKED` lets several workers claim concurrently without
 *   blocking each other or picking the same row twice.
 * - `next_attempt_at <= now()` skips units still waiting out a retry backoff.
 * - `attempts` is incremented at claim time, so it counts attempts started.
 * - The new `attempt_token` identifies this claim; the save* helpers below only
 *   write if the token still matches, which rejects results from stale workers.
 * - `lease_expires_at` lets reapExpiredLeases() recover units from crashed workers.
 */
export async function claim(db, jobId, limit, leaseSeconds) {
  if (limit <= 0) return [];
  const { rows } = await db.query(
    `WITH picked AS (
       SELECT id FROM enrichments
       WHERE job_id = $1 AND status = 'PENDING' AND next_attempt_at <= now()
       ORDER BY id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE enrichments e
       SET status = 'IN_PROGRESS',
           attempts = e.attempts + 1,
           attempt_token = gen_random_uuid(),
           lease_expires_at = now() + make_interval(secs => $3),
           updated_at = now()
       FROM picked
       WHERE e.id = picked.id
       RETURNING e.id, e.attempt_token, e.attempts, e.store_pk
     )
     SELECT c.id, c.attempt_token, c.attempts,
            s.store_id, s.store_name, s.address, s.city, s.state
     FROM claimed c JOIN stores s ON s.id = c.store_pk
     ORDER BY c.id`,
    [jobId, limit, leaseSeconds],
  );
  return rows;
}

/**
 * Record a successful enrichment and release the claim.
 * Guarded: the `attempt_token`/`IN_PROGRESS` check means a late result from a worker
 * whose lease was reaped is ignored. Returns true only if this claim is still current.
 */
export async function saveSuccess(db, id, token, data) {
  const { rowCount } = await db.query(
    `UPDATE enrichments
     SET status = 'SUCCESS', footfall = $3, revenue = $4, size_sqft = $5,
         attempt_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = now()
     WHERE id = $1 AND attempt_token = $2 AND status = 'IN_PROGRESS'`,
    [id, token, data.footfall, data.revenue, data.size_sqft],
  );
  return rowCount === 1;
}

/** Mark a unit permanently FAILED (e.g. HTTP 4xx, malformed body). Guarded like saveSuccess; no retry. */
export async function saveFailure(db, id, token, error) {
  const { rowCount } = await db.query(
    `UPDATE enrichments
     SET status = 'FAILED', last_error = $3,
         attempt_token = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND attempt_token = $2 AND status = 'IN_PROGRESS'`,
    [id, token, error],
  );
  return rowCount === 1;
}

/**
 * Retryable failure (timeout, 429, 5xx). Guarded like saveSuccess.
 * The unit returns to PENDING and becomes claimable again after `delayMs`
 * (via next_attempt_at), or goes to FAILED once `attempts >= maxAttempts`.
 * Returns the new status, or null if the attempt was stale.
 */
export async function saveRetry(db, id, token, error, delayMs, maxAttempts) {
  const { rows } = await db.query(
    `UPDATE enrichments
     SET status = CASE WHEN attempts >= $5 THEN 'FAILED' ELSE 'PENDING' END,
         last_error = $3,
         next_attempt_at = now() + make_interval(secs => $4::float8 / 1000.0),
         attempt_token = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND attempt_token = $2 AND status = 'IN_PROGRESS'
     RETURNING status`,
    [id, token, error, delayMs, maxAttempts],
  );
  return rows[0]?.status ?? null; // null = stale attempt
}

/**
 * Recover units whose worker vanished (crash, hang, lost DB write): IN_PROGRESS rows
 * past `lease_expires_at` go back to PENDING after a short backoff, or to FAILED once
 * attempts are exhausted. Returns the number of rows reaped.
 */
export async function reapExpiredLeases(db, jobId, maxAttempts, backoffSeconds = 1) {
  const { rowCount } = await db.query(
    `UPDATE enrichments
     SET status = CASE WHEN attempts >= $2 THEN 'FAILED' ELSE 'PENDING' END,
         attempt_token = NULL, lease_expires_at = NULL,
         last_error = 'lease expired (no response from worker)',
         next_attempt_at = now() + make_interval(secs => $3::float8),
         updated_at = now()
     WHERE job_id = $1 AND status = 'IN_PROGRESS' AND lease_expires_at < now()`,
    [jobId, maxAttempts, backoffSeconds],
  );
  return rowCount;
}
