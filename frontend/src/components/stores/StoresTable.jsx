// Stores table: server-side filtering (tier, status, name search), sorting and pagination, auto-refreshing while the job runs.

import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { usePolling } from '../../hooks/usePolling.js';
import TierFilter from './TierFilter.jsx';
import Pager from '../common/Pager.jsx';

const PAGE_SIZE = 25;
// [sort key, header label] for each column.
const COLUMNS = [
  ['store_name', 'Name'], ['city', 'City / State'], ['footfall', 'Footfall'], ['revenue', 'Revenue'],
  ['size_sqft', 'Size'], ['score', 'Score'], ['tier', 'Tier'], ['status', 'Status'], ['last_error', 'Failure reason'],
];
// Right-aligned numeric columns.
const NUMERIC = new Set(['footfall', 'revenue', 'size_sqft', 'score']);
// Columns the backend can sort by.
const SORTABLE = new Set(['store_name', 'footfall', 'revenue', 'size_sqft', 'score', 'tier', 'status']);

/** Returns `value` only after it has stopped changing for `ms` (avoids a request per keystroke). */
function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Fetches one page of stores for the job; any filter/sort change resets to page 1. */
export default function StoresTable({ jobId, tier, onTierChange, version, running }) {
  const [status, setStatus] = useState('All');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('store_id:asc');
  const q = useDebounced(search, 300);

  useEffect(() => setPage(1), [tier, status, q, sort]);

  const { data, error, loading } = usePolling(
    () => api.getStores(jobId, { tier, status, q, sort, page, pageSize: PAGE_SIZE }),
    5000,
    () => !running,
    [jobId, tier, status, q, sort, page, version, running],
  );

  // Clicking a header sorts ascending, clicking it again flips to descending.
  const toggleSort = (key) => {
    if (!SORTABLE.has(key)) return;
    setSort((s) => (s === `${key}:asc` ? `${key}:desc` : `${key}:asc`));
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="stores">
      <div className="row filters">
        <TierFilter value={tier} onChange={onTierChange} />
        <label>
          Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['All', 'SUCCESS', 'FAILED', 'PENDING', 'IN_PROGRESS'].map((s) => <option key={s} value={s}>{s === 'IN_PROGRESS' ? 'In progress' : s === 'All' ? s : s[0] + s.slice(1).toLowerCase()}</option>)}
          </select>
        </label>
        <input type="search" aria-label="Search store name" placeholder="Search store name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {data && <span className="muted">{data.total.toLocaleString()} stores</span>}
      </div>
      {error && <div className="banner error">{error.message}</div>}
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {COLUMNS.map(([key, label]) => (
              <th key={key} className={`${SORTABLE.has(key) ? 'sortable' : ''} ${NUMERIC.has(key) ? 'num' : ''}`} onClick={() => toggleSort(key)}
                tabIndex={SORTABLE.has(key) ? 0 : undefined}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleSort(key))}
                aria-sort={sort.startsWith(`${key}:`) ? (sort.endsWith('asc') ? 'ascending' : 'descending') : undefined}>
                {label}{sort.startsWith(`${key}:`) ? (sort.endsWith('asc') ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && !data && <tr><td colSpan={9}><div className="skeleton" /></td></tr>}
          {data && data.stores.length === 0 && <tr><td colSpan={9} className="empty">No stores match these filters.</td></tr>}
          {data?.stores.map((s) => (
            <tr key={s.store_id} title={s.last_error || undefined}>
              <td>{s.store_name}</td>
              <td>{[s.city, s.state].filter(Boolean).join(', ')}</td>
              <td className="num">{s.footfall?.toLocaleString() ?? '—'}</td>
              <td className="num">{s.revenue?.toLocaleString() ?? '—'}</td>
              <td className="num">{s.size_sqft?.toLocaleString() ?? '—'}</td>
              <td className="num">{s.score ?? '—'}</td>
              <td>{s.tier ? <span className={`pill tier-${s.tier.toLowerCase()}`}>{s.tier}</span> : <span className="muted">unscored</span>}</td>
              <td><span className={`chip ${s.status}`}>{s.status.replace('_', ' ')}</span></td>
              <td className={s.status === 'FAILED' ? 'bad' : 'muted'}>{s.status === 'FAILED' ? s.last_error || 'unknown error' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <Pager page={page} pages={pages} onChange={setPage} />
    </div>
  );
}
