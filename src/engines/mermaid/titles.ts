// Subgraph titles (U10): Mermaid centres a title at the top of its frame, which is where edges enter the
// subgraph, so an edge often runs through the text. The title may sit at the left, the middle or the right of
// the frame, at the top or (when every top place is crossed) in the bottom padding, at no cost to the layout
// (the frame is as big whatever the title's place), so after a render the engine picks, per subgraph, the place
// where no edge crosses it and renders once more with those places (window.__axiTitleAt: the translate of each
// moved title, honoured by the patch in scripts/build-mermaid.mjs).

import type { NeutralBox, NeutralScene } from "../neutral.js";

/** Zone id -> [dx, dy] px its title box moves; zones that keep their title where Mermaid put it are not listed. */
export type TitleShifts = Record<string, [number, number]>;

/** Px between the frame's side and the title box. */
const SIDE = 6;
/** Px between the frame's bottom and a title box placed there. */
const BOTTOM = 3;

/** Whether the segment p-q crosses the box (inside counts; touching the border does not). */
export function segmentHitsBox(p: [number, number], q: [number, number], b: NeutralBox): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const clip = (d: number, lo: number): boolean => {
    // constraint: lo + d * t >= 0
    if (d === 0) return lo > 0;
    const t = -lo / d;
    if (d > 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(dx, p[0] - b.x) && clip(-dx, b.x + b.w - p[0]) && clip(dy, p[1] - b.y) && clip(-dy, b.y + b.h - p[1]) && t1 - t0 > 1e-9;
}

const overlaps = (a: NeutralBox, b: NeutralBox): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * How far each title moves to leave the edges alone: the box goes to the left, the middle or the right of its
 * frame at the top (left first, then the middle, then right; the fewest edge segments through it wins), and when
 * every top place is crossed to the bottom of the frame (same order), where it must also clear every node.
 * Undefined when no title moves.
 */
export function alignTitles(scene: NeutralScene): TitleShifts | undefined {
  const zones = new Map(scene.nodes.filter((n) => n.kind === "zone").map((n) => [n.id, n.box] as const));
  const nodes = scene.nodes.filter((n) => n.kind === "node").map((n) => n.box);
  const out: TitleShifts = {};
  const hitsOf = (box: NeutralBox): number => {
    let hits = 0;
    for (const e of scene.edges) for (let i = 1; i < e.poly.length; i++) if (segmentHitsBox(e.poly[i - 1] as [number, number], e.poly[i] as [number, number], box)) hits++;
    return hits;
  };
  for (const l of scene.labels) {
    const zone = zones.get(l.ownerId);
    if (!zone) continue;
    if (zone.w < l.box.w + 24) continue; // no room to move
    const at = (x: number, y: number): NeutralBox => ({ x, y: y + 1, w: l.box.w, h: l.box.h - 2 });
    const first = zone.x + SIDE;
    const last = zone.x + zone.w - l.box.w - SIDE;
    // left, middle, right come first (ties keep them), then every 20 px in between for a gap among the edges
    const xs = [first, l.box.x, last];
    for (let x = first + 20; x < last; x += 20) xs.push(x);
    const best = (y: number, clear: boolean): { box: NeutralBox; hits: number } | undefined => {
      let pick: { box: NeutralBox; hits: number } | undefined;
      for (const x of xs) {
        const box = at(x, y);
        if (clear && nodes.some((n) => overlaps(box, n))) continue;
        const hits = hitsOf(box);
        if (!pick || hits < pick.hits) pick = { box, hits };
      }
      return pick;
    };
    let pick = best(l.box.y, false);
    if (pick && pick.hits > 0) {
      const bottom = best(zone.y + zone.h - l.box.h - BOTTOM, true);
      if (bottom && bottom.hits < pick.hits) pick = bottom;
    }
    if (pick && (Math.abs(pick.box.x - l.box.x) > 0.01 || Math.abs(pick.box.y - 1 - l.box.y) > 0.01)) {
      out[l.ownerId] = [Math.round((pick.box.x - l.box.x) * 100) / 100, Math.round((pick.box.y - 1 - l.box.y) * 100) / 100];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The title moves of alignTitles (`shifts`) as the translate each label is drawn at: the translate of its `cluster-label`
 * in `svg` (the render they were measured on, whose svg id is `svgId`) plus the move. Undefined when none moves.
 */
export function moveTitles(svg: string, svgId: string, shifts: TitleShifts | undefined): Record<string, [number, number]> | undefined {
  if (!shifts) return undefined;
  const out: Record<string, [number, number]> = {};
  const re = new RegExp(`<g class="cluster[^"]*" id="${svgId}-([^"]+)"[^>]*>(?:(?!<g class="cluster[ "]).)*?<g class="cluster-label[^"]*" transform="translate\\(([-0-9.e]+),\\s*([-0-9.e]+)\\)`, "gs");
  for (const m of svg.matchAll(re)) {
    const d = shifts[m[1] as string];
    if (d !== undefined) out[m[1] as string] = [Math.round((Number(m[2]) + d[0]) * 100) / 100, Math.round((Number(m[3]) + d[1]) * 100) / 100];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The zone title boxes as they will be drawn once `shifts` (from alignTitles) are applied. */
export function titleBoxes(scene: NeutralScene, shifts: TitleShifts | undefined): Record<string, NeutralBox> {
  const zones = new Set(scene.nodes.filter((n) => n.kind === "zone").map((n) => n.id));
  const out: Record<string, NeutralBox> = {};
  for (const l of scene.labels) {
    if (!zones.has(l.ownerId)) continue;
    const d = shifts?.[l.ownerId] ?? [0, 0];
    out[l.ownerId] = { x: l.box.x + d[0], y: l.box.y + d[1], w: l.box.w, h: l.box.h };
  }
  return out;
}
