// View -> `.exd` text. Deterministic: ids come from paths (sanitized to [A-Za-z0-9_], prefixed so they never hit the
// parser keywords dir|direction|title|group, deduped with _2), statement order follows the View order, no timestamps.

import { MAX_LINE } from "../lint/rules.js";
import type { View, ViewEdge, ViewGroup, ViewNode } from "./aggregate.js";
import { layeringOf } from "./layering.js";

export interface ExdResult {
  text: string;
  /** View node key -> exd node id. */
  ids: Map<string, string>;
  /** View group key -> exd group id. */
  groupIds: Map<string, string>;
}

const PREFIX: Record<ViewNode["kind"], string> = { file: "f", dir: "d", rest: "r", stub: "s", external: "x" };

const clean = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, "_");

/**
 * Cuts a label line to MAX_LINE. The file name matters most, so it is kept whole and the folders in front of it are
 * cut (`examples/benc.../hooks-benchmark-async-await.js`); a name that alone is too long is cut in the middle.
 * A ` (N files)` suffix survives.
 */
export function cutLine(line: string): string {
  if (line.length <= MAX_LINE) return line;
  const m = /^(.*)( \(\d+ files?\))$/.exec(line);
  const head = m ? (m[1] as string) : line;
  const tail = m ? (m[2] as string) : "";
  const room = MAX_LINE - tail.length;
  const trimmed = head.replace(/\/$/, "");
  const slash = trimmed.lastIndexOf("/");
  const base = trimmed.slice(slash + 1) + head.slice(trimmed.length);
  if (slash > 0 && base.length + 5 <= room) {
    const keep = Math.max(1, room - base.length - 4);
    return `${trimmed.slice(0, keep)}.../${base}${tail}`;
  }
  const inner = Math.max(2, room - 3);
  const front = Math.ceil(inner / 2);
  return `${head.slice(0, front)}...${head.slice(head.length - (inner - front))}${tail}`;
}

/** Label text safe inside `[...]`: brackets and backslashes replaced, a leading `(` shielded from the cylinder shape. */
function labelSrc(lines: string[]): string {
  const safe = lines.map((l) => cutLine(l).replace(/\[/g, "<").replace(/\]/g, ">").replace(/\\/g, "/").replace(/[\r\n]+/g, " "));
  const first = safe[0] as string;
  if (first.startsWith("(")) safe[0] = ` ${first}`;
  return safe.join("\\n");
}

const quoted = (s: string): string => `"${s.replace(/\\/g, "/").replace(/"/g, "'").replace(/[\r\n]+/g, " ")}"`;

function nodeLine(n: ViewNode, id: string): string {
  const text = labelSrc([n.label, ...n.notes]);
  const shape = n.kind === "stub" ? `(${text})` : `[${text}]`;
  return `${id}${shape}${n.color ? ` :${n.color}` : ""}`;
}

function arrowOf(e: ViewEdge): string {
  if (e.stub) return "--";
  if (e.typeOnly) return "-.->";
  return e.dynamic ? "-->" : "->";
}

/**
 * A deep, narrow import graph (L layers > 1.5 x W boxes on the widest layer) reads better left to right on d2: the scene grows
 * along the page instead of down it. Kept only if the vision gate does not drop; set to false to always emit `dir DOWN`.
 */
export const AUTO_DIR_RIGHT = true;
/** `dir RIGHT` when layers > DIR_RIGHT_RATIO x width. */
export const DIR_RIGHT_RATIO = 1.5;

export interface ExdOptions {
  /** The engine the file will be drawn with; `dir RIGHT` is emitted only for d2 (see AUTO_DIR_RIGHT). */
  engine?: string;
}

/** `RIGHT` for a d2-bound view with L > 1.5 W (layering.ts), else `DOWN`. */
export function preferredDir(view: View, engine: string | undefined): "DOWN" | "RIGHT" {
  if (!AUTO_DIR_RIGHT || engine !== "d2") return "DOWN";
  const { width, layers } = layeringOf(view);
  return layers > DIR_RIGHT_RATIO * width ? "RIGHT" : "DOWN";
}

