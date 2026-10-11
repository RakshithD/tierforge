// Process entry point: applies the DB schema, builds the app and starts the HTTP server.

import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';

await migrate(pool);
const app = createApp(pool);
const server = app.listen(config.port, () => {
  console.log(`TierForge API listening on :${config.port}`);
});

// Graceful shutdown: stop accepting connections, then close the DB pool.
const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
