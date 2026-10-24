// Model-first .exd generator for the fuzzer. Pure: no I/O, no clock, no dependencies.
//
//   generate(seed, profile, {rtl?}) -> { text, meta, model }   deterministic in (seed, profile)
//   buildModel(seed, profile, opts) -> model                   {title?, nodes[], edges[], groups[], merge, edgesFirst}
//   emit(model) -> text                                        serialise a model into DSL text that obeys the lexer / parser rules
//
// Model shapes (emit() is the only place that knows the syntax, so every model serialises to valid text):
//   node  {id, label, shape: rect|ellipse|diamond|cylinder, color?, flags[], group?, inline?, implicit?}
//   edge  {from, to, arrow: solid|dashed|dotted|line|both, label?}
//   group {id, title?, color?, flags[], parent?, kind: normal|single|empty, depth}
// Labels hold real newlines; emit() writes them as the literal `\n` and strips whatever would break the lexer
// (a label's own closer, quotes, backslashes, a trailing `;`, a leading `(` in a rect). `dir` is never emitted:
// the QA runner forces the direction. Reserved words (dir, direction, title, group) are never used as ids.

import { hash32, makeRng } from "./prng.mjs";
import { EDGE_WORDS, GROUP_WORDS, ID_WORDS, NODE_WORDS, PROFILES, UNICODE_POOLS } from "./profiles.mjs";

const RESERVED = new Set(["dir", "direction", "title", "group"]);
const ARROW_TEXT = { solid: "->", dashed: "-->", dotted: "-.->", line: "--", both: "<->" };
const BRACKETS = { rect: ["[", "]"], ellipse: ["(", ")"], diamond: ["{", "}"], cylinder: ["[(", ")]"] };
const FLAGS = ["dashed", "dotted", "bold", "sketchy"];
const COLORS = ["blue", "green", "orange", "purple", "red", "yellow", "teal", "pink"];

// ---- text pools ----
const words = (rng, pool, range) => Array.from({ length: rng.range(range) }, () => rng.pick(pool)).join(" ");
function longText(rng, pool, target) {
  let s = "";
  while (s.length < target) s += (s ? " " : "") + rng.pick(pool);
  return s.slice(0, target).trimEnd();
}

function unicodeText(rng, P) {
  const pools = P.rtl ? ["rtl", "combining", "zwj", "cjk", "emoji"] : ["cjk", "emoji"];
  const piece = () => rng.pick(UNICODE_POOLS[rng.pick(pools)]);
  switch (rng.int(0, 3)) {
    case 0: return Array.from({ length: rng.int(1, 3) }, () => rng.pick(UNICODE_POOLS.cjk)).join("");
    case 1: return `${rng.pick(NODE_WORDS)} ${piece()} ${rng.pick(UNICODE_POOLS.emoji)}`;
    case 2: return `${piece()} ${piece()}`;
    default: return `${piece()}${rng.chance(0.5) ? ` ${rng.pick(NODE_WORDS)}` : ""}`;
  }
}

/** Optional bracket noise that is legal for the shape (never contains the shape's own closer). */
function bracketNoise(rng, shape) {
  const common = [" [1]", " (see 2)", " {x}", " f(x)", " a: b", " -> y"];
  const byShape = {
    rect: [" (v2)", " {a, b}", " f(x) -> y", " (see [1])"],
    ellipse: [" [1]", " {x}", " [a, b]"],
    diamond: [" [x in 0..1]", " (ok)", " (x) [y]"],
    cylinder: [" [shard 1]", " {x}"],
  };
  return rng.pick(shape ? byShape[shape] : common);
}

function wsNoise(rng, s) {
  return rng.pick([`  ${s}  `, `\n${s}`, `${s}\n`, s.replace(" ", "   "), `\t${s}`]);
}

