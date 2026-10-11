// Progress panel: status banner, progress bar, counts, elapsed time and ETA for a job.

import { useEffect, useState } from 'react';
import { formatDuration as fmt } from '../../utils/format.js';

// User-facing text for each job status.
const LABELS = {
  PENDING: 'Waiting for worker',
  RUNNING: 'Enriching stores',
  PAUSED: 'Paused — waiting for the enrichment API to recover (will resume automatically)',
  COMPLETED: 'Completed',
  COMPLETED_WITH_FAILURES: 'Completed with failures',
  FAILED: 'Failed',
};

/** Shows job progress; ticks a local clock each second until the job finishes so elapsed time stays live. */
export default function ProgressPanel({ job }) {
  const [now, setNow] = useState(Date.now());
  const finished = job.finished_at;
  useEffect(() => {
    if (finished) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [finished]);

  const start = job.started_at ? new Date(job.started_at).getTime() : null;
  const end = finished ? new Date(finished).getTime() : now;
  const c = job.counts;
  const processed = c.SUCCESS + c.FAILED;
  const elapsedMs = start ? end - start : 0;
  // ETA extrapolates from the average rate so far; withheld until >5 units are done to avoid wild estimates.
  const etaMs = !finished && processed > 5 && elapsedMs > 0 ? ((job.total - processed) * elapsedMs) / processed : null;

  return (
    <section className="panel">
      <h2><span className="step">2</span> Enrichment progress <span className="muted">· job #{job.id} · {job.filename}</span></h2>
      <div className={`banner ${job.status === 'FAILED' ? 'error' : job.status === 'PAUSED' ? 'info' : job.status.startsWith('COMPLETED') ? 'ok' : 'info'}`}>
        <strong>{job.status === 'RUNNING' && <span className="pulse" />}{LABELS[job.status] || job.status}</strong>
        {job.failure_reason && <span> — {job.failure_reason}</span>}
      </div>
      <div className="bar" role="progressbar" aria-label="Enrichment progress" aria-valuenow={job.percent_complete} aria-valuemin={0} aria-valuemax={100}>
        <div className={`bar-fill ${job.status === 'FAILED' ? 'failed' : job.status.startsWith('COMPLETED') ? 'done' : ''}`} style={{ width: `${job.percent_complete}%` }} />
      </div>
      <p className="muted">{job.percent_complete}% · {c.SUCCESS + c.FAILED} of {job.total} processed{start ? ` · elapsed ${fmt(elapsedMs)}` : ''}{etaMs ? ` · ~${fmt(etaMs)} left` : ''}</p>
      <div className="stats">
        <Stat label="Enriched" value={c.SUCCESS} cls="good" />
        <Stat label="Failed" value={c.FAILED} cls="bad" />
        <Stat label="Pending" value={c.PENDING} />
        <Stat label="In progress" value={c.IN_PROGRESS} />
      </div>
    </section>
  );
}

/** A single count tile. */
function Stat({ label, value, cls = '' }) {
  return (
    <div className={`stat ${cls}`}>
      <div className="stat-n">{value.toLocaleString()}</div>
      <div className="muted">{label}</div>
    </div>
  );
}
