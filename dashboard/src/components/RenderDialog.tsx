import { useEffect, useRef, useState } from 'react';
import type { ReviewRow, VCheck } from '../lib/types';
import { CheckerChip, ReviewerChip, VisualChips } from './ReviewChips';

interface Props {
  row: ReviewRow | null;
  vchecks: VCheck[];
  imgUrl: (png: string) => string;
  onClose: () => void;
  onStep: (delta: -1 | 1) => void;
  canStep: boolean;
}

/** Full-size view of one render: image (fit or actual size), all V verdicts, notes and rule findings. */
export default function RenderDialog({ row, vchecks, imgUrl, onClose, onStep, canStep }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [actual, setActual] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (row && !d.open) d.showModal();
    if (!row && d.open) d.close();
    setActual(false);
  }, [row]);

  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (!canStep || (e.target as HTMLElement)?.closest('button, input, select')) return;
      if (e.key === 'ArrowLeft') onStep(-1);
      if (e.key === 'ArrowRight') onStep(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [row, canStep, onStep]);

  return (
    <dialog
      ref={ref}
      className="rv-dialog"
      aria-label={row ? `${row.name} ${row.dir}` : 'Render'}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {row && (
        <div className="rv-dialog-body">
          <header className="rv-dialog-head">
            <h3>
              {row.name} <span className="rv-dir">{row.dir}</span>
            </h3>
            <div className="rv-chips">
              <CheckerChip row={row} />
              <ReviewerChip row={row} />
            </div>
            <div className="rv-dialog-actions">
              {canStep && (
                <>
                  <button type="button" onClick={() => onStep(-1)} aria-label="Previous render">
                    Prev
                  </button>
                  <button type="button" onClick={() => onStep(1)} aria-label="Next render">
                    Next
                  </button>
                </>
              )}
              <button type="button" onClick={() => setActual((a) => !a)} aria-pressed={actual}>
                {actual ? 'Fit to window' : 'Actual size'}
              </button>
              <button type="button" onClick={onClose} className="rv-close">
                Close
              </button>
            </div>
          </header>

          <div className={`rv-dialog-img${actual ? ' is-actual' : ''}`}>
            <img src={imgUrl(row.png)} alt={`Render of ${row.name} laid out ${row.dir}`} />
          </div>

          <div className="rv-dialog-meta">
            <section>
              <h4>Reviewer notes</h4>
              <p className="rv-notes-full">{row.notes || 'No notes.'}</p>
            </section>
            <section>
              <h4>Reviewer verdicts</h4>
              <ul className="rv-vlist">
                {vchecks.map((c) => (
                  <li key={c.id} data-verdict={row.v[c.id]}>
                    <strong>{c.id}</strong> <span className="rv-vmeaning">{c.meaning}</span>
                    <span className="rv-vval">{row.v[c.id]}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h4>Checker and rules</h4>
              <p>
                HARD checker: <CheckerChip row={row} />
              </p>
              {row.visual === null ? (
                <p className="rv-muted">New SOFT visual rules: scene not analysed (analyzer or .excalidraw missing).</p>
              ) : row.visual.length === 0 ? (
                <p>New SOFT visual rules: none fired.</p>
              ) : (
                <>
                  <p>
                    New SOFT visual rules: <VisualChips row={row} />
                  </p>
                  <ul className="rv-findings">
                    {row.visual.map((f, i) => (
                      <li key={`${f.code}-${i}`}>
                        <code>{f.code}</code> {f.detail}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {row.softLegacy.length > 0 && <p className="rv-muted">Other SOFT codes in the report: {row.softLegacy.join(', ')}</p>}
            </section>
          </div>
        </div>
      )}
    </dialog>
  );
}
