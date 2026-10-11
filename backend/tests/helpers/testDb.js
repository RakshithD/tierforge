import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';

const TEST_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://tierforge:tierforge@localhost:5433/tierforge_test';

async function tryConnect(url) {
  const p = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 1500 });
  try {
    await p.query('SELECT 1');
    return p;
  } catch {
    await p.end().catch(() => {});
    return null;
  }
}

/** Returns a migrated pool, or null when no Postgres is reachable (DB tests then skip). */
export async function openTestDb() {
  let p = await tryConnect(TEST_URL);
  if (!p) {
    const u = new URL(TEST_URL);
    const dbName = u.pathname.slice(1);
    u.pathname = '/postgres';
    const admin = await tryConnect(u.toString());
    if (!admin) return null;
    await admin.query(`CREATE DATABASE "${dbName}"`).catch(() => {});
    await admin.end();
    p = await tryConnect(TEST_URL);
    if (!p) return null;
  }
  await migrate(p);
  return p;
}

export async function resetDb(p) {
  await p.query('TRUNCATE jobs RESTART IDENTITY CASCADE');
}

export function fakeStores(n) {
  return Array.from({ length: n }, (_, i) => ({
    store_id: `S${i + 1}`,
    store_name: `Store ${i + 1}`,
    address: `${i + 1} Main St`,
    city: 'Austin',
    state: 'TX',
    country: 'US',
  }));
}
