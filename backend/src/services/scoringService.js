// Scoring service: config validation, the score/tier rules, running scoring in SQL and tier counts.

import { HttpError } from '../middleware/errorHandler.js';

/** Pure scoring formula; mirrors the SQL in runScoring. Comparisons are inclusive. */
export function calculateScore(metrics, cfg) {
  return (
    (metrics.footfall >= cfg.footfall_bar ? cfg.footfall_weight : 0) +
    (metrics.revenue >= cfg.revenue_bar ? cfg.revenue_weight : 0) +
    (metrics.size_sqft >= cfg.size_bar ? cfg.size_weight : 0)
  );
}

// Map a score to a tier: >= large_threshold is Large, >= medium_threshold is Medium, else Small.
export function tierFor(score, cfg) {
  if (score >= cfg.large_threshold) return 'Large';
  if (score >= cfg.medium_threshold) return 'Medium';
  return 'Small';
}

// Validation rules for each scoring config field: allowed range and whether it must be an integer.
const FIELDS = [
  ['footfall_bar', { min: 0, integer: true }],
  ['footfall_weight', { min: 0, max: 100, integer: true }],
  ['revenue_bar', { min: 0 }],
  ['revenue_weight', { min: 0, max: 100, integer: true }],
  ['size_bar', { min: 0, integer: true }],
  ['size_weight', { min: 0, max: 100, integer: true }],
  ['large_threshold', { min: 0, max: 100, integer: true }],
  ['medium_threshold', { min: 0, max: 100, integer: true }],
];

/**
 * Validate and coerce a scoring config body. Returns { value, errors }, where errors
 * is a list of { field, message }. Field checks run first; the cross-field rules
 * (weights sum to 100, medium_threshold <= large_threshold) only run if all fields are valid.
 */
export function validateScoringConfig(body = {}) {
  const errors = [];
  const value = {};
  for (const [field, rule] of FIELDS) {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') {
      errors.push({ field, message: 'is required' });
      continue;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      errors.push({ field, message: 'must be a number' });
    } else if (rule.integer && !Number.isInteger(n)) {
      errors.push({ field, message: 'must be an integer' });
    } else if (n < rule.min) {
      errors.push({ field, message: `must be >= ${rule.min}` });
    } else if (rule.max !== undefined && n > rule.max) {
      errors.push({ field, message: `must be <= ${rule.max}` });
    } else {
      value[field] = n;
    }
  }
  if (!errors.length) {
    const total = value.footfall_weight + value.revenue_weight + value.size_weight;
    if (total !== 100) {
      errors.push({ field: 'weights', message: `weights must sum to 100 (got ${total})` });
    }
    if (value.medium_threshold > value.large_threshold) {
      errors.push({ field: 'medium_threshold', message: 'must be <= large_threshold' });
    }
  }
  return { value, errors };
}

/**
 * Insert a config row and score every SUCCESS store in SQL, in one transaction.
 * Each metric that meets its bar earns that metric's weight; the summed score
 * picks the tier. Scoring runs inside the database (one INSERT ... SELECT) rather
 * than per row in JS, so large jobs score fast. Each run adds a new config, so
 * earlier runs are kept as history. Stores that failed enrichment get no score row.
 */
export async function runScoring(pool, jobId, cfg) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO scoring_configs
         (job_id, footfall_bar, footfall_weight, revenue_bar, revenue_weight,
          size_bar, size_weight, large_threshold, medium_threshold)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [jobId, cfg.footfall_bar, cfg.footfall_weight, cfg.revenue_bar, cfg.revenue_weight,
        cfg.size_bar, cfg.size_weight, cfg.large_threshold, cfg.medium_threshold],
    );
    const configId = rows[0].id;
    await client.query(
      `INSERT INTO store_scores (config_id, store_pk, score, tier)
       SELECT $1, s.id, x.score,
              CASE WHEN x.score >= $8 THEN 'Large'
                   WHEN x.score >= $9 THEN 'Medium' ELSE 'Small' END
       FROM stores s
       JOIN enrichments e ON e.store_pk = s.id AND e.status = 'SUCCESS'
       CROSS JOIN LATERAL (SELECT
           (CASE WHEN e.footfall  >= $2 THEN $3::int ELSE 0 END) +
           (CASE WHEN e.revenue   >= $4 THEN $5::int ELSE 0 END) +
           (CASE WHEN e.size_sqft >= $6 THEN $7::int ELSE 0 END) AS score) x
       WHERE s.job_id = $10`,
      [configId, cfg.footfall_bar, cfg.footfall_weight, cfg.revenue_bar, cfg.revenue_weight,
        cfg.size_bar, cfg.size_weight, cfg.large_threshold, cfg.medium_threshold, jobId],
    );
    await client.query('COMMIT');
    return configId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The most recent scoring config for a job, or null if it was never scored.
export async function latestConfig(pool, jobId) {
  const { rows } = await pool.query(
    'SELECT * FROM scoring_configs WHERE job_id = $1 ORDER BY id DESC LIMIT 1',
    [jobId],
  );
  return rows[0] || null;
}

/** Tier counts for a config; `unscored` = stores without a score row. */
export async function tierBreakdown(pool, jobId, configId) {
  const out = { Large: 0, Medium: 0, Small: 0, unscored: 0 };
  const { rows: total } = await pool.query('SELECT COUNT(*)::int AS n FROM stores WHERE job_id = $1', [jobId]);
  if (!configId) {
    out.unscored = total[0].n;
    return out;
  }
  const { rows } = await pool.query(
    'SELECT tier, COUNT(*)::int AS n FROM store_scores WHERE config_id = $1 GROUP BY tier',
    [configId],
  );
  let scored = 0;
  for (const r of rows) {
    out[r.tier] = r.n;
    scored += r.n;
  }
  out.unscored = total[0].n - scored;
  return out;
}

// Re-exported for callers/tests that import the error type alongside scoring helpers.
export { HttpError };
