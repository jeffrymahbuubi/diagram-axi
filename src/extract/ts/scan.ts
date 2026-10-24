/**
 * TS/JS import-graph extractor: oxc-parser for syntax, oxc-resolver for resolution. Both are imported
 * lazily so commands that never call `extract` keep their cold start.
 *
 * Decisions (plan section 3-4):
 * - One edge per import occurrence: static imports, re-exports (`export ... from`), `import()` (also in
 *   type position), `require()` and `import x = require()`.
 * - `typeOnly` = `import type`, `export type`, `import type X = require()`, or every binding `type`-qualified.
 * - Node core modules (`node:fs`, `fs`, `fs/promises`) are NOT externals: they are listed in
 *   `RawGraph.builtins` (name without `node:`), so the npm external count stays honest.
 * - Externals = bare specifiers resolving into a `node_modules` directory, plus bare specifiers the
 *   resolver cannot find (dependency not installed) unless they match a tsconfig `paths` pattern, which is
 *   reported as `unresolved` / `alias-miss`. Counted by package name (`@scope/pkg`, subpath stripped).
 * - Imports that are neither an edge nor an external are listed in `skipped` with a reason.
 */
import { readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { discover, sourceLang, toPosix } from "../discover.js";
import { readGit } from "../git.js";
import type {
  EdgeKind,
  ExtractOptions,
  Extractor,
  RawEdge,
  RawExternal,
  RawFile,
  RawGraph,
  RawSkipped,
  RawUnresolved,
  SkippedReason,
  SourceLang,
} from "../types.js";

/** Keep in step with the exact pin in package.json (asserted by test/extract-scan.test.ts). */
export const OXC_PARSER_VERSION = "0.155.0";
export const EXTRACTOR_NAME = "oxc-ts";

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".d.ts", ".d.mts", ".d.cts"];
const CASE_FOLD = process.platform === "win32" || process.platform === "darwin";

