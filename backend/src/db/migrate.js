// Schema migration: applies sql/schema.sql on startup or as a standalone CLI step.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolve schema.sql relative to this file so it works regardless of the current working directory.
const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sql/schema.sql');

// Apply sql/schema.sql. Every statement is IF NOT EXISTS, so it is safe to run on every startup.
export async function migrate(db) {
  const sql = await readFile(schemaPath, 'utf8');
  await db.query(sql);
}

// Allow running directly (`node migrate.js`) as a standalone CLI step.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool } = await import('./pool.js');
  await migrate(pool);
  console.log('schema applied');
  await pool.end();
}
