// Failure signatures and the .exd <-> model bridge for the shrinker / promotion tools. Pure except for the lazy
// parser import (dist/dsl/parser.js, so run `npm run build` first) and the corpus scan helpers.
//
//   graphToModel(graph) -> model          parsed AST -> the generator's model shape (scripts/qa/gen.mjs)
//   parseModel(text, parse?) -> model|null  text -> model, null on a parse error
//   canonical(model) -> object             ids renamed by position, labels reduced to a length class, flags/colors dropped
//   modelHash(model) -> 8 hex              sha1 of the canonical JSON (stable under label / id renames)
//   signature(code, model) -> "<code>:<hash8>"
//   corpusHashes(dirs) -> Map<hash, file>  structural hashes of every .exd below the given directories
//   failureKey(finding) -> string          cli-failure findings are told apart by their (number-free) message

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./run.mjs";

let parserPromise;
/** The built DSL parser (`parse(text) -> {graph, diagnostics}`). */
export function loadParser() {
  parserPromise ??= import(pathToFileURL(join(ROOT, "dist", "dsl", "parser.js")).href).then((m) => m.parse);
  return parserPromise;
}

/** Parsed Graph -> generator model. Group nesting comes from Group.groups; node ownership from Group.children. */
export function graphToModel(graph) {
  const ownerOf = new Map();
  const parentOf = new Map();
  for (const g of graph.groups) {
    for (const c of g.children) ownerOf.set(c, g.id);
    for (const c of g.groups) parentOf.set(c, g.id);
  }
  const depth = (id) => (parentOf.has(id) ? 1 + depth(parentOf.get(id)) : 1);
  return {
    title: graph.title,
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      shape: n.shape,
      ...(n.color ? { color: n.color } : {}),
      flags: [...n.flags],
      ...(ownerOf.has(n.id) ? { group: ownerOf.get(n.id) } : {}),
      ...(n.implicit && !ownerOf.has(n.id) ? { implicit: true } : {}),
    })),
    edges: graph.edges.map((e) => ({ from: e.from, to: e.to, arrow: e.arrow, ...(e.label ? { label: e.label } : {}) })),
    groups: graph.groups.map((g) => ({
      id: g.id,
      ...(g.title ? { title: g.title } : {}),
      ...(g.color ? { color: g.color } : {}),
      flags: [...g.flags],
      ...(parentOf.has(g.id) ? { parent: parentOf.get(g.id) } : {}),
      kind: "normal",
      depth: depth(g.id),
    })),
    merge: false,
    edgesFirst: false,
  };
}

/** Text -> model; null when the parser reports an error. `parse` defaults to the built parser. */
export async function parseModel(text, parse) {
  const p = parse ?? (await loadParser());
  const r = p(text);
  return r.diagnostics.some((d) => d.severity === "error") ? null : graphToModel(r.graph);
}

const labelClass = (s) => {
  if (s === undefined || s === "") return "";
  if (s.includes("\n")) return "multi";
  const n = [...s].length;
  return n === 1 ? "1" : n <= 12 ? "short" : "long";
};

/**
 * Structure that identifies a repro: shapes, edge endpoints (by node position), arrow kinds, group nesting and a
 * length class per label. Ids, label text, colors and style flags do not take part.
 */
export function canonical(m) {
  const nIdx = new Map(m.nodes.map((n, i) => [n.id, i]));
  const gIdx = new Map(m.groups.map((g, i) => [g.id, i]));
  return {
    title: Boolean(m.title),
    nodes: m.nodes.map((n) => [n.shape, labelClass(n.label), n.group === undefined ? -1 : gIdx.get(n.group)]),
    edges: m.edges.map((e) => [nIdx.get(e.from), nIdx.get(e.to), e.arrow, labelClass(e.label)]),
    groups: m.groups.map((g) => [g.parent === undefined ? -1 : gIdx.get(g.parent), g.title ? labelClass(g.title) : ""]),
  };
}

export const modelHash = (m) => createHash("sha1").update(JSON.stringify(canonical(m))).digest("hex").slice(0, 8);
export const signature = (code, m) => `${code}:${modelHash(m)}`;

/** Structural hashes of every `.exd` directly inside each directory: Map(hash -> relative-ish file label). */
export async function corpusHashes(dirs) {
  const parse = await loadParser();
  const out = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".exd")).sort()) {
      const model = await parseModel(readFileSync(join(dir, f), "utf8"), parse);
      if (model) out.set(modelHash(model), f);
    }
  }
  return out;
}

/** What makes two failures "the same bug": the code, plus for cli-failure the message with numbers removed. */
export function failureKey(f) {
  if (f.code !== "cli-failure") return f.code;
  const msg = String(f.detail ?? "")
    .replace(/^exit [-\d]+:\s*/, "")
    .split(" | suggestion")[0]
    .replace(/\d+/g, "#")
    .trim()
    .slice(0, 120);
  return `${f.code}|${msg}`;
}
