// Mermaid error mapping (KTD3). Mermaid fails in three shapes: Jison parse errors carry `hash.loc`
// (1-based line, 0-based column), Langium parse errors only a message with "line N, column M" (both
// 1-based), and anything else (an UnknownDiagramError, a TypeError from a diagram that cannot be drawn)
// has no position. Positions are relative to the text after the YAML frontmatter, so the frontmatter's
// line count is added back; lines and columns are clamped into the document.

import type { Diagnostic } from "../types.js";
import type { RawError } from "./inpage.js";

export const MERMAID_KINDS_HINT =
  "start with flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram-v2, timeline, gitGraph or mindmap";

/** Lines taken by a leading `---` ... `---` frontmatter block (0 when there is none). */
export function frontmatterLines(source: string): number {
  const m = /^-{3}[^\S\n]*\r?\n[\s\S]*?\r?\n-{3}[^\S\n]*(?:\r?\n|$)/.exec(source);
  if (!m) return 0;
  return m[0].split("\n").length - (m[0].endsWith("\n") ? 1 : 0);
}

/** First word of the first content line after frontmatter, comments and directives. */
export function firstKeyword(source: string): string {
  const lines = source.split(/\r?\n/);
  for (let i = frontmatterLines(source); i < lines.length; i++) {
    const t = (lines[i] as string).trim();
    if (t !== "" && !t.startsWith("%%")) return /^[^\s{(;:]+/.exec(t)?.[0] ?? t;
  }
  return "";
}

function clampPosition(source: string, line: number | undefined, col: number | undefined): { line?: number; col?: number } {
  if (line === undefined) return {};
  const lines = source.replace(/\n$/, "").split("\n");
  const l = Math.min(Math.max(1, line), Math.max(1, lines.length));
  if (col === undefined) return { line: l };
  const max = ((lines[l - 1] as string | undefined)?.replace(/\r$/, "").length ?? 0) + 1;
  return { line: l, col: Math.min(Math.max(1, col), max) };
}

/** `unexpected 'X'; expected A, B, C` from a Jison "Expecting 'A', 'B', got 'X'" tail. */
function jisonMessage(message: string): { text: string; atEnd: boolean } {
  const lines = message.split("\n");
  const expecting = lines.find((l) => l.startsWith("Expecting "));
  const m = expecting && /^Expecting (.+), got (.+)$/.exec(expecting);
  if (m) {
    const got = (m[2] as string).replace(/^'|'$/g, "");
    const expected = (m[1] as string).split(", ").map((t) => t.replace(/^'|'$/g, ""));
    const shown = expected.length > 6 ? `${expected.slice(0, 6).join(", ")}, ...` : expected.join(", ");
    return { text: `unexpected ${got === "EOF" ? "end of input" : `'${got}'`}; expected ${shown}`, atEnd: got === "EOF" };
  }
  const lexical = /^Lexical error on line \d+\.\s*(.*)$/.exec(lines[0] as string);
  if (lexical) return { text: (lexical[1] || "unrecognized text").replace(/\.$/, ""), atEnd: false };
  return { text: (lines[0] as string).replace(/^Parse error on line \d+:?\s*/, "") || "syntax error", atEnd: false };
}

/** Langium messages are "Parsing failed: Lexer error on line L, column C: ... Parse error on line ...". */
function langiumMessage(message: string): { text: string; line?: number; col?: number } {
  const body = message.replace(/^Parsing failed:\s*/, "").trim();
  const first = body.split(/\.\s+(?=(?:Lexer|Parse) error)/)[0] as string;
  const at = /line (\d+), column (\d+)/.exec(first);
  const text = first.replace(/ on line \d+, column \d+/, "").replace(/\s+/g, " ").replace(/\.$/, "");
  return { text, ...(at ? { line: Number(at[1]), col: Number(at[2]) } : {}) };
}

/**
 * One Diagnostic for a failure in the page. `extraLines` is the number of lines the caller prepended
 * to `source` after the frontmatter (a config directive) so they can be subtracted again.
 */
export function mapError(raw: RawError, source: string, extraLines = 0): Diagnostic {
  const offset = frontmatterLines(source) - extraLines;
  const keyword = firstKeyword(source);

  if (raw.name === "UnknownDiagramError" || /No diagram type detected/.test(raw.message)) {
    return {
      code: "unknown-diagram",
      message: keyword ? `unknown diagram type '${keyword}'` : "no diagram type found; the source is empty or has no diagram keyword",
      suggestion: MERMAID_KINDS_HINT,
    };
  }

  // Langium (pie, gitGraph, ...): positions live in the message.
  if (raw.message.startsWith("Parsing failed:")) {
    const m = langiumMessage(raw.message);
    return { ...clampPosition(source, m.line === undefined ? undefined : m.line + offset, m.col), code: "mermaid-syntax", message: m.text };
  }

  // Jison: hash.loc, or hash.line for lexical errors (0-based).
  const jisonLine = raw.locLine ?? (raw.hashLine !== undefined ? raw.hashLine + 1 : undefined);
  if (jisonLine !== undefined || /^(Parse|Lexical) error/.test(raw.message)) {
    const m = jisonMessage(raw.message);
    const pos = clampPosition(source, jisonLine === undefined ? undefined : jisonLine + offset, raw.locCol === undefined ? undefined : raw.locCol + 1);
    return {
      ...pos,
      code: "mermaid-syntax",
      message: m.text,
      ...(m.atEnd ? { suggestion: "a statement is cut off; finish it or delete it" } : {}),
    };
  }

  // No position: a semantic error or a diagram Mermaid cannot draw.
  const message = raw.message.split("\n")[0] as string;
  const kind = keyword ? ` ${keyword}` : "";
  if (raw.ctor === "TypeError" || raw.name === "TypeError") {
    return {
      code: "render-error",
      message: `Mermaid could not draw this${kind} diagram: ${message}`,
      suggestion: "simplify the diagram, or try --layout dagre; the error has no source position",
    };
  }
  return { code: "mermaid-error", message };
}
