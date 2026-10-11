// Thin fetch-based client for the TierForge backend API, with normalized error handling.

// API origin; override with VITE_API_URL at build time.
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// Error from the backend's { error: { code, message, details } } shape, with the HTTP status (0 = network failure).
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details || [];
  }
}

// fetch wrapper: parses JSON and throws ApiError for network failures and non-2xx responses.
async function request(path, options) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, options);
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'Cannot reach the API server' } });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

// Build a query string, dropping empty values and the UI's 'All' filter placeholder.
const qs = (params) => {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '' && v !== 'All') u.set(k, v);
  });
  const s = u.toString();
  return s ? `?${s}` : '';
};

// One method per backend endpoint; list endpoints take filter/pagination params.
export const api = {
  uploadJob(file) {
    const form = new FormData();
    form.append('file', file);
    return request('/api/jobs', { method: 'POST', body: form });
  },
  getJob: (id) => request(`/api/jobs/${id}`),
  getFailures: (id, params) => request(`/api/jobs/${id}/failures${qs(params)}`),
  getDashboard: (id) => request(`/api/jobs/${id}/dashboard`),
  getStores: (id, params) => request(`/api/jobs/${id}/stores${qs(params)}`),
  runScoring: (id, cfg) =>
    request(`/api/jobs/${id}/scoring`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    }),
};
