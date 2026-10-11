// Dashboard controller: read-only endpoints that feed the UI (progress, tier counts, store table).

import { getProgress, listStores, parseJobId } from '../services/jobService.js';
import { latestConfig, tierBreakdown } from '../services/scoringService.js';

/** Build dashboard request handlers bound to the given DB pool. */
export function dashboardController(pool) {
  return {
    // GET /api/jobs/:id/dashboard: progress + latest scoring config + tier counts in one response.
    async summary(req, res) {
      const jobId = parseJobId(req.params.id);
      const progress = await getProgress(pool, jobId);
      const cfg = await latestConfig(pool, jobId);
      res.json({ progress, config: cfg, tiers: await tierBreakdown(pool, jobId, cfg?.id) });
    },

    // GET /api/jobs/:id/stores: filtered/sorted/paginated store table.
    async stores(req, res) {
      const jobId = parseJobId(req.params.id);
      await getProgress(pool, jobId); // 404 for unknown job
      const cfg = await latestConfig(pool, jobId);
      res.json(await listStores(pool, jobId, cfg?.id ?? null, req.query));
    },
  };
}
