// Upload page: pick or drop a CSV, create a job via the API and navigate to its page.

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';

/** CSV dropzone + submit form; shows server-side validation errors (per-row details) on failure. */
export default function UploadPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  // Upload the file; on success go to the new job, otherwise show the error and re-enable the form.
  async function submit(e) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const job = await api.uploadJob(file);
      navigate(`/jobs/${job.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2><span className="step">1</span> Upload stores</h2>
      <p className="muted">
        CSV with columns: <code>store_id, store_name, address, city, state, country</code> (max 5 MB).
      </p>
      <form onSubmit={submit}>
        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          role="button"
          aria-label="Choose a CSV file to upload"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (e.dataTransfer.files[0]) { setFile(e.dataTransfer.files[0]); setError(null); }
          }}
        >
          <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files[0] || null); setError(null); }} />
          {file ? (
            <span className="file-chip">{file.name} · {(file.size / 1024).toFixed(1)} KB</span>
          ) : (
            <>
              <div className="big">Drop your CSV here or click to browse</div>
              <div className="muted">.csv, up to 5 MB</div>
            </>
          )}
        </div>
        <div className="row">
          <button type="submit" disabled={!file || busy}>{busy ? 'Uploading…' : 'Create job'}</button>
          {file && !busy && <button type="button" className="secondary" onClick={() => setFile(null)}>Clear</button>}
        </div>
      </form>
      {error && (
        <div className="banner error" role="alert">
          <strong>{error.message}</strong>
          {error.details.length > 0 && (
            <ul>
              {error.details.map((d, i) => (
                <li key={i}>
                  {d.row !== undefined ? `Row ${d.row}: ${d.message}` : `${d.field}: ${d.problem}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
