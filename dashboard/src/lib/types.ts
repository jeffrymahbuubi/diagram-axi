export type Verdict = 'pass' | 'fail' | 'n-a' | 'yes' | 'no';

/** One rendered PNG with its reviewer verdicts, checker result and visual-rule findings (written by scripts/gen-pages.mjs). */
export interface ReviewRow {
  /** Anchor id, `<case>-<DIR>`; unique within a round. */
  id: string;
  round: string;
  /** Engine of the round (excalidraw, d2, mermaid) or null for rounds without an `engine` field. */
  engine: string | null;
  set: string;
  name: string;
  dir: 'DOWN' | 'UP' | 'LEFT' | 'RIGHT';
  /** Path under public/, e.g. review/round-3/qa/x.png (join with BASE_URL). */
  png: string;
  /** Optional vector twin of the PNG (same name, .svg), used for thumbnails; null when absent. */
  svg: string | null;
  v: Record<string, Verdict>;
  /** V1..V9 that the reviewer marked fail. */
  fails: string[];
  /** Reviewer verdict V10. */
  accepted: boolean;
  notes: string;
  /** HARD checker codes; empty = pass; null = no report covers this render. */
  checker: string[] | null;
  /** New SOFT visual-rule findings; null = scene not analysed (analyzer or .excalidraw missing). */
  visual: { code: string; detail: string }[] | null;
  /** Other SOFT codes recorded by the original report (aspect-ratio, arrow-crossings, ...). */
  softLegacy: string[];
}

export interface VCheck {
  id: string;
  short: string;
  meaning: string;
}

export interface SetStats {
  id: string;
  label: string;
  title: string;
  n: number;
  accepted: number;
  rejected: number;
  acceptedPct: number | null;
  checkerKnown: number;
  checkerPass: number;
  checkerPct: number | null;
  fails: Record<string, number>;
}

export interface FuzzProfile {
  profile: string;
  renders: number;
  passed: number;
  passRate: number;
  topCode: string;
  gated: boolean;
}

export interface FuzzReport {
  id: string;
  label: string;
  summary: Record<string, number | string | string[] | boolean>;
  profiles: FuzzProfile[];
  byCode: { code: string; count: number; cases: number }[];
}

export interface VisualRuleStats {
  code: string;
  fired: number;
  firedRejected: number;
  firedAccepted: number;
  precisionPct: number | null;
}

export interface RoundStats {
  id: string;
  label: string;
  engine: string | null;
  /** True when the round was read from synthetic test-fixtures/ (never real QA data). */
  fixture: boolean;
  total: number;
  accepted: number;
  rejected: number;
  acceptedPct: number | null;
  checkerKnown: number;
  checkerPass: number;
  checkerPct: number | null;
  fails: Record<string, number>;
  sets: SetStats[];
  visual: {
    analysed: number;
    rejectedAnalysed: number;
    anyFired: number;
    anyFiredRejected: number;
    recallPct: number | null;
    precisionPct: number | null;
    perRule: VisualRuleStats[];
  };
  fuzz: FuzzReport[];
}

export interface Meta {
  siteTitle: string;
  vchecks: VCheck[];
  visualRules: string[];
  sets: { id: string; label: string; title: string }[];
  rounds: { id: string; label: string; engine: string | null; fixture: boolean }[];
  skippedRounds: { id: string; label: string }[];
  analyzerLoaded: boolean;
}

/** Three-engine bake-off (scripts/gen-bakeoff.mjs). */
export type EngineId = 'excalidraw' | 'd2' | 'mermaid';

export interface BakeoffEngineVerdict {
  /** Path under public/, e.g. bakeoff/d2/<id>.png (join with BASE_URL). */
  png: string;
  v: Record<string, Verdict>;
  /** V1..V9 the reviewer marked fail. */
  fails: string[];
  accepted: boolean;
  classes: string[];
  notes: string;
}

export interface BakeoffScenario {
  id: string;
  name: string;
  set: 'realistic' | 'edge' | 'fuzz';
  dir: 'DOWN' | 'UP' | 'LEFT' | 'RIGHT';
  kind: string;
  best: EngineId | 'tie' | 'none' | null;
  why: string;
  engines: Partial<Record<EngineId, BakeoffEngineVerdict>>;
}

export interface BakeoffEngineStats {
  label: string;
  n: number;
  accepted: number;
  pct: number | null;
  sets: Record<string, { n: number; accepted: number; pct: number | null }>;
  fails: Record<string, number>;
  classes: Record<string, number>;
  rejectedClasses: Record<string, number>;
}

export interface BakeoffKindStats {
  scenarios: number;
  wins: Record<EngineId, number>;
  tie: number;
  none: number;
  accepted: Record<EngineId, number>;
  winner: string;
}

export interface BakeoffSummaryData {
  label: string;
  scenarios: number;
  renders: number;
  engines: Record<EngineId, BakeoffEngineStats>;
  kinds: Record<string, BakeoffKindStats>;
  wins: Record<EngineId | 'tie' | 'none', number>;
  allAccepted: number;
  noneAccepted: number;
}