/** Minimal structural view of the ESTree nodes we read. */
interface AstNode {
  type?: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

function key(p: string): string {
  return CASE_FOLD ? p.toLowerCase() : p;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Package name for a bare specifier: `lodash/fp` -> `lodash`, `@a/b/c` -> `@a/b`. */
export function packageName(spec: string): string {
  const parts = spec.split("/");
  if (spec.startsWith("@") && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? spec;
}

function builtinName(spec: string): string | undefined {
  if (spec.startsWith("node:")) return spec.slice(5);
  return BUILTINS.has(spec) ? spec : undefined;
}

function isBare(spec: string): boolean {
  return !(spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || isAbsolute(spec));
}

/** `https:`, `data:`, `file:` ... (but not a Windows drive path such as `C:\x`). */
function isUrlLike(spec: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/i.test(spec);
}

/** Strip comments and trailing commas so tsconfig.json parses as JSON. */
function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** `compilerOptions.paths` keys of a tsconfig, following relative `extends` (depth <= 5). */
export function readPathPatterns(tsconfigAbs: string): string[] {
  const patterns = new Set<string>();
  let cur: string | undefined = tsconfigAbs;
  for (let depth = 0; cur && depth < 5; depth++) {
    let cfg: { extends?: unknown; compilerOptions?: { paths?: Record<string, unknown> } };
    try {
      cfg = parseJsonc(readFileSync(cur, "utf8")) as typeof cfg;
    } catch {
      break;
    }
    for (const k of Object.keys(cfg.compilerOptions?.paths ?? {})) patterns.add(k);
    const ext: unknown = Array.isArray(cfg.extends) ? cfg.extends[0] : cfg.extends;
    if (typeof ext !== "string" || !ext.startsWith(".")) break;
    cur = resolve(dirname(cur), ext.endsWith(".json") ? ext : `${ext}.json`);
  }
  return [...patterns].sort(byCodeUnit);
}

function matchesPathPattern(spec: string, patterns: string[]): boolean {
  for (const p of patterns) {
    const star = p.indexOf("*");
    if (star < 0) {
      if (spec === p) return true;
    } else {
      const pre = p.slice(0, star);
      const post = p.slice(star + 1);
      if (spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post)) return true;
    }
  }
  return false;
}

/** Offsets -> 1-based lines. `starts[i]` is the offset of line i+1. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

interface Occurrence {
  /** String specifier, or undefined for a non-literal expression. */
  spec: string | undefined;
  /** Source text shown for non-literal specifiers. */
  snippet: string;
  offset: number;
  kind: EdgeKind;
  typeOnly: boolean;
  dynamic: boolean;
}

/** Literal string value of a Literal / template-without-substitutions node. */
function literalString(n: AstNode | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral") {
    const exprs = n.expressions as unknown[] | undefined;
    const quasis = n.quasis as Array<{ value: { cooked?: string | null } }> | undefined;
    if (exprs && exprs.length === 0 && quasis && quasis.length === 1) return quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function snippetOf(text: string, n: AstNode | null | undefined): string {
  if (!n || typeof n.start !== "number" || typeof n.end !== "number") return "<expression>";
  return text.slice(n.start, n.end).replace(/\s+/g, " ").slice(0, 60);
}

/** Collect `import()`, `import("x")` types, `require()` and `import x = require()` from the AST. */
function walkDynamic(root: unknown, text: string, out: Occurrence[]): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      for (const c of n) stack.push(c);
      continue;
    }
    const node = n as AstNode;
    switch (node.type) {
      case "ImportExpression":
      case "TSImportType": {
        const src = node.source as AstNode | undefined;
        out.push({
          spec: literalString(src),
          snippet: snippetOf(text, src),
          offset: node.start ?? 0,
          kind: "dynamic",
          typeOnly: node.type === "TSImportType",
          dynamic: true,
        });
        break;
      }
      case "TSImportEqualsDeclaration": {
        const ref = node.moduleReference as AstNode | undefined;
        if (ref?.type === "TSExternalModuleReference") {
          const expr = ref.expression as AstNode | undefined;
          out.push({
            spec: literalString(expr),
            snippet: snippetOf(text, expr),
            offset: node.start ?? 0,
            kind: "require",
            typeOnly: node.importKind === "type",
            dynamic: false,
          });
        }
        break;
      }
      case "CallExpression": {
        const callee = node.callee as AstNode | undefined;
        const args = node.arguments as AstNode[] | undefined;
        if (callee?.type === "Identifier" && callee.name === "require" && args && args.length >= 1) {
          out.push({
            spec: literalString(args[0]),
            snippet: snippetOf(text, args[0]),
            offset: node.start ?? 0,
            kind: "require",
            typeOnly: false,
            dynamic: false,
          });
        }
        break;
      }
    }
    for (const k of Object.keys(node)) {
      if (k === "type" || k === "start" || k === "end") continue;
      const v = node[k];
      if (v && typeof v === "object") stack.push(v);
    }
  }
}

interface StaticImportLike {
  start: number;
  moduleRequest: { value: string };
  entries: Array<{ isType: boolean }>;
}
interface StaticExportLike {
  start: number;
  entries: Array<{
    start: number;
    moduleRequest: { value: string; start: number } | null;
    exportName: { kind: string };
    isType: boolean;
  }>;
}

/** The resolver configuration used by the scan (exported so tests can resolve with the same settings). */
export function resolverOptions(tsconfigAbs?: string) {
  return {
    tsconfig: tsconfigAbs ? { configFile: tsconfigAbs } : undefined,
    extensions: RESOLVE_EXTENSIONS,
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
    conditionNames: ["import", "require", "node", "default"],
  };
}

export type ResolverLike = {
  sync(directory: string, request: string): { path?: string; error?: string };
};

