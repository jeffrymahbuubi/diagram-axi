import { useMemo, useState } from 'react';
import type { BakeoffScenario, EngineId } from '../lib/types';

const ENGINES: { id: EngineId; label: string }[] = [
  { id: 'excalidraw', label: 'Excalidraw (ours)' },
  { id: 'd2', label: 'D2 elk' },
  { id: 'mermaid', label: 'Mermaid' },
];
const SETS = [
  { id: 'all', label: 'All sets' },
  { id: 'realistic', label: 'Realistic' },
  { id: 'edge', label: 'Edge' },
  { id: 'fuzz', label: 'Fuzz' },
];
const STATUSES = [
  { id: 'all', label: 'All scenarios' },
  { id: 'ours-rejected', label: 'Excalidraw rejected' },
  { id: 'ours-not-best', label: 'Excalidraw not the best' },
  { id: 'any-rejected', label: 'Any engine rejected' },
  { id: 'all-rejected', label: 'All three rejected' },
  { id: 'all-accepted', label: 'All three accepted' },
];
const imgUrl = (png: string) => `${import.meta.env.BASE_URL}${png}`;

/** Side-by-side card grid: one card per scenario, three engine columns with verdicts. Island: client:visible. */
export default function BakeoffGrid({ scenarios }: { scenarios: BakeoffScenario[] }) {
  const [set, setSet] = useState('all');
  const [kind, setKind] = useState('all');
  const [best, setBest] = useState('all');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');

  const kinds = useMemo(() => [...new Set(scenarios.map((s) => s.kind))].sort(), [scenarios]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scenarios.filter((s) => {
      const acc = ENGINES.map((e) => s.engines[e.id]?.accepted ?? false);
      if (set !== 'all' && s.set !== set) return false;
      if (kind !== 'all' && s.kind !== kind) return false;
      if (best !== 'all' && s.best !== best) return false;
      if (status === 'ours-rejected' && acc[0]) return false;
      if (status === 'ours-not-best' && s.best === 'excalidraw') return false;
      if (status === 'any-rejected' && acc.every(Boolean)) return false;
      if (status === 'all-rejected' && acc.some(Boolean)) return false;
      if (status === 'all-accepted' && !acc.every(Boolean)) return false;
      if (q) {
        const hay = [s.name, s.kind, s.why, ...ENGINES.map((e) => s.engines[e.id]?.notes ?? '')].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [scenarios, set, kind, best, status, query]);

  const reset = () => {
    setSet('all');
    setKind('all');
    setBest('all');
    setStatus('all');
    setQuery('');
  };

  return (
    <div className="rv bk not-content">
      <form className="rv-filters" onSubmit={(e) => e.preventDefault()} aria-label="Bake-off filters">
        <label className="rv-field">
          <span className="rv-label">Set</span>
          <select value={set} onChange={(e) => setSet(e.target.value)}>
            {SETS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="rv-field">
          <span className="rv-label">Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">All kinds</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="rv-field">
          <span className="rv-label">Best engine</span>
          <select value={best} onChange={(e) => setBest(e.target.value)}>
            <option value="all">Any</option>
            {ENGINES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
            <option value="tie">Tie</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="rv-field">
          <span className="rv-label">Verdicts</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="rv-field rv-field--grow">
          <span className="rv-label">Search case, kind or notes</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. self-loop, cicd" />
        </label>
        <button type="button" className="rv-reset" onClick={reset}>
          Reset
        </button>
      </form>

      <p className="rv-count" role="status" aria-live="polite">
        Showing <strong>{shown.length}</strong> of {scenarios.length} scenarios. Click an image to open it full size in a new tab.
      </p>

      {shown.length === 0 ? (
        <p className="rv-empty">No scenario matches these filters.</p>
      ) : (
        <ul className="bk-list" role="list">
          {shown.map((s) => (
            <li key={s.id} id={s.id} className="bk-card">
              <header className="bk-head">
                <h3 className="rv-title">
                  {s.name} <span className="rv-dir">{s.dir}</span>
                </h3>
                <div className="rv-chips">
                  <span className="rv-chip rv-chip--muted">{s.set}</span>
                  <span className="rv-chip rv-chip--muted">{s.kind}</span>
                  <span className="rv-chip rv-chip--soft" title={s.why}>
                    best: {s.best ?? 'n/a'}
                  </span>
                </div>
                {s.why && <p className="rv-notes">{s.why}</p>}
              </header>
              <div className="bk-cols">
                {ENGINES.map((e) => {
                  const v = s.engines[e.id];
                  if (!v) return <div key={e.id} className="bk-col bk-col--empty">{e.label}: no verdict</div>;
                  return (
                    <div key={e.id} className="bk-col" data-accepted={v.accepted} data-best={s.best === e.id}>
                      <div className="bk-col-head">
                        <strong>{e.label}</strong>
                        {v.accepted ? (
                          <span className="rv-chip rv-chip--ok" title="Reviewer verdict V10: yes">accepted</span>
                        ) : (
                          <span className="rv-chip rv-chip--bad rv-chip--solid" title="Reviewer verdict V10: no">rejected</span>
                        )}
                      </div>
                      <a className="bk-thumb" href={imgUrl(v.png)} target="_blank" rel="noreferrer" aria-label={`Open ${e.label} render of ${s.name} ${s.dir} full size`}>
                        <img src={imgUrl(v.png)} alt="" loading="lazy" decoding="async" />
                      </a>
                      {(v.fails.length > 0 || v.classes.length > 0) && (
                        <div className="rv-chips">
                          {v.fails.map((f) => (
                            <span key={f} className="rv-chip rv-chip--fail" title={`${f}: reviewer fail`}>
                              {f}
                            </span>
                          ))}
                          {v.classes.map((c) => (
                            <span key={c} className="rv-chip rv-chip--soft" title="Failure class">
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="rv-notes">{v.notes}</p>
                    </div>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
