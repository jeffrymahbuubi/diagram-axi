// Generic download of a release archive: fetch (redirects followed), verify sha256, extract a .tar.gz
// into a pid-suffixed temp directory, then rename it into place. A failure at any step leaves nothing
// behind, so `dest` either holds a complete extraction or does not exist.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { AxiError } from "../output/errors.js";

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface FetchArchiveOptions {
  url: string;
  /** Expected sha256 of the archive file, hex. */
  sha256: string;
  /** Directory created from the archive's contents; an existing directory is reused without a download. */
  dest: string;
  timeoutMs?: number;
  /** Try the system `tar` first (default); false forces the built-in extractor. */
  useSystemTar?: boolean;
}

export interface FetchArchiveResult {
  dir: string;
  /** `dest` already existed, nothing was downloaded. */
  reused: boolean;
  /** Archive size in bytes (0 when reused). */
  bytes: number;
}

/** Download `url` and check it against `sha256`. Throws AxiError on HTTP, network, timeout or checksum failure. */
export async function downloadVerified(url: string, sha256: string, timeoutMs = 120_000): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error;
    const reason = e.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : ((e.cause as Error | undefined)?.message ?? e.message);
    throw new AxiError(`download failed: ${url} (${reason})`, "check your network connection, or pass an explicit path to a local copy");
  }
  if (!response.ok) {
    throw new AxiError(`download failed: ${url} (HTTP ${response.status})`, "check that the release exists for this platform");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual !== sha256.toLowerCase()) {
    throw new AxiError(
      `checksum mismatch for ${url}: expected ${sha256.toLowerCase()}, got ${actual}`,
      "nothing was installed; retry, or check that the pinned checksum matches the release",
    );
  }
  return bytes;
}

/** Download, verify and extract into `dest` atomically. */
export async function fetchArchive(o: FetchArchiveOptions): Promise<FetchArchiveResult> {
  const dest = resolve(o.dest);
  if (existsSync(dest)) return { dir: dest, reused: true, bytes: 0 };
  const bytes = await downloadVerified(o.url, o.sha256, o.timeoutMs);

  const tmp = join(dirname(dest), `.${basename(dest)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const archive = `${tmp}.tgz`;
  try {
    await mkdir(tmp, { recursive: true });
    await writeFile(archive, bytes);
    await extractTarGz(archive, tmp, o.useSystemTar !== false);
    if ((await readdir(tmp)).length === 0) throw new AxiError(`archive from ${o.url} is empty`, "check the release asset");
    try {
      await rename(tmp, dest);
    } catch (err) {
      // Another process finished first: its directory is as good as ours.
      if (!existsSync(dest)) throw err;
    }
  } finally {
    await rm(archive, { force: true }).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  return { dir: dest, reused: false, bytes: bytes.length };
}

/**
 * Extract `archive` (.tar.gz, a file next to the empty directory `into`) into `into`: the system tar
 * first, the zlib-based extractor when that is missing or fails.
 */
export async function extractTarGz(archive: string, into: string, useSystemTar = true): Promise<void> {
  if (useSystemTar) {
    // Relative path with cwd = into: GNU tar would read `C:\...` as host:path.
    const rel = dirname(resolve(archive)) === dirname(resolve(into)) ? join("..", basename(archive)) : archive;
    const r = spawnSync("tar", ["-xzf", rel], { cwd: into, stdio: "ignore", timeout: 120_000 });
    if (r.status === 0) return;
    // Partial output of a failed tar must not leak into the fallback's result.
    for (const name of await readdir(into)) await rm(join(into, name), { recursive: true, force: true });
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(await readFile(archive));
  } catch (err) {
    throw new AxiError(`cannot read archive: ${(err as Error).message}`, "the download is corrupt; retry");
  }
  await untar(tar, into);
}

const nul = /\0[\s\S]*$/;
const octal = (b: Buffer, start: number, len: number): number => {
  const text = b.toString("latin1", start, start + len).replace(nul, "").trim();
  return text === "" ? 0 : parseInt(text, 8);
};
const cstr = (b: Buffer, start: number, len: number): string => b.toString("utf8", start, start + len).replace(nul, "");

const unsafe = (name: string): AxiError => new AxiError(`unsafe path in archive: ${name}`, "the archive is not trusted; nothing was installed");

/** Minimal ustar/pax/GNU-longname reader: regular files and directories only; links are skipped. */
export async function untar(tar: Buffer, into: string): Promise<void> {
  const root = resolve(into);
  let longName: string | undefined;
  let paxPath: string | undefined;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((x) => x === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = body.toString("utf8").replace(nul, "");
      continue;
    }
    if (type === "x") {
      for (let i = 0; i < body.length; ) {
        const sp = body.indexOf(0x20, i);
        const len = parseInt(body.toString("latin1", i, sp), 10);
        if (sp < 0 || !(len > 0)) break;
        const record = body.toString("utf8", sp + 1, i + len - 1);
        if (record.startsWith("path=")) paxPath = record.slice(5);
        i += len;
      }
      continue;
    }
    if (type === "g") continue;

    let name = longName ?? paxPath;
    if (name === undefined) {
      const prefix = header.toString("latin1", 257, 262) === "ustar" ? cstr(header, 345, 155) : "";
      name = (prefix ? `${prefix}/` : "") + cstr(header, 0, 100);
    }
    longName = paxPath = undefined;

    const segments = name.split("/").filter((s) => s !== "" && s !== ".");
    if (isAbsolute(name) || /^[a-zA-Z]:/.test(name) || segments.includes("..")) throw unsafe(name);
    if (segments.length === 0) continue;
    const target = join(root, ...segments);
    if (!target.startsWith(root + sep)) throw unsafe(name);
    if (type === "5") {
      await mkdir(target, { recursive: true });
    } else if (type === "0" || type === "7") {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      const mode = octal(header, 100, 8) & 0o777;
      if (mode) chmodSync(target, mode);
    }
  }
}
