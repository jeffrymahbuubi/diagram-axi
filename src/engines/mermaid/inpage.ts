// Functions Playwright serializes into the Mermaid page. They must not reference anything outside
// themselves (no imports, no module constants); everything they need comes in through the argument.
// `window.mermaid` is the bundle from scripts/build-mermaid.mjs.

export interface RawBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What went wrong in the page: enough to build a Diagnostic without the Error object. */
export interface RawError {
  phase: "parse" | "render";
  name: string;
  ctor: string;
  message: string;
  /** Jison parse errors: `hash.loc` (first_line 1-based, first_column 0-based). */
  locLine?: number;
  locCol?: number;
  /** Jison lexical errors: `hash.line` is 0-based. */
  hashLine?: number;
}

export interface RawNode {
  /** Candidate names edges may use for this node (`A` and `entity-A-0` for an ER entity). */
  keys: string[];
  zone: boolean;
  box: RawBox;
  /** Tag of the shape element (rect, circle, polygon, path, g). */
  tag: string;
  /** Number of points of a polygon (4 = diamond). */
  sides?: number;
  /** From the path commands: a cylinder draws arcs (a), a stadium cubic curves (C). */
  curve?: "arc" | "cubic";
  text?: string;
  label?: RawBox;
}

export interface RawEdge {
  dataId: string;
  /** Present when the page knows the ends (sequence diagrams); else they are parsed from `dataId`. */
  src?: string;
  dst?: string;
  poly: [number, number][];
  label?: RawBox;
  text?: string;
  startArrow: boolean;
  endArrow: boolean;
}

export interface RawGeometry {
  /** `aria-roledescription` of the svg: flowchart-v2, sequence, classDiagram, er, stateDiagram, ... */
  role: string;
  viewBox: [number, number, number, number];
  nodes: RawNode[];
  edges: RawEdge[];
  /** Per-kind counts (participants, messages, commits, ...). */
  stats: Record<string, number>;
}

/** ELK layoutOptions for the root graph, every subgraph and every plain node (see the hook in scripts/build-mermaid.mjs). */
export interface ElkOptions {
  root?: Record<string, string | number | boolean>;
  group?: Record<string, string | number | boolean>;
  node?: Record<string, string | number | boolean>;
}

export interface InPageInput {
  source: string;
  config: Record<string, unknown>;
  id: string;
  /** Collect geometry from the rendered svg (needs it in the DOM). */
  geometry: boolean;
  /** Extra ELK layoutOptions for this render (see the hook in scripts/build-mermaid.mjs). */
  elk?: ElkOptions;
  /** Minimum label box per node id (scripts/build-mermaid.mjs patches labelHelper to honour it): the node grows around its label. */
  nodeMin?: Record<string, { w?: number; h?: number }>;
  /** Subgraph id -> x of its title's translate, instead of the middle of the frame (patched in by scripts/build-mermaid.mjs). */
  titleAt?: Record<string, [number, number]>;
  /** Edge id -> translate its label is drawn at instead of where ELK put it (patched in by scripts/build-mermaid.mjs). */
  labelAt?: Record<string, [number, number]>;
}

export interface InPageResult {
  error?: RawError;
  svg?: string;
  geometry?: RawGeometry;
  ms: number;
}

/** `mermaid.parse` then a real `render` (parse misses render-time errors); first failure wins. */
export async function checkInPage({ source, config, id }: Pick<InPageInput, "source" | "config" | "id">): Promise<{ error?: RawError }> {
  const mm = (window as unknown as { mermaid: { initialize(c: unknown): void; parse(s: string): Promise<unknown>; render(id: string, s: string): Promise<{ svg: string }> } }).mermaid;
  const describe = (phase: "parse" | "render", e: unknown): RawError => {
    const err = e as { name?: string; message?: string; hash?: { loc?: { first_line?: number; first_column?: number }; line?: number }; constructor?: { name?: string } };
    const out: RawError = { phase, name: String(err?.name ?? "Error"), ctor: String(err?.constructor?.name ?? "Error"), message: String(err?.message ?? e) };
    if (typeof err?.hash?.loc?.first_line === "number") {
      out.locLine = err.hash.loc.first_line;
      if (typeof err.hash.loc.first_column === "number") out.locCol = err.hash.loc.first_column;
    }
    if (typeof err?.hash?.line === "number") out.hashLine = err.hash.line;
    return out;
  };
  const cleanup = () => {
    for (const el of Array.from(document.querySelectorAll("#" + id + ", #d" + id))) el.remove();
  };
  mm.initialize(config);
  try {
    await mm.parse(source);
  } catch (e) {
    return { error: describe("parse", e) };
  }
  try {
    await mm.render(id, source);
  } catch (e) {
    cleanup();
    return { error: describe("render", e) };
  }
  cleanup();
  return {};
}

