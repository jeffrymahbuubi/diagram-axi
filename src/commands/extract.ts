// `extract <path>`: static import graph of a TS/JS codebase -> a budgeted `.exd` (draw it next) plus a JSON
// sidecar that maps every box back to files and lines. Emits only; it never draws, so it never loads a
// browser, WASM or Mermaid. Pipeline: scan (oxc) -> aggregate (filter, focus, cut, roll-up, hubs, cycles)
// -> toExd + sidecar. Include/exclude globs are applied once, by the scanner (src/extract/discover.ts).

import { existsSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { FlagSpec } from "../cli/spec.js";
import { recommendationLine, type RouteResult } from "../engines/route.js";
import { FocusNotFoundError, aggregate, type AggregateOptions, type View } from "../extract/aggregate.js";
import { denseReason } from "../extract/density.js";
import { detectEntry } from "../extract/entry.js";
import { sidecar } from "../extract/sidecar.js";
import { toExd } from "../extract/to-exd.js";
import type { RawGraph } from "../extract/types.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitBlock, emitList, print } from "../output/toon.js";
import type { OutputFile } from "../render/outputs.js";
import { ENGINE_FLAG, quietRoute, routeGraph } from "./engine-io.js";
import { TOOL, arg, displayPath, existingTargets, fail, flagBool, flagStr, outputsTable, parseDsl, plural, writeTarget } from "./shared.js";

type Flags = Record<string, string | boolean>;

const UNRESOLVED_ROWS = 8;
const CYCLES_SHOWN = 3;
const CYCLE_MEMBERS = 4;

const FLAGS: FlagSpec[] = [
  { name: "focus", type: "string", description: "zoom on a file or folder and what it imports or is imported by" },
  { name: "depth", type: "string", default: "2", description: "--focus: import hops to follow (positive integer)" },
  { name: "dir", type: "string", default: "both", values: ["out", "in", "both"], description: "--focus: follow imports out, importers in, or both" },
  { name: "level", type: "string", default: "auto", values: ["auto", "file", "dir"], description: "auto fits --max-nodes; file never collapses folders; dir never opens below depth 1" },
  { name: "max-nodes", type: "string", default: "25", description: "node budget of the view (positive integer)" },
  { name: "expand", type: "string", description: "comma-separated folders to open even when the budget says collapse" },
  { name: "group", type: "string", default: "dir", values: ["dir", "none"], description: "dir draws folders as groups; none is flat with path labels" },
  { name: "include", type: "string", description: "comma-separated globs; only matching files are scanned" },
  { name: "exclude", type: "string", description: "comma-separated globs; matching files are skipped" },
  { name: "externals", type: "string", default: "hide", values: ["hide", "count", "show"], description: "npm packages: hidden, one summary node, or the heaviest few" },
  { name: "types", type: "boolean", description: "keep type-only imports (drawn dotted)" },
  { name: "tests", type: "boolean", description: "keep test files" },
  { name: "hubs", type: "string", default: "hide", values: ["hide", "show"], description: "show restores the arrows into busy hub files" },
  { name: "tsconfig", type: "string", description: "tsconfig.json for path aliases (default: nearest one at or above <path>)" },
  { name: "out", type: "string", default: "imports", description: "output base path, no extension: writes <out>.exd and <out>.exd.map.json" },
  { name: "format", type: "string", default: "exd", values: ["exd", "json"], description: "exd writes the diagram source; json writes the full scan graph for tools" },
  ENGINE_FLAG,
  { name: "force", type: "boolean", description: "overwrite existing output files" },
];

function posInt(flags: Flags, name: string): number {
  const raw = flagStr(flags, name) ?? "";
  if (!/^[1-9]\d{0,8}$/.test(raw.trim())) throw new UsageError(`invalid value '${raw}' for --${name}`, `use a positive integer, e.g. --${name} ${name === "depth" ? 2 : 25}`);
  return Number(raw);
}

const inside = (rel: string): boolean => rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
const posix = (p: string): string => p.split(sep).join("/");

/** `p` as a posix path relative to the scan root: cwd-relative first (like <path>), then root-relative. */
function underRoot(rootAbs: string, p: string): string | undefined {
  const first = relative(rootAbs, resolve(p));
  if (inside(first)) return posix(first);
  const second = relative(rootAbs, resolve(rootAbs, p));
  return inside(second) && existsSync(resolve(rootAbs, p)) ? posix(second) : undefined;
}

function csv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** `core/a.ts` -> `src/core/a.ts` for a help line (the scan root as the user typed it). */
function shown(rootShown: string, rel: string): string {
  return arg(rootShown === "." ? rel : `${rootShown}/${rel}`);
}

function graphLine(v: View, rawExternalsHidden: boolean): string {
  const s = v.summary;
  const parts: string[] = [];
  if (s.nodes.dirs > 0) parts.push(plural(s.nodes.dirs, "dir"));
  if (s.nodes.files > 0) parts.push(plural(s.nodes.files, "file"));
  if (s.nodes.rest > 0) parts.push(`${s.nodes.rest} rest`);
  if (s.nodes.stubs > 0) parts.push(`${s.nodes.stubs} stubs`);
  if (s.nodes.externals > 0) parts.push(`${s.nodes.externals} npm`);
  const hidden: string[] = [];
  if (rawExternalsHidden && s.externals.packages > 0) hidden.push(`${s.externals.packages} externals`);
  if (s.files.tests > 0) hidden.push(plural(s.files.tests, "test file"));
  if (s.files.generated > 0) hidden.push(`${s.files.generated} generated`);
  if (s.hubs.length > 0 && s.edges.hubDropped > 0) hidden.push(`${plural(s.hubs.length, "hub")} (${plural(s.edges.hubDropped, "edge")})`);
  if (s.edges.typeOnly > 0) hidden.push(`${s.edges.typeOnly} type-only`);
  if (s.focus) hidden.push(`${plural(s.files.kept - s.files.covered, "file")} out of focus`);
  const drawn = v.edges.filter((e) => !e.stub).length;
  const groups = s.nodes.groups > 0 ? ` in ${plural(s.nodes.groups, "group")}` : "";
  const isolated = (s.isolated.files > 0 ? `; isolated: ${plural(s.isolated.files, "file")}` : "") + (s.budget.dense ? `; budget ${s.budget.max} (dense)` : "");
  return `graph: ${plural(s.nodes.visible, "node")} (${parts.join(", ")})${groups}, ${plural(drawn, "edge")}; hidden: ${hidden.length > 0 ? hidden.join(", ") : "none"}${isolated}`;
}

function cyclesLine(v: View): string {
  const c = v.summary.cycles;
  if (c.length === 0) return "cycles: 0";
  const one = (m: string[]): string => (m.length > CYCLE_MEMBERS ? `${m.slice(0, CYCLE_MEMBERS).join(", ")}, +${m.length - CYCLE_MEMBERS}` : m.join(", "));
  const more = c.length > CYCLES_SHOWN ? `; +${c.length - CYCLES_SHOWN} more` : "";
  return `cycles: ${c.length} (${c.slice(0, CYCLES_SHOWN).map(one).join("; ")}${more})`;
}

/** The suggestions: draw first, then a zoom and an expand that name real boxes of this view. */
function helpLines(v: View, rootShown: string, drawLine: string | undefined, flags: Flags, depth: number): string[] {
  const lines: string[] = drawLine ? [drawLine] : [];
  const rootArg = arg(rootShown);
  if (v.summary.focus) {
    const f = v.summary.focus;
    lines.push(`${TOOL} extract ${rootArg} --focus ${shown(rootShown, f.path)} --depth ${depth + 1}`, `${TOOL} extract ${rootArg}`);
    return lines;
  }
  const deg = new Map<string, number>();
  for (const e of v.edges) if (!e.stub) (deg.set(e.from, (deg.get(e.from) ?? 0) + e.weight), deg.set(e.to, (deg.get(e.to) ?? 0) + e.weight));
  const best = (kind: "file" | "dir"): string | undefined =>
    v.nodes
      .filter((n) => n.kind === kind)
      .sort((a, b) => (deg.get(b.key) ?? 0) - (deg.get(a.key) ?? 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0]?.path;
  const file = best("file");
  const dir = best("dir");
  const level = flagStr(flags, "level");
  if (file ?? dir) lines.push(`${TOOL} extract ${rootArg} --focus ${shown(rootShown, (file ?? dir) as string)} --depth 2`);
  if (dir && level !== "file") lines.push(`${TOOL} extract ${rootArg} --expand ${shown(rootShown, dir)}`);
  return lines;
}

/**
 * The shared router says "fits" for graphs that only look small: import graphs converge on a few files, so the arrows pile up.
 * A dense view (src/extract/density.ts) turns a fitting excalidraw route into the d2 suggestion (or d2 itself with
 * `--engine auto`). An explicit --engine, a --target and every route that already suggests something are left alone.
 */
function denser(route: RouteResult, view: View, flags: Flags): RouteResult {
  if (route.explicit || route.suggestion || route.engine !== "excalidraw" || !route.reason.startsWith("fits")) return route;
  const reason = denseReason(view);
  if (reason === undefined) return route;
  return flagStr(flags, "engine") === "auto" ? { ...route, engine: "d2", reason } : { ...route, suggestion: "d2", reason };
}

async function run(parsed: Parameters<CommandModule["run"]>[0]): Promise<number> {
  const flags = parsed.flags;
  const rootArg = parsed.positionals[0] as string;
  const depth = posInt(flags, "depth");
  const maxNodes = posInt(flags, "max-nodes");
  const rootAbs = resolve(rootArg);
  const rootShown = displayPath(rootArg);
  const rootLabel = rootShown === "." ? basename(rootAbs) : rootShown;

  const focusRaw = flagStr(flags, "focus");
  let focus: string | undefined;
  if (focusRaw !== undefined) {
    focus = underRoot(rootAbs, focusRaw);
    if (focus === undefined && relative(rootAbs, resolve(focusRaw)) !== "") {
      throw new UsageError(`--focus '${focusRaw}' is not under ${rootShown}`, `pass a file or folder inside it, e.g. --focus ${rootShown === "." ? "<file>" : `${rootShown}/<file>`}`);
    }
  }
  const expand = csv(flagStr(flags, "expand")).map((p) => {
    const rel = underRoot(rootAbs, p);
    if (rel === undefined) throw new UsageError(`--expand '${p}' is not under ${rootShown}`, `pass folders inside it, e.g. --expand ${rootShown === "." ? "<dir>" : `${rootShown}/<dir>`}`);
    return rel;
  });
  const tsconfig = flagStr(flags, "tsconfig");
  if (tsconfig !== undefined && !existsSync(resolve(tsconfig))) throw new UsageError(`--tsconfig '${tsconfig}' does not exist`, "pass the path of a tsconfig.json, or omit it to use the nearest one");

  const format = flagStr(flags, "format") === "json" ? "json" : "exd";
  const base = (flagStr(flags, "out") ?? "imports").replace(/\.(exd|json)$/i, "");
  const paths = format === "json" ? [`${base}.json`] : [`${base}.exd`, `${base}.exd.map.json`];
  const clash = existingTargets(paths, flagBool(flags, "force"));
  if (clash) {
    return fail(`refusing to overwrite ${clash}`, "pass --force to replace it, or choose another --out", [], [`${TOOL} extract ${arg(rootArg)} --force`, `${TOOL} extract ${arg(rootArg)} --out ${arg(`${base}-2`)}`]);
  }

  let raw: RawGraph;
  try {
    const { tsExtractor } = await import("../extract/ts/scan.js");
    raw = await tsExtractor.extract({
      root: rootAbs,
      rootLabel,
      ...(flagStr(flags, "include") ? { include: flagStr(flags, "include") as string } : {}),
      ...(flagStr(flags, "exclude") ? { exclude: flagStr(flags, "exclude") as string } : {}),
      ...(tsconfig ? { tsconfig: resolve(tsconfig) } : {}),
    });
  } catch (err) {
    throw new AxiError(`extract failed: ${err instanceof Error ? err.message : String(err)}`, `check the path; ${TOOL} extract <dir-with-ts-or-js-files>`);
  }
  if (raw.files.length === 0) {
    throw new AxiError(`no TS/JS source files under ${rootShown}`, "point at a source folder (.ts .tsx .js .jsx .mjs .cjs); node_modules, dist, build and out are skipped");
  }

  const testFiles = new Set(raw.files.filter((f) => f.test).map((f) => f.path));
  const linked = new Set<string>();
  for (const e of raw.edges) if (e.from !== e.to && !testFiles.has(e.from) && !testFiles.has(e.to) && (!e.typeOnly || flagBool(flags, "types"))) (linked.add(e.from), linked.add(e.to));
  const entry = detectEntry(rootAbs, new Set(raw.files.map((f) => f.path)), linked);
  const opts: AggregateOptions = {
    maxNodes,
    autoBudget: !parsed.explicit.has("max-nodes"),
    level: flagStr(flags, "level") as AggregateOptions["level"],
    group: flagStr(flags, "group") as AggregateOptions["group"],
    externals: flagStr(flags, "externals") as AggregateOptions["externals"],
    hubs: flagStr(flags, "hubs") as AggregateOptions["hubs"],
    dir: flagStr(flags, "dir") as AggregateOptions["dir"],
    depth,
    types: flagBool(flags, "types"),
    tests: flagBool(flags, "tests"),
    ...(expand.length > 0 ? { expand } : {}),
    ...(focus !== undefined && focus !== "" ? { focus } : {}),
    ...(entry !== undefined ? { entry } : {}),
  };
  let view: View;
  try {
    view = aggregate(raw, opts);
  } catch (err) {
    if (err instanceof FocusNotFoundError) {
      throw new UsageError(`--focus '${focusRaw}' matches no scanned file or folder under ${rootShown}`, "test files are skipped unless --tests; check the path with: " + `${TOOL} extract ${arg(rootArg)}`);
    }
    throw err;
  }
  if (flagStr(flags, "group") === "none" && view.groups.length === 0 && view.nodes.some((n) => n.kind === "dir" || n.kind === "rest")) {
    view.summary.warnings.push("--group none changes nothing here: no folder is open in this view (raise --max-nodes or --expand a folder)");
  }
  for (const p of expand) {
    if (!raw.files.some((f) => f.path.startsWith(`${p}/`))) view.summary.warnings.push(`--expand '${p}' matches no scanned folder`);
  }

  const written: OutputFile[] = [];
  let drawLine: string | undefined;
  let engineLine: string | undefined;
  if (format === "json") {
    written.push(writeTarget({ kind: "json", path: paths[0] as string, data: `${JSON.stringify(raw, null, 2)}\n` }));
  } else {
    let exd = toExd(view);
    const { graph, errors } = parseDsl(exd.text);
    if (errors[0]) throw new AxiError(`internal: the emitted .exd does not parse (line ${errors[0].line}: ${errors[0].message})`, "report this with the command line");
    const route = denser(await routeGraph(graph, flags), view, flags);
    if (!route.explicit && !quietRoute(route, flags)) engineLine = recommendationLine(route);
    const drawEngine = route.explicit || flagStr(flags, "engine") === "auto" ? route.engine : route.suggestion;
    // the direction depends on the engine the file will be drawn with (a deep, narrow view reads left to right on d2)
    if (drawEngine === "d2") exd = toExd(view, { engine: "d2" });
    written.push(writeTarget({ kind: "exd", path: paths[0] as string, data: exd.text }));
    written.push(writeTarget({ kind: "map", path: paths[1] as string, data: `${JSON.stringify(sidecar(view, exd, raw), null, 2)}\n` }));
    drawLine = `${TOOL} draw ${arg(paths[0] as string)}${drawEngine && drawEngine !== "excalidraw" ? ` --engine ${drawEngine}` : ""} --png`;
  }

  const s = view.summary;
  const warnings = s.warnings.filter((w) => !/ unresolved specifiers$/.test(w));
  const lines = [`extract: ok, ${plural(raw.files.length, "file")}, ${raw.edges.length} import edges in ${rootShown} (${raw.meta.langs.join(", ")})`];
  if (format === "exd") {
    lines.push(graphLine(view, opts.externals === "hide"));
    if (s.focus) lines.push(`focus: ${s.focus.path} (depth ${s.focus.depth}, ${s.focus.dir}), ${plural(s.focus.reached, "file")} reached`);
    lines.push(cyclesLine(view));
  } else {
    lines.push(`graph: full scan (${plural(raw.externals.length, "external")}, ${raw.builtins.length} node builtins)`);
  }
  if (raw.unresolved.length === 0) lines.push("unresolved: 0");
  else {
    const rows = raw.unresolved.slice(0, UNRESOLVED_ROWS).map((u) => ({ file: `${u.file}:${u.line}`, specifier: u.specifier, reason: u.reason }));
    lines.push(emitList("unresolved", rows, ["file", "specifier", "reason"], { total: raw.unresolved.length }));
  }
  if (warnings.length > 0) lines.push(emitBlock("warnings", warnings));
  lines.push(outputsTable(written));
  if (engineLine) lines.push(engineLine);
  lines.push(helpBlock(format === "json" ? [`${TOOL} extract ${arg(rootArg)} --force`] : helpLines(view, rootShown, drawLine, flags, depth)));
  print(lines.join("\n"));
  return 0;
}

export const extractCommand: CommandModule = {
  spec: {
    name: "extract",
    summary: "(experimental) Turn the import graph of a TS/JS codebase into a budgeted .exd (dense or wide views suggest d2; entry and --focus file green, hubs yellow with one `used by N` note) plus a sidecar mapping boxes to files",
    args: [{ name: "path", required: true, description: "source folder to scan (TS/JS: .ts .tsx .js .jsx .mjs .cjs)" }],
    flags: FLAGS,
    examples: [
      "diagram-axi extract src",
      "diagram-axi extract src --focus src/commands/draw.ts --depth 2",
      "diagram-axi extract src --expand src/layout --max-nodes 30",
      "diagram-axi extract . --group none --exclude legacy --out out/imports",
    ],
  },
  run,
};
