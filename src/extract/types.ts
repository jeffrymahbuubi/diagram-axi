/**
 * RawGraph: the language-neutral output of an extractor (plan 2026-10-24-extract-plan.md, section 3-4).
 *
 * Contract rules (every extractor must keep them so the aggregate/emit stages stay pure and byte-stable):
 * - All paths are posix (forward slashes), relative to the scan root, never absolute.
 * - `files` is sorted by `path`; `edges` by (from, to, line, specifier, kind); every other list is sorted
 *   by its natural key (externals/builtins by name, unresolved/skipped by file, line, specifier).
 * - One edge per import occurrence (statement or call), NOT per file pair: the roll-up sums them.
 * - Nothing is dropped silently: whatever is not an edge ends up in `externals`, `builtins`,
 *   `unresolved` or `skipped`.
 * - No timestamps and no machine-specific data (no absolute paths) anywhere.
 */

export type SourceLang = "ts" | "js";

export type EdgeKind = "import" | "reexport" | "dynamic" | "require";

/** One scanned source file. Test files are kept (flagged), the aggregate stage filters them. */
export interface RawFile {
  /** Posix path relative to the scan root. */
  path: string;
  lang: SourceLang;
  /** `*.test.*`, `*.spec.*`, or under a `test/`, `tests/`, `__tests__/` directory. */
  test: boolean;
  /** Number of lines in the file. */
  loc: number;
  /** Count of named/default exports declared or re-exported by name (`export *` is not counted). */
  exports: number;
}

/** A resolved file-to-file dependency, one per import occurrence. */
export interface RawEdge {
  /** Importing file (key into `files`). */
  from: string;
  /** Imported file (key into `files`). */
  to: string;
  /** The specifier text as written, e.g. `./util.js` or `@app/core`. */
  specifier: string;
  /** 1-based line of the import statement / call. */
  line: number;
  /** `import type`, `export type`, or every binding is `type`-qualified. */
  typeOnly: boolean;
  /** `import("x")` (also set for type-position `import("x")`). */
  dynamic: boolean;
  kind: EdgeKind;
}

/** A third-party package (npm), counted by package name, never drawn as a file node. */
export interface RawExternal {
  /** Package name: `lodash`, `@scope/pkg` (subpaths stripped). */
  name: string;
  /** Number of import occurrences. */
  count: number;
  /** Number of distinct importing files. */
  files: number;
}

export type UnresolvedReason =
  /** Relative or bare-with-no-match specifier the resolver could not find. */
  | "not-found"
  /** Matches a tsconfig `paths` pattern but the target does not exist. */
  | "alias-miss";

/** A specifier that SHOULD resolve to a project file but did not. Reported prominently, never hidden. */
export interface RawUnresolved {
  file: string;
  specifier: string;
  line: number;
  reason: UnresolvedReason;
}

export type SkippedReason =
  /** `import(expr)` / `require(expr)` whose argument is not a string literal. */
  | "non-literal"
  /** Resolved to a file that is not TS/JS source (json, css, .d.ts, ...). */
  | "not-source"
  /** Resolved to a file outside the scan root. */
  | "outside-root"
  /** Resolved to a project file removed by skip rules or --include/--exclude. */
  | "excluded"
  /** `https:`, `data:`, `file:` and similar. */
  | "url";

/** An import that is intentionally not an edge and not an external; listed so nothing vanishes. */
export interface RawSkipped {
  file: string;
  /** Specifier, or a truncated source snippet for `non-literal`. */
  specifier: string;
  line: number;
  reason: SkippedReason;
}

export interface RawMeta {
  /** Root as given by the caller (posix, relative to cwd unless overridden); a label, not an access path. */
  root: string;
  /** Languages present among `files`, sorted. */
  langs: SourceLang[];
  /** tsconfig used, posix path relative to the scan root (may start with `../`); absent when none. */
  tsconfig?: string;
  /** `git rev-parse HEAD` of the repo containing the root; absent outside a repo. */
  rev?: string;
  /** True when `git status --short` under the root is non-empty; absent outside a repo. */
  dirty?: boolean;
  extractor: { name: string; version: string };
}

export interface RawGraph {
  schema: 1;
  meta: RawMeta;
  files: RawFile[];
  edges: RawEdge[];
  externals: RawExternal[];
  /** Node.js core modules (`node:fs`, `path`, ...), name without the `node:` prefix. Not npm packages. */
  builtins: RawExternal[];
  unresolved: RawUnresolved[];
  skipped: RawSkipped[];
  /** Human-readable, deterministic warnings, e.g. a missing tsconfig. */
  warnings: string[];
}

export interface ExtractOptions {
  /** Directory to scan (absolute or relative to cwd). */
  root: string;
  /** Comma-separated globs (or already split); only matching files (relative to root) are scanned. */
  include?: string | string[];
  /** Comma-separated globs (or already split); matching files are removed. */
  exclude?: string | string[];
  /** Explicit tsconfig path; default is the nearest `tsconfig.json` at or above the root. */
  tsconfig?: string;
  /** Overrides `meta.root` (use for stable goldens). */
  rootLabel?: string;
  /** Read rev/dirty via git (default true). */
  git?: boolean;
}

/** A language adapter: turns a directory into a RawGraph. Replaceable per language. */
export interface Extractor {
  name: string;
  version: string;
  langs: readonly SourceLang[];
  extract(opts: ExtractOptions): Promise<RawGraph>;
}
