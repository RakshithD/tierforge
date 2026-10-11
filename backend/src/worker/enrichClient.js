// HTTP client for the enrichment API: calls POST /enrich and classifies every outcome as
// success, retryable failure or permanent failure so the engine never has to handle exceptions.

// Transient HTTP statuses worth retrying; any other non-200 is treated as a permanent rejection.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Retry-After header (seconds) -> milliseconds, or null if absent/invalid.
function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  return Number.isFinite(secs) && secs >= 0 ? Math.round(secs * 1000) : null;
}

/**
 * Validate a 200 body. Every metric must be a finite, non-negative number.
 * Footfall and size are rounded because they are stored as integers.
 * Returns { footfall, revenue, size_sqft } or null if malformed.
 */
export function parseEnrichment(body) {
  if (!body || typeof body !== 'object') return null;
  const footfall = body.estimated_monthly_footfall;
  const revenue = body.estimated_monthly_revenue;
  const size_sqft = body.store_size_sqft;
  for (const v of [footfall, revenue, size_sqft]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  }
  return { footfall: Math.round(footfall), revenue, size_sqft: Math.round(size_sqft) };
}

/**
 * Classify an HTTP status + body into a result. Pure, for unit tests.
 *   ok: true                    -> usable data
 *   ok: false, retryable: true  -> transient (429/5xx); retry later, honouring Retry-After on 429
 *   ok: false, retryable: false -> permanent (4xx or malformed 200 body); do not retry
 */
export function classifyResponse(status, body, retryAfterHeader) {
  if (status === 200) {
    const data = parseEnrichment(body);
    return data
      ? { ok: true, data }
      : { ok: false, retryable: false, error: 'invalid response: malformed enrichment body' };
  }
  if (RETRYABLE_STATUS.has(status)) {
    return {
      ok: false,
      retryable: true,
      error: status === 429 ? 'rate limited (429)' : `server error (${status})`,
      retryAfterMs: status === 429 ? parseRetryAfter(retryAfterHeader) : null,
    };
  }
  return { ok: false, retryable: false, error: `request rejected (HTTP ${status})` };
}

/** Call POST /enrich with an abort timeout. Never throws. `country` is deliberately not sent. */
export async function callEnrich(store, { baseUrl, timeoutMs, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/enrich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store_id: store.store_id,
        store_name: store.store_name,
        address: store.address,
        city: store.city,
        state: store.state,
      }),
      signal: controller.signal,
    });
    // Only parse JSON on 200; otherwise drain the body so the connection can be reused.
    let body = null;
    if (res.status === 200) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    } else {
      await res.arrayBuffer().catch(() => {});
    }
    return classifyResponse(res.status, body, res.headers.get('retry-after'));
  } catch (err) {
    // fetch threw: either our timeout aborted it or the network failed. Both are retryable.
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      retryable: true,
      error: timedOut ? `timeout after ${timeoutMs}ms` : `network error: ${err.cause?.code || err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
