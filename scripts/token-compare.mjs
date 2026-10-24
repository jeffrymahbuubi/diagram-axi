#!/usr/bin/env node
// Token-cost comparison: diagram-axi DSL vs the Excalidraw MCP create_view JSON.
//
// Rows (all for the same "Order pipeline" diagram):
//   dsl            test/fixtures/arch.exd (what the agent writes)
//   dsl+slice      the DSL plus the `syntax example` output (what the agent must read first)
//   mcp-json       test/fixtures/arch.mcp.json, minified (the `elements` string create_view takes)
//   mcp-json+sheet the same plus RECALL_CHEAT_SHEET (the read_me text an agent must read before drawing)
//   excalidraw-scene the .excalidraw file `draw` builds from the DSL, minified (what an agent writes by hand for a
//                  plain Excalidraw CLI renderer); built with `draw` and no --png, so no browser starts
//
// est_tokens = ceil(chars / 4); no tokenizer package is installed, so no new dependency is added.
// (The plan also lists a whitespace-split count; it is meaningless for minified JSON, so it is omitted.)
//
// The cheat sheet is extracted at runtime from excalidraw-mcp/src/server.ts when a copy is found
// (env EXCALIDRAW_MCP_SERVER_TS, or the first CLI argument). Otherwise the vendored
// CHEAT_SHEET_CHARS constant below is used. It was measured from the template literal in
// excalidraw-mcp src/server.ts (RECALL_CHEAT_SHEET, backtick escapes resolved). The plan assumed
// ~9.5k chars; the real sheet is ~26.9k chars (~6.7k tokens).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Vendored fallback: RECALL_CHEAT_SHEET length in chars (see header). */
export const CHEAT_SHEET_CHARS = 26943;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "diagram-axi.js");

const SERVER_TS_CANDIDATES = [
  process.env.EXCALIDRAW_MCP_SERVER_TS,
  join(ROOT, "..", "excalidraw-mcp", "src", "server.ts"),
  join(ROOT, "excalidraw-mcp", "src", "server.ts"),
  join(ROOT, "..", "..", "excalidraw-mcp", "src", "server.ts"),
];

/** Pull the RECALL_CHEAT_SHEET template literal out of server.ts; null if unavailable. */
export function extractCheatSheet(extraPath) {
  for (const p of [extraPath, ...SERVER_TS_CANDIDATES]) {
    if (!p || !existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    const start = src.indexOf("RECALL_CHEAT_SHEET = `");
    if (start < 0) continue;
    const bodyStart = start + "RECALL_CHEAT_SHEET = `".length;
    // The literal ends at the first unescaped backtick.
    let i = bodyStart;
    let out = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\" && i + 1 < src.length) {
        out += src[i + 1]; // \` -> `, \\ -> \ (the sheet uses no other escapes)
        i += 2;
        continue;
      }
      if (c === "`") return { text: out.replace(/\r\n/g, "\n"), source: p };
      out += c;
      i++;
    }
  }
  return null;
}

const est = (chars) => Math.ceil(chars / 4);

/** Measure every row. Requires a built CLI (npm run build) for the `syntax example` slice. */
export function measure({ cheatSheetPath } = {}) {
  const dsl = readFileSync(join(ROOT, "test", "fixtures", "arch.exd"), "utf8");
  const mcpRaw = readFileSync(join(ROOT, "test", "fixtures", "arch.mcp.json"), "utf8");
  // Count the minified array: create_view says "Keep compact", and this is the smallest honest form.
  const mcp = JSON.stringify(JSON.parse(mcpRaw));

  const r = spawnSync("node", [BIN, "syntax", "example"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`syntax example failed (exit ${r.status}): ${r.stdout}${r.stderr}`);
  const slice = r.stdout;

  const dir = mkdtempSync(join(tmpdir(), "token-compare-"));
  let scene;
  try {
    copyFileSync(join(ROOT, "test", "fixtures", "arch.exd"), join(dir, "arch.exd"));
    const d = spawnSync("node", [BIN, "draw", join(dir, "arch.exd")], { encoding: "utf8" });
    if (d.status !== 0) throw new Error(`draw failed (exit ${d.status}): ${d.stdout}${d.stderr}`);
    scene = JSON.stringify(JSON.parse(readFileSync(join(dir, "arch.excalidraw"), "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const sheet = extractCheatSheet(cheatSheetPath);
  const sheetChars = sheet ? sheet.text.length : CHEAT_SHEET_CHARS;

  const rows = [
    { approach: "dsl", chars: dsl.length },
    { approach: "dsl+slice", chars: dsl.length + slice.length },
    { approach: "mcp-json", chars: mcp.length },
    { approach: "mcp-json+sheet", chars: mcp.length + sheetChars },
    { approach: "excalidraw-scene", chars: scene.length },
  ].map((x) => ({ ...x, tokens: est(x.chars) }));

  const by = Object.fromEntries(rows.map((x) => [x.approach, x]));
  const ratios = {
    dslVsMcp: by["dsl"].chars / by["mcp-json"].chars,
    sliceVsSheet: by["dsl+slice"].chars / by["mcp-json+sheet"].chars,
    dslVsScene: by["dsl"].chars / by["excalidraw-scene"].chars,
  };
  return {
    rows,
    ratios,
    cheatSheet: { chars: sheetChars, source: sheet ? sheet.source : "vendored constant" },
  };
}

function toon(result) {
  const { rows, ratios, cheatSheet } = result;
  const lines = [`rows[${rows.length}]{approach,chars,est_tokens}:`];
  for (const x of rows) lines.push(`  ${x.approach},${x.chars},${x.tokens}`);
  lines.push(`ratios[3]{name,value,target}:`);
  lines.push(`  dsl/mcp-json,${ratios.dslVsMcp.toFixed(3)},<=0.200 (1/5)`);
  lines.push(`  dsl+slice/mcp-json+sheet,${ratios.sliceVsSheet.toFixed(3)},<=0.250 (1/4)`);
  lines.push(`  dsl/excalidraw-scene,${ratios.dslVsScene.toFixed(3)},<=0.050 (1/20)`);
  lines.push(`cheat_sheet: ${cheatSheet.chars} chars from ${cheatSheet.source}`);
  lines.push(`tokenizer: chars/4 estimate (no tokenizer installed)`);
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(toon(measure({ cheatSheetPath: process.argv[2] })));
  } catch (e) {
    console.log(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
