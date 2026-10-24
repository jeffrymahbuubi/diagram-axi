// Mermaid rendering and checking in the shared page (KTD3): initialize config, option overrides,
// SVG finalization and the PNG screenshot.

import { detectKind } from "../detect.js";
import { AxiError } from "../../output/errors.js";
import { HARD_MAX_SIDE, MAX_PIXELS, MAX_SIDE } from "../../render/page.js";
import type { Diagnostic, EngineRenderOptions, EngineRenderResult, Kind } from "../types.js";
import { measure, type MermaidStats } from "./geometry.js";
import { checkInPage, prepareShot, renderInPage, type ElkOptions, type RawGeometry } from "./inpage.js";
import { MERMAID_FONT_FAMILY, getSession, type MermaidPage } from "./page.js";
import { DEFAULT_SIZING, growNodes, roundStadiums, type NodeMin, type Sizing } from "./sizing.js";
import { moveLabels, placeLabels } from "./labels.js";
import { alignTitles, moveTitles, titleBoxes } from "./titles.js";
import { frontmatterLines, mapError } from "./validate.js";

/** The id of the svg in the page: fixed, so a render does not depend on how many came before. */
export const SVG_ID = "dax";

/** Diagram kinds that take a `layout` (dagre or elk); a global `layout: elk` breaks mindmap (it needs its own loader). */
const LAYOUT_KINDS = new Set<Kind>(["graph", "state", "class", "erd"]);
const LAYOUTS = ["dagre", "elk"];

/** ELK layoutOptions added to every mermaid render (the page's hook merges them into the graph). */
export const ELK_OPTIONS: ElkOptions = {
  // a self-loop leaves its node by 30 px (ELK's default of 12 is not enough for the checker's 20 px)
  // an edge keeps 30 px from the nodes it passes (long edges ran 5-8 px from each other beside a node)
  // parallel edges and edges in one channel at least 26 px apart (the checker wants 20; ELK drew them exactly 20 apart)
  // ends of edges keep 14 px from the corners of a node (12 left two ends on neighbouring sides 16 px apart; 18 and more
  // reorders layers and starves the sizing of room)
  root: { "elk.spacing.nodeSelfLoop": 30, "elk.spacing.edgeEdge": 26, "elk.layered.spacing.edgeEdgeBetweenLayers": 26, "elk.spacing.edgeNode": 30, "elk.layered.spacing.edgeNodeBetweenLayers": 30, "elk.spacing.portsSurrounding": "[top=14,left=14,bottom=14,right=14]" },
  // (a node inside a subgraph takes its corner clearance from the subgraph: Mermaid sets 12 there)
  group: { "elk.spacing.nodeSelfLoop": 30, "elk.spacing.edgeEdge": 26, "elk.layered.spacing.edgeEdgeBetweenLayers": 26, "elk.spacing.edgeNode": 30, "elk.layered.spacing.edgeNodeBetweenLayers": 30, "elk.spacing.portsSurrounding": "[top=14,left=14,bottom=14,right=14]" },
  // spread the ends of the edges over the whole side of a node instead of packing them 3 px apart at its centre
  node: { "elk.portAlignment.default": "JUSTIFIED" },
};
/** Node growth for crowded sides (sizing.ts); undefined = nodes keep the size of their label. */
export const SIZING: Sizing | undefined = DEFAULT_SIZING;
/** Extra renders after the first that grow the nodes too small for their edge ends and labels (one more render places titles and labels: at most 3 per diagram). */
export const SIZING_PASSES = 1;

/** Move a subgraph title to the side where no edge crosses it (titles.ts); costs one more render when a title moves. */
export const TITLES = true;
/** Move an edge label that collides with something to a free spot of its own edge (labels.ts); shares the title render. */
export const LABELS = true;

interface Tuning {
  elk: ElkOptions;
  sizing: Sizing | undefined;
  titles: boolean;
  labels: boolean;
  passes: number;
}

/** The defaults, plus DIAGRAM_AXI_MERMAID_TUNE (JSON {elk?, sizing?}) for experiments. */
function tuning(): Tuning {
  const env = process.env.DIAGRAM_AXI_MERMAID_TUNE;
  if (!env) return { elk: ELK_OPTIONS, sizing: SIZING, titles: TITLES, labels: LABELS, passes: SIZING_PASSES };
  const x = JSON.parse(env) as { elk?: ElkOptions; sizing?: Partial<Sizing> | null; titles?: boolean; labels?: boolean; passes?: number };
  const sizing = x.sizing === undefined ? SIZING : x.sizing === null ? undefined : { ...DEFAULT_SIZING, ...x.sizing };
  return { elk: { root: { ...ELK_OPTIONS.root, ...x.elk?.root }, group: { ...ELK_OPTIONS.group, ...x.elk?.group }, node: { ...ELK_OPTIONS.node, ...x.elk?.node } }, sizing, titles: x.titles ?? TITLES, labels: x.labels ?? LABELS, passes: x.passes ?? SIZING_PASSES };
}

