// Static text measurement from Excalifont / Cascadia advance widths (KTD2).
// No browser involved: width = sum(advances) * fontSize / unitsPerEm,
// line height = 1.25 * fontSize. Code points outside the font tables (CJK, fullwidth, emoji, other
// scripts) use widths calibrated against the real renderer, see measure-ext.ts.

import { createRequire } from "node:module";
import type { TextMetrics } from "./engine.js";
import { emojiSequence, extAdvance } from "./measure-ext.js";

export type FontFamily = "excalifont" | "cascadia";

interface FontMetricsData {
  unitsPerEm: number;
  first: number;
  last: number;
  avg: number;
  widths: number[];
}

/** Excalidraw's line height multiplier for Excalifont (lineHeight 1.25). */
export const LINE_HEIGHT = 1.25;

const require = createRequire(import.meta.url);
const cache = new Map<FontFamily, FontMetricsData>();

// The JSON sits next to this module: src/layout/metrics (vitest, tsx) or
// dist/layout/metrics (after `npm run build`, copied by `build-font-metrics.mjs --copy`).
function load(family: FontFamily): FontMetricsData {
  let data = cache.get(family);
  if (!data) {
    data = require(`./metrics/${family}.json`) as FontMetricsData;
    cache.set(family, data);
  }
  return data;
}

function lineWidth(line: string, fontSize: number, data: FontMetricsData): number {
  let units = 0;
  const avgEm = data.avg / data.unitsPerEm;
  let extEm = 0; // advances outside the metrics table, already in em
  for (let i = 0; i < line.length; ) {
    const cp = line.codePointAt(i) ?? 0;
    if (cp === 0x09) {
      units += 4 * (data.widths[0] ?? data.avg); // tab -> 4 spaces
      i++;
    } else if (cp >= data.first && cp <= data.last) {
      // A keycap sequence (digit + VS16 + U+20E3) is one emoji glyph.
      if (line.charCodeAt(i + 1) === 0xfe0f && (cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39))) {
        const adv = emojiSequence(line, i + 1);
        extEm += adv.em;
        i = adv.next;
      } else {
        units += data.widths[cp - data.first] ?? data.avg;
        i++;
      }
    } else {
      // CJK / fullwidth / emoji / other scripts: widths measured from the real renderer (measure-ext.ts).
      const adv = extAdvance(line, i, cp, avgEm);
      extEm += adv.em;
      i = adv.next;
    }
  }
  return (units / data.unitsPerEm + extEm) * fontSize;
}

/** Measure `text` (lines split on \n) at `fontSize` px. Widths are rounded to 0.01. */
export function measure(text: string, fontSize: number, family: FontFamily = "excalifont"): TextMetrics {
  const data = load(family);
  const lines = text.split("\n");
  let width = 0;
  for (const line of lines) width = Math.max(width, lineWidth(line, fontSize, data));
  return {
    lines,
    width: Math.round(width * 100) / 100,
    height: Math.round(lines.length * LINE_HEIGHT * fontSize * 100) / 100,
  };
}

/**
 * Like `measure`, but a line wider than `maxWidth` is broken at spaces (greedily) into lines that
 * fit; a single word wider than the limit stays on a line of its own. Explicit line breaks are kept.
 */
export function measureWrapped(text: string, fontSize: number, maxWidth: number, family: FontFamily = "excalifont"): TextMetrics {
  const plain = measure(text, fontSize, family);
  if (plain.width <= maxWidth) return plain;
  const data = load(family);
  const lines: string[] = [];
  for (const line of plain.lines) {
    if (lineWidth(line, fontSize, data) <= maxWidth) {
      lines.push(line);
      continue;
    }
    let cur = "";
    for (const word of line.split(" ")) {
      const next = cur === "" ? word : `${cur} ${word}`;
      if (cur !== "" && lineWidth(next, fontSize, data) > maxWidth) {
        lines.push(cur);
        cur = word;
      } else cur = next;
    }
    lines.push(cur);
  }
  return measure(lines.join("\n"), fontSize, family);
}
