// D2 optional binary (U2): resolve order, release table, install from a local http server, PNG fallback.
// No network. Tests that need a real d2 v0.9.0 binary skip without one (--d2-path / DIAGRAM_AXI_D2_PATH / cache / PATH).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CACHE_DIR_ENV } from "../src/engines/cache.js";
import { cachedBinaryPath, D2_PATH_ENV, installD2Binary, resolveD2Binary, type D2Binary } from "../src/engines/d2/binary.js";
import { D2_RELEASE, platformKey } from "../src/engines/d2/release.js";
import { renderD2 } from "../src/engines/d2/render.js";
import { disposeD2 } from "../src/engines/d2/wasm.js";
import { sha256Hex } from "../src/engines/fetch.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
/** Small enough that the default PNG scale is not lowered by the 2048 px cap. */
const SMALL = "direction: right\na -> b";

afterAll(async () => {
  await disposeD2();
});

// ---- binary: resolve, install, PNG ----

describe("binary resolve", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dg-d2-bin-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => {
    delete process.env[CACHE_DIR_ENV];
  });

  const touch = (path: string): string => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
    return path;
  };
  /** A probe that reports the version listed for each path, or fails. */
  const probe = (versions: Record<string, string>) => async (p: string) => versions[p];

  it("--d2-path beats the env var, the cache and PATH", async () => {
    const flag = touch(join(dir, "flag", "d2"));
    const env = touch(join(dir, "env", "d2"));
    const got = await resolveD2Binary({ d2Path: flag, env: { [D2_PATH_ENV]: env }, probe: async () => "v0.9.0" });
    expect(got).toEqual({ path: flag, version: "v0.9.0", source: "flag" });
  });

  it("the env var comes next, then the cache, then PATH", async () => {
    const env = touch(join(dir, "env2", "d2"));
    expect((await resolveD2Binary({ env: { [D2_PATH_ENV]: env }, probe: async () => "v0.9.0" }))?.source).toBe("env");

    process.env[CACHE_DIR_ENV] = join(dir, "cache");
    const cached = touch(cachedBinaryPath());
    const onPath = touch(join(dir, "pathdir", process.platform === "win32" ? "d2.exe" : "d2"));
    const both = await resolveD2Binary({ env: { PATH: join(dir, "pathdir") }, probe: async () => "v0.9.0" });
    expect(both).toMatchObject({ path: cached, source: "cache" });
    rmSync(cached);
    const pathOnly = await resolveD2Binary({ env: { PATH: [join(dir, "nothing"), join(dir, "pathdir")].join(delimiter) }, probe: async () => "v0.9.0" });
    expect(pathOnly).toMatchObject({ path: onPath, source: "path" });
  });

  it("skips cache and PATH entries that report another version; a requested path with another version is an error", async () => {
    process.env[CACHE_DIR_ENV] = join(dir, "cache2");
    const cached = touch(cachedBinaryPath());
    expect(await resolveD2Binary({ env: { PATH: "" }, probe: probe({ [cached]: "v0.8.2" }) })).toBeUndefined();
    const flag = touch(join(dir, "old", "d2"));
    await expect(resolveD2Binary({ d2Path: flag, probe: probe({ [flag]: "v0.8.2" }) })).rejects.toThrow(/is v0\.8\.2; this tool is built for v0\.9\.0/);
    await expect(resolveD2Binary({ d2Path: join(dir, "missing"), probe: async () => "v0.9.0" })).rejects.toThrow(/not found or not runnable/);
    await expect(resolveD2Binary({ env: { [D2_PATH_ENV]: join(dir, "missing") }, probe: async () => "v0.9.0" })).rejects.toThrow(/from DIAGRAM_AXI_D2_PATH/);
  });

  it("finds nothing on a machine without d2", async () => {
    process.env[CACHE_DIR_ENV] = join(dir, "cache3");
    expect(await resolveD2Binary({ env: { PATH: join(dir, "empty") } })).toBeUndefined();
  });
});

describe("release table", () => {
  it("release.json and release.ts agree", () => {
    const json = JSON.parse(readFileSync(here("../src/engines/d2/release.json"), "utf8")) as unknown;
    expect(json).toEqual(D2_RELEASE);
  });

  it("every platform has a pinned file name and sha256; windows-amd64 is the SHA256SUMS value", () => {
    expect(Object.keys(D2_RELEASE.assets).sort()).toEqual(["linux-amd64", "linux-arm64", "macos-amd64", "macos-arm64", "windows-amd64", "windows-arm64"]);
    for (const [key, a] of Object.entries(D2_RELEASE.assets)) {
      expect(a.file).toBe(`d2-v0.9.0-${key}.tar.gz`);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(D2_RELEASE.assets["windows-amd64"]!.sha256).toBe("5f63b643de8f5a6dfb922d172e1b5496e4caf47497c33c4427cf1127f28c340f");
    expect(D2_RELEASE.baseUrl).toBe("https://github.com/d2lang/d2/releases/download/v0.9.0/");
  });

  it("maps node platform/arch to asset keys", () => {
    expect(platformKey("win32", "x64")).toBe("windows-amd64");
    expect(platformKey("darwin", "arm64")).toBe("macos-arm64");
    expect(platformKey("linux", "x64")).toBe("linux-amd64");
    expect(platformKey("freebsd", "x64")).toBeUndefined();
    expect(platformKey("linux", "ia32")).toBeUndefined();
  });
});

/** One ustar file entry (no directories needed: the extractor creates parents). */
function tarFile(name: string, data: Buffer, mode = 0o755): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, "utf8");
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1");
  h.write("0000000\0", 116, "latin1");
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  h.write("00000000000\0", 136, "latin1");
  h.write("        ", 148, "latin1");
  h.write("0", 156, "latin1");
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

