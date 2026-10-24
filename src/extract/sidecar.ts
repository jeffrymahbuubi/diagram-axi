// View -> the `imports.exd.map.json` object (plan section 3). Key order is fixed by construction, so
// JSON.stringify(sidecar(...), null, 2) is byte-stable. Lets an agent go from a box id to files and lines.

import type { RawGraph } from "./types.js";
import type { View } from "./aggregate.js";
import type { ExdResult } from "./to-exd.js";

export interface SidecarNode {
  path: string;
  kind: "file" | "dir" | "group" | "rest" | "stub" | "external";
  files?: number;
  loc?: number;
  /** The package entry or the --focus target. */
  mark?: "entry" | "focus";
}

export interface Sidecar {
  schema: 1;
  meta: {
    root: string;
    langs: string[];
    rev?: string;
    dirty?: boolean;
    extractor: { name: string; version: string };
    stats: { files: number; edges: number; unresolved: number };
  };
  nodes: Record<string, SidecarNode>;
  edges: Array<{
    from: string;
    to: string;
    weight: number;
    typeOnly: boolean;
    dynamic: boolean;
    evidence: Array<{ path: string; line: number }>;
  }>;
  hidden: {
    externals: Array<{ name: string; edges: number; files: number }>;
    tests: string[];
    hubEdges: Array<{ from: string; to: string; weight: number }>;
    sccs: string[][];
    /** Files and folders with no import edge to the rest of the view; not drawn. `files` counts all, `items` lists the outermost paths. */
    isolated: { files: number; items: Array<{ path: string; kind: "file" | "dir"; files: number }>; more: number };
  };
}

export interface SidecarOptions {
  /** Evidence rows kept per edge (the weight still carries the true count). Default 20. */
  maxEvidence?: number;
}

export function sidecar(view: View, exd: ExdResult, raw: RawGraph, opts: SidecarOptions = {}): Sidecar {
  const cap = opts.maxEvidence ?? 20;
  const id = (key: string): string => exd.ids.get(key) as string;
  const nodes: Sidecar["nodes"] = {};
  for (const g of view.groups) {
    const members = view.nodes.filter((n) => n.group === g.key || view.groups.some((h) => h.parent === g.key && n.group === h.key));
    nodes[exd.groupIds.get(g.key) as string] = { path: g.path, kind: "group", files: members.reduce((a, n) => a + (n.kind === "stub" ? 0 : n.files), 0) };
  }
  for (const n of view.nodes) {
    const entry: SidecarNode = { path: n.path, kind: n.kind };
    if (n.kind === "dir" || n.kind === "rest" || n.kind === "stub") entry.files = n.files;
    if (n.kind === "file" || n.kind === "dir" || n.kind === "rest") entry.loc = n.loc;
    if (n.mark) entry.mark = n.mark;
    nodes[id(n.key)] = entry;
  }
  return {
    schema: 1,
    meta: {
      root: raw.meta.root,
      langs: [...raw.meta.langs],
      ...(raw.meta.rev !== undefined ? { rev: raw.meta.rev } : {}),
      ...(raw.meta.dirty !== undefined ? { dirty: raw.meta.dirty } : {}),
      extractor: { name: raw.meta.extractor.name, version: raw.meta.extractor.version },
      stats: { files: raw.files.length, edges: raw.edges.length, unresolved: raw.unresolved.length },
    },
    nodes,
    edges: view.edges
      .filter((e) => !e.stub)
      .map((e) => ({
        from: id(e.from),
        to: id(e.to),
        weight: e.weight,
        typeOnly: e.typeOnly,
        dynamic: e.dynamic,
        evidence: e.evidence.slice(0, cap).map((v) => ({ path: v.path, line: v.line })),
      })),
    hidden: {
      externals: view.hidden.externals.map((x) => ({ name: x.name, edges: x.edges, files: x.files })),
      tests: [...view.hidden.tests],
      hubEdges: view.hidden.hubEdges.map((h) => ({ from: id(h.from), to: id(h.to), weight: h.weight })),
      sccs: view.sccs.map((c) => c.map(id)),
      isolated: { files: view.summary.isolated.files, items: view.summary.isolated.items.map((i) => ({ path: i.path, kind: i.kind, files: i.files })), more: view.summary.isolated.more },
    },
  };
}
