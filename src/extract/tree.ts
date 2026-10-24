// Containment tree and the budgeted cut (plan section 2, step 2). Pure helpers for aggregate.ts.

import type { ViewGroup, ViewKind } from "./aggregate.js";

export interface TNode {
  /** Full posix path (the deepest directory of a compressed single-child chain). */
  path: string;
  dir: boolean;
  parent?: TNode;
  kids: TNode[];
  depth: number;
  /** Source files in the subtree (1 for a file). */
  files: number;
  loc: number;
  /** Weighted degree: live edges with exactly one endpoint inside the subtree. */
  cross: number;
}

export interface CutNode {
  key: string;
  kind: ViewKind;
  path: string;
  label: string;
  group?: string;
  files: number;
  loc: number;
}

export interface CutOptions {
  budget: number;
  level: "auto" | "file" | "dir";
  forced: TNode[];
  group: boolean;
  maxDepth: number;
  /** Tree paths (files or directories) that are left out entirely: they cost no budget and get no box (isolated). */
  skip?: ReadonlySet<string>;
  /** Directories that stay collapsed in the automatic cut (their children are mostly hub importers); `level: file` and `forced` still open them. */
  noExpand?: ReadonlySet<string>;
  /** File paths that must stay visible when the root has to be bucketed (the entry and the focus file). */
  pinned?: readonly string[];
}

