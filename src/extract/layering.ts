// Layering of the drawn import DAG: how wide and how deep will a layered layout (dagre, ELK) make this view?
//
// Longest-path layering over the boxes that carry a drawn arrow: strongly connected components collapse to one vertex (a
// cycle cannot be layered), every vertex sits one layer below its lowest-placed importer, a source sits on layer 0.
// `width` (W) is the most vertices on one layer (a collapsed cycle is one vertex), `layers` (L) the layer count. The view is
// already hub-suppressed when it gets here, so the arrows the reader sees are the arrows layered.
//
// What the two numbers decide (density.ts, to-exd.ts): a wide layer makes the excalidraw router run long horizontal bundles
// (vitest-none: W 9, 4499x945 px, rejected by both reviewers; the accepted excalidraw views have W <= 7), a deep and narrow one
// (L > 1.5 W) reads better left to right (to-exd.ts emits `dir RIGHT` on d2).

import { cmp, sccsOf } from "./graph-ops.js";

export interface LayeringInput {
  edges: Array<{ from: string; to: string; stub: boolean }>;
}

export interface Layering {
  /** Vertices on the widest layer (a collapsed cycle counts as one). */
  width: number;
  /** Number of layers. */
  layers: number;
}

export function layeringOf(view: LayeringInput): Layering {
  const drawn = view.edges.filter((e) => !e.stub && e.from !== e.to);
  const keys = [...new Set(drawn.flatMap((e) => [e.from, e.to]))].sort(cmp);
  if (keys.length === 0) return { width: 0, layers: 0 };

  // collapse every cycle to one vertex (its smallest member stands for it)
  const rep = new Map<string, string>(keys.map((k) => [k, k]));
  const verts = new Set<string>();
  for (const comp of sccsOf(keys, drawn.map((e) => [e.from, e.to] as [string, string]))) {
    for (const k of comp) rep.set(k, comp[0] as string);
  }
  for (const k of keys) verts.add(rep.get(k) as string);

  const succ = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const v of verts) (succ.set(v, new Set()), indeg.set(v, 0));
  for (const e of drawn) {
    const a = rep.get(e.from) as string, b = rep.get(e.to) as string;
    if (a === b || (succ.get(a) as Set<string>).has(b)) continue;
    (succ.get(a) as Set<string>).add(b);
    indeg.set(b, (indeg.get(b) as number) + 1);
  }

  // Kahn's order, layer = longest path from a source
  const layer = new Map<string, number>();
  let ready = [...verts].filter((v) => indeg.get(v) === 0).sort(cmp);
  for (const v of ready) layer.set(v, 0);
  while (ready.length > 0) {
    const next: string[] = [];
    for (const v of ready) {
      for (const w of succ.get(v) as Set<string>) {
        layer.set(w, Math.max(layer.get(w) ?? 0, (layer.get(v) as number) + 1));
        indeg.set(w, (indeg.get(w) as number) - 1);
        if (indeg.get(w) === 0) next.push(w);
      }
    }
    ready = next.sort(cmp);
  }

  const perLayer = new Map<number, number>();
  for (const l of layer.values()) perLayer.set(l, (perLayer.get(l) ?? 0) + 1);
  return { width: Math.max(...perLayer.values()), layers: perLayer.size };
}