export async function loadOxc() {
  try {
    const [parser, resolver] = await Promise.all([import("oxc-parser"), import("oxc-resolver")]);
    return { parseSync: parser.parseSync, ResolverFactory: resolver.ResolverFactory };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new Error(
      `cannot load oxc-parser/oxc-resolver native binding (${msg}); needs Node >= 20.19 and a supported platform`,
    );
  }
}

export async function scanTs(opts: ExtractOptions): Promise<RawGraph> {
  const d = discover({ root: opts.root, include: opts.include, exclude: opts.exclude, tsconfig: opts.tsconfig });
  const { parseSync, ResolverFactory } = await loadOxc();
  const warnings = [...d.warnings];

  const resolver = new ResolverFactory(resolverOptions(d.tsconfig)) as ResolverLike;
  const pathPatterns = d.tsconfig ? readPathPatterns(d.tsconfig) : [];

  let realRoot = d.root;
  try {
    realRoot = realpathSync.native(d.root);
  } catch {
    /* keep d.root */
  }
  const relToRoot = (abs: string): string | undefined => {
    for (const base of [d.root, realRoot]) {
      const rel = toPosix(relative(base, abs));
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    }
    return undefined;
  };
  const fileByKey = new Map<string, string>();
  for (const f of d.files) fileByKey.set(key(f.path), f.path);

  const files: RawFile[] = [];
  const edges: RawEdge[] = [];
  const unresolved: RawUnresolved[] = [];
  const skipped: RawSkipped[] = [];
  const extAcc = new Map<string, { count: number; files: Set<string> }>();
  const builtinAcc = new Map<string, { count: number; files: Set<string> }>();
  const parseFailures: string[] = [];

  const bump = (m: Map<string, { count: number; files: Set<string> }>, name: string, file: string) => {
    let a = m.get(name);
    if (!a) m.set(name, (a = { count: 0, files: new Set() }));
    a.count++;
    a.files.add(file);
  };
  const skip = (file: string, specifier: string, line: number, reason: SkippedReason) =>
    skipped.push({ file, specifier, line, reason });

  for (const f of d.files) {
    const text = readFileSync(f.abs, "utf8");
    const starts = lineStarts(text);
    const loc = text.length === 0 ? 0 : starts.length - (text.endsWith("\n") ? 1 : 0);
    const result = parseSync(f.abs, text);
    if (result.errors.some((e) => e.severity === "Error")) parseFailures.push(f.path);

    const occ: Occurrence[] = [];
    let exportCount = 0;
    for (const s of result.module.staticImports as unknown as StaticImportLike[]) {
      occ.push({
        spec: s.moduleRequest.value,
        snippet: s.moduleRequest.value,
        offset: s.start,
        kind: "import",
        typeOnly: s.entries.length > 0 && s.entries.every((e) => e.isType),
        dynamic: false,
      });
    }
    for (const s of result.module.staticExports as unknown as StaticExportLike[]) {
      // `export { x }` of an imported binding also carries a moduleRequest (the import's); a real
      // `export ... from "m"` has its export clause BEFORE the module string.
      const from = s.entries.filter((e) => e.moduleRequest !== null && e.start <= e.moduleRequest.start);
      for (const e of s.entries) if (e.exportName.kind === "Name" || e.exportName.kind === "Default") exportCount++;
      const first = from[0];
      if (first?.moduleRequest) {
        occ.push({
          spec: first.moduleRequest.value,
          snippet: first.moduleRequest.value,
          offset: s.start,
          kind: "reexport",
          typeOnly: from.every((e) => e.isType),
          dynamic: false,
        });
      }
    }
    if (/\brequire\b|\bimport\s*\(/.test(text)) walkDynamic(result.program, text, occ);

    files.push({ path: f.path, lang: f.lang, test: f.test, loc, exports: exportCount });

    for (const o of occ) {
      const line = lineAt(starts, o.offset);
      if (o.spec === undefined) {
        skip(f.path, o.snippet, line, "non-literal");
        continue;
      }
      const spec = o.spec;
      const bi = builtinName(spec);
      if (bi !== undefined) {
        bump(builtinAcc, bi, f.path);
        continue;
      }
      if (isUrlLike(spec)) {
        skip(f.path, spec, line, "url");
        continue;
      }
      const res = resolver.sync(dirname(f.abs), spec);
      if (res.path) {
        const resolvedAbs = resolve(res.path);
        const rel = relToRoot(resolvedAbs);
        const target = rel === undefined ? undefined : fileByKey.get(key(rel));
        const inNodeModules = /[\\/]node_modules[\\/]/.test(resolvedAbs);
        if (target !== undefined) {
          edges.push({
            from: f.path,
            to: target,
            specifier: spec,
            line,
            typeOnly: o.typeOnly,
            dynamic: o.dynamic,
            kind: o.kind,
          });
        } else if (isBare(spec) && inNodeModules) {
          bump(extAcc, packageName(spec), f.path);
        } else if (rel === undefined) {
          skip(f.path, spec, line, "outside-root");
        } else if (sourceLang(resolvedAbs) === undefined) {
          skip(f.path, spec, line, "not-source");
        } else {
          skip(f.path, spec, line, "excluded");
        }
      } else if (isBare(spec)) {
        if (matchesPathPattern(spec, pathPatterns)) {
          unresolved.push({ file: f.path, specifier: spec, line, reason: "alias-miss" });
        } else {
          bump(extAcc, packageName(spec), f.path);
        }
      } else {
        unresolved.push({ file: f.path, specifier: spec, line, reason: "not-found" });
      }
    }
  }

  if (parseFailures.length > 0) {
    const shown = parseFailures.slice(0, 5).join(", ");
    warnings.push(
      `${parseFailures.length} file(s) with syntax errors (edges may be incomplete): ${shown}${parseFailures.length > 5 ? ", ..." : ""}`,
    );
  }

  const toRefs = (m: Map<string, { count: number; files: Set<string> }>): RawExternal[] =>
    [...m.entries()]
      .map(([name, a]) => ({ name, count: a.count, files: a.files.size }))
      .sort((a, b) => byCodeUnit(a.name, b.name));

  edges.sort(
    (a, b) =>
      byCodeUnit(a.from, b.from) ||
      byCodeUnit(a.to, b.to) ||
      a.line - b.line ||
      byCodeUnit(a.specifier, b.specifier) ||
      byCodeUnit(a.kind, b.kind),
  );
  const byLoc = (a: { file: string; line: number; specifier: string }, b: typeof a) =>
    byCodeUnit(a.file, b.file) || a.line - b.line || byCodeUnit(a.specifier, b.specifier);
  unresolved.sort(byLoc);
  skipped.sort(byLoc);

  const langs = [...new Set(files.map((f) => f.lang))].sort() as SourceLang[];
  const label = opts.rootLabel ?? (toPosix(relative(process.cwd(), d.root)) || ".");
  const meta: RawGraph["meta"] = { root: label, langs, extractor: { name: EXTRACTOR_NAME, version: OXC_PARSER_VERSION } };
  if (d.tsconfig) meta.tsconfig = toPosix(relative(d.root, d.tsconfig));
  if (opts.git !== false) {
    const g = readGit(d.root);
    if (g.rev) meta.rev = g.rev;
    if (g.dirty !== undefined) meta.dirty = g.dirty;
  }

  return {
    schema: 1,
    meta,
    files,
    edges,
    externals: toRefs(extAcc),
    builtins: toRefs(builtinAcc),
    unresolved,
    skipped,
    warnings,
  };
}

/** The oxc-backed TS/JS extractor. */
export const tsExtractor: Extractor = {
  name: EXTRACTOR_NAME,
  version: OXC_PARSER_VERSION,
  langs: ["ts", "js"],
  extract: scanTs,
};
