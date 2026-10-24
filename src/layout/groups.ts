// Group (zone) bookkeeping for the dagre layout: the group tree, zone boxes computed bottom-up from the
// real child boxes, and the pass that pulls apart zones that ended up on top of something they do not
// contain (a zone widened for a long title, or padded round a node's self-loop, is wider than the
// space dagre reserved).

import type { Graph as Ast, Node as AstNode } from "../dsl/ast.js";
import type { Box, TextMetrics } from "./engine.js";
import { measure } from "./measure.js";

export const GROUP_PAD = 24;
const TITLE_FONT = 16;

export interface GroupInfo {
  id: string;
  parent?: string;
  title?: { text: TextMetrics };
  /** Room above the children inside the box (padding, plus the title when present). */
  topPad: number;
  nodes: string[];
  groups: string[];
}

export function union(boxes: Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Normalize the flat AST groups into GroupInfo (parents resolved, cycles and duplicates ignored). */
export function buildGroups(graph: Ast, known: Map<string, AstNode>): Map<string, GroupInfo> {
  const infos = new Map<string, GroupInfo>();
  for (const g of graph.groups) {
    if (infos.has(g.id)) continue;
    let title: GroupInfo["title"];
    let topPad = GROUP_PAD;
    if (g.title) {
      const text = measure(g.title, TITLE_FONT);
      title = { text };
      topPad = Math.max(GROUP_PAD, Math.ceil(text.height) + 18);
    }
    infos.set(g.id, { id: g.id, title, topPad, nodes: g.children.filter((id) => known.has(id)), groups: [] });
  }
  for (const g of graph.groups) {
    const info = infos.get(g.id)!;
    for (const child of g.groups) {
      const c = infos.get(child);
      if (!c || c.parent || child === g.id || isAncestor(infos, child, g.id)) continue;
      c.parent = g.id;
      info.groups.push(child);
    }
  }
  return infos;
}

function isAncestor(infos: Map<string, GroupInfo>, anc: string, of: string): boolean {
  for (let p: string | undefined = of; p; p = infos.get(p)?.parent) if (p === anc) return true;
  return false;
}

/** Parents before children, roots in declaration order. */
export function groupsPreorder(infos: Map<string, GroupInfo>): GroupInfo[] {
  const out: GroupInfo[] = [];
  const visit = (g: GroupInfo) => {
    out.push(g);
    for (const c of g.groups) visit(infos.get(c)!);
  };
  for (const g of infos.values()) if (!g.parent) visit(g);
  return out;
}

/** What a zone box is computed from. */
export interface GroupGeometry {
  infos: Map<string, GroupInfo>;
  ordered: GroupInfo[];
  /** Real node boxes (mutated by `separate`). */
  nodeBox: Map<string, Box>;
  /** Boxes of groups without members (movable like nodes). */
  emptyBox: Map<string, Box>;
  /** Extra room a node's surroundings need inside its zone (self-loops with their labels), relative to the node's top-left. */
  halo: Map<string, Box[]>;
}

/** Zone boxes bottom-up from the real child boxes; a zone is at least as wide as its title. */
export function groupBoxes(geo: GroupGeometry): Map<string, Box> {
  const out = new Map<string, Box>();
  const place = (g: GroupInfo): Box => {
    const known = out.get(g.id);
    if (known) return known;
    let box: Box;
    const empty = geo.emptyBox.get(g.id);
    if (empty) {
      box = { ...empty };
    } else {
      const parts: Box[] = [];
      for (const id of g.nodes) {
        const b = geo.nodeBox.get(id);
        if (b) parts.push(b, ...(geo.halo.get(id) ?? []).map((h) => ({ x: b.x + h.x, y: b.y + h.y, w: h.w, h: h.h })));
      }
      for (const id of g.groups) {
        const c = geo.infos.get(id);
        if (c) parts.push(place(c));
      }
      const u = union(parts);
      box = { x: u.x - GROUP_PAD, y: u.y - g.topPad, w: u.w + 2 * GROUP_PAD, h: u.h + g.topPad + GROUP_PAD };
      const needW = g.title ? Math.ceil(g.title.text.width + 32) : 0;
      if (box.w < needW) box = { ...box, x: box.x - Math.floor((needW - box.w) / 2), w: needW };
    }
    out.set(g.id, box);
    return box;
  };
  for (const g of geo.ordered) place(g);
  return out;
}

/** Every node and group id below each group (keys `n:id` / `g:id`). */
function subtrees(geo: GroupGeometry): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (g: GroupInfo): Set<string> => {
    const known = out.get(g.id);
    if (known) return known;
    const set = new Set<string>();
    out.set(g.id, set);
    for (const id of g.nodes) set.add(`n:${id}`);
    for (const id of g.groups) {
      set.add(`g:${id}`);
      for (const k of walk(geo.infos.get(id)!)) set.add(k);
    }
    return set;
  };
  for (const g of geo.ordered) walk(g);
  return out;
}

/** Ids of the nodes inside each group, nested groups included. */
export function memberSets(geo: GroupGeometry): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [id, set] of subtrees(geo)) out.set(id, new Set([...set].filter((k) => k.startsWith("n:")).map((k) => k.slice(2))));
  return out;
}

