// Dropdown for filtering the store list by tier.

const OPTIONS = ['All', 'Large', 'Medium', 'Small', 'unscored'];

/** Controlled tier selector; "unscored" matches stores with no tier yet. */
export default function TierFilter({ value, onChange }) {
  return (
    <label>
      Tier{' '}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {OPTIONS.map((o) => <option key={o} value={o}>{o === 'unscored' ? 'Unscored' : o}</option>)}
      </select>
    </label>
  );
}
