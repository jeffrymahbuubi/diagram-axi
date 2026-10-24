// Aggregation: RawGraph -> View (pure, deterministic, no IO). Pipeline (plan 2026-10-24-extract-plan.md, section 2):
// filter -> focus -> containment cut -> roll-up -> cycles -> hubs -> stubs. `to-exd.ts` and `sidecar.ts` consume the View.
// Nothing is dropped silently: every removed file or edge lands in `summary` (see the identities on ViewSummary).

import { MANY_NODES, MAX_DEGREE, MAX_DEPTH, MAX_LINE } from "../lint/rules.js";
import { BUDGET_FLOOR, EXTRACT_DENSE_RATIO, crowded, densityOf } from "./density.js";
import { bfs, cmp, degree, sccsOf, suppressHubs, type LiveEdge, type Rolled } from "./graph-ops.js";
import { buildTree, closeSkips, cutTree, resolveDir, resolveFocus, skippedItems, type Cut, type TNode } from "./tree.js";
import { matchesAny } from "./glob.js";
import type { RawGraph } from "./types.js";

export type ViewKind = "file" | "dir" | "rest" | "stub" | "external";
export type ViewColor = "red" | "yellow" | "green";

export interface AggregateOptions {
  /** Visible node budget, default MANY_NODES (25). Stubs and external nodes count against it. */
  maxNodes?: number;
  /** The budget was not typed: a crowded view (density.ts) is cut again with a smaller budget, down to BUDGET_FLOOR. */
  autoBudget?: boolean;
  level?: "auto" | "file" | "dir";
  /** Directory paths forced open (any depth); may push the view past the budget (reported). */
  expand?: string[];
  group?: "dir" | "none";
  include?: string[];
  exclude?: string[];
  externals?: "hide" | "count" | "show";
  /** Keep type-only edges (drawn dotted). */
  types?: boolean;
  /** Keep test files. */
  tests?: boolean;
  /** `show` restores the edges into hubs. */
  hubs?: "hide" | "show";
  /** File or directory path (relative to the scan root). */
  focus?: string;
  depth?: number;
  dir?: "out" | "in" | "both";
  /**
   * `hide` (default) leaves out files and folders with no drawn import edge (they cost no budget; reported as `isolated`);
   * `show` keeps them as ordinary boxes. An edge-less graph is always drawn whole.
   */
  isolated?: "hide" | "show";
  /** Detected entry file (relative to the scan root, see entry.ts); gets the `entry` mark when it is a visible file. */
  entry?: string;
}

export interface ViewNode {
  /** Unique, stable key: `file:<path>`, `dir:<path>`, `rest:<path>`, `stub:<key>`, `ext:<name>`. */
  key: string;
  kind: ViewKind;
  path: string;
  /** Base label (no hub notes, not yet cut to MAX_LINE). */
  label: string;
  /** Extra label lines (`used by 20`, `+3 more`). */
  notes: string[];
  /** Key of the enclosing group, if any. */
  group?: string;
  /** Source files represented (1 for a file). */
  files: number;
  loc: number;
  color?: ViewColor;
  /** `entry` (package main/bin or root index) or `focus` (the --focus target): drawn green with its own label line. */
  mark?: "entry" | "focus";
  hub?: { usedBy: number; uses: number; shown: number };
}

export interface ViewGroup {
  key: string;
  path: string;
  /** Path relative to the enclosing group (chain-compressed dirs read `main/java/com`). */
  label: string;
  parent?: string;
}

export interface ViewEdge {
  from: string;
  to: string;
  /** Number of raw import occurrences rolled into this edge. */
  weight: number;
  /** Every constituent is type-only. */
  typeOnly: boolean;
  /** Every constituent is a dynamic `import()`. */
  dynamic: boolean;
  /** A `--` line to a stub (no evidence). */
  stub: boolean;
  evidence: Array<{ path: string; line: number }>;
}

