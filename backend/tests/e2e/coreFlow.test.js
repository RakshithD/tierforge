/**
 * TierForge — core functionality test (black-box, end to end)
 * Place at: backend/tests/e2e/coreFlow.test.js
 *
 * What it does
 *   • Starts its OWN fake enrichment server on port 8002 (fast, scripted, deterministic).
 *   • Talks to your running API over HTTP (default http://localhost:8000).
 *   • Your WORKER must be pointed at the fake server (see "How to run").
 *
 * How to run (4 terminals)
 *   1. docker start tierforge-postgres
 *   2. API:     cd backend && npm run dev
 *   3. Worker:  cd backend && ENRICHMENT_API_URL=http://localhost:8002 npm run worker
 *               (worker rate limit must be <= 5/s; the default 4/s is fine)
 *   4. Tests:   cd backend && npm run test:e2e
 *
 *   Use a clean DB (or make sure no other job is PENDING/RUNNING): the worker
 *   processes the oldest unfinished job first, which would delay this test's job.
 *
 * Install once:  npm i -D vitest
 *
 * ADAPT: the response-shape helpers right below (jobIdOf, counts, rowsOf, tiersOf,
 * failureRowsOf) accept several common field names. If your API uses different
 * names, change only those helpers, not the tests.
 */
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

const API = process.env.TEST_API_URL ?? 'http://localhost:8000';
const FAKE_PORT = Number(process.env.TEST_FAKE_PORT ?? 8002);
const TERMINAL = ['COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED'];
const HEADER = 'store_id,store_name,address,city,state,country';

/* ------------------------------------------------------------------ */
/* Response-shape adapters (ADAPT here if your field names differ)     */
/* ------------------------------------------------------------------ */
const first = (o, ...keys) => {
  for (const k of keys) if (o?.[k] !== undefined) return o[k];
  return undefined;
};
const jobIdOf = (b) => b?.id ?? b?.jobId ?? b?.job_id ?? b?.job?.id;
const statusOf = (b) => first(b, 'status') ?? b?.job?.status;
const totalOf = (b) => Number(first(b, 'total', 'total_stores', 'totalStores') ?? b?.job?.total_stores ?? 0);
function counts(p) {
  const c = p?.counts ?? p?.progress ?? p ?? {};
  const g = (...k) => Number(first(c, ...k) ?? first(p, ...k) ?? 0);
  return {
    success: g('SUCCESS', 'success', 'successful', 'enriched'),
    failed: g('FAILED', 'failed'),
    pending: g('PENDING', 'pending'),
    inProgress: g('IN_PROGRESS', 'inProgress', 'in_progress'),
  };
}
const rowsOf = (b) => b?.rows ?? b?.stores ?? b?.items ?? b?.data ?? [];
const failureRowsOf = (b) => b?.failures ?? b?.rows ?? b?.items ?? b?.data ?? [];
const tiersOf = (d) => d?.tiers ?? d?.tierBreakdown ?? d?.tier_breakdown ?? d?.tier_counts ?? {};

/* ------------------------------------------------------------------ */
/* Fake enrichment server (mimics the real simulator's contract)       */
/* ------------------------------------------------------------------ */
const FIXED = {            // the brief's worked example: A -> Large 100, B -> Medium 50, C -> Small 20
  ST_A: [40000, 400000, 18000],
  ST_B: [20000, 100000, 5000],
  ST_C: [2000, 20000, 9000],
};
const hash = (s) => { let x = 0; for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x; };

