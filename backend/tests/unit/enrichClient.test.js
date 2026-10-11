import { describe, expect, it } from 'vitest';
import { callEnrich, classifyResponse } from '../../src/worker/enrichClient.js';
import { startFakeServer } from '../helpers/fakeEnrichServer.js';

const raw = { store_id: 'S1', estimated_monthly_footfall: 100, estimated_monthly_revenue: 2000.5, store_size_sqft: 900 };
const good = { footfall: 100, revenue: 2000.5, size_sqft: 900 };

describe('classifyResponse', () => {
  it('treats 200 with a valid body as success', () => {
    expect(classifyResponse(200, raw)).toEqual({ ok: true, data: good });
  });

  it.each([429, 500, 502, 503, 504])('treats %i as retryable', (status) => {
    expect(classifyResponse(status, null)).toMatchObject({ ok: false, retryable: true });
  });

  it('honours Retry-After on 429', () => {
    expect(classifyResponse(429, null, '3')).toMatchObject({ retryAfterMs: 3000 });
  });

  it.each([400, 404, 422])('treats %i as permanent', (status) => {
    expect(classifyResponse(status, null)).toMatchObject({ ok: false, retryable: false });
  });

  it('treats a malformed 200 as permanent', () => {
    expect(classifyResponse(200, { foo: 1 })).toMatchObject({ ok: false, retryable: false });
    expect(classifyResponse(200, null)).toMatchObject({ ok: false, retryable: false });
    expect(classifyResponse(200, { ...raw, estimated_monthly_revenue: 'x' })).toMatchObject({ ok: false, retryable: false });
  });
});

describe('callEnrich against a fake server', () => {
  it('sends the right payload without country and succeeds', async () => {
    const srv = await startFakeServer();
    const r = await callEnrich(
      { store_id: 'S3', store_name: 'n', address: 'a', city: 'c', state: 's', country: 'US' },
      { baseUrl: srv.url, timeoutMs: 1000 },
    );
    expect(r.ok).toBe(true);
    expect(srv.log[0].body).toEqual({ store_id: 'S3', store_name: 'n', address: 'a', city: 'c', state: 's' });
    await srv.close();
  });

  it('classifies a hang as a retryable timeout', async () => {
    const srv = await startFakeServer(() => 'hang');
    const r = await callEnrich({ store_id: 'S1' }, { baseUrl: srv.url, timeoutMs: 150 });
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(r.error).toMatch(/timeout/);
    await srv.close();
  });

  it('classifies a refused connection as a retryable network error', async () => {
    const r = await callEnrich({ store_id: 'S1' }, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    expect(r).toMatchObject({ ok: false, retryable: true });
  });
});
