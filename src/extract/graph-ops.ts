// Graph helpers for aggregate.ts: rolled edges, strongly connected components, the focus BFS and hub suppression.
// Pure functions over keys and edge lists; nothing here knows about files or the containment tree.

import { MAX_DEGREE } from "../lint/rules.js";

/** Arrows from collapsed folders that stay drawn into an entry/focus hub. */
const KEEP_FOLDER_ARROWS = 3;

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface LiveEdge { from: string; to: string; typeOnly: boolean; dynamic: boolean; line: number }

export interface Rolled { from: string; to: string; weight: number; types: number; dyn: number; evidence: Array<{ path: string; line: number }> }

/** Tarjan SCC (iterative); components of size >= 2, members sorted, components sorted. */
export function sccsOf(nodes: string[], edges: Array<[string, string]>): string[][] {
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) if (a !== b) adj.get(a)?.push(b);
  for (const l of adj.values()) l.sort(cmp);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const root of [...nodes].sort(cmp)) {
    if (index.has(root)) continue;
    const work: Array<{ n: string; i: number }> = [{ n: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const top = work[work.length - 1] as { n: string; i: number };
      const next = (adj.get(top.n) ?? [])[top.i++];
      if (next !== undefined) {
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter++);
          stack.push(next);
          onStack.add(next);
          work.push({ n: next, i: 0 });
        } else if (onStack.has(next)) low.set(top.n, Math.min(low.get(top.n) as number, index.get(next) as number));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.n, Math.min(low.get(parent.n) as number, low.get(top.n) as number));
      if (low.get(top.n) === index.get(top.n)) {
        const comp: string[] = [];
        for (let m: string | undefined; m !== top.n; ) {
          m = stack.pop() as string;
          onStack.delete(m);
          comp.push(m);
        }
        if (comp.length > 1) out.push(comp.sort(cmp));
      }
    }
  }
  return out.sort((a, b) => cmp(a[0] as string, b[0] as string));
}

/** BFS over live edges from the focus files; returns the reached set. */
export function bfs(starts: string[], live: LiveEdge[], depth: number, dir: "out" | "in" | "both"): Set<string> {
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const e of live) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from))?.push(e.to);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to))?.push(e.from);
  }
  const seen = new Set(starts);
  let frontier = [...starts];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      const ns = [...(dir !== "in" ? out.get(f) ?? [] : []), ...(dir !== "out" ? inn.get(f) ?? [] : [])];
      for (const n of ns) if (!seen.has(n)) (seen.add(n), next.push(n));
    }
    frontier = next;
  }
  return seen;
}

export const degree = (list: Rolled[]): Map<string, number> => {
  const d = new Map<string, number>();
  for (const r of list) (d.set(r.from, (d.get(r.from) ?? 0) + 1), d.set(r.to, (d.get(r.to) ?? 0) + 1));
  return d;
};

export interface HubPass {
  edgesLeft: Rolled[];
  /** Hub keys in the order they were taken. */
  hubOrder: string[];
  /** Hub key -> its fan-out before the cap, for hubs that were capped. */
  capped: Map<string, number>;
  hubEdges: Array<{ from: string; to: string; weight: number }>;
  hubDropped: number;
}

/**
 * Hub suppression over the rolled edges. `hide` takes the busiest node (degree > MAX_DEGREE), drops its incoming edges (except
 * those from `keepFrom`, the focus file and the entry) and caps its fan-out; otherwise hubs are only identified.
 */
export function suppressHubs(rolledList: Rolled[], keys: string[], hide: boolean, keepFrom: ReadonlySet<string>): HubPass {
  // The entry and the focus file are the boxes the reader starts from: when one is a hub, the heaviest arrows from collapsed
  // folders (`examples/ (18 files)`) into it stay drawn, so those folders are not left floating.
  const keepInto = new Set<Rolled>();
  for (const h of keepFrom) {
    const folders = rolledList.filter((r) => r.to === h && /^(dir|rest):/.test(r.from));
    for (const r of folders.sort((x, y) => y.weight - x.weight || cmp(x.from, y.from)).slice(0, KEEP_FOLDER_ARROWS)) keepInto.add(r);
  }
  const hubEdges: HubPass["hubEdges"] = [];
  const hubOrder: string[] = [];
  const capped = new Map<string, number>();
  let edgesLeft = rolledList;
  let hubDropped = 0;
  if (hide) {
    const drop = (r: Rolled): boolean => (hubDropped += r.weight, hubEdges.push({ from: r.from, to: r.to, weight: r.weight }), false);
    for (;;) {
      const d = degree(edgesLeft);
      let worst: string | undefined;
      for (const k of keys) if (!hubOrder.includes(k) && (d.get(k) ?? 0) > MAX_DEGREE && (worst === undefined || (d.get(k) as number) > (d.get(worst) as number))) worst = k;
      if (worst === undefined) break;
      const h = worst;
      hubOrder.push(h);
      // the focus file's and the entry's own imports stay drawn, so the box that marks them never floats edge-less
      edgesLeft = edgesLeft.filter((r) => r.to !== h || keepFrom.has(r.from) || keepInto.has(r) || drop(r));
      const outs = edgesLeft.filter((r) => r.from === h);
      const room = MAX_DEGREE - edgesLeft.filter((r) => r.to === h).length; // incoming edges kept above count against the degree
      if (outs.length > room) {
        capped.set(h, outs.length);
        const keep = new Set([...outs].sort((x, y) => y.weight - x.weight || cmp(x.to, y.to)).slice(0, room));
        edgesLeft = edgesLeft.filter((r) => r.from !== h || keep.has(r) || drop(r));
      }
    }
  } else {
    const d = degree(rolledList);
    hubOrder.push(...keys.filter((k) => (d.get(k) ?? 0) > MAX_DEGREE));
  }
  hubEdges.sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to));
  return { edgesLeft, hubOrder, capped, hubEdges, hubDropped };
}

