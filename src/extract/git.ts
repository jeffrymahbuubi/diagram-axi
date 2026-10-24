/**
 * Repository identity for sidecar metadata: `git rev-parse HEAD` and a dirty flag. Local git only, every
 * call has a 5 s timeout, and everything is omitted outside a repository (or when git is missing).
 */
import { spawnSync } from "node:child_process";

export interface GitInfo {
  rev?: string;
  dirty?: boolean;
}

const TIMEOUT_MS = 5000;

function git(cwd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.error || r.status !== 0) return undefined;
    return r.stdout;
  } catch {
    return undefined;
  }
}

/** `rev` is the 40-hex HEAD; `dirty` is true when `git status --short` under `cwd` is non-empty. */
export function readGit(cwd: string): GitInfo {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const rev = head?.trim();
  if (!rev || !/^[0-9a-f]{40,64}$/.test(rev)) return {};
  const status = git(cwd, ["status", "--short", "--", "."]);
  return status === undefined ? { rev } : { rev, dirty: status.trim().length > 0 };
}
