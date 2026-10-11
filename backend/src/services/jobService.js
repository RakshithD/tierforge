// Job service: creating jobs, reporting progress/failures and listing stores (all job-related SQL).

import { HttpError } from '../middleware/errorHandler.js';

// Valid enrichment statuses (also the allowed values for the `status` filter).
const STATUSES = ['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED'];
const INSERT_BATCH = 1000; // rows per INSERT, to keep queries small for large CSVs

/**
 * Create a job from parsed CSV rows in one transaction: the job row, its stores
 * (bulk-inserted in batches via UNNEST), and one PENDING enrichment per store, which
 * is the queue the worker consumes. Any failure rolls everything back, so no
 * half-created job is ever visible.
 */
export async function createJob(pool, filename, stores) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO jobs (filename, total_stores) VALUES ($1, $2) RETURNING id',
      [filename, stores.length],
    );
    const jobId = rows[0].id;
    for (let i = 0; i < stores.length; i += INSERT_BATCH) {
      const chunk = stores.slice(i, i + INSERT_BATCH);
      const cols = ['store_id', 'store_name', 'address', 'city', 'state', 'country'];
      await client.query(
        `INSERT INTO stores (job_id, store_id, store_name, address, city, state, country)
         SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])`,
        [jobId, ...cols.map((c) => chunk.map((s) => s[c]))],
      );
    }
    await client.query(
      `INSERT INTO enrichments (store_pk, job_id)
       SELECT id, job_id FROM stores WHERE job_id = $1 ORDER BY id`,
      [jobId],
    );
    await client.query('COMMIT');
    return jobId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Fetch a job or throw 404.
export async function getJob(pool, jobId) {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (!rows[0]) throw new HttpError(404, 'JOB_NOT_FOUND', `Job ${jobId} not found`);
  return rows[0];
}

// Validate the :id URL param; non-numeric or non-positive ids are reported as 404.
export function parseJobId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'JOB_NOT_FOUND', `Job ${raw} not found`);
  return id;
}

/** Live progress: always computed from enrichments, never from stored counters. */
export async function getProgress(pool, jobId) {
  const job = await getJob(pool, jobId);
  const { rows } = await pool.query(
    'SELECT status, COUNT(*)::int AS n FROM enrichments WHERE job_id = $1 GROUP BY status',
    [jobId],
  );
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) counts[r.status] = r.n;
  const done = counts.SUCCESS + counts.FAILED;
  return {
    id: job.id,
    filename: job.filename,
    status: job.status,
    failure_reason: job.failure_reason,
    total: job.total_stores,
    counts,
    failed: counts.FAILED,
    percent_complete: job.total_stores ? Math.round((done / job.total_stores) * 1000) / 10 : 100,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
}

// Normalise ?page / ?pageSize: page >= 1, pageSize between 1 and 200.
export function clampPage(query, defaultSize = 50) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// Paginated failed stores plus a summary grouped by error message, so the UI can
// show e.g. "120 x server error (503)" without loading every row.
export async function getFailures(pool, jobId, query) {
  await getJob(pool, jobId);
  const { page, pageSize, offset } = clampPage(query);
  const [list, grouped, total] = await Promise.all([
    pool.query(
      `SELECT s.store_id, s.store_name, e.attempts, e.last_error
       FROM enrichments e JOIN stores s ON s.id = e.store_pk
       WHERE e.job_id = $1 AND e.status = 'FAILED'
       ORDER BY e.id LIMIT $2 OFFSET $3`,
      [jobId, pageSize, offset],
    ),
    pool.query(
      `SELECT COALESCE(last_error, 'unknown') AS error, COUNT(*)::int AS count
       FROM enrichments WHERE job_id = $1 AND status = 'FAILED'
       GROUP BY 1 ORDER BY count DESC`,
      [jobId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM enrichments WHERE job_id = $1 AND status = 'FAILED'`,
      [jobId],
    ),
  ]);
  return { page, pageSize, total: total.rows[0].n, summary: grouped.rows, failures: list.rows };
}

// Whitelist mapping the public ?sort key to a SQL column. The column is interpolated
// into the query, so only these fixed strings may ever reach it (prevents SQL injection).
const SORTS = {
  store_name: 's.store_name',
  store_id: 's.store_id',
  city: 's.city',
  state: 's.state',
  footfall: 'e.footfall',
  revenue: 'e.revenue',
  size_sqft: 'e.size_sqft',
  score: 'sc.score',
  tier: 'sc.tier',
  status: 'e.status',
};

/**
 * Paginated store list joined with enrichment results and the scores for `configId`
 * (the latest scoring run; null means no scores yet). Supports tier ('unscored' =
 * no score row), status and store-name search filters, plus sorting. Values go
 * through bind parameters; NULLs sort last. `COUNT(*) OVER()` returns the total
 * match count in the same query as the page.
 */
export async function listStores(pool, jobId, configId, query) {
  const { page, pageSize, offset } = clampPage(query);
  const tier = query.tier && query.tier !== 'All' ? query.tier : null;
  const status = query.status && query.status !== 'All' ? query.status : null;
  const q = query.q ? String(query.q) : null;
  if (tier && !['Large', 'Medium', 'Small', 'unscored'].includes(tier)) {
    throw new HttpError(400, 'INVALID_FILTER', 'tier must be Large, Medium, Small or unscored');
  }
  if (status && !STATUSES.includes(status)) {
    throw new HttpError(400, 'INVALID_FILTER', `status must be one of ${STATUSES.join(', ')}`);
  }
  const [sortKey, dirRaw] = String(query.sort || 'store_id:asc').split(':');
  const sortCol = SORTS[sortKey] || SORTS.store_id;
  const dir = dirRaw === 'desc' ? 'DESC' : 'ASC';

  const { rows } = await pool.query(
    `SELECT s.store_id, s.store_name, s.city, s.state,
            e.status, e.footfall, e.revenue, e.size_sqft, e.last_error,
            sc.score, sc.tier,
            COUNT(*) OVER()::int AS total_rows
     FROM stores s
     JOIN enrichments e ON e.store_pk = s.id
     LEFT JOIN store_scores sc ON sc.store_pk = s.id AND sc.config_id = $2
     WHERE s.job_id = $1
       AND ($3::text IS NULL OR ($3::text = 'unscored' AND sc.tier IS NULL) OR sc.tier = $3::text)
       AND ($4::text IS NULL OR e.status = $4::text)
       AND ($5::text IS NULL OR s.store_name ILIKE '%' || $5::text || '%')
     ORDER BY ${sortCol} ${dir} NULLS LAST, s.id
     LIMIT $6 OFFSET $7`,
    [jobId, configId, tier, status, q, pageSize, offset],
  );
  return {
    page,
    pageSize,
    total: rows.length ? rows[0].total_rows : 0,
    stores: rows.map(({ total_rows, ...r }) => r),
  };
}
