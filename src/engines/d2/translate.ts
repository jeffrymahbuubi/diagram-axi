// exd Graph -> D2 source (KTD2). A port of the bake-off translator (exd2d2.mjs): same output for the same
// graph, so the bake-off `d2src/*.d2` files are the goldens. Containers are declared first (nested), edges
// follow at the root with qualified paths. Things D2 cannot carry over come back as `losses`.

import type { ArrowKind, ColorName, Direction, Graph, Group, Node, ShapeKind, StyleFlag } from "../../dsl/ast.js";
import type { Loss, TranslateOptions } from "../types.js";

const NODE_FILL: Record<ColorName, string> = {
  blue: "#a5d8ff",
  green: "#b2f2bb",
  orange: "#ffd8a8",
  purple: "#d0bfff",
  red: "#ffc9c9",
  yellow: "#fff3bf",
  teal: "#c3fae8",
  pink: "#eebefa",
};
// Zone tints from the repo palette (opacity 30 there); the same hex is used as a plain fill here.
const ZONE_FILL: Record<ColorName, string> = {
  blue: "#dbe4ff",
  purple: "#e5dbff",
  green: "#d3f9d8",
  orange: "#ffe8cc",
  red: "#ffe3e3",
  yellow: "#fff3bf",
  teal: "#c3fae8",
  pink: "#ffdeeb",
};
const STROKE = "#1e1e1e";
const ZONE_STROKE = "#868e96";
const SHAPE: Record<ShapeKind, string> = { rect: "rectangle", ellipse: "oval", diamond: "diamond", cylinder: "cylinder" };
const DIR: Record<Direction, string> = { DOWN: "down", RIGHT: "right", UP: "up", LEFT: "left" };

/** D2 reserved keywords: quoted when used as plain ids. */
const RESERVED = new Set([
  "label", "shape", "icon", "constraint", "tooltip", "link", "near", "width", "height", "direction",
  "top", "left", "grid-rows", "grid-columns", "grid-gap", "vertical-gap", "horizontal-gap", "class",
  "classes", "style", "vars", "layers", "scenarios", "steps", "source-arrowhead", "target-arrowhead",
  "_", "d2-config", "d2-legend",
]);

/** D2 key for one id segment. DSL ids are [A-Za-z_][A-Za-z0-9_]*, so only reserved words need quoting. */
function key(id: string): string {
  if (RESERVED.has(id.toLowerCase()) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return str(id);
  return id;
}

/** Double-quoted D2 string: escapes backslash, quote, `$` (substitution) and newlines. */
function str(s: string): string {
  return (
    '"' +
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/\r\n|\r|\n/g, "\\n") +
    '"'
  );
}

// Label metrics, chosen with the QA checker (U10): ELK reserves room for labels but D2 draws an edge label at the middle
// of the finished route, so wide labels land on neighbouring edges and zone titles. Narrower text and lines shrink that.
/** Zone title: top-left (edges meet a zone near its middle, not its corner), 16 px (D2's default is a 28 px headline). */
const ZONE_FONT = 16;
/** Edge labels are 14 px (default 16) in the node-label ink, not D2's default grey: 13 px grey was unreadable on a scaled-down scene. */
const EDGE_LABEL_FONT = 14;
/** Longest line, in chars, before a label is broken at a space. */
const EDGE_WRAP = 14;
const ZONE_WRAP = 12;
const NODE_WRAP = 20;

/** Breaks `s` at spaces so no line is longer than `max` chars (a longer word stays whole); `max` 0 leaves it alone. */
function wrap(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s;
  return s
    .split("\n")
    .map((line) => {
      const lines: string[] = [];
      let cur = "";
      for (const w of line.split(" ")) {
        if (cur !== "" && cur.length + 1 + w.length > max) {
          lines.push(cur);
          cur = w;
        } else cur = cur === "" ? w : `${cur} ${w}`;
      }
      lines.push(cur);
      return lines.join("\n");
    })
    .join("\n");
}

/** Glyphs Source Sans (the font D2 embeds) does not have: CJK and emoji fall back to a system font. */
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/u;
const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u;

const ARROW_OP: Record<ArrowKind, string> = { solid: "->", dashed: "->", dotted: "->", line: "--", both: "<->" };

export interface TranslateResult {
  source: string;
  losses: Loss[];
}

