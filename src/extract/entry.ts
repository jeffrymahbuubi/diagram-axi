// Entry detection for a scan root: the package's `bin` / `main` / `module` / `exports` / `imports` mapped back to a scanned
// source file (directly, via a sourcemap, or by a unique basename), else an `index.*` at the scan root. Deterministic,
// read-only (package.json and `.map` files only), never throws. Used by `extract` to mark the entry box; the aggregate
// stage just receives the resulting path.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const BUILD_DIRS = new Set(["dist", "build", "lib", "out"]);
const FLAVORS = new Set(["cjs", "esm", "mjs", "umd", "types", "es"]);
/** Ancestors of the scan root searched for a package.json (the scan root itself first). */
const PACKAGE_LEVELS = 4;
/** Sourcemaps larger than this are not read (a bundle map can be tens of MB; the entry rarely needs it). */
const MAX_MAP_BYTES = 16 * 1024 * 1024;

const JS_LIKE = /\.[cm]?[jt]sx?$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const TESTISH = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

type Json = Record<string, unknown>;

const posix = (p: string): string => p.split(sep).join("/");

/** Package-relative source candidates for a manifest path such as `./dist/cjs/index.js`. */
export function candidates(manifestPath: string): string[] {
  const p = manifestPath.replace(/^\.\//, "").replace(/^\/+/, "");
  if (p === "" || DECLARATION.test(p) || p.includes("*")) return [];
  const segs = p.split("/");
  const stem = (q: string): string => q.replace(/\.[cm]?[jt]sx?$/, "");
  const withExts = (q: string): string[] => [q, ...EXTS.map((e) => `${stem(q)}${e}`)];
  const out = [...withExts(p)];
  if (BUILD_DIRS.has(segs[0] as string)) {
    let rest = segs.slice(1);
    if (rest.length > 1 && FLAVORS.has(rest[0] as string)) rest = rest.slice(1);
    out.push(...withExts(`src/${rest.join("/")}`), ...withExts(rest.join("/")));
  }
  return [...new Set(out)];
}

/** A leaf that can name source code: relative, no glob, no declaration file, a JS/TS extension or none (`./package.json`, `./x.css` are not). */
const isCodeLeaf = (p: string): boolean => p.startsWith("./") && !p.includes("*") && !DECLARATION.test(p) && (JS_LIKE.test(p) || !/\.[a-z0-9]+$/i.test(p));

/** Every string leaf of an exports/imports value in document order (condition objects keep their key order, arrays their index order). */
function leaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) leaves(x, out);
  else if (v && typeof v === "object") for (const k of Object.keys(v)) leaves((v as Json)[k], out);
  return out;
}

/**
 * Leaves of `exports`: the "." entry first, then the other subpaths sorted by name. An exports value without subpath keys
 * (a string, an array or a bare condition object) is the "." entry. Declaration files, globs and non-code files are dropped.
 */
export function exportLeaves(exportsField: unknown): string[] {
  let all: string[];
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField) && Object.keys(exportsField).some((k) => k.startsWith("."))) {
    const map = exportsField as Json;
    const keys = Object.keys(map).sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a < b ? -1 : a > b ? 1 : 0));
    all = keys.flatMap((k) => leaves(map[k]));
  } else all = leaves(exportsField);
  return all.filter(isCodeLeaf);
}

/** Leaves of `imports` (`#alias` keys sorted by name); package specifiers and non-code files are dropped. */
export function importLeaves(importsField: unknown): string[] {
  if (!importsField || typeof importsField !== "object" || Array.isArray(importsField)) return [];
  const map = importsField as Json;
  return Object.keys(map)
    .sort()
    .flatMap((k) => leaves(map[k]))
    .filter(isCodeLeaf);
}

/**
 * Manifest paths in rank order: bin (sorted by name), main, module, then the `exports` leaves ("." first, subpaths sorted;
 * a source condition such as `__vitest_source__` or `@zod/source` is just a leaf that lives in the scan), then `imports`.
 */
function manifestEntries(pkg: Json): string[] {
  const out: string[] = [];
  const bin = pkg["bin"];
  if (typeof bin === "string") out.push(bin);
  else if (bin && typeof bin === "object") for (const k of Object.keys(bin).sort()) if (typeof (bin as Json)[k] === "string") out.push((bin as Json)[k] as string);
  for (const k of ["main", "module"]) if (typeof pkg[k] === "string") out.push(pkg[k] as string);
  out.push(...exportLeaves(pkg["exports"]), ...importLeaves(pkg["imports"]));
  return [...new Set(out)];
}

/**
 * Scanned sources (relative to `rootAbs`) named by `<builtAbs>.map`: a source with the built file's stem first, then the
 * listed order. Empty, silently, when the map is absent, too large or unreadable.
 */
