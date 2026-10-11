// Scoring configuration form: per-metric bars and weights plus tier thresholds, validated client-side before submitting.

import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';

// Initial values, used until the job's saved config loads.
const DEFAULTS = {
  footfall_bar: 15000, footfall_weight: 50,
  revenue_bar: 150000, revenue_weight: 30,
  size_bar: 8000, size_weight: 20,
  large_threshold: 70, medium_threshold: 40,
};

// [label, bar field, weight field] for each metric row.
const ROWS = [
  ['Footfall', 'footfall_bar', 'footfall_weight'],
  ['Revenue', 'revenue_bar', 'revenue_weight'],
  ['Size (sqft)', 'size_bar', 'size_weight'],
];

/** Validates inputs (weights sum to 100, thresholds ordered) and posts the config; `onScored` fires after success. */
export default function ScoringForm({ jobId, initial, onScored }) {
  const [form, setForm] = useState(DEFAULTS);
  const [seeded, setSeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);

  // Pre-fill from the latest saved config once.
  useEffect(() => {
    if (initial && !seeded) {
      setForm(Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, initial[k]])));
      setSeeded(true);
    }
  }, [initial, seeded]);

  // Form helpers: `set` updates a field, `num` parses it (empty -> NaN so validation fails).
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const num = (k) => (form[k] === '' ? NaN : Number(form[k]));
  const total = num('footfall_weight') + num('revenue_weight') + num('size_weight');
  const thresholdsOk = Number.isInteger(num('large_threshold')) && Number.isInteger(num('medium_threshold')) &&
    num('medium_threshold') >= 0 && num('large_threshold') <= 100 && num('medium_threshold') <= num('large_threshold');
  const barsOk = ROWS.every(([, bar, w]) => num(bar) >= 0 && num(w) >= 0 && num(w) <= 100);
  // Mirrors the backend rules so invalid configs are blocked before a request is made.
  const valid = total === 100 && thresholdsOk && barsOk;

  // Convert string inputs to numbers and run scoring (recomputed server-side from stored data, no API calls).
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, Number(form[k])]));
      const res = await api.runScoring(jobId, payload);
      setLast(res);
      onScored(res);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="scoring">
      <table>
        <thead><tr><th>Metric</th><th>Bar (≥)</th><th>Weight</th></tr></thead>
        <tbody>
          {ROWS.map(([label, bar, weight]) => (
            <tr key={bar}>
              <td>{label}</td>
              <td><input type="number" min="0" aria-label={`${label} bar`} value={form[bar]} onChange={set(bar)} /></td>
              <td><input type="number" min="0" max="100" aria-label={`${label} weight`} value={form[weight]} onChange={set(weight)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <label>Large ≥ <input type="number" min="0" max="100" value={form.large_threshold} onChange={set('large_threshold')} /></label>
        <label>Medium ≥ <input type="number" min="0" max="100" value={form.medium_threshold} onChange={set('medium_threshold')} /></label>
        <span className={total === 100 ? 'good' : 'bad'}>Weights total: {Number.isNaN(total) ? '—' : total} / 100</span>
        <div className={`weights-meter ${total === 100 ? 'ok' : total > 100 ? 'over' : ''}`} style={{ flexBasis: '100%' }}><div style={{ width: `${Math.min(100, Number.isNaN(total) ? 0 : total)}%` }} /></div>
        {!thresholdsOk && <span className="bad">Need 0 ≤ medium ≤ large ≤ 100</span>}
      </div>
      <div className="row">
        <button type="submit" disabled={!valid || busy}>{busy ? 'Scoring…' : 'Apply scoring'}</button>
        {last && <span className="muted">Scored in {last.duration_ms} ms (no API calls)</span>}
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error.message}
          {error.details.length > 0 && (
            <ul>{error.details.map((d, i) => <li key={i}>{d.field}: {d.message}</li>)}</ul>
          )}
        </div>
      )}
    </form>
  );
}
