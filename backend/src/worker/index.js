// Worker process entrypoint: migrates the DB, then runs the engine until signalled to stop.
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { createEngine } from './engine.js';

// Worker entrypoint: runs separately from the API server and polls the DB for jobs.
await migrate(pool);
// SIGINT/SIGTERM set a flag so the engine finishes in-flight work before exiting.
let stopping = false;
const stop = () => {
  stopping = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(`[worker] started; enrichment API at ${config.enrichmentApiUrl}`);
await createEngine({ db: pool, config }).runForever(() => stopping);
await pool.end();