export interface ConfigOptions {
  kind?: Kind | undefined;
  layout?: string | undefined;
  sketch?: boolean | undefined;
  theme?: "light" | "dark" | undefined;
}

/** `mermaid.initialize` argument (KTD3). Frontmatter in the source still overrides it; see withOverrides. */
export function mermaidConfig(o: ConfigOptions = {}): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    deterministicIds: true,
    deterministicIDSeed: "diagram-axi",
    handDrawnSeed: 1,
    suppressErrorRendering: true,
    look: o.sketch ? "handDrawn" : "classic",
    ...(o.kind !== undefined && LAYOUT_KINDS.has(o.kind) ? { layout: o.layout ?? "elk" } : {}),
    ...(o.theme === "dark" ? { theme: "dark" } : {}),
    themeVariables: { fontFamily: MERMAID_FONT_FAMILY },
  };
}

/**
 * Flags the caller typed must beat the source's own frontmatter (`config: layout: elk` in a translated
 * file), so they are added as an `%%{init}%%` directive, which Mermaid applies after the frontmatter.
 * The source on disk is never rewritten; this is the in-memory text handed to Mermaid.
 */
export function withOverrides(source: string, o: ConfigOptions): { source: string; extraLines: number } {
  const init: Record<string, unknown> = {};
  if (o.layout !== undefined && o.kind !== undefined && LAYOUT_KINDS.has(o.kind)) init.layout = o.layout;
  if (o.sketch !== undefined) init.look = o.sketch ? "handDrawn" : "classic";
  if (o.theme === "dark") init.theme = "dark";
  if (Object.keys(init).length === 0) return { source, extraLines: 0 };
  const lines = source.split("\n");
  const at = frontmatterLines(source);
  lines.splice(at, 0, `%%{init: ${JSON.stringify(init)}}%%`);
  return { source: lines.join("\n"), extraLines: 1 };
}

/** Kind of a Mermaid source; undefined when its keyword is none of the eight kinds. */
export function kindOfSource(source: string): Kind | undefined {
  const d = detectKind("mmd", source);
  return d.from === "default" ? undefined : d.kind;
}

function checkLayout(layout: string | undefined): void {
  if (layout !== undefined && !LAYOUTS.includes(layout)) {
    throw new AxiError(`unknown Mermaid layout '${layout}'`, `use --layout ${LAYOUTS.join("|")}`);
  }
}

/** Throws the AxiError a failed render becomes (position, message, suggestion from the diagnostic). */
export class MermaidSourceError extends AxiError {
  constructor(readonly diagnostic: Diagnostic) {
    const at = diagnostic.line !== undefined ? ` at ${diagnostic.line}${diagnostic.col !== undefined ? `:${diagnostic.col}` : ""}` : "";
    super(`invalid Mermaid source${at}: ${diagnostic.message}`, diagnostic.suggestion ?? "run `check <file>` for the diagnostic");
  }
}

/** Parse, then render for real (parse misses render-time errors). Returns 0 or 1 diagnostics. */
export async function checkMermaid(source: string, o: { browserPath?: string; timeoutMs?: number; layout?: string } = {}): Promise<Diagnostic[]> {
  if (source.trim() === "") return [{ code: "empty-source", message: "the Mermaid source is empty", suggestion: "start with a diagram keyword such as flowchart TD" }];
  checkLayout(o.layout);
  const { page } = await getSession(o.browserPath, o.timeoutMs);
  const kind = kindOfSource(source);
  const res = await page.run(checkInPage, { source, config: mermaidConfig({ kind, layout: o.layout }), id: SVG_ID }, o.timeoutMs);
  return res.error ? [mapError(res.error, source)] : [];
}

export type MermaidRenderResult = EngineRenderResult & {
  kind: Kind | undefined;
  stats: MermaidStats;
  /** Milliseconds `mermaid.render` took in the page. */
  renderMs: number;
};

interface Finalized {
  svg: string;
  width: number;
  height: number;
}

/** Standalone SVG: explicit pixel size instead of `width="100%"` + max-width, and a background unless transparent. */
export function finalizeSvg(svg: string, background: string | undefined): Finalized {
  const open = /<svg\b[^>]*>/.exec(svg);
  const vb = open && /viewBox="([^"]+)"/.exec(open[0]);
  if (!open || !vb) return { svg, width: 0, height: 0 };
  const [, , w, h] = (vb[1] as string).split(/\s+/).map(Number) as [number, number, number, number];
  const width = Math.ceil(w);
  const height = Math.ceil(h);
  let tag = open[0].replace(/ width="[^"]*"/, "").replace(/ height="[^"]*"/, "").replace(/ style="[^"]*"/, "");
  const size = ` width="${width}" height="${height}"`;
  tag = /^<svg id="[^"]*"/.test(tag) ? tag.replace(/^(<svg id="[^"]*")/, `$1${size}`) : tag.replace("<svg", `<svg${size}`);
  if (background) tag = tag.replace(/>$/, ` style="background-color: ${background};">`);
  return { svg: svg.replace(open[0], tag), width, height };
}

