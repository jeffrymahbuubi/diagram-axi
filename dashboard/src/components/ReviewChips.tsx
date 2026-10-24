import type { ReviewRow } from '../lib/types';

/** Checker chip: "pass", the HARD codes, or "no report" when no fuzz/QA report covers the render. */
export function CheckerChip({ row }: { row: ReviewRow }) {
  if (row.checker === null) return <span className="rv-chip rv-chip--muted" title="No checker report covers this render">checker n/a</span>;
  if (row.checker.length === 0) return <span className="rv-chip rv-chip--ok" title="No HARD checker findings">checker pass</span>;
  return (
    <>
      {row.checker.map((c) => (
        <span key={c} className="rv-chip rv-chip--bad" title="HARD checker finding">
          {c}
        </span>
      ))}
    </>
  );
}

export function ReviewerChip({ row }: { row: ReviewRow }) {
  return row.accepted ? (
    <span className="rv-chip rv-chip--ok" title="Reviewer verdict V10: yes">
      accepted
    </span>
  ) : (
    <span className="rv-chip rv-chip--bad rv-chip--solid" title="Reviewer verdict V10: no">
      rejected
    </span>
  );
}

export function FailChips({ row, titles }: { row: ReviewRow; titles: Record<string, string> }) {
  return (
    <>
      {row.fails.map((f) => (
        <span key={f} className="rv-chip rv-chip--fail" title={`${f}: ${titles[f] ?? ''} (reviewer: fail)`}>
          {f}
        </span>
      ))}
    </>
  );
}

export function VisualChips({ row }: { row: ReviewRow }) {
  if (!row.visual) return null;
  const codes = [...new Set(row.visual.map((f) => f.code))];
  return (
    <>
      {codes.map((c) => (
        <span key={c} className="rv-chip rv-chip--soft" title="New SOFT visual rule fired">
          {c}
        </span>
      ))}
    </>
  );
}