export interface ViewSummary {
  root: string;
  langs: string[];
  files: { total: number; generated: number; excluded: number; tests: number; kept: number; covered: number };
  /**
   * raw = filteredFiles + dangling + typeOnly + live
   * live = outsideFocus + boundary + inFocus;  inFocus = self + rolled;  rolled = hubDropped + drawn
   * (`drawn` is the weight of the drawn edges between real nodes; stub lines are not counted.)
   */
  edges: {
    raw: number; filteredFiles: number; dangling: number; typeOnly: number; live: number;
    outsideFocus: number; boundary: number; inFocus: number; self: number; rolled: number; hubDropped: number; drawn: number;
  };
  nodes: { visible: number; files: number; dirs: number; rest: number; stubs: number; externals: number; groups: number };
  externals: { packages: number; builtins: number; shown: number };
  unresolved: number;
  skipped: number;
  hubs: Array<{ key: string; path: string; usedBy: number; uses: number; shown: number }>;
  hubsShown: boolean;
  cycles: string[][];
  budget: { max: number; effective: number; exceeded: boolean; /** The box budget was lowered automatically because the view was crowded (see density.ts). */ dense: boolean };
  /**
   * Files and folders with no import edge to the rest of the visible graph. They cost no budget and get no box:
   * `files` counts every file left out, `items` lists the outermost paths (at most ISOLATED_ITEMS, `more` = the rest).
   */
  isolated: { files: number; items: Array<{ path: string; kind: "file" | "dir"; files: number }>; more: number };
  focus?: { path: string; depth: number; dir: string; reached: number; files: number };
  /** The directory the view starts from (common prefix of the kept files). */
  effectiveRoot: string;
  warnings: string[];
}

export interface View {
  root: string;
  nodes: ViewNode[];
  groups: ViewGroup[];
  edges: ViewEdge[];
  /** Strongly connected components of the rolled-up graph (keys), each with >= 2 nodes. */
  sccs: string[][];
  hidden: {
    externals: Array<{ name: string; edges: number; files: number }>;
    tests: string[];
    hubEdges: Array<{ from: string; to: string; weight: number }>;
  };
  summary: ViewSummary;
}

export { sccsOf };

export class FocusNotFoundError extends Error {
  constructor(readonly focus: string) {
    super(`--focus '${focus}' matches no scanned file or directory`);
  }
}

/** Isolated items listed in the summary and the sidecar; the rest is only counted. */
export const ISOLATED_ITEMS = 100;
const GENERATED_DIRS = new Set(["node_modules", "dist", "build", "out"]);
const isGenerated = (p: string): boolean => p.split("/").some((s) => GENERATED_DIRS.has(s)) || /\.d\.[cm]?ts$/.test(p);

/** Visible files/folders whose label repeats (`index.ts` in several groups) get the tail of their path until they differ. */
function disambiguate(nodes: ViewNode[]): void {
  const by = new Map<string, ViewNode[]>();
  for (const n of nodes) if (n.kind === "file" || n.kind === "dir") (by.get(n.label) ?? by.set(n.label, []).get(n.label))?.push(n);
  for (const list of by.values()) {
    if (list.length < 2) continue;
    const segs = list.map((n) => n.path.split("/"));
    const longest = Math.max(...segs.map((x) => x.length));
    const label = (n: ViewNode, i: number, k: number): string => {
      const m = /^(.*?)(\/?)( \(\d+ files?\))?$/.exec(n.label) as RegExpExecArray;
      return `${(segs[i] as string[]).slice(-k).join("/")}${m[2]}${m[3] ?? ""}`;
    };
    let k = 2;
    while (k < longest && new Set(list.map((n, i) => label(n, i, k))).size < list.length) k++;
    list.forEach((n, i) => (n.label = label(n, i, k)));
  }
}

