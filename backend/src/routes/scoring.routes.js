// Scoring routes, mounted under /api/jobs/:id/scoring.

import { Router } from 'express';
import { scoringController } from '../controllers/scoring.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

/** mergeParams exposes the parent :id param to the controller. */
export function scoringRoutes(pool) {
  const router = Router({ mergeParams: true });
  router.post('/', asyncHandler(scoringController(pool).run));
  return router;
}