describe("binary install (local http server, never the network)", () => {
  const archive = gzipSync(Buffer.concat([tarFile("d2-v0.9.0/bin/d2", Buffer.from("fake-d2")), tarFile("d2-v0.9.0/LICENSE.txt", Buffer.from("MPL"), 0o644), Buffer.alloc(1024)]));
  const noBin = gzipSync(Buffer.concat([tarFile("d2-v0.9.0/README.md", Buffer.from("hi"), 0o644), Buffer.alloc(1024)]));
  let server: Server;
  let base = "";
  let hits = 0;
  let work: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (req.url === "/d2-v0.9.0-linux-amd64.tar.gz") res.writeHead(200).end(archive);
      else if (req.url === "/d2-v0.9.0-linux-arm64.tar.gz") res.writeHead(200).end(noBin);
      else res.writeHead(404).end("nope");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`;
    work = mkdtempSync(join(tmpdir(), "dg-d2-install-"));
    process.env[CACHE_DIR_ENV] = work;
  });
  afterAll(() => {
    server.close();
    delete process.env[CACHE_DIR_ENV];
    rmSync(work, { recursive: true, force: true });
  });

  const release = (): typeof D2_RELEASE => ({
    ...D2_RELEASE,
    baseUrl: base,
    assets: {
      "linux-amd64": { file: "d2-v0.9.0-linux-amd64.tar.gz", sha256: sha256Hex(archive) },
      "linux-arm64": { file: "d2-v0.9.0-linux-arm64.tar.gz", sha256: sha256Hex(noBin) },
      "windows-amd64": { file: "d2-v0.9.0-windows-amd64.tar.gz", sha256: "0".repeat(64) },
    },
  });

  it("downloads, verifies and extracts into the engine cache; a second call reuses it", async () => {
    const r = await installD2Binary({ release: release(), platform: "linux", arch: "x64" });
    expect(r).toMatchObject({ version: "v0.9.0", reused: false, bytes: archive.length, url: `${base}d2-v0.9.0-linux-amd64.tar.gz` });
    expect(r.path).toBe(join(work, "engines", "d2", "v0.9.0", "d2-v0.9.0", "bin", "d2"));
    expect(readFileSync(r.path, "utf8")).toBe("fake-d2");
    const before = hits;
    expect((await installD2Binary({ release: release(), platform: "linux", arch: "x64" })).reused).toBe(true);
    expect(hits).toBe(before);
  });

  it("rejects a checksum mismatch and leaves nothing behind", async () => {
    rmSync(join(work, "engines"), { recursive: true, force: true });
    await expect(installD2Binary({ release: release(), platform: "win32", arch: "x64" })).rejects.toThrow(/HTTP 404|checksum mismatch/);
    expect(existsSync(join(work, "engines", "d2", "v0.9.0"))).toBe(false);
    const bad = release();
    bad.assets["linux-amd64"]!.sha256 = "1".repeat(64);
    await expect(installD2Binary({ release: bad, platform: "linux", arch: "x64" })).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(join(work, "engines", "d2", "v0.9.0"))).toBe(false);
  });

  it("fails when the archive has no binary, and on an unsupported platform", async () => {
    rmSync(join(work, "engines"), { recursive: true, force: true });
    await expect(installD2Binary({ release: release(), platform: "linux", arch: "arm64" })).rejects.toThrow(/did not contain d2-v0.9.0\/bin\/d2/);
    await expect(installD2Binary({ release: release(), platform: "freebsd", arch: "x64" })).rejects.toThrow(/no d2 v0\.9\.0 build for freebsd/);
  });
});

describe("png via the d2 binary", () => {
  let bin: D2Binary | undefined;
  beforeAll(async () => {
    bin = await resolveD2Binary().catch(() => undefined);
  });

  it("writes the PNG when no browser can be found", async (ctx) => {
    if (!bin) return ctx.skip("no d2 v0.9.0 binary");
    const plain = await renderD2(SMALL);
    const r = await renderD2(SMALL, { png: true, browserPath: join(tmpdir(), "no-such-browser-for-d2-test"), d2Path: bin.path });
    expect(r.pngVia).toBe("binary");
    expect(r.browser).toBe("d2");
    expect(r.warning).toMatch(/no usable browser/);
    expect(Buffer.from(r.png!).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(Math.abs(r.width - plain.width * 2.5)).toBeLessThanOrEqual(2);
    expect(r.svg).toBe(plain.svg);
  });
});

