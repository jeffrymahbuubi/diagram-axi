// exd graph -> Mermaid flowchart source (KTD2). Ported from the bake-off script exd2mmd.mjs: for the same
// graph and options the output is identical (test/golden/mermaid/*.mmd are the bake-off sources). The
// graph is already parsed; losses are the bake-off notes that name a source construct, with its position.

import type { ColorName, Direction, Graph, Group, Node } from "../../dsl/ast.js";
import type { Loss, TranslateOptions } from "../types.js";

const PALETTE: Record<ColorName, string> = {
  blue: "#a5d8ff",
  green: "#b2f2bb",
  orange: "#ffd8a8",
  purple: "#d0bfff",
  red: "#ffc9c9",
  yellow: "#fff3bf",
  teal: "#c3fae8",
  pink: "#eebefa",
};
const STROKE = "#1e1e1e";
const DIR: Record<Direction, string> = { DOWN: "TD", RIGHT: "LR", UP: "BT", LEFT: "RL" };

/**
 * Escape text for a double-quoted Mermaid label. Newlines become <br>. The labels are drawn as svg text, where
 * only `#lt;`, `#gt;` and `#amp;` turn back into characters: `#35;` and `#quot;` come out as the literal text
 * "&#35;" and "&quot;". So a `#` stays as it is, with a zero-width space after it when it would start an
 * entity (`#35;`); a double quote becomes a typographic one (opening after a space or bracket, else closing);
 * a backtick becomes a modifier grave (a leading one would start a markdown string).
 */