export function sourcemapSources(rootAbs: string, builtAbs: string, files: ReadonlySet<string>): string[] {
  const mapFile = `${builtAbs}.map`;
  try {
    if (!existsSync(mapFile) || statSync(mapFile).size > MAX_MAP_BYTES) return [];
    const map = JSON.parse(readFileSync(mapFile, "utf8")) as { sources?: unknown; sourceRoot?: unknown };
    if (!Array.isArray(map.sources)) return [];
    const base = resolve(dirname(mapFile), typeof map.sourceRoot === "string" ? map.sourceRoot : "");
    const hits: string[] = [];
    for (const s of map.sources) {
      if (typeof s !== "string" || s.includes("://") || s.includes("node_modules")) continue;
      const rel = posix(relative(rootAbs, resolve(base, s)));
      if (!rel.startsWith("..") && files.has(rel)) hits.push(rel);
    }
    const stem = basename(builtAbs).replace(JS_LIKE, "");
    const same = hits.filter((h) => basename(h).replace(JS_LIKE, "") === stem);
    return [...new Set([...same, ...hits])];
  } catch {
    return [];
  }
}

/**
 * Basename fallback for a built file whose stem found no source (`dist/index.js`, sources in `src/public/index.ts`): the
 * shallowest scanned `**\/<stem>.<ext>` (test files and, when `linked` is given, files without an import edge excluded).
 * Two files at that shallowest depth are ambiguous: no answer.
 */
export function basenameMatch(manifestPath: string, files: ReadonlySet<string>, linked?: ReadonlySet<string>): string | undefined {
  const stem = basename(manifestPath).replace(JS_LIKE, "");
  if (stem === "") return undefined;
  const hits = [...files].filter((f) => JS_LIKE.test(f) && !DECLARATION.test(f) && basename(f).replace(JS_LIKE, "") === stem && !TESTISH.test(f) && (!linked || linked.has(f)));
  if (hits.length === 0) return undefined;
  const depth = (f: string): number => f.split("/").length;
  const min = Math.min(...hits.map(depth));
  const top = hits.filter((f) => depth(f) === min);
  return top.length === 1 ? top[0] : undefined;
}

/**
 * Existing, scanned entry files in rank order:
 *  1. each manifest path (bin by name, main, module, exports "." then subpaths sorted, imports): the first
 *     `candidates()` hit, else a hit from the built file's sourcemap;
 *  2. `index.<ext>` at the scan root;
 *  3. basename fallback for the build-dir manifest paths that found nothing in step 1 (see `basenameMatch`; the weakest
 *     evidence, so last). `linked` (the files that have an import edge) narrows it.
 */
export function entryCandidates(rootAbs: string, files: ReadonlySet<string>, linked?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const unresolved: string[] = [];
  for (let dir = resolve(rootAbs), i = 0; i < PACKAGE_LEVELS; i++, dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      let pkg: unknown;
      try {
        pkg = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        pkg = undefined;
      }
      if (pkg && typeof pkg === "object") {
        for (const m of manifestEntries(pkg as Json)) {
          let hit: string | undefined;
          for (const c of candidates(m)) {
            const rel = posix(relative(rootAbs, resolve(dir, c)));
            if (!rel.startsWith("..") && files.has(rel)) {
              hit = rel;
              break;
            }
          }
          if (!hit && !DECLARATION.test(m)) {
            const mapped = sourcemapSources(rootAbs, resolve(dir, m.replace(/^\.\//, "")), files);
            hit = (linked ? mapped.find((s) => linked.has(s)) : undefined) ?? mapped[0];
          }
          if (hit) out.push(hit);
          else if (BUILD_DIRS.has(m.replace(/^\.\//, "").split("/")[0] as string)) unresolved.push(m);
        }
      }
      break;
    }
    if (dirname(dir) === dir) break;
  }
  for (const e of EXTS) if (files.has(`index${e}`)) out.push(`index${e}`);
  for (const m of unresolved) {
    const hit = basenameMatch(m, files, linked);
    if (hit) out.push(hit);
  }
  return [...new Set(out)];
}

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/**
 * The entry file as a posix path relative to `rootAbs` and present in `files`, or undefined.
 * Without `linked` the first candidate wins. With it (the files that have an import edge) the first candidate with an
 * edge wins; a candidate without one that only starts another file (`import "./dist/cli.js"`) is followed to that file's
 * source (dist -> src) when it is scanned and linked; otherwise there is no entry.
 */
export function detectEntry(rootAbs: string, files: ReadonlySet<string>, linked?: ReadonlySet<string>): string | undefined {
  const list = entryCandidates(rootAbs, files, linked);
  if (!linked) return list[0];
  for (const c of list) if (linked.has(c)) return c;
  for (const c of list) {
    let text = "";
    try {
      text = readFileSync(resolve(rootAbs, c), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(RELATIVE_IMPORT)) {
      const target = posix(join(dirname(c), m[1] as string));
      for (const cand of candidates(target)) if (files.has(cand) && linked.has(cand)) return cand;
    }
  }
  return undefined;
}