function nodeLabel(rng, P, shape) {
  let s;
  if (rng.chance(P.unicodeP)) s = unicodeText(rng, P);
  else if (rng.chance(P.nodeOneCharP)) s = rng.pick([..."ABCDEFGHJKMNPQRSTWXYZ"]);
  else if (rng.chance(P.nodeLongP)) s = longText(rng, NODE_WORDS, 70);
  else if (rng.chance(P.nodeMultilineP)) s = Array.from({ length: rng.int(2, 4) }, () => words(rng, NODE_WORDS, [1, 2])).join("\n");
  else s = words(rng, NODE_WORDS, P.nodeWords);
  if (rng.chance(P.bracketP)) s += bracketNoise(rng, shape);
  if (rng.chance(P.wsP)) s = wsNoise(rng, s);
  return s;
}

function edgeLabelText(rng, P) {
  let s;
  if (rng.chance(P.unicodeP)) s = unicodeText(rng, P);
  else if (rng.chance(P.edgeLongP)) s = longText(rng, EDGE_WORDS, 60);
  else if (rng.chance(P.edgeMultilineP)) s = Array.from({ length: rng.int(2, 4) }, () => words(rng, EDGE_WORDS, [1, 3])).join("\n");
  else s = words(rng, EDGE_WORDS, P.edgeWords);
  if (rng.chance(P.bracketP)) s += bracketNoise(rng);
  if (rng.chance(P.hashP)) s += " issue #5";
  if (rng.chance(P.wsP)) s = `\n${s}`;
  return s;
}

function titleText(rng, P) {
  if (rng.chance(P.titleLongP)) return longText(rng, [...NODE_WORDS, ...GROUP_WORDS], rng.int(60, 90));
  if (rng.chance(0.1)) return `${words(rng, GROUP_WORDS, [1, 2])}\n${words(rng, GROUP_WORDS, [1, 2])}`;
  return words(rng, [...NODE_WORDS, ...GROUP_WORDS], [2, 6]);
}

// ---- model construction ----
function makeNodes(rng, P, count, used) {
  const wordIds = rng.chance(0.5);
  const uid = (base) => {
    let id = base;
    for (let k = 2; used.has(id) || RESERVED.has(id); k++) id = `${base}${k % 2 ? "-" : ""}${k}`;
    used.add(id);
    return id;
  };
  return Array.from({ length: count }, (_, i) => {
    const shape = rng.weighted(P.shapes);
    const node = { id: uid(wordIds ? rng.pick(ID_WORDS) : `n${i}`), label: "", shape, flags: [] };
    node.label = nodeLabel(rng, P, shape);
    if (rng.chance(P.colorP)) node.color = rng.pick(COLORS);
    if (rng.chance(P.flagP)) node.flags.push(rng.pick(FLAGS));
    return node;
  });
}

function assignGroups(rng, P, m, used) {
  const G = P.groups;
  const count = G.max > 0 ? rng.int(G.min, G.max) : 0;
  for (let j = 0; j < count; j++) {
    const kind = rng.chance(G.emptyP) ? "empty" : rng.chance(G.singleP) ? "single" : "normal";
    const parents = m.groups.filter((g) => g.kind === "normal" && g.depth < G.depth);
    const parent = parents.length && rng.chance(0.5) ? rng.pick(parents) : undefined;
    let id = `g${j}`;
    for (let k = 2; used.has(id) || RESERVED.has(id); k++) id = `g${j}_${k}`;
    used.add(id);
    const g = { id, flags: [], kind, depth: parent ? parent.depth + 1 : 1 };
    if (parent) g.parent = parent.id;
    if (!rng.chance(G.untitledP)) g.title = words(rng, GROUP_WORDS, [1, 3]).slice(0, G.titleMax).trimEnd() || "Zone";
    if (rng.chance(0.8)) g.color = rng.pick(COLORS);
    if (rng.chance(0.1)) g.flags.push(rng.pick(FLAGS));
    m.groups.push(g);
  }
  const room = new Map(m.groups.map((g) => [g.id, g.kind === "single" ? 1 : g.kind === "empty" ? 0 : Infinity]));
  for (const node of rng.shuffle(m.nodes)) {
    if (!rng.chance(G.coverage)) continue;
    const open = m.groups.filter((g) => room.get(g.id) > 0);
    if (!open.length) break;
    const g = rng.pick(open);
    node.group = g.id;
    room.set(g.id, room.get(g.id) - 1);
  }
}

