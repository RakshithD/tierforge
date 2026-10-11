// PostgreSQL connection pool shared by the API and the worker.

import pg from 'pg';
import { config } from '../config/index.js';

// NUMERIC -> JS number (revenue fits comfortably in a double).
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

// Factory so tests can create a pool against a separate database.
export function createPool(connectionString = config.databaseUrl) {
  return new pg.Pool({ connectionString, max: 10 });
}

// Default app-wide pool, created once at import time.
export const pool = createPool();
