// Diagnostic helpers shared by the lexer and the parser. Messages never carry
// the "line L, col C:" prefix; commands add it when printing.

import type { Diagnostic, DiagnosticCode } from "./ast.js";

/** Thrown to stop parsing at the first error (R3: no error recovery). */
export class ParseError extends Error {
  constructor(public readonly diag: Diagnostic) {
    super(diag.message);
    this.name = "ParseError";
  }
}

export function makeError(
  code: DiagnosticCode,
  line: number,
  col: number,
  message: string,
  suggestion: string,
): Diagnostic {
  return { line, col, code, message, suggestion, severity: "error" };
}

export function makeWarning(
  code: DiagnosticCode,
  line: number,
  col: number,
  message: string,
  suggestion?: string,
): Diagnostic {
  const d: Diagnostic = { line, col, code, message, severity: "warning" };
  if (suggestion !== undefined) d.suggestion = suggestion;
  return d;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(up + 1, (prev[j - 1] as number) + 1, diag + cost);
      diag = up;
    }
  }
  return prev[b.length] as number;
}

/** Closest candidate to `word` (case-insensitive), or undefined when nothing is close. */
export function nearest(word: string, candidates: readonly string[]): string | undefined {
  const w = word.toLowerCase();
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = c.startsWith(w) && w.length >= 2 ? 1 : distance(w, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== undefined && bestD <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined;
}

/** "did you mean 'x'? valid: a, b, c" style suggestion. */
export function didYouMean(word: string, candidates: readonly string[], label: string): string {
  const hit = nearest(word, candidates);
  const list = `valid ${label}: ${candidates.join(", ")}`;
  return hit ? `did you mean '${hit}'? ${list}` : `use one of the ${list}`;
}
