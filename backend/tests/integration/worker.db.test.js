import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createJob, getProgress } from '../../src/services/jobService.js';
import { createEngine } from '../../src/worker/engine.js';
import { createRateLimiter } from '../../src/worker/rateLimiter.js';
import { startFakeServer } from '../helpers/fakeEnrichServer.js';
import { fakeStores, openTestDb, resetDb } from '../helpers/testDb.js';

const db = await openTestDb();
const d = db ? describe : describe.skip;

const cfg = (url, over = {}) => ({
  enrichmentApiUrl: url,
  rateLimitPerSec: 1000,
  maxInFlight: 10,
  requestTimeoutMs: 300,
  leaseSeconds: 15,
  maxAttempts: 3,
  backoffBaseMs: 10,
  backoffMaxMs: 40,
  breakerWindow: 10,
  breakerFailureRatio: 0.9,
  pauseProbeMs: 20,
  pauseMaxMs: 300,
  ...over,
});

const engineFor = (c) =>
  createEngine({
    db,
    config: c,
    limiter: createRateLimiter({ ratePerSec: c.rateLimitPerSec }),
    pollMs: 20,
    idleMs: 20,
    log: () => {},
  });

d('worker integration (fake enrichment server)', () => {
  afterAll(async () => db?.end());
  beforeEach(() => resetDb(db));

  it('recovers from 429s, 500s and hangs; every store ends SUCCESS or FAILED', async () => {
    const srv = await startFakeServer((id, n) => {
      const k = Number(id.slice(1));
      if (k % 5 === 0 && n === 1) return 429;
      if (k % 7 === 0 && n === 1) return 500;
      if (k % 11 === 0 && n === 1) return 'hang';
      if (k === 13) return 422; // permanent
      if (k === 14) return 500; // always fails -> exhausts attempts
      return 'ok';
    });
    const jobId = await createJob(db, 't.csv', fakeStores(40));
    const status = await engineFor(cfg(srv.url)).runJob(jobId);
    const p = await getProgress(db, jobId);

    expect(status).toBe('COMPLETED_WITH_FAILURES');
    expect(p.counts.SUCCESS + p.counts.FAILED).toBe(40);
    expect(p.counts.PENDING).toBe(0);
    expect(p.counts.IN_PROGRESS).toBe(0);
    expect(p.counts.FAILED).toBe(2);

    const { rows } = await db.query(
      `SELECT s.store_id, e.attempts, e.last_error FROM enrichments e JOIN stores s ON s.id=e.store_pk WHERE e.status='FAILED' ORDER BY s.id`,
    );
    expect(rows.find((r) => r.store_id === 'S13')).toMatchObject({ attempts: 1 }); // no retry
    expect(rows.find((r) => r.store_id === 'S14')).toMatchObject({ attempts: 3 });
    expect(srv.calls.get('S5')).toBe(2);
    await srv.close();
  });

  it('completes cleanly when nothing fails', async () => {
    const srv = await startFakeServer();
    const jobId = await createJob(db, 't.csv', fakeStores(15));
    expect(await engineFor(cfg(srv.url)).runJob(jobId)).toBe('COMPLETED');
    expect((await getProgress(db, jobId)).counts.SUCCESS).toBe(15);
    await srv.close();
  });

  it('trips the circuit breaker, pauses, and finally FAILS when the API never recovers', async () => {
    const jobId = await createJob(db, 't.csv', fakeStores(60));
    const status = await engineFor(cfg('http://127.0.0.1:1', { maxInFlight: 5, backoffBaseMs: 5 })).runJob(jobId);
    const p = await getProgress(db, jobId);
    expect(status).toBe('FAILED');
    expect(p.status).toBe('FAILED');
    expect(p.failure_reason).toMatch(/unavailable/);
    expect(p.counts.SUCCESS).toBe(0);
    expect(p.counts.PENDING + p.counts.FAILED).toBe(60);
    expect(p.counts.IN_PROGRESS).toBe(0);
  });

  it('auto-resumes a paused job once the API is back and completes it', async () => {
    let down = true;
    const srv = await startFakeServer(() => (down ? 500 : 'ok'));
    const jobId = await createJob(db, 't.csv', fakeStores(30));
    const c = cfg(srv.url, { maxAttempts: 6, maxInFlight: 5, pauseMaxMs: 10000 });
    const running = engineFor(c).runJob(jobId);
    // wait until the job is observed as PAUSED, then bring the API back
    for (let i = 0; i < 200 && (await getProgress(db, jobId)).status !== 'PAUSED'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const paused = await getProgress(db, jobId);
    expect(paused.status).toBe('PAUSED');
    expect(paused.failure_reason).toMatch(/unavailable/);
    down = false;
    expect(await running).toBe('COMPLETED');
    const p = await getProgress(db, jobId);
    expect(p.counts.SUCCESS).toBe(30);
    expect(p.failure_reason).toBeNull();
    await srv.close();
  });

  it('a late response after lease reaping cannot overwrite or double count', async () => {
    const srv = await startFakeServer();
    const jobId = await createJob(db, 't.csv', fakeStores(1));
    // simulate a paused worker: unit is claimed, lease expires, reaper requeues, new claim happens
    const { claim, reapExpiredLeases, saveSuccess } = await import('../../src/worker/claim.js');
    const [old] = await claim(db, jobId, 1, 15);
    await db.query(`UPDATE enrichments SET lease_expires_at = now() - interval '1 s' WHERE id=$1`, [old.id]);
    await reapExpiredLeases(db, jobId, 6, 0);
    const [fresh] = await claim(db, jobId, 1, 15);
    expect(await saveSuccess(db, old.id, old.attempt_token, { footfall: 1, revenue: 1, size_sqft: 1 })).toBe(false);
    expect(await saveSuccess(db, fresh.id, fresh.attempt_token, { footfall: 2, revenue: 2, size_sqft: 2 })).toBe(true);
    await srv.close();
  });

  it('stops mid-job when asked, leaving the job RUNNING and nothing IN_PROGRESS', async () => {
    const srv = await startFakeServer();
    const jobId = await createJob(db, 't.csv', fakeStores(30));
    let stop = false;
    setTimeout(() => { stop = true; }, 60);
    const c = cfg(srv.url, { rateLimitPerSec: 100, maxInFlight: 2 });
    const status = await engineFor(c).runJob(jobId, () => stop);
    const p = await getProgress(db, jobId);
    expect(status).toBe('RUNNING');
    expect(p.status).toBe('RUNNING');
    expect(p.counts.IN_PROGRESS).toBe(0);
    expect(p.counts.PENDING).toBeGreaterThan(0);
    await srv.close();
  });
});
