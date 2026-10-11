// Jobs controller: CSV upload to create a job, plus progress and failure reporting.

import { HttpError } from '../middleware/errorHandler.js';
import { parseStoresCsv } from '../services/csvService.js';
import { createJob, getFailures, getProgress, parseJobId } from '../services/jobService.js';

/** Build job request handlers bound to the given DB pool. */
export function jobsController(pool) {
  return {
    // POST /api/jobs: validate the upload, parse the CSV and create the job. The worker picks it up later.
    async create(req, res) {
      if (!req.file) throw new HttpError(400, 'NO_FILE', 'Attach a CSV file in the "file" field');
      if (!/\.csv$/i.test(req.file.originalname)) {
        throw new HttpError(400, 'INVALID_FILE_TYPE', 'Only .csv files are accepted');
      }
      const stores = parseStoresCsv(req.file.buffer);
      const jobId = await createJob(pool, req.file.originalname, stores);
      res.status(201).json({ id: jobId, total: stores.length, status: 'PENDING' });
    },

    // GET /api/jobs/:id: live progress.
    async get(req, res) {
      res.json(await getProgress(pool, parseJobId(req.params.id)));
    },

    // GET /api/jobs/:id/failures: failed stores and error summary.
    async failures(req, res) {
      res.json(await getFailures(pool, parseJobId(req.params.id), req.query));
    },
  };
}
