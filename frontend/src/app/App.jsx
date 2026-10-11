// Application shell: top bar plus the route table (upload page, per-job page, 404).

import { Link, Route, Routes } from 'react-router-dom';
import UploadPage from '../pages/UploadPage.jsx';
import JobPage from '../pages/JobPage.jsx';

/** Root layout and routes. */
export default function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="logo">T</span>
        <Link to="/" className="brand">TierForge</Link>
        <span className="muted">Bulk store scoring &amp; tiering</span>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<UploadPage />} />
          <Route path="/jobs/:id" element={<JobPage />} />
          <Route path="*" element={<p className="panel">Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}
