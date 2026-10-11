// Dashboard routes, mounted under /api/jobs/:id (summary and store listing).

import { Router } from 'express';
import { dashboardController } from '../controllers/dashboard.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

/** mergeParams exposes the parent :id param to the controllers. */
export function dashboardRoutes(pool) {
  const router = Router({ mergeParams: true });
  const ctrl = dashboardController(pool);
  router.get('/dashboard', asyncHandler(ctrl.summary));
  router.get('/stores', asyncHandler(ctrl.stores));
  return router;
}