/** Render `source`; with `geometry`, also measure the svg in place. */
export async function renderInPage({ source, config, id, geometry, elk, nodeMin, titleAt, labelAt }: InPageInput): Promise<InPageResult> {
  const mm = (window as unknown as { mermaid: { initialize(c: unknown): void; render(id: string, s: string): Promise<{ svg: string }> } }).mermaid;
  const t0 = performance.now();
  const w = window as unknown as { __axiElk?: unknown; __axiNodeMin?: Record<string, { w?: number; h?: number }>; __axiTitleAt?: Record<string, [number, number]>; __axiLabelAt?: Record<string, [number, number]> };
  w.__axiElk = elk;
  mm.initialize(config);
  w.__axiNodeMin = nodeMin;
  w.__axiTitleAt = titleAt;
  w.__axiLabelAt = labelAt;
  let svg: string;
  try {
    svg = (await mm.render(id, source)).svg;
  } catch (e) {
    for (const el of Array.from(document.querySelectorAll("#" + id + ", #d" + id))) el.remove();
    const err = e as { name?: string; message?: string; hash?: { loc?: { first_line?: number; first_column?: number }; line?: number }; constructor?: { name?: string } };
    const error: RawError = { phase: "render", name: String(err?.name ?? "Error"), ctor: String(err?.constructor?.name ?? "Error"), message: String(err?.message ?? e) };
    if (typeof err?.hash?.loc?.first_line === "number") {
      error.locLine = err.hash.loc.first_line;
      if (typeof err.hash.loc.first_column === "number") error.locCol = err.hash.loc.first_column;
    }
    if (typeof err?.hash?.line === "number") error.hashLine = err.hash.line;
    return { error, ms: Math.round(performance.now() - t0) };
  }
  const host = document.getElementById("host") as HTMLElement;
  host.innerHTML = svg;
  const ms = Math.round(performance.now() - t0);
  if (!geometry) return { svg, ms };

  // ---- geometry: boxes and routes in the svg's own user space (viewBox units) ----
  const root = host.querySelector("svg") as SVGSVGElement;
  const vb = root.viewBox.baseVal;
  const role = root.getAttribute("aria-roledescription") ?? "";
  const round = (n: number) => Math.round(n * 100) / 100;
  const rootInverse = (root.getScreenCTM() as DOMMatrix).inverse();
  /** local-to-root-user matrix of an element */
  const matrixOf = (el: Element): DOMMatrix => rootInverse.multiply((el as SVGGraphicsElement).getScreenCTM() as DOMMatrix);
  const mapPoint = (m: DOMMatrix, x: number, y: number): [number, number] => {
    const p = new DOMPoint(x, y).matrixTransform(m);
    return [round(p.x), round(p.y)];
  };
  const boxOf = (el: Element): RawBox => {
    const b = (el as SVGGraphicsElement).getBBox();
    const m = matrixOf(el);
    const corners = [mapPoint(m, b.x, b.y), mapPoint(m, b.x + b.width, b.y), mapPoint(m, b.x, b.y + b.height), mapPoint(m, b.x + b.width, b.y + b.height)];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: round(Math.max(...xs) - Math.min(...xs)), h: round(Math.max(...ys) - Math.min(...ys)) };
  };
  const textOf = (el: Element): string => {
    const rows = Array.from(el.querySelectorAll(".text-outer-tspan"));
    const text = rows.length > 0 ? rows.map((r) => (r.textContent ?? "").trim()).join("\n") : (el.textContent ?? "").trim();
    return text;
  };
  const SHAPE = /^(rect|circle|ellipse|polygon|path)$/;
  const shapeOf = (g: Element): Element => {
    for (const child of Array.from(g.children)) {
      const cls = child.getAttribute("class") ?? "";
      if (SHAPE.test(child.tagName) || /label-container|outer-path/.test(cls)) return child;
    }
    return g;
  };
  const stripId = (id: string): string => id.replace(new RegExp("^" + root.id + "-"), "");

  const nodes: RawNode[] = [];
  const edges: RawEdge[] = [];
  const stats: Record<string, number> = {};

  // unified renderer: flowchart, state, class, er (mindmap nodes too)
  for (const g of Array.from(root.querySelectorAll("g.node"))) {
    const shape = shapeOf(g);
    const rawId = stripId(g.id);
    const keys = [rawId];
    const named = /^(?:flowchart|state|classId|entity|node)-(.+)-\d+$/.exec(rawId);
    if (named) keys.unshift(named[1] as string);
    const label = Array.from(g.children).find((c) => c.tagName === "g" && /(^|\s)label(\s|$)/.test(c.getAttribute("class") ?? ""));
    const node: RawNode = { keys, zone: false, box: boxOf(shape), tag: shape.tagName };
    const d = shape.tagName === "path" ? shape.getAttribute("d") : (shape.querySelector("path")?.getAttribute("d") ?? null);
    if (d) node.curve = /[a]/.test(d) ? "arc" : /C/.test(d) ? "cubic" : undefined;
    if (shape.tagName === "polygon") node.sides = (shape.getAttribute("points") ?? "").trim().split(/[\s,]+/).length / 2;
    if (label && textOf(label) !== "") {
      node.text = textOf(label);
      node.label = boxOf(label);
    }
    nodes.push(node);
  }
  for (const g of Array.from(root.querySelectorAll("g.cluster"))) {
    const rect = g.querySelector(":scope > rect") ?? g;
    const key = stripId(g.id);
    const label = g.querySelector(":scope > .cluster-label");
    const node: RawNode = { keys: [key], zone: true, box: boxOf(rect), tag: rect.tagName };
    if (label && textOf(label) !== "") {
      node.text = textOf(label);
      node.label = boxOf(label);
    }
    nodes.push(node);
  }
  const labelFor = new Map<string, { box: RawBox; text: string }>();
  for (const g of Array.from(root.querySelectorAll("g.edgeLabel"))) {
    const inner = g.querySelector("g.label") ?? g;
    const text = textOf(inner);
    if (text === "") continue;
    labelFor.set(inner.getAttribute("data-id") ?? g.getAttribute("data-id") ?? "", { box: boxOf(inner), text });
  }
  for (const p of Array.from(root.querySelectorAll("path[data-edge]"))) {
    const dataId = p.getAttribute("data-id") ?? "";
    const m = matrixOf(p);
    let poly: [number, number][] = [];
    const encoded = p.getAttribute("data-points");
    if (encoded) {
      try {
        const pts = JSON.parse(atob(encoded)) as { x: number; y: number }[];
        poly = pts.map((q) => mapPoint(m, q.x, q.y));
      } catch {
        poly = [];
      }
    }
    if (poly.length < 2) {
      const path = p as unknown as SVGGeometryElement;
      const len = path.getTotalLength();
      for (let i = 0; i <= 24; i++) {
        const q = path.getPointAtLength((len * i) / 24);
        poly.push(mapPoint(m, q.x, q.y));
      }
    }
    const edge: RawEdge = { dataId, poly, startArrow: p.hasAttribute("marker-start"), endArrow: p.hasAttribute("marker-end") };
    const lab = labelFor.get(dataId);
    if (lab) {
      edge.label = lab.box;
      edge.text = lab.text;
    }
    edges.push(edge);
  }

  // sequence
  if (role === "sequence") {
    const byName = new Map<string, { box: RawBox; text: string }>();
    for (const r of Array.from(root.querySelectorAll("rect.actor"))) {
      const name = r.getAttribute("name") ?? "";
      const box = boxOf(r);
      const known = byName.get(name);
      if (!known || box.y < known.box.y) byName.set(name, { box, text: name });
    }
    const centers: { name: string; cx: number }[] = [];
    for (const [name, a] of byName) {
      nodes.push({ keys: [name], zone: false, box: a.box, tag: "rect", text: a.text });
      centers.push({ name, cx: a.box.x + a.box.w / 2 });
    }
    const nearest = (x: number): string => centers.reduce((best, c) => (Math.abs(c.cx - x) < Math.abs(best.cx - x) ? c : best), centers[0] as { name: string; cx: number }).name;
    const texts = Array.from(root.querySelectorAll("text.messageText"));
    const lines = Array.from(root.querySelectorAll("[class^=messageLine]"));
    lines.forEach((l, i) => {
      const m = matrixOf(l);
      let poly: [number, number][];
      if (l.tagName === "line") {
        poly = [mapPoint(m, Number(l.getAttribute("x1")), Number(l.getAttribute("y1"))), mapPoint(m, Number(l.getAttribute("x2")), Number(l.getAttribute("y2")))];
      } else {
        const path = l as unknown as SVGGeometryElement;
        const len = path.getTotalLength();
        poly = [];
        for (let k = 0; k <= 12; k++) {
          const q = path.getPointAtLength((len * k) / 12);
          poly.push(mapPoint(m, q.x, q.y));
        }
      }
      if (centers.length === 0) return;
      const edge: RawEdge = { dataId: "msg" + i, src: nearest(poly[0]![0]), dst: nearest(poly[poly.length - 1]![0]), poly, startArrow: false, endArrow: true };
      const t = texts.length === lines.length ? texts[i] : undefined;
      if (t && (t.textContent ?? "").trim() !== "") {
        edge.label = boxOf(t);
        edge.text = (t.textContent ?? "").trim();
      }
      edges.push(edge);
    });
    stats.participants = byName.size;
    stats.messages = lines.length;
  }

  // per-kind aggregates
  if (role.startsWith("class")) {
    stats.classes = nodes.filter((n) => !n.zone).length;
    stats.relations = edges.length;
  } else if (role === "er") {
    stats.tables = nodes.filter((n) => !n.zone).length;
    stats.columns = root.querySelectorAll("g.label.attribute-name").length;
    stats.relations = edges.length;
  } else if (role.startsWith("stateDiagram")) {
    stats.states = nodes.filter((n) => !n.zone).length;
    stats.transitions = edges.length;
  } else if (role === "gitGraph") {
    stats.commits = root.querySelectorAll("circle.commit").length;
    stats.branches = root.querySelectorAll("g.branchLabel").length;
  } else if (role === "timeline") {
    stats.periods = root.querySelectorAll("g.taskWrapper").length;
    stats.events = root.querySelectorAll("g.eventWrapper").length;
  } else if (role === "mindmap") {
    stats.topics = nodes.filter((n) => !n.zone).length;
  }

  return { svg, ms, geometry: { role, viewBox: [vb.x, vb.y, vb.width, vb.height], nodes, edges, stats } };
}

/** Puts `svg` in #host at `scale` times its viewBox size, ready for an element screenshot. */
export function prepareShot({ svg, scale, background }: { svg: string; scale: number; background: string }): { width: number; height: number } {
  const host = document.getElementById("host") as HTMLElement;
  host.innerHTML = svg;
  document.body.style.background = background;
  const root = host.querySelector("svg") as SVGSVGElement;
  const vb = root.viewBox.baseVal;
  const width = Math.max(1, Math.ceil(vb.width * scale));
  const height = Math.max(1, Math.ceil(vb.height * scale));
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.style.maxWidth = "none";
  root.style.display = "block";
  return { width, height };
}
