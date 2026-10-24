// Serves the fonts the renderer page requests: packaged fonts from dist/fonts, the rest (Xiaolai, the
// CJK fallback) from a local cache or, on first use, from mirrors. Every download is checked against
// its sha256. Adapted from the MIT-licensed excalidraw/cli (see NOTICE).

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Fonts left out of the package, by sha256 (written by scripts/build-renderer.mjs). */
interface RemoteFonts {
  release: string;
  fonts: Record<string, string>;
}

/** Mirrors that serve the release's dist/prod/ directory. Any of them works: every file is checked against its sha256. */
function defaultMirrors(release: string): string[] {
  return [
    // excalidraw.com's asset CDN.
    "https://excalidraw.nyc3.cdn.digitaloceanspaces.com/oss/",
    `https://cdn.jsdelivr.net/npm/${release}/dist/prod/`,
  ];
}

/**
 * Maps `--fonts-url` to the mirror list: undefined = built-in mirrors, "none" = downloads disabled,
 * otherwise one or more comma-separated base URLs that serve the release's dist/prod/ layout.
 */
export function parseFontsUrl(value: string | undefined): string[] | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.toLowerCase() === "none") return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((base) => (base.endsWith("/") ? base : `${base}/`));
}

/** `%LOCALAPPDATA%/diagram-axi/fonts` on Windows, `~/Library/Caches/...` on macOS, XDG elsewhere. */
export function fontCacheDirectory(): string {
  const env = process.env;
  let base: string;
  if (process.platform === "win32") {
    base = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  } else if (process.platform === "darwin") {
    base = join(homedir(), "Library", "Caches");
  } else {
    base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  }
  return join(base, "diagram-axi", "fonts");
}

export interface FontLoader {
  load(hash: string): Promise<Buffer | undefined>;
  /** One line about fonts that could not be loaded, if any. */
  warning(): string | undefined;
}

/**
 * @param mirrors undefined = default mirrors, [] = downloads disabled.
 * @param deadline epoch ms after which downloads stop, so the render can still finish with fallback glyphs.
 * @param distDirectory directory holding fonts/<sha256>.woff2 and fonts/remote.json.
 * @param cacheDirectory override for the download cache (tests).
 */
export function createFontLoader({
  mirrors,
  deadline,
  distDirectory,
  cacheDirectory = fontCacheDirectory(),
}: {
  mirrors?: string[];
  deadline: number;
  distDirectory: URL;
  cacheDirectory?: string;
}): FontLoader {
  const failures = new Map<string, string>();
  let remote: Promise<RemoteFonts | undefined> | undefined;

  async function download(hash: string, path: string, release: string) {
    const urls = (mirrors ?? defaultMirrors(release)).map((base) => new URL(path, base));
    if (urls.length === 0) {
      failures.set(hash, "font downloads are disabled");
      return undefined;
    }
    let reason = "";
    for (const [index, url] of urls.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reason = "timed out";
        break;
      }
      try {
        // Later mirrors get their share of the remaining time if an earlier one hangs.
        // AbortSignal.timeout() only accepts whole milliseconds.
        const timeout = Math.ceil(remaining / (urls.length - index));
        const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const font = Buffer.from(await response.arrayBuffer());
        if (sha256(font) !== hash) {
          throw new Error("unexpected file contents");
        }
        return font;
      } catch (error) {
        reason = `${url.host}: ${describe(error)}`;
      }
    }
    failures.set(hash, reason);
    return undefined;
  }

  return {
    async load(hash) {
      const packaged = await readFile(new URL(`fonts/${hash}.woff2`, distDirectory)).catch(() => undefined);
      if (packaged) {
        return packaged;
      }
      remote ??= readFile(new URL("fonts/remote.json", distDirectory), "utf8")
        .then((text) => JSON.parse(text) as RemoteFonts)
        .catch(() => undefined);
      const manifest = await remote;
      const path = manifest?.fonts[hash];
      if (!manifest || !path) {
        return undefined;
      }

      const cached = join(cacheDirectory, `${hash}.woff2`);
      const font = await readFile(cached).catch(() => undefined);
      if (font && sha256(font) === hash) {
        return font;
      }
      const downloaded = await download(hash, path, manifest.release);
      if (downloaded) {
        await saveToCache(cached, downloaded);
      }
      return downloaded;
    },

    warning() {
      if (failures.size === 0) {
        return undefined;
      }
      if (mirrors?.length === 0) {
        return "font downloads are disabled (--fonts-url none), so characters that need a downloaded font use a fallback font";
      }
      const reasons = [...new Set(failures.values())].join("; ");
      const files = failures.size === 1 ? "1 font file" : `${failures.size} font files`;
      return `could not download ${files} for this scene's text (${reasons}), so some characters use a fallback font; check your network connection or set --fonts-url to a reachable mirror`;
    },
  };
}

async function saveToCache(path: string, font: Buffer) {
  // Written under a unique name, then renamed, so concurrent renders never read a partial file.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(temporary, font);
    await rename(temporary, path);
  } catch {
    // An unwritable cache only costs a download next time.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function describe(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "timed out";
  }
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  return cause?.code ?? (error instanceof Error ? error.message : String(error));
}
