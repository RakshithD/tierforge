// Tier distribution bar and clickable per-tier count cards that double as filters.

// Tier buckets in display order.
const CARDS = ['Large', 'Medium', 'Small', 'unscored'];

/** Renders counts per tier; clicking a card selects it as the filter, clicking again clears it. */
export default function TierSummary({ tiers, active, onSelect }) {
  if (!tiers) return null;
  const total = CARDS.reduce((a, t) => a + (tiers[t] ?? 0), 0) || 1;
  return (
    <>
    <div className="dist" aria-hidden="true">
      {CARDS.map((t) => <span key={t} className={`d-${t}`} style={{ width: `${((tiers[t] ?? 0) / total) * 100}%` }} />)}
    </div>
    <div className="cards">
      {CARDS.map((t) => (
        <button
          key={t}
          className={`card tier-${t.toLowerCase()} ${active === t ? 'active' : ''}`}
          onClick={() => onSelect(active === t ? 'All' : t)}
          aria-pressed={active === t}
        >
          <div className="stat-n">{(tiers[t] ?? 0).toLocaleString()}</div>
          <div>{t === 'unscored' ? 'Unscored' : t} <span className="muted">· {Math.round(((tiers[t] ?? 0) / total) * 100)}%</span></div>
        </button>
      ))}
    </div>
    </>
  );
}