export function esc(s: string): string {
  return String(s)
    .replace(/#(?=\w+;)/g, "#​")
    .replace(/&/g, "#amp;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/(^|[\s([{])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/`/g, "ˋ")
    .replace(/\n/g, "<br>");
}

function label(s: string | undefined): string {
  const t = esc(s ?? "");
  return t.trim() === "" ? " " : t;
}

function yamlStr(s: string): string {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

const mangle = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, (c) => "_x" + c.codePointAt(0)!.toString(16) + "_");
/** Mermaid node and subgraph ids: `n_`/`g_` keep DSL ids (any characters) from colliding with keywords. */
export const nodeIdOf = (id: string): string => "n_" + mangle(id);
export const groupIdOf = (id: string): string => "g_" + mangle(id);

function darken(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * 0.55).toString(16).padStart(2, "0");
  return "#" + f((n >> 16) & 255) + f((n >> 8) & 255) + f(n & 255);
}

/**
 * `direction` of the graph's own direction line wins over `o.direction`, then DOWN (as the excalidraw
 * engine does). `o.layout` is `elk` (default) or `dagre`; `o.sketch` selects the handDrawn look.
 */
export function translate(graph: Graph, o: TranslateOptions = {}): { source: string; losses: Loss[] } {
  const losses: Loss[] = [];
  const loss = (code: string, detail: string, at?: { line: number; col: number }): void => {
    losses.push({ code, detail, ...(at ? { line: at.line, col: at.col } : {}) });
  };

  const dir = graph.direction ?? o.direction ?? "DOWN";
  const layout = o.layout ?? "elk";
  const look = o.sketch ? "handDrawn" : "classic";
  const title = o.title ?? graph.title;

  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const groupIds = new Set(graph.groups.map((g) => g.id));
  const ref = (id: string): string => (nodeIds.has(id) ? nodeIdOf(id) : groupIds.has(id) ? groupIdOf(id) : nodeIdOf(id));

  const L: string[] = [];
  L.push("---");
  if (title) {
    L.push("title: " + yamlStr(title));
    if (title.includes("\n")) loss("multi-line-title", "the title has several lines; Mermaid may draw it on one");
  }
  L.push("config:");
  L.push("  layout: " + layout);
  L.push("  look: " + look);
  L.push("  theme: base");
  L.push("  themeVariables:");
  L.push('    primaryColor: "#a5d8ff"');
  L.push('    primaryBorderColor: "#1e1e1e"');
  L.push('    lineColor: "#1e1e1e"');
  L.push('    primaryTextColor: "#1e1e1e"');
  L.push('    edgeLabelBackground: "#ffffff"');
  L.push("---");
  L.push("flowchart " + DIR[dir]);

  for (const c of Object.keys(PALETTE) as ColorName[]) L.push(`  classDef c_${c} fill:${PALETTE[c]},stroke:${STROKE},color:${STROKE}`);

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodeDecl = (n: Node): string => {
    const l = label(n.label);
    const id = nodeIdOf(n.id);
    switch (n.shape) {
      case "ellipse":
        return `${id}(["${l}"])`;
      case "diamond":
        return `${id}{"${l}"}`;
      case "cylinder":
        return `${id}[("${l}")]`;
      default:
        return `${id}["${l}"]`;
    }
  };
  const colorOf = (n: Node): ColorName => n.color ?? (n.shape === "cylinder" ? "teal" : "blue");
  const styleLines: string[] = [];

  const groupById = new Map(graph.groups.map((g) => [g.id, g]));
  const childGroups = new Set(graph.groups.flatMap((g) => g.groups));
  const emitNode = (n: Node, ind: string): void => {
    L.push(`${ind}${nodeDecl(n)}:::c_${colorOf(n)}`);
    const st: string[] = [];
    if (n.flags.includes("bold")) st.push("stroke-width:4px");
    if (n.flags.includes("dashed")) st.push("stroke-dasharray:8 5");
    if (n.flags.includes("dotted")) st.push("stroke-dasharray:2 4");
    if (n.flags.includes("sketchy")) loss("sketchy-dropped", `node '${n.id}': the sketchy flag is dropped (the handDrawn look sketches every shape)`, n);
    if (st.length) styleLines.push(`  style ${nodeIdOf(n.id)} ${st.join(",")}`);
  };
  const emitGroup = (g: Group, ind: string): void => {
    L.push(`${ind}subgraph ${groupIdOf(g.id)} ["${label(g.title ?? "")}"]`);
    // children keep declaration order: nodes then sub-groups (the parser gives no interleaving)
    for (const cid of g.children) {
      const n = nodeById.get(cid);
      if (n) emitNode(n, ind + "  ");
    }
    for (const sid of g.groups) {
      const sg = groupById.get(sid);
      if (sg) emitGroup(sg, ind + "  ");
    }
    if (!g.children.length && !g.groups.length) {
      // Mermaid draws an empty subgraph as a zero-height frame whose title lands on a neighbour; a hidden node gives it a body.
      const hidden = "e" + groupIdOf(g.id);
      L.push(`${ind}  ${hidden}[" "]`);
      styleLines.push(`  style ${hidden} fill:none,stroke:none`);
      loss("empty-group", `group '${g.id}' is empty; it is drawn as an empty frame (with a hidden node inside)`, g);
    }
    L.push(`${ind}end`);
    const col = PALETTE[g.color ?? "blue"];
    const dark = darken(col);
    const st = [`fill:${col}55`, `stroke:${dark}`, `color:${STROKE}`];
    if (g.flags.includes("dashed")) st.push("stroke-dasharray:8 5");
    if (g.flags.includes("dotted")) st.push("stroke-dasharray:2 4");
    if (g.flags.includes("bold")) st.push("stroke-width:4px");
    styleLines.push(`  style ${groupIdOf(g.id)} ${st.join(",")}`);
  };

  // Source order: ungrouped nodes and top-level groups interleaved by source line.
  type Item = { line: number; node?: Node; group?: Group };
  const items: Item[] = [];
  const grouped = new Set(graph.groups.flatMap((g) => g.children));
  for (const n of graph.nodes) if (!grouped.has(n.id)) items.push({ line: n.line ?? 0, node: n });
  for (const g of graph.groups) if (!childGroups.has(g.id)) items.push({ line: g.line ?? 0, group: g });
  items.sort((a, b) => a.line - b.line);
  for (const it of items) {
    if (it.node) emitNode(it.node, "  ");
    else if (it.group) emitGroup(it.group, "  ");
  }

  // edges
  const linkStyles: string[] = [];
  let dotted: { line: number; col: number } | undefined;
  let dottedCount = 0;
  graph.edges.forEach((e, i) => {
    const from = ref(e.from);
    const to = ref(e.to);
    for (const end of [e.from, e.to]) {
      if (groupIds.has(end) && !nodeIds.has(end)) loss("edge-to-group", `edge ${e.from} -> ${e.to} ends at group '${end}'; drawn as a subgraph edge`, e);
    }
    let op: string;
    switch (e.arrow) {
      case "dashed":
        op = "-.->";
        linkStyles.push(`  linkStyle ${i} stroke-dasharray:8 5`);
        break;
      case "dotted":
        op = "-.->";
        dotted ??= e;
        dottedCount++;
        linkStyles.push(`  linkStyle ${i} stroke-dasharray:2 4`);
        break;
      case "line":
        op = "---";
        break;
      case "both":
        op = "<-->";
        break;
      default:
        op = "-->";
    }
    const lab = e.label != null && e.label.trim() !== "" ? `|"${label(e.label)}"|` : "";
    L.push(`  ${from} ${op}${lab} ${to}`);
  });
  L.push(...styleLines, ...linkStyles);

  if (dotted) loss("dotted-as-dashed", `${dottedCount} dotted edge(s): dotted and dashed both map to Mermaid -.->, told apart only by a linkStyle dash pattern`, dotted);
  return { source: L.join("\n") + "\n", losses };
}
