// Model-level fixers: apply the authoring lints' own suggestions (src/lint/rules.ts) mechanically to a fuzz model
// (scripts/qa/gen.mjs shape: nodes[{id,label,shape,...}], edges[{from,to,arrow,label?}], groups[]).
// Pure: every fixer returns a new model and never mutates its input. Labels hold real newlines.
//
//   mergeParallel      parallel-edges     > 2 edges per node pair -> the first edge, labels joined by \n (<-> when mixed)
//   mergeReciprocal    reciprocal-pair    a -> b plus b -> a with the same label -> one a <-> b
//   shortenEdgeLabels  wordy-edge-label   edge label lines cut to their first 3 words (<= 30 chars)
//   breakLongLabels    long-label         node label lines > 40 chars broken at word boundaries; edge lines shortened
//   diamondToRect      diamond-hub        diamonds with > 4 edges become rectangles
//
// busy-node, dense-graph, many-nodes, too-many-nodes, deep-nesting and cross-group-edges need a human decision: UNFIXABLE.
// The limits mirror the exported constants of src/lint/rules.ts (kept literal here: this file has no build dependency).

const MAX_PARALLEL = 2;
const MAX_DIAMOND_DEGREE = 4;
const MAX_EDGE_WORDS = 3;
const MAX_EDGE_LINE = 30;
const MAX_LINE = 40;

export const UNFIXABLE = ["busy-node", "dense-graph", "many-nodes", "too-many-nodes", "deep-nesting", "cross-group-edges"];

const wordsOf = (line) => line.split(/\s+/).filter((w) => w !== "");
const linesOf = (label) => label.split("\n");
const clone = (m) => ({ ...m, nodes: m.nodes.map((n) => ({ ...n })), edges: m.edges.map((e) => ({ ...e })), groups: m.groups.map((g) => ({ ...g })) });
const pairKey = (e) => (e.from < e.to ? `${e.from}\0${e.to}` : `${e.to}\0${e.from}`);

/** Incident edge count per node id (a self-loop counts once, like the lint). */
export function degrees(model) {
  const deg = new Map();
  for (const e of model.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    if (e.to !== e.from) deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  return deg;
}

/** Groups edges by unordered node pair (self-loops excluded). */
function pairs(model) {
  const map = new Map();
  for (const e of model.edges) {
    if (e.from === e.to) continue;
    const k = pairKey(e);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return map;
}

export function mergeParallel(model) {
  const m = clone(model);
  const drop = new Set();
  for (const list of pairs(m).values()) {
    if (list.length <= MAX_PARALLEL) continue;
    const [first, ...rest] = list;
    const labels = list.flatMap((e) => (e.label ? [e.label] : []));
    if (list.some((e) => e.from !== first.from || e.arrow === "both")) first.arrow = "both";
    first.label = labels.length > 0 ? labels.join("\n") : undefined;
    for (const e of rest) drop.add(e);
  }
  m.edges = m.edges.filter((e) => !drop.has(e));
  return m;
}

export function mergeReciprocal(model) {
  const m = clone(model);
  const drop = new Set();
  for (const list of pairs(m).values()) {
    if (list.length !== 2) continue;
    const [a, b] = list;
    const plain = (e) => e.arrow !== "both" && e.arrow !== "line";
    if (a.from === b.to && a.to === b.from && plain(a) && a.arrow === b.arrow && (a.label ?? "") === (b.label ?? "")) {
      a.arrow = "both";
      drop.add(b);
    }
  }
  m.edges = m.edges.filter((e) => !drop.has(e));
  return m;
}

/** First words of a line that fit the edge-label limits; cuts a lone over-long word. */
function shortenLine(line) {
  const out = [];
  for (const w of wordsOf(line).slice(0, MAX_EDGE_WORDS)) {
    if ([...out, w].join(" ").length > MAX_EDGE_LINE) break;
    out.push(w);
  }
  return out.length > 0 ? out.join(" ") : line.trim().slice(0, MAX_EDGE_LINE - 2);
}

const tooWordy = (line) => wordsOf(line).length > MAX_EDGE_WORDS || line.length > MAX_EDGE_LINE;

export function shortenEdgeLabels(model) {
  const m = clone(model);
  for (const e of m.edges) if (e.label) e.label = linesOf(e.label).map((l) => (tooWordy(l) ? shortenLine(l) : l)).join("\n");
  return m;
}

/** Breaks one over-long node label line at word boundaries into pieces of <= MAX_LINE chars. */
function breakLine(line) {
  const out = [];
  let cur = "";
  for (let w of wordsOf(line)) {
    while (w.length > MAX_LINE) {
      if (cur) out.push(cur);
      out.push(w.slice(0, MAX_LINE));
      cur = "";
      w = w.slice(MAX_LINE);
    }
    if (cur && cur.length + 1 + w.length > MAX_LINE) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

export function breakLongLabels(model) {
  const m = clone(model);
  for (const n of m.nodes) if (linesOf(n.label).some((l) => l.length > MAX_LINE)) n.label = linesOf(n.label).flatMap((l) => (l.length > MAX_LINE ? breakLine(l) : [l])).join("\n");
  for (const e of m.edges) if (e.label && linesOf(e.label).some((l) => l.length > MAX_LINE)) e.label = linesOf(e.label).map((l) => (l.length > MAX_LINE ? shortenLine(l) : l)).join("\n");
  return m;
}

export function diamondToRect(model) {
  const m = clone(model);
  const deg = degrees(m);
  for (const n of m.nodes) if (n.shape === "diamond" && (deg.get(n.id) ?? 0) > MAX_DIAMOND_DEGREE) n.shape = "rect";
  return m;
}

/** Lint code -> the fixer that implements its suggestion. */
export const FIXERS = {
  "parallel-edges": mergeParallel,
  "reciprocal-pair": mergeReciprocal,
  "wordy-edge-label": shortenEdgeLabels,
  "long-label": breakLongLabels,
  "diamond-hub": diamondToRect,
};

/** Every fixer in dependency order: merge first (it joins labels), then the label cuts, then shapes. */
export function fixAll(model) {
  return ["parallel-edges", "reciprocal-pair", "long-label", "wordy-edge-label", "diamond-hub"].reduce((m, code) => FIXERS[code](m), model);
}
