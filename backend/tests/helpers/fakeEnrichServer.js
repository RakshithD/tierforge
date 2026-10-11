import express from 'express';

/**
 * Fake enrichment API with a scriptable failure plan.
 * `script(storeId, callNumber)` returns one of:
 *   'ok' | 429 | 500 | 422 | 'hang' | 'malformed'
 */
export async function startFakeServer(script = () => 'ok') {
  const app = express();
  app.use(express.json());
  const calls = new Map();
  const log = [];

  app.post('/enrich', (req, res) => {
    const id = req.body.store_id;
    const n = (calls.get(id) || 0) + 1;
    calls.set(id, n);
    log.push({ id, n, body: req.body, at: Date.now() });
    const action = script(id, n);
    if (action === 'hang') return; // never answer; client must abort
    if (action === 'malformed') return res.json({ nope: true });
    if (typeof action === 'number') return res.status(action).json({ detail: 'scripted' });
    const seed = Number(id.replace(/\D/g, '')) || 1;
    return res.json({ store_id: id, estimated_monthly_footfall: seed * 1000, estimated_monthly_revenue: seed * 10000, store_size_sqft: seed * 100 });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    calls,
    log,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
