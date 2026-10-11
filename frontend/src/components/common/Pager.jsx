// Prev/Next pagination control shared by tables.

/** `page` is 1-based; `onChange` receives the new page number. */
export default function Pager({ page, pages, onChange }) {
  return (
    <div className="row pager">
      <button className="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>Prev</button>
      <span className="muted">Page {page} of {pages}</span>
      <button className="secondary" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next</button>
    </div>
  );
}