export function translateGraph(graph: Graph, opts: TranslateOptions = {}): TranslateResult {
  const direction = opts.direction ?? graph.direction ?? "DOWN";
  const losses: Loss[] = [];

  const nodeById = new Map<string, Node>(graph.nodes.map((n) => [n.id, n]));
  const groupById = new Map<string, Group>(graph.groups.map((g) => [g.id, g]));
  const parentOfNode = new Map<string, string>();
  const parentOfGroup = new Map<string, string>();
  for (const g of graph.groups) {
    for (const c of g.children) parentOfNode.set(c, g.id);
    for (const c of g.groups) parentOfGroup.set(c, g.id);
  }
  const groupPath = (gid: string): string[] => {
    const p: string[] = [];
    for (let cur: string | undefined = gid; cur; cur = parentOfGroup.get(cur)) p.unshift(cur);
    return p;
  };
  const nodePath = (nid: string): string[] => {
    const p = parentOfNode.get(nid);
    return [...(p ? groupPath(p) : []), nid];
  };
  const qual = (path: string[]): string => path.map(key).join(".");

  const scan = (text: string | undefined, where: { line?: number; col?: number }) => {
    if (!text || !/[^\x00-\x7f]/u.test(text)) return;
    const what = CJK.test(text) ? "CJK" : EMOJI.test(text) ? "emoji" : undefined;
    if (what) losses.push({ code: "font-fallback", detail: `${what} text is not in D2's embedded font and renders with a system fallback font`, ...where });
  };

  const out: string[] = [];
  const flagStyle = (flags: StyleFlag[], ind: string, what: string, at: { line: number; col: number }): string[] => {
    const l: string[] = [];
    if (flags.includes("dashed")) l.push(`${ind}style.stroke-dash: 5`);
    else if (flags.includes("dotted")) l.push(`${ind}style.stroke-dash: 2`);
    if (flags.includes("bold")) l.push(`${ind}style.stroke-width: 4`);
    if (flags.includes("sketchy")) {
      losses.push({ code: "sketchy-flag", detail: `${what}: D2 has no per-shape sketch, only the whole-diagram --sketch`, line: at.line, col: at.col });
    }
    return l;
  };

  out.push(`direction: ${DIR[direction]}`);
  if (graph.title) {
    let tkey = "d2_title";
    while (nodeById.has(tkey) || groupById.has(tkey)) tkey += "_";
    scan(graph.title, {});
    out.push(`${tkey}: ${str(graph.title)} {`, "  shape: text", "  near: top-center", "  style.font-size: 28", "  style.bold: true", "}");
  }

  const emitNode = (n: Node, ind: string) => {
    scan(n.label, n);
    const fill = n.color ? NODE_FILL[n.color] : n.shape === "cylinder" ? NODE_FILL.teal : NODE_FILL.blue;
    out.push(`${ind}${key(n.id)}: ${str(wrap(n.label, NODE_WRAP))} {`);
    out.push(`${ind}  shape: ${SHAPE[n.shape]}`);
    out.push(`${ind}  style.fill: "${fill}"`);
    out.push(`${ind}  style.stroke: "${STROKE}"`);
    out.push(`${ind}  style.font-color: "${STROKE}"`);
    out.push(...flagStyle(n.flags, ind + "  ", `node ${n.id}`, n));
    out.push(`${ind}}`);
  };

  const emitGroup = (g: Group, ind: string) => {
    if (g.children.length === 0 && g.groups.length === 0) {
      losses.push({ code: "empty-group", detail: `group ${g.id} has no members; D2 draws it as a plain box`, line: g.line, col: g.col });
    }
    scan(g.title, g);
    const fill = ZONE_FILL[g.color ?? "blue"];
    out.push(`${ind}${key(g.id)}: ${str(wrap(g.title ?? g.id, ZONE_WRAP))} {`);
    out.push(`${ind}  label.near: top-left`, `${ind}  style.font-size: ${ZONE_FONT}`);
    out.push(`${ind}  style.fill: "${fill}"`);
    out.push(`${ind}  style.stroke: "${ZONE_STROKE}"`);
    out.push(`${ind}  style.font-color: "${STROKE}"`);
    out.push(...flagStyle(g.flags, ind + "  ", `group ${g.id}`, g));
    for (const nid of g.children) emitNode(nodeById.get(nid)!, ind + "  ");
    for (const gid of g.groups) emitGroup(groupById.get(gid)!, ind + "  ");
    out.push(`${ind}}`);
  };

  // Declare all containers and nodes first (nested), then edges at the root with qualified paths.
  for (const n of graph.nodes) if (!parentOfNode.has(n.id)) emitNode(n, "");
  for (const g of graph.groups) if (!parentOfGroup.has(g.id)) emitGroup(g, "");

  for (const e of graph.edges) {
    const pf = nodeById.has(e.from) ? nodePath(e.from) : groupPath(e.from);
    const pt = nodeById.has(e.to) ? nodePath(e.to) : groupPath(e.to);
    let line = `${qual(pf)} ${ARROW_OP[e.arrow]} ${qual(pt)}`;
    // The bake-off d2src files (the goldens) write `a -> b: {` for an unlabeled edge: an empty label, same drawing.
    if (e.label) {
      scan(e.label, e);
      line += `: ${str(wrap(e.label, EDGE_WRAP))}`;
    } else line += ":";
    const st = [`  style.stroke: "${STROKE}"`];
    if (e.label) st.push(`  style.font-size: ${EDGE_LABEL_FONT}`, `  style.font-color: "${STROKE}"`);
    if (e.arrow === "dashed") st.push("  style.stroke-dash: 5");
    if (e.arrow === "dotted") st.push("  style.stroke-dash: 2");
    out.push(`${line} {`, ...st, "}");
  }
  return { source: out.join("\n") + "\n", losses };
}
