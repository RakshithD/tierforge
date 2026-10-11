// Scoring controller: validates a scoring config and runs scoring for a job.

import { HttpError } from '../middleware/errorHandler.js';
import { getJob, parseJobId } from '../services/jobService.js';
import { runScoring, tierBreakdown, validateScoringConfig } from '../services/scoringService.js';

/** Build scoring request handlers bound to the given DB pool. */
export function scoringController(pool) {
  return {
    // POST /api/jobs/:id/scoring: validate the config, score the job's stores and return the tier counts.
    async run(req, res) {
      const jobId = parseJobId(req.params.id);
      await getJob(pool, jobId);
      const { value, errors } = validateScoringConfig(req.body);
      if (errors.length) {
        throw new HttpError(400, 'INVALID_SCORING_CONFIG', 'Invalid scoring configuration', errors);
      }
      const started = Date.now();
      const configId = await runScoring(pool, jobId, value);
      res.status(201).json({
        config_id: configId,
        tiers: await tierBreakdown(pool, jobId, configId),
        duration_ms: Date.now() - started,
      });
    },
  };
}