function build(raw: RawGraph, opts: AggregateOptions = {}): View {
  const maxNodes = Math.max(1, opts.maxNodes ?? MANY_NODES);
  const level = opts.level ?? "auto";
  const groupMode = opts.group ?? "dir";
  const externalsMode = opts.externals ?? "hide";
  const hubsMode = opts.hubs ?? "hide";
  const depth = opts.depth ?? 2;
  const dirMode = opts.dir ?? "both";
  const warnings = [...raw.warnings];

  // ---- 1. filter files ----
  let generated = 0, excluded = 0, tests = 0;
  const testPaths: string[] = [];
  const kept = new Map<string, { loc: number }>();
  for (const f of raw.files) {
    if (isGenerated(f.path)) generated++;
    else if ((opts.include?.length && !matchesAny(f.path, opts.include)) || (opts.exclude?.length && matchesAny(f.path, opts.exclude))) excluded++;
    else if (f.test && !opts.tests) (tests++, testPaths.push(f.path));
    else kept.set(f.path, { loc: f.loc });
  }
  testPaths.sort(cmp);

  // ---- 1b. filter edges ----
  let filteredFiles = 0, dangling = 0, typeOnlyHidden = 0;
  let live: LiveEdge[] = [];
  const known = new Set(raw.files.map((f) => f.path));
  for (const e of raw.edges) {
    if (!known.has(e.from) || !known.has(e.to)) dangling++;
    else if (!kept.has(e.from) || !kept.has(e.to)) filteredFiles++;
    else if (e.typeOnly && !opts.types) typeOnlyHidden++;
    else live.push({ from: e.from, to: e.to, typeOnly: e.typeOnly, dynamic: e.dynamic, line: e.line });
  }
  const liveCount = live.length;

  // ---- 2. focus: restrict to the reached subgraph, remember the boundary ----
  let outsideFocus = 0;
  let boundaryEdges: LiveEdge[] = [];
  let focusInfo: ViewSummary["focus"];
  let files = new Map(kept);
  if (opts.focus !== undefined) {
    const starts = resolveFocus(opts.focus, [...kept.keys()].sort(cmp));
    if (starts.length === 0) throw new FocusNotFoundError(opts.focus);
    const reached = bfs(starts, live, depth, dirMode);
    files = new Map([...kept].filter(([p]) => reached.has(p)));
    const inside: LiveEdge[] = [];
    for (const e of live) {
      const a = reached.has(e.from), b = reached.has(e.to);
      if (a && b) inside.push(e);
      else if ((a && !b && dirMode !== "in") || (b && !a && dirMode !== "out")) boundaryEdges.push(e);
      else outsideFocus++;
    }
    live = inside;
    focusInfo = { path: opts.focus, depth, dir: dirMode, reached: reached.size, files: starts.length };
  }

  // ---- 3. containment tree + cut (isolated files and folders cost no budget and get no box) ----
  const tree = buildTree(files, live);
  const extNodes = externalsMode === "hide" ? 0 : externalsMode === "count" ? (raw.externals.length > 0 ? 1 : 0) : Math.min(raw.externals.length, 6);
  const stubCap = Math.floor(maxNodes / 3);
  const boundaryFiles = new Set(boundaryEdges.flatMap((e) => (files.has(e.from) ? [e.from] : [e.to])));
  const forced = (opts.expand ?? []).map((p) => resolveDir(tree, p)).filter((n): n is TNode => n !== undefined);
  // The --focus file and the entry stay visible and keep their arrows into hubs.
  const focusFile = opts.focus !== undefined && files.has(opts.focus) ? opts.focus : undefined;
  // an entry with no import edge at all (a stub such as `import "./dist/cli.js"`) is neither kept nor marked
  const entryFile = opts.entry !== undefined && files.has(opts.entry) && live.some((e) => e.from !== e.to && (e.from === opts.entry || e.to === opts.entry)) ? opts.entry : undefined;
  const protect = [focusFile, entryFile].filter((f): f is string => f !== undefined);
  // files that stay individual boxes when a big folder opens partially: the focus file's direct neighbours, the entry
  const pinned = [...protect];
  if (focusFile) for (const e of live) { if (e.from === focusFile) pinned.push(e.to); else if (e.to === focusFile) pinned.push(e.from); }
  const covers = (treePath: string): boolean => protect.some((f) => f === treePath || f.startsWith(`${treePath}/`));

  const skip = new Set<string>();
  const noExpand = new Set<string>();
  const isolationOn = live.length > 0 && opts.isolated !== "show";
  if (isolationOn) {
    // isolated = no import edge at all (in or out): hub-suppressed importers are not isolated, they are rolled into their folder below
    const linked = new Set<string>(boundaryFiles);
    for (const e of live) if (e.from !== e.to) (linked.add(e.from), linked.add(e.to));
    for (const f of files.keys()) if (!linked.has(f) && !protect.includes(f)) skip.add(f);
    // a folder whose files only import each other (no edge to anything outside it) is isolated as a whole, unless that
    // would leave nothing connected (then the biggest such folder is the graph)
    const loneDirs: TNode[] = [];
    const sweep = (n: TNode): void => {
      for (const k of n.kids) {
        if (!k.dir) continue;
        if (k.cross === 0 && !covers(k.path) && !forced.includes(k) && ![...boundaryFiles].some((f) => f.startsWith(`${k.path}/`))) loneDirs.push(k);
        else sweep(k);
      }
    };
    sweep(tree);
    const underLone = (f: string): boolean => loneDirs.some((d) => f.startsWith(`${d.path}/`));
    if (loneDirs.length > 0 && ![...linked].some((f) => !underLone(f))) {
      loneDirs.sort((x, y) => y.files - x.files || (x.path < y.path ? -1 : 1));
      loneDirs.shift();
    }
    for (const d of loneDirs) skip.add(d.path);
    closeSkips(tree, skip);
    // Hub importers: files whose imports all go to a hub (a file imported by more than MAX_DEGREE others) and that nobody imports.
    // A folder where they are at least half of the files stays one box: its arrow into the hub is drawn, while its files as
    // separate boxes would show none (hub arrows are suppressed) and just fill the budget.
    if (hubsMode === "hide") {
      const importers = new Map<string, Set<string>>();
      for (const e of live) if (e.from !== e.to) (importers.get(e.to) ?? importers.set(e.to, new Set()).get(e.to))?.add(e.from);
      const isHub = (f: string): boolean => (importers.get(f)?.size ?? 0) > MAX_DEGREE;
      const outs = new Map<string, string[]>();
      for (const e of live) if (e.from !== e.to) (outs.get(e.from) ?? outs.set(e.from, []).get(e.from))?.push(e.to);
      const leafImporter = (f: string): boolean => !importers.has(f) && (outs.get(f) ?? []).length > 0 && (outs.get(f) as string[]).every(isHub);
      const count = (n: TNode): { all: number; leaf: number } => {
        if (!n.dir) return { all: skip.has(n.path) ? 0 : 1, leaf: !skip.has(n.path) && leafImporter(n.path) ? 1 : 0 };
        return n.kids.reduce((t, k) => { const c = count(k); return { all: t.all + c.all, leaf: t.leaf + c.leaf }; }, { all: 0, leaf: 0 });
      };
      const visit = (n: TNode): void => {
        for (const k of n.kids) {
          if (!k.dir) continue;
          const c = count(k);
          if (c.leaf > 0 && c.leaf * 2 >= c.all && !forced.includes(k)) noExpand.add(k.path);
          visit(k);
        }
      };
      visit(tree);
    }
  }

  let budget = 1;
  const fit = (): Cut => {
    budget = Math.max(1, maxNodes - extNodes);
    const base = { level, forced, group: groupMode === "dir", maxDepth: MAX_DEPTH, skip, noExpand, pinned };
    let c = cutTree(tree, { ...base, budget });
    const stubCount = (): number => (boundaryFiles.size === 0 ? 0 : Math.min(stubCap, new Set([...boundaryFiles].map((f) => c.repOf.get(f))).size));
    if (level !== "file") {
      for (let i = 0; i < 8; i++) {
        const over = c.nodes.length + stubCount() + extNodes - maxNodes;
        if (over <= 0 || budget <= 1) break;
        budget = Math.max(1, budget - over);
        c = cutTree(tree, { ...base, budget });
      }
    }
    return c;
  };

  // ---- 4. roll-up, repeated while the cut leaves boxes with no edge (isolated folders) or folders full of hub importers ----
  let cut: Cut;
  let rolledList: Rolled[] = [];
  let self = 0;
  for (let round = 0; ; round++) {
    cut = fit();
    const rolled = new Map<string, Rolled>();
    self = 0;
    for (const e of live) {
      const a = cut.repOf.get(e.from), b = cut.repOf.get(e.to);
      // both ends inside one box, or inside an isolated folder (only edges among its own files)
      if (a === undefined || b === undefined || a === b) { self++; continue; }
      const k = `${a}\u0000${b}`;
      const r = rolled.get(k) ?? (rolled.set(k, { from: a, to: b, weight: 0, types: 0, dyn: 0, evidence: [] }).get(k) as Rolled);
      r.weight++;
      if (e.typeOnly) r.types++;
      if (e.dynamic) r.dyn++;
      r.evidence.push({ path: e.from, line: e.line });
    }
    rolledList = [...rolled.values()].sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to));
    if (!isolationOn || round >= 5) break;
    const touched = new Set<string>();
    for (const r of rolledList) (touched.add(r.from), touched.add(r.to));
    for (const f of boundaryFiles) touched.add(cut.repOf.get(f) as string);
    const lone = cut.nodes.filter((n) => !touched.has(n.key) && !(cut.members.get(n.key) ?? []).some(covers));
    if (lone.length === 0 || lone.length === cut.nodes.length) break;
    for (const n of lone) for (const m of cut.members.get(n.key) ?? []) skip.add(m);
    closeSkips(tree, skip);
  }
  const rolledWeight = rolledList.reduce((s, r) => s + r.weight, 0);
  const isolatedItems = skippedItems(tree, skip);
  const isolatedFiles = [...files.keys()].filter((f) => !cut.repOf.has(f)).length;

  // ---- view nodes ----
  const nodes: ViewNode[] = cut.nodes.map((c) => ({
    key: c.key, kind: c.kind, path: c.path, label: c.label, notes: [], ...(c.group ? { group: c.group } : {}), files: c.files, loc: c.loc,
  }));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  disambiguate(nodes);

  // ---- 5. cycles (before hub suppression: the data is cyclic even if the hub's arrows are not drawn) ----
  const sccs = sccsOf(nodes.map((n) => n.key), rolledList.map((r) => [r.from, r.to]));
  for (const comp of sccs) for (const k of comp) (byKey.get(k) as ViewNode).color = "red";

  // ---- 6. hubs: repeatedly take the busiest node (degree > MAX_DEGREE), drop its incoming edges, cap its fan-out ----
  const hubInfo: View["summary"]["hubs"] = [];
  const keepFrom = new Set(protect.map((f) => cut.repOf.get(f) as string));
  const { edgesLeft, hubOrder, capped, hubEdges, hubDropped } = suppressHubs(rolledList, nodes.map((n) => n.key), hubsMode === "hide", keepFrom);
  for (const h of hubOrder) {
    const n = byKey.get(h) as ViewNode;
    const used = new Set(rolledList.filter((r) => r.to === h).flatMap((r) => r.evidence.map((ev) => ev.path))).size;
    const shown = edgesLeft.filter((r) => r.from === h).length;
    const uses = capped.get(h) ?? shown;
    n.hub = { usedBy: used, uses, shown };
    // one note line (the label stays at two lines): `used by 20, 2 uses hidden`; the drawn arrows are the `shown` uses
    const parts: string[] = [];
    if (used > 0) parts.push(`used by ${used}`);
    if (uses > shown) parts.push(`${uses - shown} ${uses - shown === 1 ? "use" : "uses"} hidden`);
    if (parts.length > 0) n.notes.push(parts.join(", "));
    n.color ??= "yellow";
    hubInfo.push({ key: h, path: n.path, usedBy: used, uses, shown });
  }

  // ---- 7. stubs (focus boundary) ----
  const deg1 = degree(edgesLeft);
  const stubEdges: ViewEdge[] = [];
  if (boundaryEdges.length > 0) {
    const per = new Map<string, Set<string>>();
    for (const e of boundaryEdges) {
      const inner = files.has(e.from) ? e.from : e.to;
      const outer = inner === e.from ? e.to : e.from;
      const k = cut.repOf.get(inner) as string;
      (per.get(k) ?? per.set(k, new Set()).get(k))?.add(outer);
    }
    const order = [...per].sort((x, y) => y[1].size - x[1].size || cmp(x[0], y[0]));
    let made = 0;
    for (const [k, outer] of order) {
      const n = byKey.get(k) as ViewNode;
      if (n.kind === "file" && made < stubCap && (deg1.get(k) ?? 0) + 1 <= MAX_DEGREE && nodes.length + 1 + extNodes <= maxNodes) {
        const stub: ViewNode = { key: `stub:${k}`, kind: "stub", path: n.path, label: `... +${outer.size} more`, notes: [], ...(n.group ? { group: n.group } : {}), files: outer.size, loc: 0 };
        nodes.push(stub);
        stubEdges.push({ from: k, to: stub.key, weight: 1, typeOnly: false, dynamic: false, stub: true, evidence: [] });
        made++;
      } else n.notes.push(`... +${outer.size} more`);
    }
  }
  // ---- marks: the entry and the --focus target: green with their own label line; green wins over hub yellow and cycle red (`cycles:` still names the members) ----
  // A file inside a collapsed folder marks the folder box and names the file (`entry: node.ts`). A hub keeps its label at two
  // lines: the mark joins the hub note (`entry, used by 20`) when the joined line fits MAX_LINE; otherwise the mark gets its own
  // line, because cutLine would cut the joined note in the middle (`entry: index.ts, us...y 3, 7 uses hidden`).
  const mark = (n: ViewNode | undefined, m: "entry" | "focus", file?: string): void => {
    if (!n || n.mark) return;
    n.mark = m;
    const text = file === undefined ? m : `${m}: ${file.slice(file.lastIndexOf("/") + 1)}`;
    const joined = `${text}, ${n.notes[0] ?? ""}`;
    if (n.hub && /^(used by|\d+ uses? hidden)/.test(n.notes[0] ?? "") && joined.length <= MAX_LINE) n.notes[0] = joined;
    else n.notes.unshift(text);
    n.color = "green";
  };
  const boxOf = (file: string): ViewNode | undefined => byKey.get(cut.repOf.get(file) ?? "");
  const inside = (file: string): string | undefined => (boxOf(file)?.kind === "file" ? undefined : file);
  // the entry is marked only when something is drawn on it (an arrow-less green box says nothing)
  const arrows = new Set(edgesLeft.flatMap((r) => [r.from, r.to]));
  const entryBox = entryFile ? boxOf(entryFile) : undefined;
  if (entryFile && entryBox && arrows.has(entryBox.key)) mark(entryBox, "entry", inside(entryFile));
  if (focusInfo && (focusFile !== entryFile || !entryBox || !arrows.has(entryBox.key))) {
    const box = byKey.get(`file:${opts.focus}`) ?? byKey.get(`dir:${opts.focus}`) ?? (focusFile ? boxOf(focusFile) : undefined);
    mark(box, "focus", focusFile && box?.kind !== "file" && box?.key !== `dir:${opts.focus}` ? focusFile : undefined);
  }

  // ---- 8. externals (counted; no per-file edges exist in a RawGraph) ----
  const ranked = [...raw.externals].sort((x, y) => y.files - x.files || y.count - x.count || cmp(x.name, y.name));
  const extViews: ViewNode[] = [];
  if (externalsMode === "count" && ranked.length > 0) {
    extViews.push({ key: "ext:*", kind: "external", path: "", label: `npm (${ranked.length} packages)`, notes: [], files: 0, loc: 0 });
  } else if (externalsMode === "show") {
    const top = ranked.slice(0, 5).sort((x, y) => cmp(x.name, y.name));
    for (const x of top) extViews.push({ key: `ext:${x.name}`, kind: "external", path: "", label: x.name, notes: [`used by ${x.files} ${x.files === 1 ? "file" : "files"}`], files: 0, loc: 0 });
    if (ranked.length > 5) extViews.push({ key: "ext:+", kind: "external", path: "", label: `+${ranked.length - 5} more packages`, notes: [], files: 0, loc: 0 });
  }
  nodes.push(...extViews);

  const edges: ViewEdge[] = [
    ...edgesLeft.map((r) => ({ from: r.from, to: r.to, weight: r.weight, typeOnly: r.types === r.weight, dynamic: r.dyn === r.weight, stub: false, evidence: [...r.evidence].sort((x, y) => cmp(x.path, y.path) || x.line - y.line) })),
    ...stubEdges,
  ];
  const drawn = edgesLeft.reduce((s, r) => s + r.weight, 0);
  const sccPaths = sccs.map((c) => c.map((k) => (byKey.get(k) as ViewNode).path));
  const count = (k: ViewKind): number => nodes.filter((n) => n.kind === k).length;
  const exceeded = nodes.length > maxNodes;
  if (exceeded && level !== "file") warnings.push(`view has ${nodes.length} nodes, over --max-nodes ${maxNodes} (forced --expand)`);
  if (raw.unresolved.length > 0) warnings.push(`${raw.unresolved.length} unresolved specifiers`);

  return {
    root: raw.meta.root,
    nodes,
    groups: cut.groups,
    edges,
    sccs,
    hidden: {
      externals: raw.externals.map((x) => ({ name: x.name, edges: x.count, files: x.files })).sort((x, y) => cmp(x.name, y.name)),
      tests: testPaths,
      hubEdges,
    },
    summary: {
      root: raw.meta.root,
      langs: [...raw.meta.langs],
      files: { total: raw.files.length, generated, excluded, tests, kept: kept.size, covered: files.size },
      isolated: { files: isolatedFiles, items: isolatedItems.slice(0, ISOLATED_ITEMS), more: Math.max(0, isolatedItems.length - ISOLATED_ITEMS) },
      edges: {
        raw: raw.edges.length, filteredFiles, dangling, typeOnly: typeOnlyHidden, live: liveCount,
        outsideFocus, boundary: boundaryEdges.length, inFocus: live.length, self, rolled: rolledWeight, hubDropped, drawn,
      },
      nodes: { visible: nodes.length, files: count("file"), dirs: count("dir"), rest: count("rest"), stubs: count("stub"), externals: count("external"), groups: cut.groups.length },
      externals: { packages: raw.externals.length, builtins: raw.builtins.length, shown: extViews.length },
      unresolved: raw.unresolved.length,
      skipped: raw.skipped.length,
      hubs: hubInfo.sort((x, y) => cmp(x.path, y.path)),
      hubsShown: hubsMode === "show",
      cycles: sccPaths,
      budget: { max: maxNodes, effective: budget, exceeded, dense: false },
      ...(focusInfo ? { focus: focusInfo } : {}),
      effectiveRoot: tree.path,
      warnings,
    },
  };
}

