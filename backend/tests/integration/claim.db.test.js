import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJob } from '../../src/services/jobService.js';
import { claim, reapExpiredLeases, saveRetry, saveSuccess } from '../../src/worker/claim.js';
import { fakeStores, openTestDb, resetDb } from '../helpers/testDb.js';

const db = await openTestDb();
const d = db ? describe : describe.skip;

d('claim / guarded writes (integration)', () => {
  let jobId;
  beforeAll(() => {});
  afterAll(async () => db?.end());
  beforeEach(async () => {
    await resetDb(db);
    jobId = await createJob(db, 't.csv', fakeStores(50));
  });

  it('two concurrent claimers never receive the same row', async () => {
    const [a, b] = await Promise.all([claim(db, jobId, 30, 15), claim(db, jobId, 30, 15)]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(50);
  });

  it('claim sets token, lease, attempts and joins store payload', async () => {
    const [u] = await claim(db, jobId, 1, 15);
    expect(u.attempt_token).toBeTruthy();
    expect(u.attempts).toBe(1);
    expect(u.store_name).toMatch(/^Store/);
    const { rows } = await db.query('SELECT status, lease_expires_at FROM enrichments WHERE id=$1', [u.id]);
    expect(rows[0].status).toBe('IN_PROGRESS');
    expect(rows[0].lease_expires_at).not.toBeNull();
  });

  it('does not claim units whose next_attempt_at is in the future', async () => {
    await db.query(`UPDATE enrichments SET next_attempt_at = now() + interval '1 hour'`);
    expect(await claim(db, jobId, 10, 15)).toHaveLength(0);
  });

  it('a stale token write affects zero rows', async () => {
    const [u] = await claim(db, jobId, 1, 15);
    const data = { footfall: 1, revenue: 2, size_sqft: 3 };
    expect(await saveSuccess(db, u.id, '00000000-0000-0000-0000-000000000000', data)).toBe(false);
    expect(await saveSuccess(db, u.id, u.attempt_token, data)).toBe(true);
  });

  it('SUCCESS is never overwritten or regressed', async () => {
    const [u] = await claim(db, jobId, 1, 15);
    await saveSuccess(db, u.id, u.attempt_token, { footfall: 1, revenue: 2, size_sqft: 3 });
    expect(await saveSuccess(db, u.id, u.attempt_token, { footfall: 9, revenue: 9, size_sqft: 9 })).toBe(false);
    expect(await saveRetry(db, u.id, u.attempt_token, 'late', 100, 6)).toBeNull();
    const { rows } = await db.query('SELECT status, footfall FROM enrichments WHERE id=$1', [u.id]);
    expect(rows[0]).toMatchObject({ status: 'SUCCESS', footfall: 1 });
  });

  it('reaper returns an expired lease to PENDING and invalidates the old token', async () => {
    const [u] = await claim(db, jobId, 1, 15);
    await db.query(`UPDATE enrichments SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [u.id]);
    expect(await reapExpiredLeases(db, jobId, 6, 0)).toBe(1);
    const { rows } = await db.query('SELECT status, attempt_token FROM enrichments WHERE id=$1', [u.id]);
    expect(rows[0]).toMatchObject({ status: 'PENDING', attempt_token: null });
    expect(await saveSuccess(db, u.id, u.attempt_token, { footfall: 1, revenue: 1, size_sqft: 1 })).toBe(false);
  });

  it('reaper fails units that exhausted their attempts', async () => {
    const [u] = await claim(db, jobId, 1, 15);
    await db.query(`UPDATE enrichments SET lease_expires_at = now() - interval '1 second', attempts = 6 WHERE id=$1`, [u.id]);
    await reapExpiredLeases(db, jobId, 6, 0);
    const { rows } = await db.query('SELECT status FROM enrichments WHERE id=$1', [u.id]);
    expect(rows[0].status).toBe('FAILED');
  });

  it('saveRetry requeues, then fails at max attempts', async () => {
    const [u] = await claim(db, jobId, 1, 15);
    expect(await saveRetry(db, u.id, u.attempt_token, 'boom', 0, 2)).toBe('PENDING');
    const [u2] = await claim(db, jobId, 1, 15);
    expect(u2.id).toBe(u.id);
    expect(u2.attempts).toBe(2);
    expect(await saveRetry(db, u2.id, u2.attempt_token, 'boom', 0, 2)).toBe('FAILED');
  });
});
