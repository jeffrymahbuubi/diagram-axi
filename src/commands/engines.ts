// `engines` and `engines install d2`: what each engine needs and whether it is ready (R6). Status checks
// never download or load WASM; the only download is the optional pinned d2 binary, and only on request.

import type { CommandModule } from "../cli/router.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import type { EngineId, EngineStatus } from "../engines/types.js";
import { BROWSER_PATH_FLAG, D2_PATH_FLAG, ENGINE_FLAG } from "./engine-io.js";
import { TOOL, displayPath, flagStr } from "./shared.js";

const strip = (v: string): string => v.replace(/^v/, "");

/** Version text per engine; mermaid names its ELK loader too. */
async function versionOf(id: EngineId, st: EngineStatus): Promise<string> {
  if (id === "mermaid") {
    const { MERMAID_ELK_VERSION } = await import("../engines/mermaid/index.js");
    return `${st.version ?? "?"} + elk ${MERMAID_ELK_VERSION}`;
  }
  return st.version ?? "?";
}

/** The `d2-binary:` line: the optional binary the PNG fallback uses. */
async function binaryLine(d2Path: string | undefined): Promise<{ line: string; present: boolean }> {
  const { resolveD2Binary } = await import("../engines/d2/index.js");
  try {
    const bin = await resolveD2Binary(d2Path ? { d2Path } : {});
    if (bin) return { line: `d2-binary: ${strip(bin.version)} at ${displayPath(bin.path)} (${bin.source})`, present: true };
  } catch (err) {
    return { line: `d2-binary: ${(err as Error).message}`, present: false };
  }
  return { line: "d2-binary: not installed (optional, for PNG without a browser)", present: false };
}

export const enginesCommand: CommandModule = {
  spec: {
    name: "engines",
    summary: "Show each engine's status, version and PNG path; `engines install d2` adds the optional d2 binary",
    flags: [
      { ...ENGINE_FLAG, values: ["excalidraw", "d2", "mermaid"], description: "show only this engine" },
      BROWSER_PATH_FLAG,
      D2_PATH_FLAG,
    ],
    examples: [`${TOOL} engines`, `${TOOL} engines install d2`],
  },
  async run(parsed) {
    const only = flagStr(parsed.flags, "engine");
    const browserPath = flagStr(parsed.flags, "browser-path");
    const d2Path = flagStr(parsed.flags, "d2-path");
    const { engines } = await import("../engines/registry.js");
    const opts = { ...(browserPath ? { browserPath } : {}), ...(d2Path ? { d2Path } : {}) };

    const rows: Array<Record<string, unknown>> = [];
    const installs: Array<Record<string, unknown>> = [];
    for (const e of engines().filter((x) => !only || x.id === only)) {
      const st = await e.status(opts);
      rows.push({ engine: e.id, status: st.status, version: await versionOf(e.id, st), png: st.png ?? "none" });
      if (st.status !== "ready" && st.install) installs.push({ engine: e.id, command: st.install });
    }
    const lines = [emitList("engines", rows, ["engine", "status", "version", "png"])];
    if (installs.length > 0) lines.push(emitList("install", installs, ["engine", "command"]));
    let installed = true;
    if (!only || only === "d2") {
      const bin = await binaryLine(d2Path);
      lines.push(bin.line);
      installed = bin.present;
    }
    lines.push(
      helpBlock([
        installed ? `${TOOL} syntax routing` : `${TOOL} engines install d2`,
        `${TOOL} draw <file.exd> --png`,
        `${TOOL} syntax`,
      ]),
    );
    print(lines.join("\n"));
    return 0;
  },
};

export const enginesInstallCommand: CommandModule = {
  spec: {
    name: "engines install",
    summary: "Download the pinned d2 binary into the tool cache (checksum verified, needs network once, then offline)",
    args: [{ name: "name", required: false, description: "d2 (the only engine with a download)" }],
    flags: [{ ...ENGINE_FLAG, values: ["d2"], description: "engine to install (same as the argument)" }],
    examples: [`${TOOL} engines install d2`],
  },
  async run(parsed) {
    const which = (parsed.positionals[0] ?? flagStr(parsed.flags, "engine"))?.toLowerCase();
    if (which === undefined) throw new UsageError("name the engine to install", `${TOOL} engines install d2`);
    if (which !== "d2") {
      throw new UsageError(`'${which}' has nothing to install`, "only d2 has an optional download: engines install d2");
    }
    const { installD2Binary } = await import("../engines/d2/index.js");
    const r = await installD2Binary();
    const how = r.reused ? "already installed" : `downloaded ${(r.bytes / 1e6).toFixed(1)} MB, sha256 verified`;
    print(
      [
        "engines install d2: ok",
        `d2-binary: ${strip(r.version)} at ${displayPath(r.path)} (${how})`,
        helpBlock([`${TOOL} engines`, `${TOOL} draw <file.exd> --engine d2 --png`]),
      ].join("\n"),
    );
    return 0;
  },
};
