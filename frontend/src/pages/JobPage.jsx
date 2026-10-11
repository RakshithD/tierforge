// Job detail page: live enrichment progress, failures, scoring configuration, tier summary and store list.

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { usePolling } from '../hooks/usePolling.js';
import ProgressPanel from '../components/progress/ProgressPanel.jsx';
import FailuresTable from '../components/progress/FailuresTable.jsx';
import ScoringForm from '../components/scoring/ScoringForm.jsx';
import TierSummary from '../components/scoring/TierSummary.jsx';
import StoresTable from '../components/stores/StoresTable.jsx';

// Job statuses after which nothing changes, so polling can stop.
const TERMINAL = ['COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED'];

/** Polls the job (2s) and dashboard (5s) and composes the panels; `version` forces refetches after scoring. */
export default function JobPage() {
  const { id } = useParams();
  const [tier, setTier] = useState('All');
  const [version, setVersion] = useState(0); // bumped after each scoring run

  const job = usePolling(() => api.getJob(id), 2000, (j) => TERMINAL.includes(j.status), [id]);
  const dash = usePolling(
    () => api.getDashboard(id),
    5000,
    (d) => TERMINAL.includes(d.progress.status),
    [id, version],
  );

  if (job.error && !job.data) {
    return <div className="banner error">{job.error.message}</div>;
  }
  if (!job.data) return <p className="panel">Loading…</p>;

  const running = !TERMINAL.includes(job.data.status);

  return (
    <>
      <ProgressPanel job={job.data} />
      {job.data.failed > 0 && <FailuresTable jobId={id} total={job.data.failed} running={running} />}

      <section className="panel">
        <h2><span className="step">3</span> Scoring &amp; tiers</h2>
        <ScoringForm
          jobId={id}
          initial={dash.data?.config}
          onScored={() => {
            setVersion((v) => v + 1);
          }}
        />
        <TierSummary tiers={dash.data?.tiers} active={tier} onSelect={setTier} />
        <StoresTable
          jobId={id}
          tier={tier}
          onTierChange={setTier}
          version={version}
          running={running}
        />
      </section>
    </>
  );
}
