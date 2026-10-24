// Deterministic test-case shrinker for failing fuzz / corpus diagrams.
//
//   shrink(source, {oracle, budget?, parse?}) -> {reproduced, text, model, steps, calls, exhausted, fellBack, from, to}
//     source   .exd text (parsed into a model) or {model} (the generator's model, see scripts/qa/gen.mjs)
//     oracle   async (text) => boolean: true iff the candidate still shows the target failure
//     parse    optional DSL parser: candidates it reports an error for are rejected without an oracle call
//     known    texts already known to reproduce (not drawn again)
//   createOracle({dir, outDir, includePlanned}) -> {probe, target, test, dispose}   the real draw + analyse oracle
//
// Passes, repeated until a full cycle makes no progress (every step is plain ddmin or a greedy try, in
// declaration order, no randomness): canonical text layout -> edges -> nodes -> groups (flattened) -> title ->
// styles / arrow kinds / shapes -> shorter labels -> ids renamed a, b, c... Every candidate is re-emitted with the
// generator's emit(), so it is valid by construction. Oracle calls are memoised by text and capped (default 400).
// When the model re-emitted from a parsed file no longer reproduces (declaration order matters to the layout),
// the shrinker falls back to ddmin over the file's lines first.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit } from "./gen.mjs";
import { RULES } from "./analyze.mjs";
import { drawCase } from "./run.mjs";
import { failureKey, loadParser, parseModel, signature } from "./signature.mjs";

export const DEFAULT_BUDGET = 400;
const BUDGET = Symbol("budget");
const RESERVED = new Set(["dir", "direction", "title", "group"]);

const counts = (m) => ({ nodes: m.nodes.length, edges: m.edges.length, groups: m.groups.length });
const firstWord = (s) => s.trim().split(/\s+/)[0] ?? s;
const firstLine = (s) => s.split("\n").find((l) => l.trim()) ?? s;

/** Classic ddmin returning the 1-minimal list of `items` for which test(list) holds; test([]) is tried first. */
export async function ddmin(items, test, { allowEmpty = true } = {}) {
  let list = items;
  if (!list.length) return list;
  if (allowEmpty && (await test([]))) return [];
  let n = 2;
  while (list.length >= 2) {
    const size = Math.ceil(list.length / n);
    const chunks = [];
    for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
    let reduced = false;
    if (chunks.length > 1) {
      for (const c of chunks) {
        if (await test(c)) {
          list = c;
          n = 2;
          reduced = true;
          break;
        }
      }
    }
    if (!reduced) {
      for (let i = 0; i < chunks.length; i++) {
        const comp = chunks.filter((_, j) => j !== i).flat();
        if (comp.length && (await test(comp))) {
          list = comp;
          n = Math.max(n - 1, 2);
          reduced = true;
          break;
        }
      }
    }
    if (!reduced) {
      if (n >= list.length) break;
      n = Math.min(list.length, n * 2);
    }
  }
  return list;
}

/** Nth id in the sequence a..z, aa..az, ba.. (reserved words skipped by the caller). */
function nameFor(i) {
  let s = "";
  for (let k = i; ; k = Math.floor(k / 26) - 1) {
    s = String.fromCharCode(97 + (k % 26)) + s;
    if (k < 26) break;
  }
  return s;
}

function removeGroups(m, removed) {
  const parentOf = new Map(m.groups.map((g) => [g.id, g.parent]));
  const up = (id) => {
    while (id !== undefined && removed.has(id)) id = parentOf.get(id);
    return id;
  };
  const lift = (o, key) => {
    const p = up(o[key]);
    if (p === undefined) delete o[key];
    else o[key] = p;
    return o;
  };
  return {
    ...m,
    nodes: m.nodes.map((n) => lift({ ...n }, "group")),
    groups: m.groups.filter((g) => !removed.has(g.id)).map((g) => lift({ ...g }, "parent")),
  };
}