function edgeFactory(rng, P, m) {
  const ids = m.nodes.map((n) => n.id);
  const seen = new Set();
  const make = (a, b, label) => ({ from: ids[a], to: ids[b], arrow: rng.weighted(P.arrows), ...(label ? { label } : {}) });
  /** Adds a -> b once (pair-deduped) unless the edge cap is reached. */
  const add = (a, b) => {
    const key = `${a}>${b}`;
    if (seen.has(key) || m.edges.length >= P.maxEdges) return false;
    seen.add(key);
    m.edges.push(make(a, b, rng.chance(P.labelP) ? edgeLabelText(rng, P) : undefined));
    return true;
  };
  return { add, make, ids, seen };
}

const target = (rng, P, n) => Math.min(P.maxEdges, Math.round(n * rng.float(P.density[0], P.density[1])));

/** Mostly-forward spanning structure plus skip-rank edges, back edges, reciprocal pairs and loops. */
function dagEdges(rng, P, m) {
  const n = m.nodes.length;
  const { add } = edgeFactory(rng, P, m);
  const grp = (i) => m.nodes[i].group;
  for (let i = 1; i < n; i++) {
    let j;
    if (P.crossP !== undefined) {
      const want = rng.chance(P.crossP);
      const cand = [...Array(i).keys()].filter((k) => (grp(k) !== grp(i)) === want);
      j = rng.pick(cand.length ? cand : [...Array(i).keys()]);
    } else j = rng.chance(0.7) ? Math.max(0, i - rng.int(1, 3)) : rng.int(0, i - 1);
    add(j, i);
  }
  const goal = target(rng, P, n);
  for (let tries = 0; m.edges.length < goal && n > 1 && tries < goal * 8; tries++) {
    const a = rng.int(0, n - 2);
    const b = rng.int(a + 1, n - 1);
    if (P.crossP !== undefined && (grp(a) !== grp(b)) !== rng.chance(P.crossP) && tries % 3) continue;
    add(a, b);
  }
  for (let k = rng.range(P.back); k > 0 && n > 1; k--) {
    const b = rng.int(0, n - 2);
    add(rng.int(b + 1, n - 1), b);
  }
  for (let k = rng.range(P.recip); k > 0 && m.edges.length; k--) {
    const e = rng.pick(m.edges.filter((x) => x.from !== x.to));
    if (e) add(m.nodes.findIndex((x) => x.id === e.to), m.nodes.findIndex((x) => x.id === e.from));
  }
  for (let i = 0; i < n; i++) if (rng.chance(P.loopP)) add(i, i);
}

/** Every pair of a spanning tree (plus a few extra pairs) carries k >= 2 parallel / opposing edges. */
function multiEdges(rng, P, m) {
  const n = m.nodes.length;
  const { make } = edgeFactory(rng, P, m);
  const pairs = [];
  for (let i = 1; i < n; i++) pairs.push([rng.int(0, i - 1), i]);
  for (let k = rng.int(0, 2); k > 0 && n > 2; k--) {
    const a = rng.int(0, n - 2);
    pairs.push([a, rng.int(a + 1, n - 1)]);
  }
  const push = (a, b, label) => m.edges.length < P.maxEdges && m.edges.push(make(a, b, label));
  for (const [a, b] of pairs) {
    const k = rng.weighted(P.multiK);
    const used = new Set();
    for (let t = 0; t < k; t++) {
      let label;
      if (rng.chance(P.labelP)) for (let tries = 0; tries < 6 && (!label || used.has(label)); tries++) label = edgeLabelText(rng, P);
      used.add(label);
      if (t === 0 || rng.chance(0.65)) push(a, b, label);
      else push(b, a, label);
    }
  }
  if (rng.chance(P.loopP)) {
    for (let k = rng.int(1, 2); k > 0; k--) {
      const a = rng.int(0, n - 1);
      for (let l = rng.int(1, 2); l > 0; l--) push(a, a, edgeLabelText(rng, P));
    }
  }
}

