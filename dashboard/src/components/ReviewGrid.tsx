import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewRow, VCheck } from '../lib/types';
import { CheckerChip, FailChips, ReviewerChip, VisualChips } from './ReviewChips';
import RenderDialog from './RenderDialog';

type Status = 'rejected-first' | 'rejected' | 'accepted' | 'all';

const STATUSES: { id: Status; label: string }[] = [
  { id: 'rejected-first', label: 'Rejected first' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'all', label: 'All' },
];
const DIRS = ['DOWN', 'UP', 'LEFT', 'RIGHT'];

interface Props {
  rows: ReviewRow[];
  vchecks: VCheck[];
  visualRules: string[];
  setLabel: string;
  roundId: string;
  /** Engine of the round; empty for rounds without an `engine` field. */
  engine?: string;
  /** Synthetic fixture data; shows a banner. */
  fixture?: boolean;
}

const imgUrl = (png: string) => `${import.meta.env.BASE_URL}${png}`;

/** Filterable card grid of one set's renders with a full-size dialog. Island: hydrate with client:visible. */
export default function ReviewGrid({ rows, vchecks, visualRules, setLabel, roundId, engine = '', fixture = false }: Props) {
  const [status, setStatus] = useState<Status>('rejected-first');
  const [dir, setDir] = useState('all');
  const [vcheck, setVcheck] = useState('all');
  const [visual, setVisual] = useState('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const titles = useMemo(() => Object.fromEntries(vchecks.map((c) => [c.id, c.meaning])), [vchecks]);
  const rejectedCount = useMemo(() => rows.filter((r) => !r.accepted).length, [rows]);
  const analysed = useMemo(() => rows.some((r) => r.visual !== null), [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (status === 'rejected' && r.accepted) return false;
      if (status === 'accepted' && !r.accepted) return false;
      if (dir !== 'all' && r.dir !== dir) return false;
      if (vcheck === 'any' && r.fails.length === 0) return false;
      if (vcheck !== 'all' && vcheck !== 'any' && !r.fails.includes(vcheck)) return false;
      if (visual === 'any' && !(r.visual && r.visual.length)) return false;
      if (visual === 'none' && !(r.visual && r.visual.length === 0)) return false;
      if (visual !== 'all' && visual !== 'any' && visual !== 'none' && !r.visual?.some((f) => f.code === visual)) return false;
      if (q && !`${r.name} ${r.notes}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return status === 'rejected-first' ? [...list].sort((a, b) => Number(a.accepted) - Number(b.accepted)) : list;
  }, [rows, status, dir, vcheck, visual, query]);

  // deep link: #<row id> opens the full-size view
  useEffect(() => {
    const fromHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      setOpenId(rows.some((r) => r.id === id) ? id : null);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [rows]);

  const open = useCallback((id: string | null) => {
    setOpenId(id);
    const url = id ? `#${encodeURIComponent(id)}` : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', url);
  }, []);

  const openIdx = openId ? shown.findIndex((r) => r.id === openId) : -1;
  const openRow = openId ? (rows.find((r) => r.id === openId) ?? null) : null;
  const step = useCallback(
    (delta: -1 | 1) => {
      if (openIdx < 0 || !shown.length) return;
      open(shown[(openIdx + delta + shown.length) % shown.length]!.id);
    },
    [openIdx, shown, open],
  );

  const reset = () => {
    setStatus('rejected-first');
    setDir('all');
    setVcheck('all');
    setVisual('all');
    setQuery('');
  };

  return (
    <div className="rv not-content" data-round={roundId} data-engine={engine || undefined}>
      {fixture && (
        <p className="rv-empty" role="note">
          Synthetic fixture data for the dashboard check, not a real QA round.
        </p>
      )}
      <form className="rv-filters" onSubmit={(e) => e.preventDefault()} aria-label={`Filters for ${setLabel}`}>
        <div className="rv-field">
          <span className="rv-label" id="rv-status-label">
            Status
          </span>
          <div className="rv-seg" role="group" aria-labelledby="rv-status-label">
            {STATUSES.map((s) => (
              <button key={s.id} type="button" aria-pressed={status === s.id} onClick={() => setStatus(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <label className="rv-field">
          <span className="rv-label">Direction</span>
          <select value={dir} onChange={(e) => setDir(e.target.value)}>
            <option value="all">All</option>
            {DIRS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="rv-field">
          <span className="rv-label">Failed V-check</span>
          <select value={vcheck} onChange={(e) => setVcheck(e.target.value)}>
            <option value="all">Any</option>
            <option value="any">At least one</option>
            {vchecks.slice(0, 9).map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} {c.short}
              </option>
            ))}
          </select>
        </label>
        <label className="rv-field">
          <span className="rv-label">Visual rule</span>
          <select value={visual} onChange={(e) => setVisual(e.target.value)} disabled={!analysed}>
            <option value="all">{analysed ? 'Any' : 'Not analysed'}</option>
            <option value="any">Fired (any)</option>
            <option value="none">None fired</option>
            {visualRules.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="rv-field rv-field--grow">
          <span className="rv-label">Search case name or notes</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. arrowhead, cicd" />
        </label>
        <button type="button" className="rv-reset" onClick={reset}>
          Reset
        </button>
      </form>

      <p className="rv-count" role="status" aria-live="polite">
        Showing <strong>{shown.length}</strong> of {rows.length} renders in {setLabel}{engine ? <> ({engine} engine)</> : null}. Reviewer rejected {rejectedCount}.
      </p>

      {shown.length === 0 ? (
        <p className="rv-empty">No render matches these filters.</p>
      ) : (
        <ul className="rv-grid" role="list">
          {shown.map((r) => (
            <li key={r.id} id={r.id} className="rv-card" data-accepted={r.accepted}>
              <button type="button" className="rv-thumb" onClick={() => open(r.id)} aria-label={`Open ${r.name} ${r.dir} full size`}>
                <img src={imgUrl(r.svg ?? r.png)} alt="" loading="lazy" decoding="async" />
              </button>
              <div className="rv-card-body">
                <h3 className="rv-title">
                  {r.name} <span className="rv-dir">{r.dir}</span>
                </h3>
                <div className="rv-chips">
                  <CheckerChip row={r} />
                  <ReviewerChip row={r} />
                </div>
                {(r.fails.length > 0 || (r.visual && r.visual.length > 0)) && (
                  <div className="rv-chips">
                    <FailChips row={r} titles={titles} />
                    <VisualChips row={r} />
                  </div>
                )}
                <p className="rv-notes">{r.notes}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <RenderDialog row={openRow} vchecks={vchecks} imgUrl={imgUrl} onClose={() => open(null)} onStep={step} canStep={openIdx >= 0 && shown.length > 1} />
    </div>
  );
}
