// Tiny glob matcher for --include / --exclude over posix paths: `**`, `*`, `?`. A glob matches when it matches a
// contiguous run of path segments (starting at any segment boundary), so `dist` and `src/gen` hide whole trees
// and `*.test.ts` matches in any directory.

const cache = new Map<string, RegExp>();

function toRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export function matchGlob(path: string, glob: string): boolean {
  const g = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  if (g === "") return false;
  const re = toRegExp(g);
  const segs = path.split("/");
  for (let start = 0; start < segs.length; start++) {
    for (let end = segs.length; end > start; end--) if (re.test(segs.slice(start, end).join("/"))) return true;
  }
  return false;
}

export const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((g) => matchGlob(path, g));