/** Star (out / in / both) around a diamond, ellipse or cylinder hub, or a complete bipartite graph. */
function hubEdges(rng, P, m, hub) {
  const { mode, left } = hub;
  const wantNodes = m.nodes.length;
  const { add } = edgeFactory(rng, P, m);
  const lbl = () => (rng.chance(P.labelP) ? edgeLabelText(rng, P) : undefined);
  const push = (a, b, label) => {
    if (m.edges.length >= P.maxEdges) return;
    m.edges.push({ from: m.nodes[a].id, to: m.nodes[b].id, arrow: rng.weighted(P.arrows), ...(label ? { label } : {}) });
  };
  if (mode === "bipartite") {
    const rev = rng.chance(0.15);
    for (let a = 0; a < left; a++) for (let b = left; b < m.nodes.length; b++) push(rev ? b : a, rev ? a : b, lbl());
    return;
  }
  m.nodes[0].shape = rng.pick(["diamond", "ellipse", "cylinder"]);
  const shared = rng.chance(0.5) ? edgeLabelText(rng, P) : undefined;
  for (let i = 1; i < wantNodes; i++) {
    const label = shared ?? lbl();
    if (mode === "out" || (mode === "both" && i % 2)) push(0, i, label);
    else push(i, 0, label);
  }
  if (mode === "both") for (let k = 0; k < 3; k++) add(1 + k, 0), add(0, 1 + k);
}

function randomEdges(rng, P, m) {
  const n = m.nodes.length;
  const { add } = edgeFactory(rng, P, m);
  const goal = target(rng, P, n);
  for (let tries = 0; m.edges.length < goal && tries < goal * 10; tries++) {
    const a = rng.int(0, n - 1);
    const b = rng.int(0, n - 1);
    if (a !== b) add(a, b);
  }
  for (let i = 0; i < n; i++) if (rng.chance(P.loopP)) add(i, i);
}

/** Ranks of 3..8 nodes; each node hangs off the previous rank; extra layered edges, then ~10% random ones. */
function layeredEdges(rng, P, m) {
  const n = m.nodes.length;
  const { add } = edgeFactory(rng, P, m);
  const ranks = [];
  for (let i = 0; i < n; ) {
    const w = Math.min(rng.int(3, 8), n - i);
    ranks.push(Array.from({ length: w }, (_, k) => i + k));
    i += w;
  }
  for (let r = 1; r < ranks.length; r++) for (const v of ranks[r]) add(rng.pick(ranks[r - 1]), v);
  const goal = target(rng, P, n) - Math.round(n * 0.1);
  for (let tries = 0; m.edges.length < goal && ranks.length > 1 && tries < goal * 8; tries++) {
    const r = rng.int(1, ranks.length - 1);
    add(rng.pick(ranks[r - 1]), rng.pick(ranks[r]));
  }
  for (let k = Math.round(n * 0.1); k > 0; k--) add(rng.int(0, n - 1), rng.int(0, n - 1));
  for (let i = 0; i < n; i++) if (rng.chance(P.loopP)) add(i, i);
}

function tinyEdges(rng, P, m) {
  const n = m.nodes.length;
  const { make } = edgeFactory(rng, P, m);
  for (let k = rng.int(0, 3); k > 0; k--) {
    const a = rng.int(0, n - 1);
    const b = rng.chance(P.loopP) ? a : rng.int(0, n - 1);
    m.edges.push(make(a, b, rng.chance(P.labelP) ? edgeLabelText(rng, P) : undefined));
  }
}

