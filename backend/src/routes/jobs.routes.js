// Job routes: CSV upload (multipart), job progress and failure listing.

import { Router } from 'express';
import multer from 'multer';
import { config } from '../config/index.js';
import { jobsController } from '../controllers/jobs.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

/** Routes mounted at /api/jobs. */
export function jobsRoutes(pool) {
  const router = Router();
  const ctrl = jobsController(pool);
  // Keep uploads in memory (no temp files); size capped and a single file only.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });

  router.post('/', upload.single('file'), asyncHandler(ctrl.create));
  router.get('/:id', asyncHandler(ctrl.get));
  router.get('/:id/failures', asyncHandler(ctrl.failures));
  return router;
}