export function toExd(view: View, opts: ExdOptions = {}): ExdResult {
  const used = new Set<string>();
  const unique = (base: string): string => {
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
    used.add(id);
    return id;
  };
  const groupIds = new Map<string, string>();
  for (const g of view.groups) groupIds.set(g.key, unique(`g_${clean(g.path)}`));
  const ids = new Map<string, string>();
  for (const n of view.nodes) {
    const name = n.kind === "external" ? (n.key === "ext:*" ? "all" : n.key === "ext:+" ? "more" : n.label) : n.kind === "stub" ? n.key.slice(5) : n.path;
    ids.set(n.key, unique(`${PREFIX[n.kind]}_${clean(name)}`));
  }

  const { summary: s } = view;
  const out: string[] = [`title ${quoted(`imports: ${view.root} (${s.files.covered - s.isolated.files} of ${s.files.total} files)`)}`, `dir ${preferredDir(view, opts.engine)}`, ""];

  const nodesIn = new Map<string | undefined, ViewNode[]>();
  for (const n of view.nodes) (nodesIn.get(n.group) ?? nodesIn.set(n.group, []).get(n.group))?.push(n);
  // the entry / focus box is listed first in its container (reading order, and the node a layered layout starts from)
  for (const list of nodesIn.values()) list.sort((a, b) => Number(!a.mark) - Number(!b.mark));
  const kidsOf = new Map<string | undefined, ViewGroup[]>();
  for (const g of view.groups) (kidsOf.get(g.parent) ?? kidsOf.set(g.parent, []).get(g.parent))?.push(g);

  const emitGroup = (g: ViewGroup, indent: string): void => {
    out.push(`${indent}group ${groupIds.get(g.key)} ${quoted(`${g.label}/`)} {`);
    for (const n of nodesIn.get(g.key) ?? []) out.push(`${indent}  ${nodeLine(n, ids.get(n.key) as string)}`);
    for (const k of kidsOf.get(g.key) ?? []) emitGroup(k, `${indent}  `);
    out.push(`${indent}}`);
  };
  for (const g of kidsOf.get(undefined) ?? []) emitGroup(g, "");
  for (const n of nodesIn.get(undefined) ?? []) out.push(nodeLine(n, ids.get(n.key) as string));

  if (view.edges.length > 0) out.push("");
  // A->B and B->A with the same arrow and label would trip the `reciprocal-pair` lint: draw them as one `<->`.
  const labelOf = (e: ViewEdge): string => (e.weight > 1 && !e.stub ? ` : x${e.weight}` : "");
  const edgeAt = new Map(view.edges.map((e) => [`${e.from}\0${e.to}`, e]));
  const merged = new Set<ViewEdge>();
  // A stub hangs below its anchor in a DOWN layout; an anchor that mostly imports already has its arrows below, so its stub goes above.
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const e of view.edges) if (!e.stub) (outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1), inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1));
  // DSL reading order: arrows by source, then target (the View already lists them so, stub lines last). No corpus-tuned order:
  // an arrow that would cross a box is the d2 engine's job to repair (src/engines/d2).
  for (const e of view.edges) {
    if (merged.has(e)) continue;
    if (e.stub && (outDeg.get(e.from) ?? 0) > (inDeg.get(e.from) ?? 0)) {
      out.push(`${ids.get(e.to)} -- ${ids.get(e.from)}`);
      continue;
    }
    const back = e.stub ? undefined : edgeAt.get(`${e.to}\0${e.from}`);
    const twin = back && arrowOf(back) === arrowOf(e) && labelOf(back) === labelOf(e) ? back : undefined;
    if (twin) merged.add(twin);
    out.push(`${ids.get(e.from)} ${twin ? "<->" : arrowOf(e)} ${ids.get(e.to)}${labelOf(e)}`);
  }
  return { text: `${out.join("\n")}\n`, ids, groupIds };
}
