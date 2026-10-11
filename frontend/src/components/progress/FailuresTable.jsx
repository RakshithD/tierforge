// Collapsible, paginated list of failed stores with a summary of failure reasons.

import { useState } from 'react';
import { api } from '../../api/client.js';
import Pager from '../common/Pager.jsx';
import { usePolling } from '../../hooks/usePolling.js';

const PAGE_SIZE = 20;

/** Fetches failures only while expanded (`enabled: open`); keeps refreshing while the job is `running`. */
export default function FailuresTable({ jobId, total, running }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const { data, error, loading } = usePolling(
    () => api.getFailures(jobId, { page, pageSize: PAGE_SIZE }),
    5000,
    () => !running,
    [jobId, page, total],
    { enabled: open },
  );

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <section className="panel">
      <button className="link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? '▾' : '▸'} Failed stores ({total.toLocaleString()})
      </button>
      {open && (
        <>
          {error && <div className="banner error">{error.message}</div>}
          {loading && !data && <p className="muted">Loading…</p>}
          {data && (
            <>
              <h3>Reasons</h3>
              <ul>
                {data.summary.map((s) => (
                  <li key={s.error}><strong>{s.count}</strong> × {s.error}</li>
                ))}
              </ul>
              <div className="table-wrap">
              <table>
                <thead><tr><th>Store ID</th><th>Name</th><th>Attempts</th><th>Last error</th></tr></thead>
                <tbody>
                  {data.failures.map((f) => (
                    <tr key={f.store_id}>
                      <td>{f.store_id}</td><td>{f.store_name}</td><td>{f.attempts}</td><td>{f.last_error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <Pager page={page} pages={pages} onChange={setPage} />
            </>
          )}
        </>
      )}
    </section>
  );
}
