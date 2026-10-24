// `check` for D2 sources: a full compile (never `d2 validate`, which is parse-only and lets semantic
// errors through). compile() rejects with every error in one pass; each carries a range that becomes
// line:col:endCol. Lints that need no compile (remote icons) run on the text and are returned as warnings.

import type { Diagnostic } from "../types.js";
import { D2CompileError, d2Compile, type D2RawError } from "./wasm.js";

const SHAPES =
  "rectangle, square, page, parallelogram, document, cylinder, queue, package, step, callout, stored_data, person, diamond, oval, circle, hexagon, cloud, text, code, class, sql_table, image, sequence_diagram";
const NEAR_POSITIONS = "top-left, top-center, top-right, center-left, center-right, bottom-left, bottom-center, bottom-right";
const STYLE_KEYWORDS =
  "opacity, stroke, fill, fill-pattern, stroke-width, stroke-dash, border-radius, shadow, 3d, multiple, font, font-size, font-color, animated, bold, italic, underline, filled, double-border, text-transform";

/** Message pattern -> code and suggestion. First match wins. */
const KNOWN: { re: RegExp; code: string; suggestion?: string }[] = [
  { re: /maps must be terminated/i, code: "unterminated-map", suggestion: "add a closing }" },
  { re: /double quoted strings must be terminated/i, code: "unterminated-string", suggestion: 'close the string with "' },
  { re: /single quoted strings must be terminated/i, code: "unterminated-string", suggestion: "close the string with '" },
  { re: /connection missing destination/i, code: "missing-destination", suggestion: "put a target after the arrow, e.g. a -> b" },
  { re: /unknown shape/i, code: "unknown-shape", suggestion: `use one of: ${SHAPES}` },
  { re: /valid named color/i, code: "bad-color", suggestion: 'use a hex code like "#f0ff3a" or a named color like "orange"' },
  { re: /near key/i, code: "bad-near", suggestion: `use one of: ${NEAR_POSITIONS}, or the path of a shape` },
  { re: /invalid style keyword/i, code: "unknown-style", suggestion: `style keywords: ${STYLE_KEYWORDS}` },
  { re: /expected ".+" to be a number/i, code: "bad-number", suggestion: "use a number inside the range the message names" },
  { re: /non-integer/i, code: "bad-integer", suggestion: "use a whole number, e.g. width: 120" },
];

const RANGE = /^[^,]*,(\d+):(\d+):\d+-(\d+):(\d+):\d+$/;

/** D2 raw error -> Diagnostic. The range is 0-based; diagnostics are 1-based, `endCol` exclusive-end + 1 on a one-line range. */
export function toDiagnostic(e: D2RawError): Diagnostic {
  const message = e.errmsg.replace(/^[^\s:]*:\d+:\d+:\s*/, "").trim();
  const known = KNOWN.find((k) => k.re.test(message));
  const d: Diagnostic = { code: known?.code ?? "d2-error", message };
  const r = e.range ? RANGE.exec(e.range) : null;
  if (r) {
    d.line = Number(r[1]) + 1;
    d.col = Number(r[2]) + 1;
    if (r[1] === r[3]) d.endCol = Number(r[4]) + 1;
  } else {
    const m = /^[^\s:]*:(\d+):(\d+):/.exec(e.errmsg);
    if (m) {
      d.line = Number(m[1]);
      d.col = Number(m[2]);
    }
  }
  if (known?.suggestion) d.suggestion = known.suggestion;
  d.severity = "error";
  return d;
}

const REMOTE_ICON = /\bicon\s*:\s*["']?(https?:\/\/[^\s"'}]+)/g;

/** `remote-icon` warnings: `icon: http(s)://...` is fetched over the network when the SVG is viewed. */
export function lintD2(source: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  source.split(/\r?\n/).forEach((text, i) => {
    if (text.trim().startsWith("#")) return;
    for (const m of text.matchAll(REMOTE_ICON)) {
      const url = m[1]!;
      const col = m.index! + m[0].length - url.length + 1;
      out.push({
        line: i + 1,
        col,
        endCol: col + url.length,
        code: "remote-icon",
        severity: "warning",
        message: `icon ${url} is fetched over the network when the diagram is viewed; offline renders leave it blank`,
        suggestion: "use a local file path or drop the icon",
      });
    }
  });
  return out;
}

/** Compile `source`: every error in one pass, plus text lints. Empty when the source is clean. */
export async function validateD2(source: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  try {
    await d2Compile(source, { layout: "dagre" });
  } catch (err) {
    if (!(err instanceof D2CompileError)) throw err;
    diagnostics.push(...err.errors.map(toDiagnostic));
  }
  diagnostics.push(...lintD2(source));
  return diagnostics.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0));
}
