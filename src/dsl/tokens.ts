// Token definitions and DSL vocabulary for the exd lexer/parser.

import type { ArrowKind, ColorName, Diagnostic, Direction, ShapeKind, StyleFlag } from "./ast.js";

export type TokenKind =
  | "ID"
  | "STRING"
  | "SHAPE" // a whole bracketed label: [..] (..) {..} [(..)]
  | "ARROW"
  | "COLON"
  | "COMMA"
  | "LBRACE" // group opener, only produced in group-header mode
  | "RBRACE"
  | "SEMI"
  | "NEWLINE"
  | "EOF"
  | "ERROR"; // lexical error; the parser rethrows `error` when it reaches it

export interface Token {
  kind: TokenKind;
  /** ID text, unescaped STRING contents, raw label text for SHAPE, arrow text for ARROW. */
  value: string;
  /** Source slice, used in "found ..." messages. */
  raw: string;
  /** 1-based position of the first character. */
  line: number;
  col: number;
  shape?: ShapeKind;
  arrow?: ArrowKind;
  error?: Diagnostic;
}

export const COLORS: readonly ColorName[] = [
  "blue",
  "green",
  "orange",
  "purple",
  "red",
  "yellow",
  "teal",
  "pink",
];

export const FLAGS: readonly StyleFlag[] = ["dashed", "dotted", "bold", "sketchy"];

export const DIRECTIONS: readonly Direction[] = ["DOWN", "RIGHT", "UP", "LEFT"];

/** Longest first so `-->` wins over `->` and `--`. */
export const ARROWS: readonly (readonly [string, ArrowKind])[] = [
  ["<->", "both"],
  ["-.->", "dotted"],
  ["-->", "dashed"],
  ["->", "solid"],
  ["--", "line"],
];

/** Shape delimiters, cylinder first because `[(` also starts with `[`. */
export const SHAPES: readonly { open: string; close: string; kind: ShapeKind }[] = [
  { open: "[(", close: ")]", kind: "cylinder" },
  { open: "[", close: "]", kind: "rect" },
  { open: "(", close: ")", kind: "ellipse" },
  { open: "{", close: "}", kind: "diamond" },
];

export function isColor(s: string): s is ColorName {
  return (COLORS as readonly string[]).includes(s);
}

export function isFlag(s: string): s is StyleFlag {
  return (FLAGS as readonly string[]).includes(s);
}
