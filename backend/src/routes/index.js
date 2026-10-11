// Route aggregator: mounts each feature router under /api.

import { Router } from 'express';
import { jobsRoutes } from './jobs.routes.js';
import { scoringRoutes } from './scoring.routes.js';
import { dashboardRoutes } from './dashboard.routes.js';

/** All REST routes, mounted under /api by the app. */
export function apiRoutes(pool) {
  const router = Router();
  router.use('/jobs', jobsRoutes(pool));
  router.use('/jobs/:id/scoring', scoringRoutes(pool));
  // Mounted last so the more specific /jobs/:id/scoring path is matched first.
  router.use('/jobs/:id', dashboardRoutes(pool));
  return router;
}
