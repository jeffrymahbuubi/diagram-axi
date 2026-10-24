// Aggregates a round's rows (and fuzz reports) into the numbers the overview page shows.
import fs from 'node:fs';
import { V_CHECKS } from './round.mjs';

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

function setStats(set, rows) {
  const mine = rows.filter((r) => r.set === set.id);
  const accepted = mine.filter((r) => r.accepted).length;
  const known = mine.filter((r) => r.checker !== null);
  const checkerPass = known.filter((r) => r.checker.length === 0).length;
  const fails = {};
  for (const c of V_CHECKS.slice(0, 9)) fails[c.id] = mine.filter((r) => r.fails.includes(c.id)).length;
  return {
    id: set.id, label: set.label, title: set.title, n: mine.length,
    accepted, rejected: mine.length - accepted, acceptedPct: pct(accepted, mine.length),
    checkerKnown: known.length, checkerPass, checkerPct: pct(checkerPass, known.length),
    fails,
  };
}

/** Per visual rule: how often it fires and how that lines up with the reviewer's verdict. */
function visualStats(rows, rules) {
  const analysed = rows.filter((r) => r.visual !== null);
  const rejected = analysed.filter((r) => !r.accepted);
  const perRule = rules.map((code) => {
    const fired = analysed.filter((r) => r.visual.some((f) => f.code === code));
    const firedRejected = fired.filter((r) => !r.accepted).length;
    return { code, fired: fired.length, firedRejected, firedAccepted: fired.length - firedRejected, precisionPct: pct(firedRejected, fired.length) };
  });
  const anyFired = analysed.filter((r) => r.visual.length > 0);
  const anyRejected = anyFired.filter((r) => !r.accepted).length;
  return {
    analysed: analysed.length, rejectedAnalysed: rejected.length,
    anyFired: anyFired.length, anyFiredRejected: anyRejected,
    recallPct: pct(anyRejected, rejected.length), precisionPct: pct(anyRejected, anyFired.length),
    perRule,
  };
}

function fuzzStats(round) {
  const out = [];
  for (const f of round.fuzzReports) {
    if (!fs.existsSync(f.file)) continue;
    const rep = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    out.push({
      id: f.id, label: f.label, summary: rep.summary ?? {},
      profiles: (rep.profiles ?? []).map((p) => ({ profile: p.profile, renders: p.renders, passed: p.passed, passRate: p.passRate, topCode: p.topCode || '', gated: p.gated !== false })),
      byCode: (rep.byCode ?? []).filter((c) => c.severity === 'hard').map((c) => ({ code: c.code, count: c.count, cases: c.cases })),
    });
  }
  return out;
}

export function roundStats(round, rows, cfg) {
  const sets = cfg.kit.sets.map((s) => setStats(s, rows));
  const total = rows.length;
  const accepted = rows.filter((r) => r.accepted).length;
  const known = rows.filter((r) => r.checker !== null);
  const checkerPass = known.filter((r) => r.checker.length === 0).length;
  const fails = {};
  for (const c of V_CHECKS.slice(0, 9)) fails[c.id] = rows.filter((r) => r.fails.includes(c.id)).length;
  return {
    id: round.id, label: round.label, engine: round.engine ?? null, fixture: Boolean(round.fixture), total, accepted, rejected: total - accepted, acceptedPct: pct(accepted, total),
    checkerKnown: known.length, checkerPass, checkerPct: pct(checkerPass, known.length),
    fails, sets,
    visual: visualStats(rows, cfg.kit.visualRules ?? []),
    fuzz: fuzzStats(round),
  };
}
