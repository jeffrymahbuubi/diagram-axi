// Source detection (R3): which engine and source type a file is (extension), and which diagram kind it
// holds: `--kind`, else a `# kind: <k>` (D2) / `%% kind: <k>` (Mermaid) header comment, else the first
// keyword, else `graph`. Pure: text in, answer out.

import { basename, extname } from "node:path";
import { UsageError } from "../output/errors.js";
import { KINDS, type EngineId, type Kind } from "./types.js";

export type SourceType = "exd" | "excalidraw" | "d2" | "mmd";

export interface DetectedSource {
  engine: EngineId;
  sourceType: SourceType;
}

export interface DetectedKind {
  kind: Kind;
  from: "flag" | "header" | "keyword" | "default";
  /** A header named a kind that does not exist; it was ignored. */
  warning?: string;
}

const BY_EXT: Record<string, DetectedSource> = {
  ".exd": { engine: "excalidraw", sourceType: "exd" },
  ".excalidraw": { engine: "excalidraw", sourceType: "excalidraw" },
  ".d2": { engine: "d2", sourceType: "d2" },
  ".mmd": { engine: "mermaid", sourceType: "mmd" },
  ".mermaid": { engine: "mermaid", sourceType: "mmd" },
};

/** Engine and source type from a file name or extension (`.d2`, `x.mmd`); undefined for anything else (`.svg`, none). */
export function detectSource(pathOrExt: string): DetectedSource | undefined {
  const name = basename(pathOrExt);
  const ext = /^\.[^.]+$/.test(name) ? name : extname(name); // a bare `.d2` is an extension, not a dotfile
  return BY_EXT[ext.toLowerCase()];
}

const ALIASES: Record<string, Kind> = {
  graph: "graph",
  flowchart: "graph",
  flow: "graph",
  sequence: "sequence",
  sequencediagram: "sequence",
  class: "class",
  classdiagram: "class",
  erd: "erd",
  er: "erd",
  erdiagram: "erd",
  state: "state",
  statediagram: "state",
  statediagramv2: "state",
  timeline: "timeline",
  gitgraph: "gitgraph",
  git: "gitgraph",
  mindmap: "mindmap",
};

/** `ERD`, `er-diagram`, `state_diagram` -> a Kind; undefined when it names none. */
export function parseKind(value: string): Kind | undefined {
  return ALIASES[value.trim().toLowerCase().replace(/[\s_-]+/g, "")];
}

/**
 * Throws a usage error when `engineFlag` names an engine that cannot read `source`. `.exd` is read by
 * every engine (it is translated); native sources only by their own.
 */
export function resolveEngine(source: DetectedSource, engineFlag: string | undefined): EngineId {
  if (!engineFlag || engineFlag === "auto") return source.engine;
  if (source.sourceType === "exd") {
    if (engineFlag === "excalidraw" || engineFlag === "d2" || engineFlag === "mermaid") return engineFlag;
    throw new UsageError(`unknown engine '${engineFlag}'`, "use --engine excalidraw|d2|mermaid");
  }
  if (engineFlag !== source.engine) {
    throw new UsageError(
      `--engine ${engineFlag} conflicts with the .${source.sourceType === "excalidraw" ? "excalidraw" : source.sourceType} source, which belongs to ${source.engine}`,
      `drop --engine, or use --engine ${source.engine}`,
    );
  }
  return source.engine;
}

const HEADER = /^\s*(?:#|%%)\s*kind\s*:\s*([A-Za-z][\w -]*?)\s*$/;

/** Lines before the first content line: blank lines, comments, a `---` frontmatter block, `%%{...}%%` directives. */
function headerLines(text: string, comment: "#" | "%%"): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (comment === "%%" && lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === "---");
    i = end < 0 ? lines.length : end + 1;
  }
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "" || t.startsWith(comment)) out.push(lines[i]!);
    else break;
  }
  return out;
}

/** First keyword of a Mermaid source (after frontmatter, comments and directives). */
function mermaidKeyword(text: string): Kind | undefined {
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === "---");
    i = end < 0 ? lines.length : end + 1;
  }
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "" || t.startsWith("%%")) continue; // comments and %%{init}%% directives
    const word = /^[A-Za-z][\w-]*/.exec(t)?.[0] ?? "";
    switch (word) {
      case "sequenceDiagram":
        return "sequence";
      case "classDiagram":
      case "classDiagram-v2":
        return "class";
      case "erDiagram":
        return "erd";
      case "stateDiagram":
      case "stateDiagram-v2":
        return "state";
      case "timeline":
        return "timeline";
      case "gitGraph":
        return "gitgraph";
      case "mindmap":
        return "mindmap";
      case "flowchart":
      case "graph":
        return "graph";
      default:
        return undefined;
    }
  }
  return undefined;
}

const D2_SHAPE_KIND: Record<string, Kind> = { sequence_diagram: "sequence", class: "class", sql_table: "erd" };

/** First `shape: sequence_diagram|class|sql_table` outside whole-line comments. */
function d2Keyword(text: string): Kind | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = /\bshape\s*:\s*(sequence_diagram|class|sql_table)\b/.exec(line);
    if (m) return D2_SHAPE_KIND[m[1]!];
  }
  return undefined;
}

/**
 * Diagram kind of `text`. `flag` is the `--kind` value: an unknown one is a usage error. For `.exd` and
 * `.excalidraw` the kind is `graph` unless a flag says otherwise.
 */
export function detectKind(sourceType: SourceType, text: string, flag?: string): DetectedKind {
  if (flag !== undefined && flag !== "") {
    const kind = parseKind(flag);
    if (!kind) throw new UsageError(`unknown kind '${flag}'`, `use --kind ${KINDS.join("|")}`);
    return { kind, from: "flag" };
  }
  if (sourceType === "exd" || sourceType === "excalidraw") return { kind: "graph", from: "default" };

  let warning: string | undefined;
  for (const line of headerLines(text, sourceType === "d2" ? "#" : "%%")) {
    const m = HEADER.exec(line);
    if (!m) continue;
    const kind = parseKind(m[1]!);
    if (kind) return { kind, from: "header" };
    warning = `unknown kind '${m[1]}' in header comment; expected one of ${KINDS.join(", ")}`;
  }
  const keyword = sourceType === "d2" ? d2Keyword(text) : mermaidKeyword(text);
  if (keyword) return { kind: keyword, from: "keyword", ...(warning ? { warning } : {}) };
  return { kind: "graph", from: "default", ...(warning ? { warning } : {}) };
}