/** Marks nodes to be declared inline on their first edge, or left fully implicit (label = id, rect). */
function applyImplicit(rng, m) {
  const mentioned = new Set(m.edges.flatMap((e) => [e.from, e.to]));
  for (const n of m.nodes) {
    if (n.group || n.color || n.flags.length || !mentioned.has(n.id)) continue;
    const r = rng.next();
    if (r < 0.5) n.inline = true;
    else if (r < 0.7) Object.assign(n, { implicit: true, label: n.id, shape: "rect" });
  }
}

export function buildModel(seed, profile, opts = {}) {
  const base = PROFILES[profile];
  if (!base) throw new Error(`unknown fuzz profile '${profile}'`);
  const P = opts.rtl === undefined ? base : { ...base, rtl: opts.rtl };
  const rng = makeRng(hash32(seed, profile));
  const used = new Set();
  const m = { title: undefined, nodes: [], edges: [], groups: [], merge: false, edgesFirst: false };
  let count = rng.range(P.nodes);
  const hub = P.topo === "hubs" ? { mode: rng.pick(["out", "in", "both", "bipartite"]), left: rng.int(3, 5), right: rng.int(3, 5) } : undefined;
  if (hub) count = hub.mode === "bipartite" ? hub.left + hub.right : rng.int(9, 15);
  m.nodes = makeNodes(rng, P, count, used);
  assignGroups(rng, P, m, used);
  switch (P.topo) {
    case "multi": multiEdges(rng, P, m); break;
    case "hubs": hubEdges(rng, P, m, hub); break;
    case "random": randomEdges(rng, P, m); break;
    case "layered": layeredEdges(rng, P, m); break;
    case "tiny": tinyEdges(rng, P, m); break;
    default: dagEdges(rng, P, m);
  }
  if (rng.chance(P.titleP)) m.title = titleText(rng, P);
  if (rng.chance(P.implicitP)) applyImplicit(rng, m);
  m.merge = rng.chance(P.mergeP);
  m.edgesFirst = m.groups.length > 0 && rng.chance(P.edgesFirstP);
  return m;
}

// ---- emit ----
const nl = (s) => s.replace(/\r/g, "").split("\n").join("\\n");

