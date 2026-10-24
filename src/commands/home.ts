// Home view (AXI principle 8): live content, never a usage dump.
//
// Scene scan contract:
//   - walks cwd for *.excalidraw, *.d2 and *.mmd, skipping node_modules, .git, dist, .claude;
//     depth <= 4 (cwd itself is depth 0); stops after a 2 s budget and says so
//   - lists the 10 most recently modified, with the true total in the header
//     (`scenes[10 of 14 total]`)
//   - elements = non-deleted elements. A file that cannot be read or parsed
//     (or has no `elements` array, or is over 20 MB) is still listed and
//     counted, with elements -1, so a broken scene is visible, not silent.
//     For a native .d2/.mmd file `elements` is its statement count (non-blank,
//     non-comment lines), -1 when unreadable.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CommandModule } from "../cli/router.js";
import { DESCRIPTION, DSL_TEASER, collapseHome, rootHelpText } from "../skill/content.js";
import { emitBlock, emitList, print } from "../output/toon.js";
import { helpBlock } from "../output/suggest.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".claude"]);
const MAX_DEPTH = 4;
const MAX_LISTED = 10;
const BUDGET_MS = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const SCENE_EXTS = [".excalidraw", ".d2", ".mmd", ".mermaid"];

export interface SceneRow {
  path: string;
  elements: number;
  modified: string;
}

export interface ScanResult {
  /** The newest `limit` scenes. */
  scenes: SceneRow[];
  total: number;
  /** True when the time budget ran out before the walk finished. */
  incomplete: boolean;
}

/** Non-deleted element count of a scene file; -1 when it is unreadable or not a scene. */
export function countElements(file: string): number {
  try {
    if (statSync(file).size > MAX_BYTES) return -1;
    const data = JSON.parse(readFileSync(file, "utf8")) as { elements?: unknown };
    if (!Array.isArray(data.elements)) return -1;
    return data.elements.filter((e) => !(e && typeof e === "object" && (e as { isDeleted?: boolean }).isDeleted === true)).length;
  } catch {
    return -1;
  }
}

/** Statements in a native source: non-blank lines that are not whole-line comments; -1 when unreadable. */
export function countStatements(file: string): number {
  try {
    if (statSync(file).size > MAX_BYTES) return -1;
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("#") && !t.startsWith("%%");
      }).length;
  } catch {
    return -1;
  }
}

export function scanScenes(root: string, limit = MAX_LISTED, budgetMs = BUDGET_MS): ScanResult {
  const deadline = Date.now() + budgetMs;
  const found: Array<{ file: string; mtime: number }> = [];
  let incomplete = false;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    if (Date.now() > deadline) {
      incomplete = true;
      break;
    }
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && SCENE_EXTS.some((x) => e.name.endsWith(x))) {
        try {
          found.push({ file: full, mtime: statSync(full).mtimeMs });
        } catch {
          // vanished between readdir and stat: ignore
        }
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  const scenes = found.slice(0, limit).map((f) => ({
    path: relative(root, f.file).split(sep).join("/"),
    elements: f.file.endsWith(".excalidraw") ? countElements(f.file) : countStatements(f.file),
    modified: new Date(f.mtime).toISOString().slice(0, 16) + "Z",
  }));
  return { scenes, total: found.length, incomplete };
}

function arg(p: string): string {
  return /[\s"]/.test(p) ? JSON.stringify(p) : p;
}

/** The whole home view for a scan result (pure, so tests can call it directly). */
export function renderHomeView(binPath: string, scan: ScanResult, tool = "diagram-axi", enginesLine?: string): string {
  const parts = [`diagram-axi: ${collapseHome(binPath)} — ${DESCRIPTION}`];
  if (scan.total === 0) {
    parts.push("scenes: 0 .excalidraw files found under . (also .d2, .mmd)");
  } else {
    parts.push(emitList("scenes", scan.scenes as unknown as Array<Record<string, unknown>>, ["path", "elements", "modified"], { total: scan.total }));
  }
  if (scan.incomplete) parts.push(`note: scan stopped after ${BUDGET_MS} ms; the list may be incomplete`);
  if (enginesLine) parts.push(enginesLine);
  parts.push(emitBlock("dsl-teaser", DSL_TEASER));
  const top = scan.scenes[0];
  parts.push(
    helpBlock(
      top
        ? [`${tool} inspect ${arg(top.path)}`, `${tool} render ${arg(top.path)} --png`, `${tool} syntax example`]
        : [`${tool} syntax example`, `${tool} draw <file.exd> --png`, `${tool} syntax`],
    ),
  );
  return parts.join("\n");
}

export const homeCommand: CommandModule = {
  spec: {
    name: "",
    summary: "Home view: live content first (AXI principle 8)",
    flags: [{ name: "version", type: "boolean", description: "print the tool version" }],
    examples: ["diagram-axi", "diagram-axi --version"],
  },
  async run(parsed) {
    if (parsed.flags["version"]) {
      print("diagram-axi: 0.1.0");
      return 0;
    }
    print(renderHomeView(process.argv[1] ?? "diagram-axi", scanScenes(process.cwd()), "diagram-axi", await enginesLine()));
    return 0;
  },
};

/** `engines: excalidraw ready, d2 ready (png browser), mermaid ready`; statuses never download or load WASM. */
export async function enginesLine(): Promise<string> {
  const { engines } = await import("../engines/registry.js");
  const parts = await Promise.all(
    engines().map(async (e) => {
      const st = await e.status();
      return `${e.id} ${st.status}${e.id === "d2" ? ` (png ${st.png ?? "none"})` : ""}`;
    }),
  );
  return `engines: ${parts.join(", ")}`;
}

export function rootHelp(): string {
  return rootHelpText();
}