function createFakeEnrichmentServer() {
  const calls = new Map();   // store_id -> number of calls received
  const bodies = [];         // every request body received
  const stamps = [];         // timestamps inside the last 1s window
  const stats = { total: 0, overLimit: 0, maxInWindow: 0 };

  const send = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/enrich') return send(res, 404, { detail: 'not found' });

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 422, { detail: 'invalid json' }); }

      const now = Date.now();
      stamps.push(now);
      while (stamps.length && now - stamps[0] >= 1000) stamps.shift();
      stats.total++;
      stats.maxInWindow = Math.max(stats.maxInWindow, stamps.length);
      bodies.push(body);
      const n = (calls.get(body.store_id) ?? 0) + 1;
      calls.set(body.store_id, n);

      if (stamps.length > 5) {                       // same rule as the real simulator
        stats.overLimit++;
        return send(res, 429, { detail: 'Rate limit exceeded: 5 requests/second' });
      }
      for (const f of ['store_id', 'store_name', 'address', 'city', 'state']) {
        if (typeof body[f] !== 'string') return send(res, 422, { detail: `missing ${f}` });
      }

      setTimeout(() => {
        const id = body.store_id;
        if (id === 'ST_BAD') return send(res, 422, { detail: 'Unprocessable store data' }); // permanent
        if (id === 'ST_FLAKY' && n <= 2) return send(res, 500, { detail: 'Transient upstream error' });
        const h = hash(id);
        if (!FIXED[id] && n === 1 && h % 8 === 0) return send(res, 500, { detail: 'Transient upstream error' });

        const [footfall, revenue, size] = FIXED[id] ?? [
          500 + (h % 49500),
          5000 + ((h * 7) % 495000) + 0.25,
          200 + ((h * 13) % 19800),
        ];
        send(res, 200, {
          store_id: id,
          estimated_monthly_footfall: footfall,
          estimated_monthly_revenue: revenue,
          store_size_sqft: size,
        });
      }, 20);
    });
  });

  return {
    calls, bodies, stats,
    start: () => new Promise((r) => server.listen(FAKE_PORT, r)),
    stop: () => new Promise((r) => server.close(r)),
  };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