function removeNodes(m, keep) {
  const ids = new Set(keep.map((n) => n.id));
  return { ...m, nodes: m.nodes.filter((n) => ids.has(n.id)), edges: m.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

function renamed(m) {
  const nodeMap = new Map();
  let k = 0;
  for (const n of m.nodes) {
    let name;
    do name = nameFor(k++);
    while (RESERVED.has(name));
    nodeMap.set(n.id, name);
  }
  const groupMap = new Map(m.groups.map((g, i) => [g.id, `g${i + 1}`]));
  return {
    ...m,
    nodes: m.nodes.map((n) => ({ ...n, id: nodeMap.get(n.id), ...(n.implicit ? { label: nodeMap.get(n.id) } : {}), ...(n.group !== undefined ? { group: groupMap.get(n.group) } : {}) })),
    edges: m.edges.map((e) => ({ ...e, from: nodeMap.get(e.from), to: nodeMap.get(e.to) })),
    groups: m.groups.map((g) => ({ ...g, id: groupMap.get(g.id), ...(g.parent !== undefined ? { parent: groupMap.get(g.parent) } : {}) })),
  };
}

/** Shrink `source`. See the file header. Never throws on budget exhaustion: the best model so far is returned. */
export async function shrink(source, { oracle, budget = DEFAULT_BUDGET, parse, known = [] } = {}) {
  const memo = new Map(known.map((t) => [t, true]));
  const steps = [];
  let calls = 0;
  let exhausted = false;

  const test = async (text) => {
    if (memo.has(text)) return memo.get(text);
    if (parse && parse(text).diagnostics.some((d) => d.severity === "error")) return memo.set(text, false).get(text);
    if (calls >= budget) throw BUDGET;
    calls++;
    const r = Boolean(await oracle(text));
    memo.set(text, r);
    return r;
  };

  const text0 = typeof source === "string" ? source : undefined;
  let cur = typeof source === "string" ? await parseModel(source, parse) : source.model;
  const from = cur ? counts(cur) : undefined;
  let bestText = text0 ?? emit(cur);
  let progress = false;
  let fellBack = false;
  const result = (reproduced) => ({ reproduced, text: bestText, model: cur, steps, calls, exhausted, fellBack, from, to: cur ? counts(cur) : undefined });

  /** Adopts `next` when its emitted text differs from the current one and still reproduces. */
  const attempt = async (next, label) => {
    const text = emit(next);
    if (text === bestText || !(await test(text))) return false;
    cur = next;
    bestText = text;
    progress = true;
    if (label) steps.push(label);
    return true;
  };
  /** ddmin over `items`; build(keep) is the candidate model. A candidate equal to the current text counts as reproducing. */
  const reduce = (items, build, opts) =>
    ddmin(items, async (keep) => (await attempt(build(keep), "")) || emit(build(keep)) === bestText, opts);
  /** Bulk edit first; when it does not reproduce, apply `each(i)` one item at a time. */
  const bulkThenEach = async (label, idxs, bulk, each) => {
    if (!idxs.length) return;
    if (await attempt(bulk(structuredClone(cur), idxs), `${label}: all`)) return;
    if (idxs.length > 1) for (const i of idxs) await attempt(each(structuredClone(cur), i), `${label}: #${i}`);
  };

  try {
    // 0. reproduce: the re-emitted model, else (parsed files only) line-level ddmin of the original text
    const lead = cur ? emit(cur) : undefined;
    if (lead !== undefined && !(await test(lead))) cur = undefined;
    if (cur) bestText = lead;
    else if (text0 !== undefined) {
      if (!(await test(text0))) return result(false);
      fellBack = true;
      const lines = text0.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
      const kept = await ddmin(lines, (sub) => test(sub.join("\n") + "\n"), { allowEmpty: false });
      bestText = kept.join("\n") + "\n";
      steps.push(`lines: ${lines.length} -> ${kept.length}`);
      cur = await parseModel(bestText, parse);
      if (cur && !(await test(emit(cur)))) cur = undefined;
      if (!cur) return result(true);
      bestText = emit(cur);
    } else return result(false);

    await attempt({ ...cur, merge: false, edgesFirst: false, nodes: cur.nodes.map(({ inline, ...n }) => n) }, "layout: one statement per line");

    for (let cycle = 0; cycle < 6; cycle++) {
      progress = false;
      // 1. edges
      const e0 = cur.edges.length;
      await reduce(cur.edges, (keep) => ({ ...cur, edges: keep }));
      if (cur.edges.length < e0) steps.push(`edges: ${e0} -> ${cur.edges.length}`);
      // 2. nodes: edge-less ones first, then any (their edges go with them)
      const n0 = cur.nodes.length;
      const used = new Set(cur.edges.flatMap((e) => [e.from, e.to]));
      const loose = cur.nodes.filter((n) => !used.has(n.id));
      await reduce(loose, (keep) => removeNodes(cur, cur.nodes.filter((n) => used.has(n.id) || keep.includes(n))));
      await reduce(cur.nodes, (keep) => removeNodes(cur, keep), { allowEmpty: false });
      if (cur.nodes.length < n0) steps.push(`nodes: ${n0} -> ${cur.nodes.length}`);
      // 3. groups: flatten (children lifted to the parent)
      const g0 = cur.groups.length;
      const gids = cur.groups.map((g) => g.id);
      await reduce(cur.groups, (keep) => removeGroups(cur, new Set(gids.filter((id) => !keep.some((g) => g.id === id)))));
      if (cur.groups.length < g0) steps.push(`groups: ${g0} -> ${cur.groups.length}`);
      // 4. diagram title
      if (cur.title) await attempt({ ...cur, title: undefined }, "title: dropped");
      // 5. styles, arrow kinds, shapes
      const idx = (xs, pred) => xs.map((x, i) => (pred(x) ? i : -1)).filter((i) => i >= 0);
      const bare = (o) => {
        delete o.color;
        o.flags = [];
      };
      await bulkThenEach("node style", idx(cur.nodes, (n) => n.color || n.flags.length), (m, is) => (is.forEach((i) => bare(m.nodes[i])), m), (m, i) => (bare(m.nodes[i]), m));
      await bulkThenEach("group style", idx(cur.groups, (g) => g.color || g.flags.length), (m, is) => (is.forEach((i) => bare(m.groups[i])), m), (m, i) => (bare(m.groups[i]), m));
      await bulkThenEach("arrow kind", idx(cur.edges, (e) => e.arrow !== "solid"), (m, is) => (is.forEach((i) => (m.edges[i].arrow = "solid")), m), (m, i) => ((m.edges[i].arrow = "solid"), m));
      await bulkThenEach("shape", idx(cur.nodes, (n) => n.shape !== "rect" && !n.implicit), (m, is) => (is.forEach((i) => (m.nodes[i].shape = "rect")), m), (m, i) => ((m.nodes[i].shape = "rect"), m));
      // 6. shorter labels
      const setEdge = (m, i, v) => (v === undefined ? delete m.edges[i].label : (m.edges[i].label = v), m);
      await bulkThenEach("edge label", idx(cur.edges, (e) => e.label), (m, is) => (is.forEach((i) => setEdge(m, i, undefined)), m), (m, i) => setEdge(m, i, undefined));
      for (const i of idx(cur.edges, (e) => e.label && e.label !== "x")) {
        const l = cur.edges[i].label;
        for (const v of ["x", firstWord(l), firstLine(l)]) if (v !== l && (await attempt(setEdge(structuredClone(cur), i, v), `edge label #${i}`))) break;
      }
      const setLabel = (m, i, v) => ((m.nodes[i].label = v), m);
      for (const i of idx(cur.nodes, (n) => !n.implicit && n.label !== "A")) {
        const l = cur.nodes[i].label;
        for (const v of ["A", firstWord(l), firstLine(l)]) if (v !== l && v.trim() && (await attempt(setLabel(structuredClone(cur), i, v), `node label #${i}`))) break;
      }
      const setTitle = (m, i, v) => (v === undefined ? delete m.groups[i].title : (m.groups[i].title = v), m);
      for (const i of idx(cur.groups, (g) => g.title)) {
        const l = cur.groups[i].title;
        for (const v of [undefined, "Z", firstWord(l)]) if (v !== l && (await attempt(setTitle(structuredClone(cur), i, v), `group title #${i}`))) break;
      }
      if (!progress) break;
    }
    // 7. cosmetic: canonical ids (not counted as progress)
    await attempt(renamed(cur), "ids: renamed");
    // 8. cosmetic: plain rect nodes need no declaration (implicit: label = id)
    const ends = new Set(cur.edges.flatMap((e) => [e.from, e.to]));
    const plain = cur.nodes.map((n, i) => (!n.implicit && n.shape === "rect" && n.group === undefined && !n.color && !n.flags.length && ends.has(n.id) ? i : -1)).filter((i) => i >= 0);
    const implicit = (m, i) => Object.assign(m.nodes[i], { implicit: true, label: m.nodes[i].id });
    await bulkThenEach("implicit nodes", plain, (m, is) => (is.forEach((i) => implicit(m, i)), m), (m, i) => implicit(m, i) && m);
  } catch (err) {
    if (err !== BUDGET) throw err;
    exhausted = true;
  }
  return result(true);
}

// ---- real oracle: draw in a fixed direction and analyse ----

const candidates = (findings, includePlanned) => findings.filter((f) => f.severity === "hard" || (includePlanned && RULES[f.code]?.[2] === "hard"));

/**
 * Oracle bound to one direction. `target(text, code?)` runs the original once and fixes the failure to chase: the
 * requested code, else cli-failure, else the lexicographically first HARD (or planned-hard) code. `test(text)` is
 * true iff a candidate shows the same failure (same code; for cli-failure also the same number-free message).
 */
export function createOracle({ dir, outDir, includePlanned = false }) {
  const own = outDir === undefined;
  const out = outDir ?? mkdtempSync(join(tmpdir(), "exd-shrink-"));
  let key;
  const probe = async (text) => (await drawCase({ name: "probe", dir, text, group: "shrink" }, { outDir: out, png: false })).findings;
  return {
    probe,
    async target(text, code) {
      const found = candidates(await probe(text), includePlanned);
      const pool = code ? found.filter((f) => f.code === code) : found;
      const pick = code ? pool[0] : pool.find((f) => f.code === "cli-failure") ?? [...pool].sort((a, b) => a.code.localeCompare(b.code))[0];
      if (!pick) return undefined;
      key = failureKey(pick);
      return { code: pick.code, key, detail: pick.detail };
    },
    test: async (text) => candidates(await probe(text), includePlanned).some((f) => failureKey(f) === key),
    dispose: () => own && rmSync(out, { recursive: true, force: true }),
  };
}

/**
 * Shrink one failing diagram with the real oracle. `text` (an .exd) or `model` (generator) is the input; `dirs` are
 * tried in order until one shows the failure (`code` pins which failure, default see createOracle).
 * Returns {ok:false, reason} or {ok:true, code, dir, key, text, model, signature, calls, steps, exhausted, fellBack, from, to}.
 */
export async function shrinkCase({ text, model, dirs, code, includePlanned = false, budget = DEFAULT_BUDGET }) {
  const parse = await loadParser();
  const text0 = text ?? emit(model);
  for (const dir of dirs) {
    const oracle = createOracle({ dir, includePlanned });
    try {
      const t = await oracle.target(text0, code);
      if (!t) continue;
      let res = await shrink(model ? { model } : text0, { oracle: oracle.test, budget: budget - 1, parse, known: [text0] });
      if (!res.reproduced) return { ok: false, reason: `the shrunk form of the ${t.code} failure in ${dir} stopped reproducing` };
      // Node order is part of the input, and a model re-parsed from its own text can order nodes differently (first
      // mention wins), so shrink the text once more until it is a fixed point: the stored file is minimal as written.
      let calls = res.calls;
      const steps = [...res.steps];
      for (let round = 0; round < 3 && !res.exhausted && calls < budget - 1; round++) {
        const next = await shrink(res.text, { oracle: oracle.test, budget: budget - 1 - calls, parse, known: [text0, res.text] });
        calls += next.calls;
        if (!next.reproduced || next.text === res.text) break;
        steps.push(...next.steps);
        res = { ...next, from: res.from };
      }
      // the signature is taken from what the file parses back to, so it matches corpus scans
      const min = (await parseModel(res.text, parse)) ?? res.model;
      const to = min ? { nodes: min.nodes.length, edges: min.edges.length, groups: min.groups.length } : res.to;
      return { ok: true, code: t.code, dir, key: t.key, detail: t.detail, text: res.text, model: min, signature: min ? signature(t.code, min) : `${t.code}:unparsed`, calls: calls + 1, steps, exhausted: res.exhausted, fellBack: res.fellBack, from: res.from, to };
    } finally {
      oracle.dispose();
    }
  }
  return { ok: false, reason: `no ${code ?? (includePlanned ? "hard or planned-hard" : "hard")} failure in ${dirs.join(",")} for this input` };
}

/** `Nn/Ee/Gg` size string. */
export const sizeOf = (c) => (c ? `${c.nodes}n/${c.edges}e/${c.groups}g` : "?");

/** `# fuzz repro: ...` header line for a shrink result. */
export const reproHeader = (r, meta = {}) =>
  `# fuzz repro: code=${r.code} dir=${r.dir}${meta.profile ? ` profile=${meta.profile} seed=${meta.seed}` : ""} signature=${r.signature} steps=${r.steps.length} oracle_calls=${r.calls} from ${sizeOf(r.from)} to ${sizeOf(r.to)}\n`;