/** Text for a quoted string (title, group title): no quotes or backslashes, newlines as `\n`. */
function str(s) {
  const t = nl(s.replace(/["\\]/g, ""));
  return t.replace(/\\n/g, "").trim() ? t : "x";
}

function nodeText(n) {
  const [open, close] = BRACKETS[n.shape];
  let s = n.label.replace(/\\/g, "");
  for (const ch of new Set(close)) s = s.split(ch).join("");
  if (n.shape === "rect") s = s.replace(/^\(+/, "");
  s = nl(s);
  if (!s.replace(/\\n/g, "").trim()) s = "x";
  return `${open}${s}${close}`;
}

function edgeText(label) {
  const s = nl(label.replace(/["\\;]/g, ""));
  const t = s.replace(/\\n/g, "").trim() ? s : "x";
  return /#/.test(t) ? `"${t}"` : t;
}

const styleText = (o) => {
  const parts = [o.color, ...o.flags].filter(Boolean);
  return parts.length ? ` :${parts.join(",")}` : "";
};

function emitEdges(m, inline) {
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const declared = new Set();
  const ref = (id) => {
    if (!inline.has(id) || declared.has(id)) return id;
    declared.add(id);
    return id + nodeText(byId.get(id));
  };
  const E = m.edges;
  const same = (a, b) => a.arrow === b.arrow && a.label === b.label;
  const out = [];
  for (let i = 0; i < E.length; ) {
    let len = 1;
    let kind = "single";
    if (m.merge) {
      let chain = 1;
      while (i + chain < E.length && E[i + chain].from === E[i + chain - 1].to && same(E[i + chain], E[i])) chain++;
      let fanOut = 1;
      while (i + fanOut < E.length && E[i + fanOut].from === E[i].from && same(E[i + fanOut], E[i]) && fanOut < 14) fanOut++;
      let fanIn = 1;
      while (i + fanIn < E.length && E[i + fanIn].to === E[i].to && same(E[i + fanIn], E[i]) && fanIn < 14) fanIn++;
      const best = Math.max(chain, fanOut, fanIn);
      if (best >= 2) [kind, len] = best === chain ? ["chain", chain] : best === fanOut ? ["out", fanOut] : ["in", fanIn];
    }
    const e = E[i];
    const tail = e.label ? ` : ${edgeText(e.label)}` : "";
    const arrow = ARROW_TEXT[e.arrow];
    if (kind === "chain") out.push([e.from, ...E.slice(i, i + len).map((x) => x.to)].map(ref).join(` ${arrow} `) + tail);
    else if (kind === "out") out.push(`${ref(e.from)} ${arrow} ${E.slice(i, i + len).map((x) => ref(x.to)).join(", ")}${tail}`);
    else if (kind === "in") out.push(`${E.slice(i, i + len).map((x) => ref(x.from)).join(", ")} ${arrow} ${ref(e.to)}${tail}`);
    else out.push(`${ref(e.from)} ${arrow} ${ref(e.to)}${tail}`);
    i += len;
  }
  return { lines: out, declared };
}

/** Serialise a model to .exd text. Valid by construction (see header). */
export function emit(m) {
  const inline = new Set(m.nodes.filter((n) => n.inline && !n.group).map((n) => n.id));
  const { lines: edgeLines, declared } = emitEdges(m, inline);
  const mentioned = new Set(m.edges.flatMap((e) => [e.from, e.to]));
  const decl = (n) => (n.implicit && !n.group && mentioned.has(n.id) ? undefined : `${n.id}${nodeText(n)}${styleText(n)}`);
  const lines = [];
  if (m.title) lines.push(`title "${str(m.title)}"`);
  if (m.edgesFirst) lines.push(...edgeLines);
  const block = (g, depth) => {
    const pad = "  ".repeat(depth);
    const title = g.title ? ` "${str(g.title)}"` : "";
    lines.push(`${pad}group ${g.id}${title}${styleText(g)} {`);
    for (const n of m.nodes) if (n.group === g.id) lines.push(`${pad}  ${decl(n)}`);
    for (const c of m.groups) if (c.parent === g.id) block(c, depth + 1);
    lines.push(`${pad}}`);
  };
  for (const g of m.groups) if (!g.parent) block(g, 0);
  for (const n of m.nodes) {
    if (n.group || declared.has(n.id)) continue;
    const d = decl(n);
    if (d) lines.push(d);
  }
  if (!m.edgesFirst) lines.push(...edgeLines);
  return lines.join("\n") + "\n";
}

function describe(m) {
  const pair = new Map();
  for (const e of m.edges) {
    const k = [e.from, e.to].sort().join("|");
    pair.set(k, (pair.get(k) ?? 0) + 1);
  }
  const shapes = {};
  for (const n of m.nodes) shapes[n.shape] = (shapes[n.shape] ?? 0) + 1;
  return {
    nodes: m.nodes.length,
    edges: m.edges.length,
    groups: m.groups.length,
    labeled: m.edges.filter((e) => e.label).length,
    loops: m.edges.filter((e) => e.from === e.to).length,
    maxParallel: Math.max(0, ...pair.values()),
    maxDepth: Math.max(0, ...m.groups.map((g) => g.depth)),
    shapes,
    title: Boolean(m.title),
    merged: m.merge,
  };
}

/** One deterministic case: text (no `dir` line), meta (sizes for the report) and the model (for the shrinker). */
export function generate(seed, profile, opts = {}) {
  const model = buildModel(seed, profile, opts);
  return { text: emit(model), meta: describe(model), model };
}
