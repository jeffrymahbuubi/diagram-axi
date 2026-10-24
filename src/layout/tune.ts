// Layout tuning in two profiles. "strict" is what the router aims for (a 24 px stub before every arrowhead, 28 px
// between an arrowhead and the next arrow's tail, 18 px track pitch, 10 px clearance from nodes); it needs room, and on
// a crowded diagram it can leave a HARD defect that the looser round-3 numbers would have avoided. The layout therefore
// runs "strict" first and, only when a HARD defect is left, tries again with "legacy" and keeps the better of the two
// (layout() in dagre-layout.ts). Every module reads `T.<name>` at the point of use, so switching is one assignment.

export interface Tune {
  /** Clearance kept between a route and the nodes it passes. */
  clearance: number;
  /** Straight run every arrow keeps before its arrowhead / after its start. */
  finalStub: number;
  /** Parallel segments closer than this (and overlapping) count as sharing a track. */
  trackGap: number;
  /** Distance between the rails (middle runs of Z routes) of neighbouring edges. */
  railPitch: number;
  /** Distance between neighbouring ports on one node side. */
  portPitch: number;
  /** Ports keep this far from the corners of their node. */
  cornerClear: number;
  /** Rails stay this far from the two end ports along the run. */
  railMargin: number;
  /** A* : parallel runs closer than this to a placed route are priced; stub length of its ports; lanes laid beside placed runs. */
  shareGap: number;
  astarStub: number;
  maxLanes: number;
  /** Repair: clearance levels of the A* detours, port spacing and offsets, stub of a candidate port. */
  margins: number[];
  portOffsets: number[];
  /** Whether the relaxed (short stub, tight pitch) port tier is tried when the strict one offers no route. */
  relaxedTier: boolean;
  /** A slanted run is kept when its cross-axis drift is at most this share of its length; price of a slanted candidate. */
  straightSlope: number;
  diagonalCost: number;
  /** Whether routeEdges asks the A* router for a detour when no orthogonal candidate is clean. */
  astarFallback: boolean;
  /** Prices (in crossings) of a crossed arrowhead / a short stub in a route's score; of a label over its own arrowhead. */
  headCross: number;
  stubCost: number;
  headCover: number;
  /** Price of a label box lying over (any of) an arrowhead's footprint, own or foreign (labels.ts, repair.ts). */
  headFoot: number;
  /** Whether the polish pass (repair.ts) runs after repair. */
  polish: boolean;
  /** A* price per px of a run within 12 px of the side of one of the route's own nodes (it then reads like a self-loop). */
  hugCost: number;
  /** Whether the rank gap grows with the extent of the edge labels along the flow (route.ts portDemand). */
  labelSep: boolean;
  /** Margin and price of a foreign arrow close to a label box (label placement and repair). */
  nearArrowPad: number;
  nearArrowPrice: number;
  /** Self-loops: distance of the loop's ends from the node corners, room reserved for a labelled loop, label-hides-run price. */
  loopCorner: number;
  loopMinQ: number;
  loopGrow: boolean;
  loopRunSlack: number;
  loopRunPrice: number;
  /** Fan rails: the gap between ranks holds two final stubs plus the rails (true), or the old 36 px plus one more rail's room (false). */
  fanStubs: boolean;
}

export const STRICT: Tune = {
  clearance: 10,
  finalStub: 24,
  trackGap: 17.5,
  railPitch: 18,
  portPitch: 28,
  cornerClear: 20,
  railMargin: 24,
  shareGap: 18,
  astarStub: 24,
  maxLanes: 8,
  margins: [14, 28, 44],
  portOffsets: [0, 28, -28, 56, -56, 84, -84],
  relaxedTier: true,
  straightSlope: 0.15,
  diagonalCost: 14,
  astarFallback: true,
  headCross: 3,
  stubCost: 2,
  headCover: 350,
  headFoot: 500,
  polish: true,
  hugCost: 5,
  labelSep: true,
  nearArrowPad: 8,
  nearArrowPrice: 60,
  loopCorner: 20,
  loopMinQ: 14,
  loopGrow: true,
  loopRunSlack: 28,
  loopRunPrice: 60,
  fanStubs: true,
};

export const LEGACY: Tune = {
  clearance: 4,
  finalStub: 12,
  trackGap: 13.5,
  railPitch: 14,
  portPitch: 20,
  cornerClear: 14,
  railMargin: 12,
  shareGap: 10,
  astarStub: 12,
  maxLanes: 0,
  margins: [10, 26, 44],
  portOffsets: [0, 22, -22, 44, -44, 66, -66],
  relaxedTier: false,
  straightSlope: 0.7,
  diagonalCost: 5,
  astarFallback: false,
  headCross: 0,
  stubCost: 0,
  headCover: 0,
  headFoot: 0,
  polish: false,
  hugCost: 0,
  labelSep: false,
  nearArrowPad: 3,
  nearArrowPrice: 10,
  loopCorner: 14,
  loopMinQ: 8,
  loopGrow: false,
  loopRunSlack: 10,
  loopRunPrice: 40,
  fanStubs: false,
};

/** The profile in force; layout() switches it with useProfile and always restores "strict". */
export const T: Tune = { ...STRICT };

export function useProfile(p: "strict" | "legacy"): void {
  Object.assign(T, p === "strict" ? STRICT : LEGACY);
}
