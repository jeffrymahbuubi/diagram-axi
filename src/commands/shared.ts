// Helpers shared by draw, render, inspect and check: input reading, flag parsing,
// diagnostics -> TOON, output files and error reporting.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import type { Diagnostic, Direction, Graph } from "../dsl/ast.js";
import { parse } from "../dsl/parser.js";
import { layout } from "../layout/dagre-layout.js";
import type { SceneElement } from "../quality/geom.js";
import { qualityHints, type QualityRow } from "../quality/hints.js";
import { buildScene } from "../scene/build.js";
import { summarize } from "../scene/summary.js";
import type { OutputFile, OutputKind, RenderRequest, RenderResult } from "../render/outputs.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";

export const TOOL = "diagram-axi";

type Flags = Record<string, string | boolean>;

export const flagStr = (flags: Flags, name: string): string | undefined => {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
};
export const flagBool = (flags: Flags, name: string): boolean => flags[name] === true;

/** Path as shown to the agent: relative to cwd (absolute across drives), forward slashes. */
export function displayPath(p: string): string {
  const abs = resolve(p);
  const rel = relative(process.cwd(), abs);
  const out = rel === "" ? "." : isAbsolute(rel) ? abs : rel;
  return out.split(sep).join("/");
}

/** A path as a command-line argument inside a help line. */
export function arg(p: string): string {
  const shown = displayPath(p);
  return /\s/.test(shown) ? `"${shown}"` : shown;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---- input ----

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError("no input on stdin", `pipe the DSL in: cat diagram.exd | ${TOOL} draw - --out diagram`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** File contents, or stdin when `file` is `-`. */
export async function readSource(file: string): Promise<string> {
  if (file === "-") return stripBom(await readStdin());
  try {
    return stripBom(readFileSync(file, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "is a directory" : (err as Error).message;
    throw new AxiError(`cannot read '${displayPath(file)}': ${reason}`, "check the path; use - to read the DSL from stdin");
  }
}

// ---- parsing and diagnostics ----

export interface Parsed {
  graph: Graph;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export function parseDsl(text: string): Parsed {
  const { graph, diagnostics } = parse(text);
  return {
    graph,
    errors: diagnostics.filter((d) => d.severity === "error"),
    warnings: diagnostics.filter((d) => d.severity === "warning"),
  };
}

export const DIAG_FIELDS = ["line", "col", "code", "message"];

export interface DiagRow {
  line: number | string;
  col: number | string;
  code: string;
  message: string;
}

export function diagTable(name: string, diags: DiagRow[]): string {
  return emitList(name, diags as unknown as Array<Record<string, unknown>>, DIAG_FIELDS);
}

export function byPosition(diags: Diagnostic[]): Diagnostic[] {
  return [...diags].sort((a, b) => a.line - b.line || a.col - b.col);
}

const SYNTAX_TOPIC: Partial<Record<Diagnostic["code"], string>> = {
  "unknown-color": "style",
  "unknown-flag": "style",
  "unclosed-group": "groups",
  "unknown-direction": "index",
};

/** Prints a failure as TOON (error, suggestion, optional blocks, help) and returns exit code 1. */
export function fail(message: string, suggestion: string | undefined, blocks: string[], help: string[]): number {
  const lines = [`error: ${message}`];
  if (suggestion) lines.push(`suggestion: ${suggestion}`);
  print([...lines, ...blocks, helpBlock(help)].join("\n"));
  return 1;
}

/** The R3 parse-error output: first error with line/col, suggestion, next steps. */
export function failParse(error: Diagnostic, file: string): number {
  const topic = SYNTAX_TOPIC[error.code] ?? "nodes";
  const help = [`${TOOL} syntax ${topic}`];
  help.push(file === "-" ? `${TOOL} syntax example` : `${TOOL} check ${arg(file)}`);
  return fail(`line ${error.line}, col ${error.col}: ${error.message}`, error.suggestion, [], help);
}

// ---- numeric flags ----

function number(flags: Flags, name: string, ok: (n: number) => boolean, rule: string, example: string): number {
  const raw = flagStr(flags, name) ?? "";
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n) || !ok(n)) {
    throw new UsageError(`invalid value '${raw}' for --${name}`, `${rule}, e.g. --${name} ${example}`);
  }
  return n;
}

export interface RenderOptions {
  scale: number;
  /** --scale was typed: the render delivers it (up to 16384 px) instead of applying the 2048 px default cap. */
  exactScale?: boolean;
  padding: number;
  timeoutMs: number;
  theme?: "light" | "dark";
  transparent: boolean;
  browserPath?: string;
  fontsUrl?: string;
}

/** Validates and converts the shared render flags; bad values are usage errors (exit 2). */
export function readRenderOptions(flags: Flags, explicit?: ReadonlySet<string>): RenderOptions {
  const o: RenderOptions = {
    scale: number(flags, "scale", (n) => n > 0 && n <= 16, "use a number above 0 and up to 16", "2"),
    padding: number(flags, "padding", (n) => n >= 0, "use a number of px, 0 or more", "20"),
    timeoutMs: number(flags, "timeout", (n) => n > 0, "use a number of ms above 0", "30000"),
    transparent: flagBool(flags, "transparent"),
  };
  if (explicit?.has("scale")) o.exactScale = true;
  const theme = flagStr(flags, "theme");
  if (theme === "light" || theme === "dark") o.theme = theme;
  const browserPath = flagStr(flags, "browser-path");
  if (browserPath) o.browserPath = browserPath;
  const fontsUrl = flagStr(flags, "fonts-url");
  if (fontsUrl) o.fontsUrl = fontsUrl;
  return o;
}

export function renderRequest(scene: RenderRequest["scene"], want: { png: boolean; svg: boolean }, o: RenderOptions): RenderRequest {
  return { scene, png: want.png, svg: want.svg, ...o };
}

// ---- output files ----

/** Output base path (no extension): --out, else the input path minus its extension. */
export function outBase(out: string | undefined, input: string | undefined): string {
  if (out) return out.replace(/\.(excalidraw|png|svg)$/i, "");
  if (!input) throw new UsageError("--out is required here", "pass --out <path-without-extension>");
  const p = parsePath(input);
  return join(p.dir, p.name);
}

export interface Target {
  kind: OutputKind;
  path: string;
  data: string | Uint8Array;
}

/** Refuses to replace existing files unless `force`; returns an error message or undefined. */
export function existingTargets(paths: string[], force: boolean): string | undefined {
  if (force) return undefined;
  const hit = paths.filter((p) => existsSync(p));
  return hit.length === 0 ? undefined : hit.map(displayPath).join(", ");
}

export function writeTarget(t: Target): OutputFile {
  mkdirSync(dirname(resolve(t.path)), { recursive: true });
  writeFileSync(t.path, t.data);
  const bytes = typeof t.data === "string" ? Buffer.byteLength(t.data) : t.data.byteLength;
  return { kind: t.kind, path: displayPath(t.path), bytes };
}

export function outputsTable(files: OutputFile[]): string {
  return emitList("outputs", files as unknown as Array<Record<string, unknown>>, ["kind", "path", "bytes"]);
}

export function sceneLine(s: { nodes: number; edges: number; groups: number; bounds: { width: number; height: number } }, extra: string[]): string {
  const parts = [plural(s.nodes, "node"), plural(s.edges, "edge"), plural(s.groups, "group"), `${s.bounds.width}x${s.bounds.height} px`, ...extra];
  return `scene: ${parts.join(", ")}`;
}

// ---- layout quality ----

export const QUALITY_ROWS = 8;
export const STRICT_QUALITY_FLAG = {
  name: "strict-quality",
  type: "boolean",
  description: "treat HARD layout findings as errors (exit 1); files are still written",
} as const;

/** Quality rows of a laid-out scene; `graph` lets the fixes name exact DSL ids and probe another rank direction. */
export function qualityFor(scene: RenderRequest["scene"], graph: Graph | undefined, direction: Direction | undefined): QualityRow[] {
  const probe = graph
    ? (dir: Direction): number | undefined => {
        const b = summarize(buildScene(graph, layout({ graph, direction: dir }))).bounds;
        return Math.max(b.width / Math.max(b.height, 1), b.height / Math.max(b.width, 1));
      }
    : undefined;
  return qualityHints(scene as { elements?: SceneElement[] }, { graph, direction, probe });
}

export const hasHard = (rows: QualityRow[]): boolean => rows.some((r) => r.severity === "hard");

/** `quality: ok`, or `quality[N]{code,detail,fix}:` rows (HARD first), cut at QUALITY_ROWS with `N of M total`. */
export function qualityBlock(rows: QualityRow[]): string {
  if (rows.length === 0) return "quality: ok";
  const shown = rows.slice(0, QUALITY_ROWS) as unknown as Array<Record<string, unknown>>;
  return emitList("quality", shown, ["code", "detail", "fix"], { total: rows.length });
}

export interface RenderOutcome {
  /** PNG/SVG files written (empty on failure). */
  files: OutputFile[];
  result?: RenderResult;
  error?: AxiError;
}

/** Renders once and writes `<base>.png` / `<base>.svg`; a render failure is returned, not thrown. */
export async function renderAndWrite(req: RenderRequest, base: string): Promise<RenderOutcome> {
  try {
    const { renderScene } = await import("../render/render.js");
    const result = await renderScene(req);
    const files: OutputFile[] = [];
    if (req.png && result.png) files.push(writeTarget({ kind: "png", path: `${base}.png`, data: result.png }));
    if (req.svg && result.svg !== undefined) files.push(writeTarget({ kind: "svg", path: `${base}.svg`, data: result.svg }));
    return { files, result };
  } catch (err) {
    if (err instanceof AxiError) return { files: [], error: err };
    return { files: [], error: new AxiError(`render failed: ${err instanceof Error ? err.message : String(err)}`, "check the scene file; try a smaller diagram") };
  }
}
