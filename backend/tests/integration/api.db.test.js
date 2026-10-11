import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { fakeStores, openTestDb, resetDb } from '../helpers/testDb.js';

const db = await openTestDb();
const d = db ? describe : describe.skip;

const HEADER = 'store_id,store_name,address,city,state,country\n';
const csv = (n) =>
  HEADER + fakeStores(n).map((s) => Object.values(s).join(',')).join('\n') + '\n';

const CFG = {
  footfall_bar: 15000, footfall_weight: 50,
  revenue_bar: 150000, revenue_weight: 30,
  size_bar: 8000, size_weight: 20,
  large_threshold: 70, medium_threshold: 40,
};

d('API (supertest)', () => {
  const app = db ? createApp(db) : null;
  afterAll(async () => db?.end());
  beforeEach(() => resetDb(db));

  const upload = (text, name = 'stores.csv') =>
    request(app).post('/api/jobs').attach('file', Buffer.from(text), name);

  it('uploads a valid CSV and creates job, stores and enrichments', async () => {
    const res = await upload(csv(25));
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(25);
    const prog = await request(app).get(`/api/jobs/${res.body.id}`);
    expect(prog.body.counts.PENDING).toBe(25);
    expect(prog.body.status).toBe('PENDING');
  });

  it('writes nothing when validation fails', async () => {
    const res = await upload('store_id,store_name\nS1,A\n');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_HEADERS');
    const dup = await upload(HEADER + 'S1,A,a,c,s,US\nS1,B,a,c,s,US\n');
    expect(dup.status).toBe(400);
    expect(dup.body.error.details[0].row).toBe(3);
    const { rows } = await db.query('SELECT (SELECT COUNT(*) FROM jobs) j, (SELECT COUNT(*) FROM stores) s');
    expect(Number(rows[0].j) + Number(rows[0].s)).toBe(0);
  });

  it('rejects non-csv files and unknown jobs', async () => {
    expect((await upload(csv(2), 'x.txt')).status).toBe(400);
    expect((await request(app).get('/api/jobs/9999')).status).toBe(404);
    expect((await request(app).get('/api/jobs/abc')).status).toBe(404);
  });

  async function seededJob() {
    const { body } = await upload(csv(3));
    const metrics = [
      [40000, 400000, 18000],
      [20000, 100000, 5000],
      [2000, 20000, 9000],
    ];
    const { rows } = await db.query('SELECT id FROM enrichments WHERE job_id=$1 ORDER BY id', [body.id]);
    for (let i = 0; i < 3; i++) {
      await db.query(
        `UPDATE enrichments SET status='SUCCESS', footfall=$2, revenue=$3, size_sqft=$4 WHERE id=$1`,
        [rows[i].id, ...metrics[i]],
      );
    }
    return body.id;
  }

  it('scores the worked example and filters by tier', async () => {
    const id = await seededJob();
    const res = await request(app).post(`/api/jobs/${id}/scoring`).send(CFG);
    expect(res.status).toBe(201);
    expect(res.body.tiers).toEqual({ Large: 1, Medium: 1, Small: 1, unscored: 0 });

    const large = await request(app).get(`/api/jobs/${id}/stores?tier=Large`);
    expect(large.body.total).toBe(1);
    expect(large.body.stores[0]).toMatchObject({ store_id: 'S1', score: 100, tier: 'Large' });

    const dash = await request(app).get(`/api/jobs/${id}/dashboard`);
    expect(dash.body.tiers.Medium).toBe(1);
    expect(dash.body.config.id).toBe(res.body.config_id);
  });

  it('re-scoring with different settings creates a new config and results', async () => {
    const id = await seededJob();
    await request(app).post(`/api/jobs/${id}/scoring`).send(CFG);
    const res = await request(app).post(`/api/jobs/${id}/scoring`).send({ ...CFG, large_threshold: 50 });
    expect(res.body.tiers).toEqual({ Large: 2, Medium: 0, Small: 1, unscored: 0 });
    const { rows } = await db.query('SELECT COUNT(*)::int n FROM scoring_configs WHERE job_id=$1', [id]);
    expect(rows[0].n).toBe(2);
  });

  it('rejects invalid scoring configs with field errors', async () => {
    const id = await seededJob();
    const res = await request(app).post(`/api/jobs/${id}/scoring`).send({ ...CFG, size_weight: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SCORING_CONFIG');
    expect(res.body.error.details[0].field).toBe('weights');
  });

  it('reports unscored stores before enrichment finishes', async () => {
    const { body } = await upload(csv(4));
    const res = await request(app).post(`/api/jobs/${body.id}/scoring`).send(CFG);
    expect(res.body.tiers).toEqual({ Large: 0, Medium: 0, Small: 0, unscored: 4 });
    const un = await request(app).get(`/api/jobs/${body.id}/stores?tier=unscored`);
    expect(un.body.total).toBe(4);
  });

  it('caps pageSize at 200 and paginates', async () => {
    const { body } = await upload(csv(250));
    const res = await request(app).get(`/api/jobs/${body.id}/stores?pageSize=5000`);
    expect(res.body.pageSize).toBe(200);
    expect(res.body.stores).toHaveLength(200);
    expect(res.body.total).toBe(250);
    const p2 = await request(app).get(`/api/jobs/${body.id}/stores?pageSize=200&page=2`);
    expect(p2.body.stores).toHaveLength(50);
  });

  it('filters by status and name, with whitelisted sorting', async () => {
    const id = await seededJob();
    const succ = await request(app).get(`/api/jobs/${id}/stores?status=SUCCESS&sort=footfall:desc`);
    expect(succ.body.stores.map((s) => s.store_id)).toEqual(['S1', 'S2', 'S3']);
    const q = await request(app).get(`/api/jobs/${id}/stores?q=store 2`);
    expect(q.body.total).toBe(1);
    const evil = await request(app).get(`/api/jobs/${id}/stores?sort=${encodeURIComponent('x; DROP TABLE jobs')}`);
    expect(evil.status).toBe(200);
    expect((await request(app).get(`/api/jobs/${id}/stores?tier=Huge`)).status).toBe(400);
  });

  it('lists failures with a grouped summary', async () => {
    const { body } = await upload(csv(3));
    await db.query(`UPDATE enrichments SET status='FAILED', attempts=6, last_error='timeout after 5000ms' WHERE job_id=$1`, [body.id]);
    const res = await request(app).get(`/api/jobs/${body.id}/failures`);
    expect(res.body.total).toBe(3);
    expect(res.body.summary).toEqual([{ error: 'timeout after 5000ms', count: 3 }]);
  });
});
