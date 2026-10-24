// Where downloaded engine pieces live: `<tool cache>/engines/<name>/<version>/`. The tool cache is the
// directory above the font cache (so it follows the tool's name), or DIAGRAM_AXI_CACHE_DIR.

import { dirname, join } from "node:path";
import { fontCacheDirectory } from "../render/fonts.js";

export const CACHE_DIR_ENV = "DIAGRAM_AXI_CACHE_DIR";

/** The tool's cache directory: env override, else the parent of the font cache directory. */
export function toolCacheDir(): string {
  const override = process.env[CACHE_DIR_ENV];
  return override ? override : dirname(fontCacheDirectory());
}

/** `<tool cache>/engines/<name>/<version>`; neither part may contain a path separator or `..`. */
export function engineCacheDir(name: string, version: string): string {
  for (const part of [name, version]) {
    if (!part || part === "." || part === ".." || /[\\/]/.test(part)) throw new Error(`invalid cache path part: ${JSON.stringify(part)}`);
  }
  return join(toolCacheDir(), "engines", name, version);
}
