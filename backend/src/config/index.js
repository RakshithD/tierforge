// Central configuration: every setting is read from environment variables (via .env) with a safe local default.

import 'dotenv/config';

// Read a numeric env var, falling back to the default when unset or not a number.
const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

// Single frozen-by-convention settings object imported across the backend.
export const config = {
  databaseUrl:
    process.env.DATABASE_URL || 'postgresql://tierforge:tierforge@localhost:5433/tierforge',
  enrichmentApiUrl: process.env.ENRICHMENT_API_URL || 'http://localhost:8001',
  port: num('PORT', 8000),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  // --- Worker tuning (all overridable via env) ---
  // rateLimitPerSec: outgoing calls/sec (kept under the upstream limit of 5)
  // maxInFlight:     concurrent enrichment calls
  // requestTimeoutMs: abort a single API call after this long
  // leaseSeconds:    how long a worker owns a claimed unit before it can be reaped
  // maxAttempts:     tries per store before it is marked FAILED
  // backoffBaseMs/backoffMaxMs: retry delay range
  // breakerWindow/breakerFailureRatio: pause the job when this share of recent calls failed
  // pauseProbeMs/pauseMaxMs: how often to probe while paused, and when to give up
  rateLimitPerSec: num('RATE_LIMIT_PER_SEC', 4),
  maxInFlight: num('MAX_IN_FLIGHT', 20),
  requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 5000),
  leaseSeconds: num('LEASE_SECONDS', 15),
  maxAttempts: num('MAX_ATTEMPTS', 6),
  backoffBaseMs: num('BACKOFF_BASE_MS', 1000),
  backoffMaxMs: num('BACKOFF_MAX_MS', 30000),
  breakerWindow: num('BREAKER_WINDOW', 30),
  breakerFailureRatio: num('BREAKER_FAILURE_RATIO', 0.9),
  pauseProbeMs: num('PAUSE_PROBE_MS', 5000),
  pauseMaxMs: num('PAUSE_MAX_MS', 30 * 60 * 1000),

  maxUploadBytes: 5 * 1024 * 1024,
};
