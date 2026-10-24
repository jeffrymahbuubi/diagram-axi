// A small pool of persistent Chromium profile directories ("slots"), one per concurrent browser process.
//
// Why: on Windows, every Chromium start with a fresh profile runs `LogonUser(user, ".", "", ...)` to find
// out whether the OS password is blank (chrome/browser/password_manager/password_manager_util_win.cc).
// The answer is cached in the profile's Local State, so a profile that persists asks the OS once. A fresh
// temp profile per launch (Playwright's default) asks every time; each ask is a failed logon, and a few
// of them in a row lock the account. A slot keeps its profile between launches.
//
// Chromium locks a profile directory per process, so concurrent processes (vitest workers, `qa --jobs`,
// two CLI runs) must not share a slot. A slot is taken with an exclusive lock file holding the owner's
// PID (`slot-<n>.lock` next to `slot-<n>/`); a lock whose PID is gone is reclaimed.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { toolCacheDir } from "../engines/cache.js";

/** Overrides the directory that holds the slots (default `<tool cache>/chrome-profiles`). */
export const PROFILE_DIR_ENV = "DIAGRAM_AXI_CHROME_PROFILE_DIR";
/** `temp` opts out: every launch uses a fresh temp profile (Playwright's default, one OS logon per launch). */
export const PROFILE_MODE_ENV = "DIAGRAM_AXI_CHROME_PROFILE";
/** Overrides the number of slots (default 4). */
export const PROFILE_SLOTS_ENV = "DIAGRAM_AXI_CHROME_PROFILE_SLOTS";

// 4 covers our own concurrency (vitest --maxWorkers=4, qa --jobs 3). Every slot re-runs the logon check once
// after a password change, so the cap must stay well under a typical account-lockout threshold.
export const DEFAULT_MAX_SLOTS = 4;
/** How long `acquireSlot` waits for a busy pool by default. */
export const DEFAULT_WAIT_MS = 2_000;
const POLL_MS = 100;
/** A lock file with no readable PID this young is a lock being written, not a stale one. */
const FRESH_LOCK_MS = 5_000;

/** Every slot stayed busy for the whole wait (thrown only with `failWhenBusy`). */
export class SlotsBusyError extends Error {
  constructor(readonly slots: number, readonly waitedMs: number) {
    super(`all ${slots} Chrome profile slots stayed busy for ${waitedMs} ms`);
  }
}

export interface Slot {
  /** The profile directory to pass to Chromium as its user data dir. */
  dir: string;
  /** Frees the slot. Safe to call twice. */
  release(): void;
}

export interface SlotOptions {
  /** Directory holding the slots. Default: env override, else `<tool cache>/chrome-profiles`. */
  root?: string;
  /** Number of slots. Default: env override, else 4. */
  maxSlots?: number;
  /** How long to wait for a free slot, ms. Default 2000. */
  waitMs?: number;
  /** Throw `SlotsBusyError` instead of returning undefined when every slot stayed busy. */
  failWhenBusy?: boolean;
  /** PID written into the lock file (tests). Default: this process. */
  pid?: number;
}

/** True when the environment opts out of persistent profiles. */
export function profilesDisabled(): boolean {
  return (process.env[PROFILE_MODE_ENV] ?? "").trim().toLowerCase() === "temp";
}

export function profileRoot(): string {
  const override = process.env[PROFILE_DIR_ENV];
  return override ? override : join(toolCacheDir(), "chrome-profiles");
}

export function maxSlots(): number {
  const n = Number(process.env[PROFILE_SLOTS_ENV]);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : DEFAULT_MAX_SLOTS;
}

/** Whether a process with this PID exists. EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const held = new Set<string>();
let exitHooked = false;

/** Last-resort cleanup for the locks this process still holds (normal exit and uncaught errors). */
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const lock of held) rmSync(lock, { force: true });
  });
}

/** Creates the lock exclusively. Returns false when it exists. */
function tryCreate(lock: string, pid: number): boolean {
  try {
    const fd = openSync(lock, "wx");
    try {
      writeSync(fd, String(pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** The PID in a lock file; undefined when unreadable or not yet written. */
function readOwner(lock: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the lock's owner is gone, so the slot can be taken over. */
function isStale(lock: string): boolean {
  const owner = readOwner(lock);
  if (owner !== undefined) return !pidAlive(owner);
  try {
    return Date.now() - statSync(lock).mtimeMs > FRESH_LOCK_MS;
  } catch {
    return false; // gone already: the next create attempt will take it
  }
}

/**
 * Moves a stale lock aside (rename is atomic, so one of several reclaimers wins) and checks that what
 * was moved is the stale lock and not a fresh one a faster reclaimer just wrote.
 */
function reclaim(lock: string, stale: number | undefined): void {
  const aside = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lock, aside);
  } catch {
    return; // someone else reclaimed or released it
  }
  const moved = readOwner(aside);
  rmSync(aside, { force: true });
  if (moved !== undefined && moved !== stale && pidAlive(moved)) {
    // We removed a live owner's fresh lock. Put it back; that owner keeps running and its release is a no-op.
    tryCreate(lock, moved);
  }
}

function tryTake(root: string, index: number, pid: number): Slot | undefined {
  const lock = join(root, `slot-${index}.lock`);
  const dir = join(root, `slot-${index}`);
  let created = tryCreate(lock, pid);
  if (!created && isStale(lock)) {
    reclaim(lock, readOwner(lock));
    created = tryCreate(lock, pid);
  }
  if (!created) return undefined;
  mkdirSync(dir, { recursive: true });
  hookExit();
  held.add(lock);
  let released = false;
  return {
    dir,
    release() {
      if (released) return;
      released = true;
      held.delete(lock);
      // Only remove a lock that is still ours.
      if (readOwner(lock) === pid) rmSync(lock, { force: true });
    },
  };
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Takes a free slot, waiting up to `waitMs` for one. Returns undefined when every slot stayed busy (the
 * caller falls back to a temp profile) or when the pool directory cannot be used.
 */
export async function acquireSlot(options: SlotOptions = {}): Promise<Slot | undefined> {
  const root = options.root ?? profileRoot();
  const count = options.maxSlots ?? maxSlots();
  const pid = options.pid ?? process.pid;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + waitMs;
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    return undefined; // read-only cache, bad override path: a temp profile still works
  }
  for (;;) {
    for (let index = 0; index < count; index++) {
      let slot: Slot | undefined;
      try {
        slot = tryTake(root, index, pid);
      } catch {
        return undefined; // the pool directory became unusable
      }
      if (slot) return slot;
    }
    if (Date.now() >= deadline) {
      if (options.failWhenBusy) throw new SlotsBusyError(count, waitMs);
      return undefined;
    }
    await sleep(POLL_MS);
  }
}
