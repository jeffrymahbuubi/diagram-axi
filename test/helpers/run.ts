// Test helper: runs the built bin (bin/diagram-axi.js -> dist/) as a child process.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

export const BIN = fileURLToPath(new URL("../../bin/diagram-axi.js", import.meta.url));

export const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export interface RunOptions {
  cwd?: string;
  /** Piped to stdin. */
  input?: string;
  /** Merged over process.env; `undefined` deletes a variable. */
  env?: Record<string, string | undefined>;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function run(args: string[], opts: RunOptions = {}): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync("node", [BIN, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env,
    // Without `input` the child's stdin is an empty pipe, never the terminal.
    input: opts.input ?? "",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const made: string[] = [];

/** A fresh temp directory, removed after the test file finishes. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "diagram-axi-"));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Writes a text file (creating parent directories) and returns its path. */
export function write(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
