// Generates src/layout/metrics/{excalifont,cascadia}.json from the TTFs shipped in
// @excalidraw/utils (devDependency). Output is compact and deterministic.
//
//   node scripts/build-font-metrics.mjs          regenerate the JSON from the fonts
//   node scripts/build-font-metrics.mjs --copy   copy src/layout/metrics -> dist/layout/metrics
//                                                (run after `tsc`; tsc does not emit plain JSON)
//
// JSON shape: { unitsPerEm, first, last, avg, widths } where widths[i] is the advance
// (font units) of codepoint first + i, and avg is the rounded mean advance of printable
// ASCII, used for codepoints outside [first, last] and for glyphs the font does not map.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src", "layout", "metrics");

if (process.argv.includes("--copy")) {
  if (!existsSync(outDir)) throw new Error(`missing ${outDir}; run without --copy first`);
  cpSync(outDir, join(root, "dist", "layout", "metrics"), { recursive: true });
  console.log("copied metrics to dist/layout/metrics");
  process.exit(0);
}

const assets = join(root, "node_modules", "@excalidraw", "utils", "dist", "prod", "assets");
const FIRST = 0x20;
const LAST = 0x24f;
const fonts = [
  { file: "Excalifont.ttf", out: "excalifont.json" },
  { file: "Cascadia Code.ttf", out: "cascadia.json" },
];

mkdirSync(outDir, { recursive: true });
for (const { file, out } of fonts) {
  const buf = readFileSync(join(assets, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const font = opentype.parse(ab);
  const raw = [];
  for (let cp = FIRST; cp <= LAST; cp++) {
    const glyph = font.charToGlyph(String.fromCodePoint(cp));
    // charToGlyph returns .notdef (index 0) for unmapped codepoints.
    raw.push(glyph && glyph.index !== 0 ? Math.round(glyph.advanceWidth ?? 0) : -1);
  }
  const ascii = raw.slice(0, 0x7f - FIRST).filter((w) => w > 0);
  const avg = Math.round(ascii.reduce((a, b) => a + b, 0) / ascii.length);
  const widths = raw.map((w) => (w < 0 ? avg : w));
  const data = { unitsPerEm: font.unitsPerEm, first: FIRST, last: LAST, avg, widths };
  writeFileSync(join(outDir, out), JSON.stringify(data) + "\n");
  console.log(`${out}: unitsPerEm=${font.unitsPerEm} avg=${avg} glyphs=${widths.length}`);
}