/** Raster scale after the size caps (the 2048 px side cap yields only to an explicit --scale). */
export function effectiveScale(scale: number, width: number, height: number, exact: boolean): { scale: number; warning?: string } {
  const limit = exact ? HARD_MAX_SIDE : MAX_SIDE;
  const capped = Math.min(scale, limit / Math.max(1, width), limit / Math.max(1, height), Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
  if (capped >= scale * 0.999) return { scale };
  return { scale: capped, warning: `scale reduced from ${scale} to ${capped.toFixed(2)} to stay within ${limit} px / 64 MP` };
}

/** Renders in the shared session's page (started on first use). */
export async function renderMermaid(source: string, o: EngineRenderOptions = {}): Promise<MermaidRenderResult> {
  if (source.trim() === "") throw new MermaidSourceError({ code: "empty-source", message: "the Mermaid source is empty", suggestion: "start with a diagram keyword such as flowchart TD" });
  checkLayout(o.layout);
  const { page, browser } = await getSession(o.browserPath, o.timeoutMs ?? 30_000);
  return renderOn(page, browser, source, o);
}

/** One render in the page; a failure becomes the MermaidSourceError of the user's source. */
async function renderPass(
  page: MermaidPage,
  input: { source: string; config: Record<string, unknown>; elk: ElkOptions; nodeMin: NodeMin; titleAt?: Record<string, [number, number]>; labelAt?: Record<string, [number, number]> },
  timeoutMs: number,
  original: string,
  extraLines: number,
): Promise<{ svg: string; geometry: RawGeometry; ms: number }> {
  const out = await page.run(renderInPage, { ...input, id: SVG_ID, geometry: true }, timeoutMs);
  if (out.error) throw new MermaidSourceError(mapError(out.error, original, extraLines));
  if (out.svg === undefined || !out.geometry) throw new AxiError("Mermaid returned no SVG", "try again; if it persists, run `check` on the source");
  return { svg: out.svg, geometry: out.geometry, ms: out.ms };
}

/** Renders on a given page (a fresh page has no state from earlier renders). */
export async function renderOn(page: MermaidPage, browser: { name: string }, source: string, o: EngineRenderOptions = {}): Promise<MermaidRenderResult> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const kind = kindOfSource(source);
  const cfg: ConfigOptions = { kind, layout: o.layout, sketch: o.sketch, theme: o.theme };
  const { source: overridden, extraLines } = withOverrides(source, cfg);
  let text = overridden;

  const { elk, sizing, titles, labels, passes } = tuning();
  let nodeMin: NodeMin = {};
  let out: Awaited<ReturnType<typeof renderPass>>;
  let measured: ReturnType<typeof measure>;
  for (let pass = 0; ; pass++) {
    out = await renderPass(page, { source: text, config: mermaidConfig(cfg), elk, nodeMin }, timeoutMs, source, extraLines);
    measured = measure(out.geometry);
    const grown = sizing && measured.kind === "graph" && pass < passes ? growNodes(measured.neutral, nodeMin, sizing) : undefined;
    if (!grown) break;
    nodeMin = grown;
    text = roundStadiums(overridden, Object.keys(grown));
  }
  // Titles and labels do not move anything else, so one more render with them in place keeps the layout just measured.
  if (measured.kind === "graph" && (titles || labels)) {
    const shifts = titles ? alignTitles(measured.neutral) : undefined;
    const labelAt = labels ? moveLabels(measured.neutral, out.svg, placeLabels(measured.neutral, titleBoxes(measured.neutral, shifts))) : undefined;
    const titleAt = moveTitles(out.svg, SVG_ID, shifts);
    if (titleAt || labelAt) {
      out = await renderPass(page, { source: text, config: mermaidConfig(cfg), elk, nodeMin, titleAt, labelAt }, timeoutMs, source, extraLines);
      measured = measure(out.geometry);
    }
  }

  const dark = o.theme === "dark";
  const background = o.transparent ? undefined : dark ? "#1e1e1e" : "#ffffff";
  const fin = finalizeSvg(out.svg, background);
  const { neutral, stats, kind: drawn } = measured;
  const result: MermaidRenderResult = { svg: fin.svg, width: fin.width, height: fin.height, browser: browser.name, neutral, kind: drawn ?? kind, stats, renderMs: out.ms };

  if (o.png) {
    const eff = effectiveScale(o.scale ?? 1, fin.width, fin.height, o.exactScale === true);
    await page.run(prepareShot, { svg: fin.svg, scale: eff.scale, background: background ?? "transparent" }, timeoutMs);
    const png = await page.screenshot(o.transparent === true);
    result.png = png;
    result.width = png.readUInt32BE(16);
    result.height = png.readUInt32BE(20);
    if (eff.warning) result.warning = eff.warning;
  }
  return result;
}