async function api(path, opts = {}) {
  const res = await fetch(API + path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
async function upload(csvText, filename = 'stores.csv', type = 'text/csv') {
  const form = new FormData();
  form.append('file', new Blob([csvText], { type }), filename);
  return api('/api/jobs', { method: 'POST', body: form });
}
const postJson = (path, payload) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

const csvRow = (id) => `${id},Store ${id},1 Main Street,Bengaluru,Karnataka,India`;
const csvOf = (ids) => [HEADER, ...ids.map(csvRow)].join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTerminal(jobId, { timeoutMs = 100_000, onPoll } = {}) {
  const t0 = Date.now();
  for (;;) {
    const { status, body } = await api(`/api/jobs/${jobId}`);
    expect(status).toBe(200);
    onPoll?.(body);
    if (TERMINAL.includes(statusOf(body))) return body;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Job ${jobId} not finished in ${timeoutMs} ms (last: ${JSON.stringify(body)})`);
    await sleep(400);
  }
}

const scoringConfig = (over = {}) => ({
  footfall_bar: 15000, footfall_weight: 50,
  revenue_bar: 150000, revenue_weight: 30,
  size_bar: 8000, size_weight: 20,
  large_threshold: 70, medium_threshold: 40,
  ...over,
});

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */
const fake = createFakeEnrichmentServer();
const GENERATED = Array.from({ length: 35 }, (_, i) => `ST_${String(i + 1).padStart(4, '0')}`);
const ALL_IDS = ['ST_A', 'ST_B', 'ST_C', 'ST_BAD', 'ST_FLAKY', ...GENERATED];   // 40 stores
const EXPECTED_SUCCESS = ALL_IDS.length - 1;                                      // only ST_BAD fails

let jobId;
let uploadMs;
const samples = [];       // progress samples seen while the job ran

beforeAll(async () => {
  await fake.start();
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`API not reachable at ${API}. Start Postgres, the API and the worker first (see header of this file).`);
  }
});
afterAll(async () => { await fake.stop(); });

describe('Step 1 — CSV upload and validation', () => {
  it('rejects a CSV with a missing header column', async () => {
    const bad = 'store_id,store_name,address,city,state\nST_X,Store X,1 Main,Bengaluru,Karnataka';
    const { status, body } = await upload(bad);
    expect(status).toBe(400);
    expect(JSON.stringify(body).toLowerCase()).toContain('country');
  });

  it('rejects a non-CSV file', async () => {
    const { status } = await upload('hello', 'notes.txt', 'text/plain');
    expect(status).toBe(400);
  });

  it('rejects an empty / header-only CSV', async () => {
    expect((await upload('')).status).toBe(400);
    expect((await upload(HEADER)).status).toBe(400);
  });

  it('rejects a row with a blank store_id', async () => {
    const { status } = await upload([HEADER, ',No Id,1 Main,Bengaluru,Karnataka,India'].join('\n'));
    expect(status).toBe(400);
  });

  it('rejects duplicate store_id values and reports the row numbers', async () => {
    const csv = [HEADER, csvRow('ST_OK'), csvRow('ST_DUP'), csvRow('ST_DUP')].join('\n');
    const { status, body } = await upload(csv);
    expect(status).toBe(400);
    const text = JSON.stringify(body);
    expect(text).toContain('ST_DUP');
    expect(text).toMatch(/\b3\b/);
    expect(text).toMatch(/\b4\b/);
  });

  it('treats whitespace variants of the same store_id as duplicates', async () => {
    const csv = [HEADER, csvRow('ST_W'), csvRow(' ST_W ')].join('\n');
    expect((await upload(csv)).status).toBe(400);
  });

  it('accepts a valid CSV and responds immediately without waiting for enrichment', async () => {
    const t0 = Date.now();
    const { status, body } = await upload(csvOf(ALL_IDS));
    uploadMs = Date.now() - t0;
    expect([200, 201, 202]).toContain(status);
    jobId = jobIdOf(body);
    expect(jobId).toBeTruthy();
    expect(uploadMs).toBeLessThan(5000);            // 40 stores take >10 s to enrich; upload must not block
  });

  it('returns 404 for an unknown job', async () => {
    expect((await api('/api/jobs/99999999')).status).toBe(404);
  });
});

describe('Step 2 — enrichment job (resilience, rate limit, progress)', () => {
  let final;

  it('runs in the background and reaches a terminal state', async () => {
    expect(jobId).toBeTruthy();
    final = await waitForTerminal(jobId, {
      onPoll: (b) => { const c = counts(b); samples.push({ done: c.success + c.failed, ...c }); },
    });
    expect(TERMINAL).toContain(statusOf(final));
  });

  it('progress is incremental, not only visible at the very end', () => {
    const total = ALL_IDS.length;
    const inBetween = samples.filter((s) => s.done > 0 && s.done < total);
    expect(inBetween.length).toBeGreaterThan(0);
    const dones = samples.map((s) => s.done);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));       // never goes backwards
  });

  it('final counts add up: all stores enriched except the permanently bad one', () => {
    const c = counts(final);
    expect(totalOf(final)).toBe(ALL_IDS.length);
    expect(c.success).toBe(EXPECTED_SUCCESS);
    expect(c.failed).toBe(1);
    expect(c.pending).toBe(0);
    expect(c.inProgress).toBe(0);
    expect(c.success + c.failed).toBe(ALL_IDS.length);
    expect(statusOf(final)).toBe('COMPLETED_WITH_FAILURES');
  });

  it('never exceeded 5 requests/second against the dependency', () => {
    expect(fake.stats.overLimit).toBe(0);
    expect(fake.stats.maxInWindow).toBeLessThanOrEqual(5);
    expect(fake.stats.total).toBeGreaterThan(ALL_IDS.length);       // retries really happened
  });

  it('retries transient 500s (flaky store succeeded on the 3rd call)', async () => {
    expect(fake.calls.get('ST_FLAKY')).toBe(3);
    const { body } = await api(`/api/jobs/${jobId}/stores?pageSize=200`);
    const flaky = rowsOf(body).find((r) => (r.store_id ?? r.storeId) === 'ST_FLAKY');
    expect(String(flaky?.status ?? flaky?.enrichment_status).toUpperCase()).toBe('SUCCESS');
  });

  it('does NOT retry permanent errors (422 was called exactly once)', () => {
    expect(fake.calls.get('ST_BAD')).toBe(1);
  });

  it('does not send "country" to the enrichment API, but sends the five required fields', () => {
    expect(fake.bodies.length).toBeGreaterThan(0);
    for (const b of fake.bodies) {
      expect('country' in b).toBe(false);
      for (const f of ['store_id', 'store_name', 'address', 'city', 'state']) expect(typeof b[f]).toBe('string');
    }
  });

  it('exposes a failure reason for the failed store', async () => {
    const { status, body } = await api(`/api/jobs/${jobId}/failures`);
    expect(status).toBe(200);
    const row = failureRowsOf(body).find((r) => (r.store_id ?? r.storeId) === 'ST_BAD');
    expect(row).toBeTruthy();
    const reason = row.last_error ?? row.reason ?? row.failure_reason ?? row.error;
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeGreaterThan(0);
  });
});

describe('Step 3 — scoring and tiering', () => {
  it('rejects weights that do not total 100', async () => {
    const r = await postJson(`/api/jobs/${jobId}/scoring`, scoringConfig({ footfall_weight: 60 }));
    expect(r.status).toBe(400);
  });

  it('rejects medium threshold above large threshold', async () => {
    const r = await postJson(`/api/jobs/${jobId}/scoring`, scoringConfig({ large_threshold: 40, medium_threshold: 70 }));
    expect(r.status).toBe(400);
  });

  it('rejects negative bars', async () => {
    const r = await postJson(`/api/jobs/${jobId}/scoring`, scoringConfig({ footfall_bar: -1 }));
    expect(r.status).toBe(400);
  });

  it('scores on demand using stored data only — no new enrichment calls', async () => {
    const before = fake.stats.total;
    const r = await postJson(`/api/jobs/${jobId}/scoring`, scoringConfig());
    expect([200, 201]).toContain(r.status);
    expect(fake.stats.total).toBe(before);
  });

  it("matches the brief's worked example (A=100/Large, B=50/Medium, C=20/Small)", async () => {
    const { body } = await api(`/api/jobs/${jobId}/stores?pageSize=200`);
    const by = Object.fromEntries(rowsOf(body).map((r) => [r.store_id ?? r.storeId, r]));
    expect(Number(by.ST_A.score)).toBe(100);  expect(by.ST_A.tier).toBe('Large');
    expect(Number(by.ST_B.score)).toBe(50);   expect(by.ST_B.tier).toBe('Medium');
    expect(Number(by.ST_C.score)).toBe(20);   expect(by.ST_C.tier).toBe('Small');
  });

  it('leaves the failed (never enriched) store unscored', async () => {
    const { body } = await api(`/api/jobs/${jobId}/stores?pageSize=200`);
    const bad = rowsOf(body).find((r) => (r.store_id ?? r.storeId) === 'ST_BAD');
    expect(bad.tier ?? null).toBeNull();
  });

  it('is re-runnable: new settings change tiers; bars are inclusive (>=)', async () => {
    // footfall only, bar exactly equal to ST_B (20000) -> B must clear it
    const r = await postJson(`/api/jobs/${jobId}/scoring`, scoringConfig({
      footfall_bar: 20000, footfall_weight: 100,
      revenue_bar: 0, revenue_weight: 0, size_bar: 0, size_weight: 0,
      large_threshold: 100, medium_threshold: 100,
    }));
    expect([200, 201]).toContain(r.status);
    const { body } = await api(`/api/jobs/${jobId}/stores?pageSize=200`);
    const by = Object.fromEntries(rowsOf(body).map((x) => [x.store_id ?? x.storeId, x]));
    expect(by.ST_B.tier).toBe('Large');   // 20000 >= 20000
    expect(by.ST_C.tier).toBe('Small');   // 2000 < 20000
    // restore the worked-example config for the dashboard tests
    await postJson(`/api/jobs/${jobId}/scoring`, scoringConfig());
  });
});

describe('Step 4 — dashboard', () => {
  it('summary shows job progress and tier counts that add up', async () => {
    const { status, body } = await api(`/api/jobs/${jobId}/dashboard`);
    expect(status).toBe(200);
    const c = counts(body.progress ?? body.job ?? body);
    expect(c.success).toBe(EXPECTED_SUCCESS);
    expect(c.failed).toBe(1);
    const t = tiersOf(body);
    const sum = Number(t.Large ?? 0) + Number(t.Medium ?? 0) + Number(t.Small ?? 0);
    expect(sum).toBe(EXPECTED_SUCCESS);
    expect(Number(t.Large)).toBeGreaterThanOrEqual(1);   // ST_A
  });

  it('store list filters by tier', async () => {
    for (const tier of ['Large', 'Medium', 'Small']) {
      const { status, body } = await api(`/api/jobs/${jobId}/stores?tier=${tier}&pageSize=200`);
      expect(status).toBe(200);
      const rows = rowsOf(body);
      expect(rows.every((r) => r.tier === tier)).toBe(true);
    }
    const large = rowsOf((await api(`/api/jobs/${jobId}/stores?tier=Large&pageSize=200`)).body);
    expect(large.some((r) => (r.store_id ?? r.storeId) === 'ST_A')).toBe(true);
  });

  it('paginates and caps page size (never returns everything unbounded)', async () => {
    const small = rowsOf((await api(`/api/jobs/${jobId}/stores?pageSize=10&page=1`)).body);
    expect(small.length).toBe(10);
    const huge = rowsOf((await api(`/api/jobs/${jobId}/stores?pageSize=100000`)).body);
    expect(huge.length).toBeLessThanOrEqual(200);
  });
});
