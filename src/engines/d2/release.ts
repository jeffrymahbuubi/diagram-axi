// The pinned D2 binary release (KTD6). `release.json` is the file of record (CI and humans read it);
// this module carries the same data as a constant because tsc does not copy .json into dist/, and a test
// keeps the two identical.

export interface D2Asset {
  file: string;
  sha256: string;
}

export interface D2Release {
  version: string;
  /** Directory URL the asset files are served from (trailing slash). */
  baseUrl: string;
  source: string;
  license: string;
  /** Keyed `<os>-<arch>`: os in windows|linux|macos, arch in amd64|arm64. */
  assets: Record<string, D2Asset>;
}

export const D2_RELEASE: D2Release = {
  version: "v0.9.0",
  baseUrl: "https://github.com/d2lang/d2/releases/download/v0.9.0/",
  source: "https://github.com/d2lang/d2/tree/v0.9.0",
  license: "MPL-2.0",
  assets: {
    "linux-amd64": { file: "d2-v0.9.0-linux-amd64.tar.gz", sha256: "5669ddc46b99e942cc96078f4a4e36d5e62103348f4c05179ede27802fdd87a9" },
    "linux-arm64": { file: "d2-v0.9.0-linux-arm64.tar.gz", sha256: "ac2c028697199479acb321db1e3d68caee9f2ba492ed73caa3cd13f3829bf913" },
    "macos-amd64": { file: "d2-v0.9.0-macos-amd64.tar.gz", sha256: "cad39576a480d6bb02ea142fef1726647914b0d2da51ccc9b30b660a2b1babf0" },
    "macos-arm64": { file: "d2-v0.9.0-macos-arm64.tar.gz", sha256: "eaf6c0c143e56dd9fa97bfb6df25ea9c1ebce40245f056a0768cf1a6c15d3064" },
    "windows-amd64": { file: "d2-v0.9.0-windows-amd64.tar.gz", sha256: "5f63b643de8f5a6dfb922d172e1b5496e4caf47497c33c4427cf1127f28c340f" },
    "windows-arm64": { file: "d2-v0.9.0-windows-arm64.tar.gz", sha256: "dd05cab459410c287d7ca3eb9cf78145a071742ee8e1b81a0122f84f471883e1" },
  },
};

/** Platform key for the asset table: `windows-amd64`, `macos-arm64`, ... undefined on an unsupported machine. */
export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  return os && cpu ? `${os}-${cpu}` : undefined;
}