/**
 * The view for `raw`. With `autoBudget` a crowded view (>= 12 connected boxes, more than 1.5 edges per box, see density.ts) is cut
 * again with budgets 3 boxes smaller, down to BUDGET_FLOOR. Rolling folders up often makes the picture denser per box, so a
 * smaller cut is only taken when it gets to 1.5 edges per box or lowers the ratio by at least 0.25; otherwise the original stays.
 */
export function aggregate(raw: RawGraph, opts: AggregateOptions = {}): View {
  const first = build(raw, opts);
  if (!opts.autoBudget || (opts.level ?? "auto") !== "auto" || (opts.expand?.length ?? 0) > 0) return first;
  if (!crowded(densityOf(first))) return first;
  const ratio = (v: View): number => {
    const d = densityOf(v);
    return d.edges / Math.max(1, d.boxes);
  };
  const start = first.summary.budget.max;
  const budgets: number[] = [];
  for (let b = start - 3; b >= BUDGET_FLOOR; b -= 3) budgets.push(b);
  if (start > BUDGET_FLOOR && !budgets.includes(BUDGET_FLOOR)) budgets.push(BUDGET_FLOOR);
  let best = first;
  for (const b of budgets) {
    const v = build(raw, { ...opts, maxNodes: b });
    if (ratio(v) <= EXTRACT_DENSE_RATIO) { best = v; break; }
    if (ratio(v) <= ratio(first) - 0.25 && ratio(v) < ratio(best)) best = v;
  }
  if (best !== first) best.summary.budget.dense = true;
  return best;
}