export interface Cut {
  nodes: CutNode[];
  groups: ViewGroup[];
  /** Source file path -> key of the visible node that represents it. */
  repOf: Map<string, string>;
  /** Visible node key -> tree paths it stands for (a `rest` bucket stands for several). */
  members: Map<string, string[]>;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byPath = (a: TNode, b: TNode): number => cmp(a.path, b.path);
const rel = (path: string, base: string): string => (base === "" ? path : path.slice(base.length + 1));
const score = (n: TNode): number => n.files * (1 + n.cross);

/** Builds the tree rooted at the common directory prefix of `files`; single-child directory chains are merged. */
export function buildTree(files: Map<string, { loc: number }>, live: Array<{ from: string; to: string }>): TNode {
  const paths = [...files.keys()].sort(cmp);
  let prefix: string[] | undefined;
  for (const p of paths) {
    const dirs = p.split("/").slice(0, -1);
    if (!prefix) prefix = dirs;
    else {
      let i = 0;
      while (i < prefix.length && prefix[i] === dirs[i]) i++;
      prefix = prefix.slice(0, i);
    }
  }
  const base = prefix ?? [];
  const root: TNode = { path: base.join("/"), dir: true, kids: [], depth: 0, files: 0, loc: 0, cross: 0 };
  const dirs = new Map<string, TNode>([[root.path, root]]);
  const leaf = new Map<string, TNode>();
  for (const p of paths) {
    const segs = p.split("/");
    let cur = root;
    for (let i = base.length; i < segs.length; i++) {
      const sub = segs.slice(0, i + 1).join("/");
      const isFile = i === segs.length - 1;
      let n = isFile ? undefined : dirs.get(sub);
      if (!n) {
        n = { path: sub, dir: !isFile, parent: cur, kids: [], depth: 0, files: 0, loc: 0, cross: 0 };
        cur.kids.push(n);
        if (isFile) leaf.set(p, n);
        else dirs.set(sub, n);
      }
      cur = n;
    }
  }
  const finish = (n: TNode, depth: number): void => {
    for (const k of n.kids) {
      while (k.dir && k.kids.length === 1 && (k.kids[0] as TNode).dir) {
        const c = k.kids[0] as TNode;
        k.path = c.path;
        k.kids = c.kids;
        for (const g of k.kids) g.parent = k;
      }
    }
    n.kids.sort(byPath);
    n.depth = depth;
    for (const k of n.kids) finish(k, depth + 1);
    if (!n.dir) { n.files = 1; return; }
    n.files = n.kids.reduce((s, k) => s + k.files, 0);
  };
  finish(root, 0);
  for (const [p, n] of leaf) n.loc = files.get(p)?.loc ?? 0;
  const sumLoc = (n: TNode): number => (n.loc = n.dir ? n.kids.reduce((s, k) => s + sumLoc(k), 0) : n.loc);
  sumLoc(root);
  for (const e of live) {
    let a = leaf.get(e.from), b = leaf.get(e.to);
    while (a && b && a !== b) {
      if (a.depth >= b.depth) { a.cross++; a = a.parent; } else { b.cross++; b = b.parent; }
    }
  }
  return root;
}

/** Focus start files: an exact file path, or every file under a directory path. */
export function resolveFocus(focus: string, sortedPaths: string[]): string[] {
  const f = focus.replace(/\/+$/, "").replace(/^\.\//, "");
  if (sortedPaths.includes(f)) return [f];
  if (f === "" || f === ".") return sortedPaths;
  return sortedPaths.filter((p) => p.startsWith(`${f}/`));
}

/** The (shallowest) directory node covering `path`; a compressed chain matches any of its segments. */
export function resolveDir(root: TNode, path: string): TNode | undefined {
  const p = path.replace(/\/+$/, "").replace(/^\.\//, "");
  for (const k of root.kids) {
    if (!k.dir) continue;
    if (k.path === p || k.path.startsWith(`${p}/`)) return k;
    if (p.startsWith(`${k.path}/`)) { const d = resolveDir(k, p); if (d) return d; }
  }
  return undefined;
}

export function filesUnder(n: TNode, out: string[] = []): string[] {
  if (!n.dir) out.push(n.path);
  else for (const k of n.kids) filesUnder(k, out);
  return out;
}

/** Adds to `skip` every directory whose children are all skipped (bottom-up); the root itself is never added. */
export function closeSkips(root: TNode, skip: Set<string>): void {
  const visit = (n: TNode): boolean => {
    if (n !== root && skip.has(n.path)) return true;
    if (!n.dir) return false;
    let all = n.kids.length > 0;
    for (const k of n.kids) if (!visit(k)) all = false;
    if (all && n !== root) skip.add(n.path);
    return all;
  };
  visit(root);
}

/** Every node of the tree by path (the root included). */
export function indexTree(root: TNode): Map<string, TNode> {
  const out = new Map<string, TNode>();
  const walk = (n: TNode): void => {
    out.set(n.path, n);
    for (const k of n.kids) walk(k);
  };
  walk(root);
  return out;
}

/** The outermost skipped files and directories, in tree order. */
export function skippedItems(root: TNode, skip: ReadonlySet<string>): Array<{ path: string; kind: "file" | "dir"; files: number }> {
  const out: Array<{ path: string; kind: "file" | "dir"; files: number }> = [];
  const walk = (n: TNode): void => {
    for (const k of n.kids) {
      if (skip.has(k.path)) out.push({ path: k.path, kind: k.dir ? "dir" : "file", files: k.files });
      else if (k.dir) walk(k);
    }
  };
  walk(root);
  return out;
}

const plural = (n: number): string => `${n} ${n === 1 ? "file" : "files"}`;

export function cutTree(root: TNode, o: CutOptions): Cut {
  const skip = o.skip ?? new Set<string>();
  const live = (n: TNode): TNode[] => (skip.size === 0 ? n.kids : n.kids.filter((k) => !skip.has(k.path)));
  const pinned = (n: TNode): boolean => (o.pinned ?? []).some((p) => p === n.path || p.startsWith(`${n.path}/`));
  const rank = (a: TNode, b: TNode): number => Number(pinned(b)) - Number(pinned(a)) || score(b) - score(a) || byPath(a, b);
  const closed = (n: TNode): boolean => !n.dir || (o.noExpand?.has(n.path) ?? false);
  /** Expanded directories that show only their best children plus one `+N more files` box. */
  const partial = new Map<TNode, TNode[]>();
  const expanded = new Set<TNode>();
  let visible = new Set<TNode>(live(root));
  const expand = (n: TNode): void => {
    expanded.add(n);
    visible.delete(n);
    for (const k of live(n)) visible.add(k);
  };
  const bucket: TNode[] = [];

  if (o.level === "file") {
    for (const n of [...visible]) if (n.dir) expand(n);
    for (let more = true; more; ) {
      more = false;
      for (const n of [...visible]) if (n.dir) { expand(n); more = true; }
    }
  } else if (o.forced.length === 0 && live(root).length > o.budget) {
    const kids = live(root);
    const ranked = [...kids].sort(rank);
    const keep = new Set(ranked.slice(0, Math.max(0, o.budget - 1)));
    visible = new Set(kids.filter((k) => keep.has(k)));
    bucket.push(...kids.filter((k) => !keep.has(k)));
  } else {
    for (const f of o.forced) {
      const chain: TNode[] = [];
      for (let n: TNode | undefined = f; n && n !== root; n = n.parent) chain.unshift(n);
      for (const n of chain) if (n.dir && !expanded.has(n) && visible.has(n)) expand(n);
    }
    if (o.level === "auto") {
      for (;;) {
        let best: TNode | undefined;
        for (const n of visible) {
          if (closed(n) || visible.size - 1 + live(n).length > o.budget) continue;
          if (!best || score(n) > score(best) || (score(n) === score(best) && byPath(n, best) < 0)) best = n;
        }
        if (!best) break;
        expand(best);
      }
      // Budget left over but no folder fits whole: open the best one with its best children and a `+N more files` box.
      const free = o.budget - visible.size;
      if (free >= 3) {
        let cand: TNode | undefined;
        for (const n of visible) {
          if (closed(n) || live(n).length <= free + 1) continue;
          if (!cand || score(n) > score(cand) || (score(n) === score(cand) && byPath(n, cand) < 0)) cand = n;
        }
        if (cand) {
          const kids = live(cand);
          const top = new Set([...kids].sort(rank).slice(0, free));
          expanded.add(cand);
          visible.delete(cand);
          for (const k of kids) if (top.has(k)) visible.add(k);
          partial.set(cand, kids.filter((k) => !top.has(k)));
        }
      }
    }
  }

  const nodes: CutNode[] = [];
  const groups: ViewGroup[] = [];
  const repOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  const addLeaf = (n: TNode, grp: TNode | undefined): void => {
    const base = grp ? grp.path : root.path;
    const key = `${n.dir ? "dir" : "file"}:${n.path}`;
    nodes.push({
      key, kind: n.dir ? "dir" : "file", path: n.path,
      label: n.dir ? `${rel(n.path, base)}/ (${plural(n.files)})` : rel(n.path, base),
      ...(grp ? { group: `grp:${grp.path}` } : {}), files: n.files, loc: n.loc,
    });
    for (const f of filesUnder(n)) repOf.set(f, key);
    members.set(key, [n.path]);
  };
  const place = (n: TNode, grp: TNode | undefined, gdepth: number): void => {
    for (const k of live(n)) {
      if (expanded.has(k)) {
        if (o.group && gdepth < o.maxDepth) {
          groups.push({ key: `grp:${k.path}`, path: k.path, label: rel(k.path, grp ? grp.path : root.path), ...(grp ? { parent: `grp:${grp.path}` } : {}) });
          place(k, k, gdepth + 1);
        } else place(k, grp, gdepth);
      } else if (visible.has(k)) addLeaf(k, grp);
    }
    const hidden = partial.get(n);
    if (hidden && hidden.length > 0) {
      const key = `rest:${n.path}`;
      const files = hidden.reduce((s, k) => s + k.files, 0);
      const more = `+${files} more ${files === 1 ? "file" : "files"}`;
      nodes.push({
        key, kind: "rest", path: n.path, label: grp === n ? more : `${rel(n.path, grp ? grp.path : root.path)}/ ${more}`,
        ...(grp ? { group: `grp:${grp.path}` } : {}), files, loc: hidden.reduce((s, k) => s + k.loc, 0),
      });
      for (const k of hidden) for (const f of filesUnder(k)) repOf.set(f, key);
      members.set(key, hidden.map((k) => k.path));
    }
  };
  place(root, undefined, 0);
  if (bucket.length > 0) {
    const key = `rest:${root.path}`;
    const files = bucket.reduce((s, k) => s + k.files, 0);
    nodes.push({ key, kind: "rest", path: root.path, label: `+${files} more ${files === 1 ? "file" : "files"}`, files, loc: bucket.reduce((s, k) => s + k.loc, 0) });
    for (const k of bucket) for (const f of filesUnder(k)) repOf.set(f, key);
    members.set(key, bucket.map((k) => k.path));
  }
  return { nodes, groups, repOf, members };
}
