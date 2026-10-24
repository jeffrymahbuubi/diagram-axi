// The optional native d2 binary (v0.9.0): opt-in via `engines install d2`, used only to write a PNG when
// no browser is found (its built-in rasteriser needs none). Never for SVG, validate, `d2 play` or `d2 validate`.
// Resolution: --d2-path, DIAGRAM_AXI_D2_PATH, the download cache, PATH; the first that reports the pinned version.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { AxiError } from "../../output/errors.js";
import { engineCacheDir } from "../cache.js";
import { fetchArchive } from "../fetch.js";
import { D2_RELEASE, platformKey, type D2Release } from "./release.js";
import type { D2Layout } from "./wasm.js";

export const D2_PATH_ENV = "DIAGRAM_AXI_D2_PATH";

export interface D2Binary {
  path: string;
  version: string;
  source: "flag" | "env" | "cache" | "path";
}

/** `d2 version` output of the binary at `path`, or undefined when it does not run. */
export type VersionProbe = (path: string) => Promise<string | undefined>;

export const probeVersion: VersionProbe = (path) =>
  new Promise((done) => {
    execFile(path, ["version"], { timeout: 15_000, windowsHide: true }, (err, stdout) => done(err ? undefined : stdout.trim().split(/\s+/)[0]));
  });

const exeName = (platform: NodeJS.Platform = process.platform): string => (platform === "win32" ? "d2.exe" : "d2");

/** Where `engines install d2` puts the binary: `<cache>/engines/d2/<version>/d2-<version>/bin/d2`. */
export function cachedBinaryPath(release: D2Release = D2_RELEASE): string {
  return join(engineCacheDir("d2", release.version), `d2-${release.version}`, "bin", exeName());
}

export interface ResolveOptions {
  /** --d2-path */
  d2Path?: string;
  env?: NodeJS.ProcessEnv;
  release?: D2Release;
  probe?: VersionProbe;
}

/**
 * The first usable binary: `--d2-path`, `DIAGRAM_AXI_D2_PATH`, the cache, PATH. A path given by flag or env that
 * is missing or reports another version is an error (it was asked for); the cache and PATH are skipped silently.
 */
export async function resolveD2Binary(o: ResolveOptions = {}): Promise<D2Binary | undefined> {
  const env = o.env ?? process.env;
  const release = o.release ?? D2_RELEASE;
  const probe = o.probe ?? probeVersion;

  const asked: { path: string; source: "flag" | "env" }[] = [];
  if (o.d2Path) asked.push({ path: o.d2Path, source: "flag" });
  else if (env[D2_PATH_ENV]) asked.push({ path: env[D2_PATH_ENV]!, source: "env" });
  for (const { path, source } of asked) {
    const full = resolve(path);
    const version = existsSync(full) ? await probe(full) : undefined;
    const from = source === "flag" ? "--d2-path" : D2_PATH_ENV;
    if (version === undefined) throw new AxiError(`d2 binary not found or not runnable: ${full} (from ${from})`, "point it at d2 v0.9.0, or run `engines install d2`");
    if (version !== release.version) throw new AxiError(`d2 at ${full} is ${version}; this tool is built for ${release.version}`, `use d2 ${release.version}, or run \`engines install d2\``);
    return { path: full, version, source };
  }

  const candidates: { path: string; source: "cache" | "path" }[] = [{ path: cachedBinaryPath(release), source: "cache" }];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    if (isAbsolute(dir)) candidates.push({ path: join(dir, exeName()), source: "path" });
  }
  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    const version = await probe(c.path);
    if (version === release.version) return { path: c.path, version, source: c.source };
  }
  return undefined;
}

export interface InstallOptions {
  release?: D2Release;
  platform?: NodeJS.Platform;
  arch?: string;
  timeoutMs?: number;
  useSystemTar?: boolean;
}

export interface InstallResult {
  path: string;
  version: string;
  /** Already in the cache; nothing was downloaded. */
  reused: boolean;
  bytes: number;
  url: string;
}

/** Download the pinned release for this platform into the cache, verified against the committed sha256. */
export async function installD2Binary(o: InstallOptions = {}): Promise<InstallResult> {
  const release = o.release ?? D2_RELEASE;
  const key = platformKey(o.platform, o.arch);
  const asset = key ? release.assets[key] : undefined;
  if (!key || !asset) {
    throw new AxiError(`no d2 ${release.version} build for ${o.platform ?? process.platform}/${o.arch ?? process.arch}`, "PNG still works with an installed browser (--browser-path)");
  }
  const url = new URL(asset.file, release.baseUrl).toString();
  const dest = engineCacheDir("d2", release.version);
  const got = await fetchArchive({
    url,
    sha256: asset.sha256,
    dest,
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    ...(o.useSystemTar === undefined ? {} : { useSystemTar: o.useSystemTar }),
  });
  const path = join(got.dir, `d2-${release.version}`, "bin", exeName(o.platform));
  if (!existsSync(path)) {
    throw new AxiError(`the archive did not contain d2-${release.version}/bin/${exeName(o.platform)}`, `remove ${got.dir} and retry`);
  }
  return { path, version: release.version, reused: got.reused, bytes: got.bytes, url };
}

export interface BinaryPngOptions {
  layout: D2Layout;
  sketch?: boolean;
  dark?: boolean;
  pad: number;
  scale: number;
  timeoutMs: number;
}

/** `d2 --layout <l> [--sketch] --pad <p> --scale <s> in.d2 out.png` in a private temp directory. */
export async function d2BinaryPng(bin: D2Binary, source: string, o: BinaryPngOptions): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), `diagram-axi-d2-${process.pid}-`));
  try {
    const input = join(dir, "in.d2");
    const output = join(dir, "out.png");
    await writeFile(input, source, "utf8");
    const args = ["--layout", o.layout, ...(o.sketch ? ["--sketch"] : []), ...(o.dark ? ["--theme", "200"] : []), "--pad", String(o.pad), "--scale", String(o.scale), input, output];
    await new Promise<void>((done, fail) => {
      execFile(bin.path, args, { timeout: o.timeoutMs, windowsHide: true, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
        if (!err) return done();
        const text = `${stderr}${stdout}`.trim().split(/\r?\n/).slice(-3).join("; ");
        fail(new AxiError(`d2 failed: ${text || err.message}`, "run `check` on the source; or use a browser for PNG (--browser-path)"));
      });
    });
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
