// The Chromium profile slot pool. Pure file-system tests: no browser is started.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SLOTS,
  PROFILE_DIR_ENV,
  PROFILE_MODE_ENV,
  PROFILE_SLOTS_ENV,
  SlotsBusyError,
  acquireSlot,
  maxSlots,
  pidAlive,
  profileRoot,
  profilesDisabled,
} from "../src/render/profile-slots.js";
import { CACHE_DIR_ENV } from "../src/engines/cache.js";
import { tempDir } from "./helpers/run.js";

const DIST_MODULE = fileURLToPath(new URL("../dist/render/profile-slots.js", import.meta.url));

/** A PID that belonged to a process that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid;
}

describe("profile slots", () => {
  let root: string;
  beforeEach(() => {
    root = join(tempDir(), "profiles");
  });

  it("takes slot 0 first, locks it with this PID, and frees it on release", async () => {
    const slot = await acquireSlot({ root, maxSlots: 3, waitMs: 0 });
    expect(slot?.dir).toBe(join(root, "slot-0"));
    expect(existsSync(join(root, "slot-0"))).toBe(true);
    expect(readFileSync(join(root, "slot-0.lock"), "utf8")).toBe(String(process.pid));
    slot?.release();
    expect(existsSync(join(root, "slot-0.lock"))).toBe(false);
    // The profile directory stays: that is the point.
    expect(existsSync(join(root, "slot-0"))).toBe(true);
    const again = await acquireSlot({ root, maxSlots: 3, waitMs: 0 });
    expect(again?.dir).toBe(join(root, "slot-0"));
    again?.release();
  });

  it("release twice is harmless and does not free a slot someone else now holds", async () => {
    const first = await acquireSlot({ root, maxSlots: 2, waitMs: 0 });
    first?.release();
    const second = await acquireSlot({ root, maxSlots: 2, waitMs: 0, pid: process.ppid });
    expect(second?.dir).toBe(join(root, "slot-0"));
    first?.release();
    expect(existsSync(join(root, "slot-0.lock"))).toBe(true);
    second?.release();
  });

  it("hands out different slots to simultaneous holders", async () => {
    const a = await acquireSlot({ root, maxSlots: 3, waitMs: 0 });
    const b = await acquireSlot({ root, maxSlots: 3, waitMs: 0 });
    expect(new Set([a?.dir, b?.dir]).size).toBe(2);
    a?.release();
    const c = await acquireSlot({ root, maxSlots: 3, waitMs: 0 });
    expect(c?.dir).toBe(join(root, "slot-0"));
    b?.release();
    c?.release();
  });

  it("returns undefined when every slot is busy, or throws SlotsBusyError with failWhenBusy", async () => {
    const held = [await acquireSlot({ root, maxSlots: 2, waitMs: 0 }), await acquireSlot({ root, maxSlots: 2, waitMs: 0 })];
    const started = Date.now();
    expect(await acquireSlot({ root, maxSlots: 2, waitMs: 250 })).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    // launchContext uses failWhenBusy: a busy pool must not silently cost a temp-profile logon
    await expect(acquireSlot({ root, maxSlots: 2, waitMs: 50, failWhenBusy: true })).rejects.toBeInstanceOf(SlotsBusyError);
    held.forEach((slot) => slot?.release());
  });

  it("waits for a slot that is released in time", async () => {
    const only = await acquireSlot({ root, maxSlots: 1, waitMs: 0 });
    setTimeout(() => only?.release(), 150);
    const next = await acquireSlot({ root, maxSlots: 1, waitMs: 3_000 });
    expect(next?.dir).toBe(join(root, "slot-0"));
    next?.release();
  });

  it("reclaims a lock whose owner has exited", async () => {
    const dead = deadPid();
    expect(pidAlive(dead)).toBe(false);
    await acquireSlot({ root, maxSlots: 1, waitMs: 0 }).then((s) => s?.release());
    writeFileSync(join(root, "slot-0.lock"), String(dead));
    const slot = await acquireSlot({ root, maxSlots: 1, waitMs: 0 });
    expect(slot?.dir).toBe(join(root, "slot-0"));
    expect(readFileSync(join(root, "slot-0.lock"), "utf8")).toBe(String(process.pid));
    slot?.release();
  });

  it("does not take a lock held by a live process", async () => {
    expect(pidAlive(process.ppid)).toBe(true);
    await acquireSlot({ root, maxSlots: 1, waitMs: 0 }).then((s) => s?.release());
    writeFileSync(join(root, "slot-0.lock"), String(process.ppid));
    expect(await acquireSlot({ root, maxSlots: 1, waitMs: 0 })).toBeUndefined();
    const second = await acquireSlot({ root, maxSlots: 2, waitMs: 0 });
    expect(second?.dir).toBe(join(root, "slot-1"));
    second?.release();
  });

  it("treats a lock with garbage content as stale once it is old, and as in-progress while young", async () => {
    await acquireSlot({ root, maxSlots: 1, waitMs: 0 }).then((s) => s?.release());
    const lock = join(root, "slot-0.lock");
    writeFileSync(lock, "");
    expect(await acquireSlot({ root, maxSlots: 1, waitMs: 0 })).toBeUndefined();
    const old = new Date(Date.now() - 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(lock, old, old);
    const slot = await acquireSlot({ root, maxSlots: 1, waitMs: 0 });
    expect(slot?.dir).toBe(join(root, "slot-0"));
    slot?.release();
  });

  it("gives N concurrent acquirers N distinct slots, and never more than the cap", async () => {
    const all = await Promise.all(Array.from({ length: 12 }, () => acquireSlot({ root, maxSlots: 5, waitMs: 0 })));
    const got = all.filter((slot) => slot !== undefined);
    expect(got).toHaveLength(5);
    expect(new Set(got.map((slot) => slot.dir)).size).toBe(5);
    got.forEach((slot) => slot.release());
  });

  it("falls back to undefined, not an exception, when the pool directory cannot be created", async () => {
    const file = join(tempDir(), "a-file");
    writeFileSync(file, "x");
    expect(await acquireSlot({ root: join(file, "sub"), maxSlots: 1, waitMs: 0 })).toBeUndefined();
  });
});

// Separate processes, through the compiled module (npm test builds first). Skipped when dist is absent.
describe.skipIf(!existsSync(DIST_MODULE))("profile slots across processes", () => {
  const script = (action: string) => `
    const { acquireSlot } = await import(${JSON.stringify(new URL(`file://${DIST_MODULE.replace(/\\/g, "/")}`).href)});
    const slot = await acquireSlot({ root: process.env.ROOT, maxSlots: 4, waitMs: 0 });
    console.log(slot ? slot.dir : "none");
    ${action}
  `;

  it("four processes at once take four different slots", async () => {
    const root = join(tempDir(), "profiles");
    const outputs = await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise<string>((done, fail) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script("await new Promise((r) => setTimeout(r, 1200)); slot?.release();")], {
            env: { ...process.env, ROOT: root },
          });
          let out = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.on("error", fail);
          child.on("close", () => done(out.trim()));
        }),
      ),
    );
    expect(outputs.filter((dir) => dir !== "none")).toHaveLength(4);
    expect(new Set(outputs).size).toBe(4);
    expect(existsSync(join(root, "slot-0.lock"))).toBe(false);
  });

  it("a process that exits without releasing leaves no lock behind", () => {
    const root = join(tempDir(), "profiles");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script("")], { env: { ...process.env, ROOT: root }, encoding: "utf8" });
    expect(child.stdout.trim()).toBe(join(root, "slot-0"));
    expect(existsSync(join(root, "slot-0.lock"))).toBe(false);
  });
});

describe("profile slot settings", () => {
  const keys = [PROFILE_DIR_ENV, PROFILE_MODE_ENV, PROFILE_SLOTS_ENV, CACHE_DIR_ENV];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    keys.forEach((key) => delete process.env[key]);
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("the default root is chrome-profiles under the tool cache, and follows DIAGRAM_AXI_CACHE_DIR", () => {
    process.env[CACHE_DIR_ENV] = join("x", "cache");
    expect(profileRoot()).toBe(join("x", "cache", "chrome-profiles"));
    delete process.env[CACHE_DIR_ENV];
    expect(profileRoot()).toMatch(/diagram-axi[\\/]chrome-profiles$/);
  });

  it("DIAGRAM_AXI_CHROME_PROFILE_DIR overrides the root", () => {
    process.env[PROFILE_DIR_ENV] = join("y", "pool");
    process.env[CACHE_DIR_ENV] = join("x", "cache");
    expect(profileRoot()).toBe(join("y", "pool"));
  });

  it("DIAGRAM_AXI_CHROME_PROFILE_SLOTS sets the cap; bad values fall back to the default of 8", () => {
    expect(maxSlots()).toBe(DEFAULT_MAX_SLOTS);
    expect(DEFAULT_MAX_SLOTS).toBe(4);
    process.env[PROFILE_SLOTS_ENV] = "1";
    expect(maxSlots()).toBe(1);
    for (const bad of ["0", "-2", "abc", "1.5", "1000", ""]) {
      process.env[PROFILE_SLOTS_ENV] = bad;
      expect(maxSlots()).toBe(DEFAULT_MAX_SLOTS);
    }
  });

  it("DIAGRAM_AXI_CHROME_PROFILE=temp opts out; anything else keeps profiles", () => {
    expect(profilesDisabled()).toBe(false);
    process.env[PROFILE_MODE_ENV] = "temp";
    expect(profilesDisabled()).toBe(true);
    process.env[PROFILE_MODE_ENV] = " TEMP ";
    expect(profilesDisabled()).toBe(true);
    process.env[PROFILE_MODE_ENV] = "persistent";
    expect(profilesDisabled()).toBe(false);
  });

  it("acquireSlot reads the environment when no options are given", async () => {
    const root = join(tempDir(), "env-pool");
    process.env[PROFILE_DIR_ENV] = root;
    process.env[PROFILE_SLOTS_ENV] = "1";
    const slot = await acquireSlot({ waitMs: 0 });
    expect(slot?.dir).toBe(join(root, "slot-0"));
    expect(await acquireSlot({ waitMs: 0 })).toBeUndefined();
    slot?.release();
  });
});