const depth = (a: Box, b: Box) => ({
  x: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
  y: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
});

/** Space kept between a zone and what it was pulled away from. */
const SEPARATION = 6;
const MAX_ROUNDS = 120;
/** Room kept between a node moved out of a zone by itself and the nodes around it, and the step it takes to find that room. */
const SOLO_GAP = 10;

/**
 * Pull apart every zone that overlaps a node or zone it does not contain: the whole far side is moved
 * rigidly along the axis of least penetration (a gap is inserted at the zone border), so rows and
 * columns stay aligned. Repeats until nothing overlaps (or MAX_ROUNDS), moving only nodes and empty groups.
 */
export function separate(geo: GroupGeometry): void {
  const inside = subtrees(geo);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const gb = groupBoxes(geo);
    let found: { z: Box; o: Box; px: number; py: number; sub: Set<string>; node?: string } | undefined;
    for (let i = 0; i < geo.ordered.length && !found; i++) {
      const z = geo.ordered[i]!;
      const zb = gb.get(z.id)!;
      const sub = inside.get(z.id)!;
      for (const [id, nb] of geo.nodeBox) {
        if (sub.has(`n:${id}`)) continue;
        const d = depth(zb, nb);
        if (d.x > 0 && d.y > 0) {
          found = { z: zb, o: nb, px: d.x, py: d.y, sub, node: id };
          break;
        }
      }
      if (found) break;
      for (let j = i + 1; j < geo.ordered.length; j++) {
        const o = geo.ordered[j]!;
        if (sub.has(`g:${o.id}`) || inside.get(o.id)!.has(`g:${z.id}`)) continue;
        const ob = gb.get(o.id)!;
        const d = depth(zb, ob);
        if (d.x > 0 && d.y > 0) {
          found = { z: zb, o: ob, px: d.x, py: d.y, sub };
          break;
        }
      }
    }
    if (!found) return;
    const { z, o, px, py, sub, node } = found;
    const start = (b: Box, alongX: boolean) => (alongX ? b.x : b.y);
    const end = (b: Box, alongX: boolean) => (alongX ? b.x + b.w : b.y + b.h);
    /** Boxes moved when `o` is pushed along an axis in a direction: it and everything beyond it. */
    const beyond = (alongX: boolean, sign: number): Array<[string, Box]> => {
      const cut = sign > 0 ? start(o, alongX) : end(o, alongX);
      const out: Array<[string, Box]> = [];
      for (const [id, b] of geo.nodeBox) if (sign > 0 ? start(b, alongX) >= cut - 0.5 : end(b, alongX) <= cut + 0.5) out.push([`n:${id}`, b]);
      for (const [id, b] of geo.emptyBox) if (sign > 0 ? start(b, alongX) >= cut - 0.5 : end(b, alongX) <= cut + 0.5) out.push([`g:${id}`, b]);
      return out;
    };
    const shift = (alongX: boolean, sign: number, by: number, boxes: Array<[string, Box]>) => {
      for (const [, b] of boxes) {
        if (alongX) b.x += sign * by;
        else b.y += sign * by;
      }
    };
    // The preferred push: along the axis of least penetration, away from the zone's center.
    const alongX = px <= py;
    const after = start(o, alongX) + end(o, alongX) >= start(z, alongX) + end(z, alongX);
    const sign = after ? 1 : -1;
    const pen = (alongX ? px : py) + SEPARATION;
    const first = beyond(alongX, sign);
    // Pushing is useless when it drags members of the zone along (a foreign node between its members):
    // then take the cheapest axis/direction that leaves them alone, else move that node by itself.
    const drags = (boxes: Array<[string, Box]>) => node !== undefined && boxes.some(([k]) => k !== `n:${node}` && sub.has(k));
    if (!drags(first)) {
      shift(alongX, sign, pen, first);
      continue;
    }
    let best: { ax: boolean; sg: number; by: number; boxes: Array<[string, Box]> } | undefined;
    let solo: { ax: boolean; sg: number; by: number } | undefined;
    for (const ax of [true, false]) {
      for (const sg of [1, -1]) {
        const by = sg > 0 ? end(z, ax) - start(o, ax) + SEPARATION : end(o, ax) - start(z, ax) + SEPARATION;
        const boxes = beyond(ax, sg);
        if (!drags(boxes) && (!best || by < best.by)) best = { ax, sg, by, boxes };
        // Moving a node by itself must not land it on another node: step further until it is clear.
        let moved = by;
        const clear = (d: number) => {
          const t = ax ? { ...o, x: o.x + sg * d } : { ...o, y: o.y + sg * d };
          for (const [id, b] of geo.nodeBox) if (id !== node && depth(t, b).x > -SOLO_GAP && depth(t, b).y > -SOLO_GAP) return false;
          return true;
        };
        while (!clear(moved) && moved < by + 40 * SOLO_GAP) moved += SOLO_GAP;
        if (!clear(moved)) continue;
        if (!solo || moved < solo.by) solo = { ax, sg, by: moved };
      }
    }
    if (best) shift(best.ax, best.sg, best.by, best.boxes);
    else if (node !== undefined && solo) shift(solo.ax, solo.sg, solo.by, [[`n:${node}`, o]]);
    else return;
  }
}
