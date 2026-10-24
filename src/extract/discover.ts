/**
 * File discovery for `extract`: deterministic walk, skip rules, test classification, include/exclude
 * globs and tsconfig lookup. Pure filesystem code, no parsing.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SourceLang } from "./types.js";

/** Directories never entered (any depth). Every directory starting with `.` is skipped as well. */
export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "out", ".git"]);

const TS_EXT = [".ts", ".tsx", ".mts", ".cts"] as const;
const JS_EXT = [".js", ".jsx", ".mjs", ".cjs"] as const;
const DTS_RE = /\.d\.[cm]?ts$/;

export interface DiscoveredFile {
  /** Posix path relative to the root. */
  path: string;
  /** Absolute path (platform separators). */
  abs: string;
  lang: SourceLang;
  test: boolean;
}

export interface Discovery {
  /** Absolute scan root. */
  root: string;
  /** Sorted by `path` (code-unit order). */
  files: DiscoveredFile[];
  /** Absolute tsconfig path, when found. */
  tsconfig?: string;
  warnings: string[];
}

export interface DiscoverOptions {
  root: string;
  include?: string | string[];
  exclude?: string | string[];
  tsconfig?: string;
}

/** Posix form of a path (backslashes to slashes). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Language by extension, or undefined for non-source files and `.d.ts` declarations. */
export function sourceLang(file: string): SourceLang | undefined {
  if (DTS_RE.test(file)) return undefined;
  const dot = file.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = file.slice(dot);
  if ((TS_EXT as readonly string[]).includes(ext)) return "ts";
  if ((JS_EXT as readonly string[]).includes(ext)) return "js";
  return undefined;
}

/** `*.test.*`, `*.spec.*`, or any directory segment named `test`, `tests`, `__tests__`. */
export function isTestPath(relPosix: string): boolean {
  const parts = relPosix.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (/\.(test|spec)\.[^.]+$/.test(name)) return true;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (seg === "test" || seg === "tests" || seg === "__tests__") return true;
  }
  return false;
}

/** Split a comma-separated glob list (or pass an array through); empty entries are dropped. */
export function splitGlobs(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : v.split(",");
  return list.map((s) => s.trim()).filter((s) => s.length > 0);
}

function escapeRe(c: string): string {
  return c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Translate one glob body into a regex source: `**`, `*`, `?`, `{a,b}`. */
function globToRegexSource(glob: string): string {
  let out = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      braces++;
      out += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      out += ")";
    } else if (c === "," && braces > 0) out += "|";
    else out += escapeRe(c);
  }
  return out + ")".repeat(braces);
}

/**
 * Compile comma-split globs into a matcher over posix paths relative to the root.
 * A pattern without `/` matches the file name or any directory segment (`legacy` removes `legacy/**`);
 * a pattern with `/` is anchored at the root and also matches everything beneath a matched directory.
 */
export function compileGlobs(patterns: string[]): (relPosix: string) => boolean {
  const res = patterns.map((raw) => {
    let p = toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    const anchored = p.includes("/");
    p = p.replace(/^\//, "");
    const body = globToRegexSource(p);
    return anchored
      ? new RegExp(`^${body}(?:/.*)?$`)
      : new RegExp(`(?:^|/)${body}(?:/|$)`);
  });
  return (rel) => res.some((re) => re.test(rel));
}

/** Nearest `tsconfig.json` at or above `dir`, or undefined. */
export function findTsconfig(dir: string): string | undefined {
  let cur = resolve(dir);
  for (;;) {
    const cand = join(cur, "tsconfig.json");
    if (existsSync(cand)) return cand;
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

function walk(rootAbs: string, relDir: string, out: DiscoveredFile[]): void {
  const abs = relDir === "" ? rootAbs : join(rootAbs, relDir);
  const entries = readdirSync(abs, { withFileTypes: true });
  for (const e of entries) {
    const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(rootAbs, rel, out);
    } else if (e.isFile()) {
      const lang = sourceLang(e.name);
      if (!lang) continue;
      out.push({ path: rel, abs: join(abs, e.name), lang, test: isTestPath(rel) });
    }
  }
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Walk `opts.root` deterministically. Symlinks are not followed. Throws when the root is not a directory
 * or an explicit tsconfig does not exist.
 */
export function discover(opts: DiscoverOptions): Discovery {
  const root = resolve(opts.root);
  let st;
  try {
    st = statSync(root);
  } catch {
    throw new Error(`path not found: ${toPosix(opts.root)}`);
  }
  if (!st.isDirectory()) throw new Error(`not a directory: ${toPosix(opts.root)}`);

  const all: DiscoveredFile[] = [];
  walk(root, "", all);

  const inc = splitGlobs(opts.include);
  const exc = splitGlobs(opts.exclude);
  const isIncluded = inc.length > 0 ? compileGlobs(inc) : undefined;
  const isExcluded = exc.length > 0 ? compileGlobs(exc) : undefined;
  const files = all
    .filter((f) => (isIncluded ? isIncluded(f.path) : true) && !(isExcluded && isExcluded(f.path)))
    .sort((a, b) => byCodeUnit(a.path, b.path));

  const warnings: string[] = [];
  let tsconfig: string | undefined;
  if (opts.tsconfig) {
    tsconfig = resolve(opts.tsconfig);
    if (!existsSync(tsconfig)) throw new Error(`tsconfig not found: ${toPosix(opts.tsconfig)}`);
  } else {
    tsconfig = findTsconfig(root);
    if (!tsconfig) warnings.push("no tsconfig found; paths aliases unresolved; pass --tsconfig");
  }
  return { root, files, tsconfig, warnings };
}
