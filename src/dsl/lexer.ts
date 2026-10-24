// Hand-written, on-demand lexer for exd. The parser pulls tokens one at a time
// because two constructs are context sensitive:
//   - `{` is a diamond label `a{Q?}` everywhere except in a group header
//     (`group id "T" :blue {`), where the parser switches on `groupHeader`.
//   - the text after an edge's `:` is raw to end of line (`restOfLine`).
// Positions are 1-based (line, col) in UTF-16 units.

import { makeError } from "./diagnostics.js";
import { ARROWS, SHAPES, type Token, type TokenKind } from "./tokens.js";

const ARROW_RE = /(?<=\s)(?:<->|-\.->|-->|->|--)(?=\s|$)/;

function isIdStart(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z_]/.test(c);
}

function isIdChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

export class Lexer {
  private pos = 0;
  private line = 1;
  private lineStart = 0;
  /** Set by the parser while reading a group header so `{` opens the body. */
  groupHeader = false;

  constructor(private readonly src: string) {
    if (src.charCodeAt(0) === 0xfeff) this.pos = this.lineStart = 1;
  }

  private col(at = this.pos): number {
    return at - this.lineStart + 1;
  }

  private lineEnd(): number {
    const i = this.src.indexOf("\n", this.pos);
    return i === -1 ? this.src.length : i;
  }

  private lineText(): string {
    return this.src.slice(this.lineStart, this.lineEnd()).replace(/\r$/, "");
  }

  private tok(kind: TokenKind, start: number, end: number, value = this.src.slice(start, end)): Token {
    return { kind, value, raw: this.src.slice(start, end), line: this.line, col: this.col(start) };
  }

  private errorTok(at: number, code: "expected-token", message: string, suggestion: string): Token {
    const t = this.tok("ERROR", at, Math.max(at + 1, this.pos));
    t.col = this.col(at);
    t.error = makeError(code, this.line, t.col, message, suggestion);
    return t;
  }

  next(): Token {
    const src = this.src;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === " " || c === "\t" || c === "\r") this.pos++;
      else if (c === "#") this.pos = this.lineEnd();
      else break;
    }
    if (this.pos >= src.length) return this.tok("EOF", this.pos, this.pos);

    const start = this.pos;
    const c = src[start] as string;

    if (c === "\n") {
      const t = this.tok("NEWLINE", start, start + 1);
      this.pos++;
      this.line++;
      this.lineStart = this.pos;
      return t;
    }
    const simple: Record<string, TokenKind> = { ";": "SEMI", ",": "COMMA", ":": "COLON", "}": "RBRACE" };
    const simpleKind = simple[c];
    if (simpleKind) {
      this.pos++;
      return this.tok(simpleKind, start, this.pos);
    }
    if (c === "{" && this.groupHeader) {
      this.groupHeader = false;
      this.pos++;
      return this.tok("LBRACE", start, this.pos);
    }
    if (c === "[" || c === "(" || c === "{") return this.shape();
    if (c === '"') return this.string();
    if (c === "-" || c === "<") {
      for (const [text, arrow] of ARROWS) {
        if (src.startsWith(text, start)) {
          this.pos += text.length;
          const t = this.tok("ARROW", start, this.pos);
          t.arrow = arrow;
          return t;
        }
      }
    }
    if (isIdStart(c)) {
      let p = start + 1;
      // A hyphen belongs to the id only when an id character follows it, so
      // `a->b`, `a-->b` and `a-.->b` still split into id, arrow, id.
      while (isIdChar(src[p]) || (src[p] === "-" && isIdChar(src[p + 1]))) p++;
      this.pos = p;
      return this.tok("ID", start, p);
    }
    this.pos = start + 1;
    return this.errorTok(
      start,
      "expected-token",
      `unexpected character '${c}'`,
      c === "-" || c === "<"
        ? "arrows are ->, -->, --, <-> and -.->"
        : `remove '${c}' or put it inside a label such as id[text]`,
    );
  }

  private shape(): Token {
    const src = this.src;
    const start = this.pos;
    const lineEnd = this.lineEnd();
    const orig = SHAPES.find((s) => src.startsWith(s.open, start)) as (typeof SHAPES)[number];
    let def = orig;
    let bodyStart = start + def.open.length;
    let close = src.indexOf(def.close, bodyStart);
    if (def.kind === "cylinder" && (close === -1 || close > lineEnd)) {
      // `[(draft) notes]` is a plain rect whose label begins with a paren.
      def = SHAPES.find((s) => s.kind === "rect") as (typeof SHAPES)[number];
      bodyStart = start + 1;
      close = src.indexOf(def.close, bodyStart);
    }
    if (close === -1 || close > lineEnd) return this.unclosedShape(start + orig.open.length, orig.close);
    this.pos = close + def.close.length;
    const t = this.tok("SHAPE", start, this.pos, src.slice(bodyStart, close));
    t.shape = def.kind;
    return t;
  }

  /** Error for a missing closer, pointing at the first arrow or the end of the line. */
  private unclosedShape(bodyStart: number, closer: string): Token {
    const text = this.lineText();
    const rel = bodyStart - this.lineStart;
    const arrow = ARROW_RE.exec(text.slice(rel));
    let foundAt: number; // 0-based index into `text`
    let found: string;
    if (arrow) {
      foundAt = rel + arrow.index;
      found = `'${arrow[0]}'`;
    } else {
      foundAt = text.trimEnd().length;
      found = "end of line";
    }
    const indent = text.length - text.trimStart().length;
    const before = text.slice(indent, foundAt).trimEnd();
    const after = text.slice(foundAt).trim();
    const fixed = `${before}${closer}${arrow && after ? " " + after : ""}`;
    this.pos = this.lineEnd();
    const t = this.errorTok(
      this.lineStart + foundAt,
      "expected-token",
      `expected '${closer}' to close label, found ${found}`,
      `close the label: ${fixed}`,
    );
    return t;
  }

  private string(): Token {
    const src = this.src;
    const start = this.pos;
    const end = this.lineEnd();
    let p = start + 1;
    let out = "";
    while (p < end) {
      const ch = src[p] as string;
      if (ch === "\\" && p + 1 < end) {
        const n = src[p + 1] as string;
        out += n === "n" ? "\n" : n;
        p += 2;
      } else if (ch === '"') {
        this.pos = p + 1;
        return this.tok("STRING", start, this.pos, out);
      } else {
        out += ch;
        p++;
      }
    }
    this.pos = end;
    const text = this.lineText().trimEnd();
    return this.errorTok(
      this.lineStart + text.length,
      "expected-token",
      `expected '"' to close string, found end of line`,
      `close the string: ${text.trimStart()}"`,
    );
  }

  /**
   * Raw text after an edge's `:` up to end of line. A trailing comment (`#`
   * preceded by whitespace) and one trailing `;` are dropped; a fully quoted
   * text is unquoted (use it for labels containing `#`). Call only when no
   * token is buffered, i.e. right after consuming the COLON.
   */
  restOfLine(): { text: string; line: number; col: number } {
    const end = this.lineEnd();
    let raw = this.src.slice(this.pos, end).replace(/\r$/, "");
    const lead = raw.length - raw.trimStart().length;
    const col = this.col(this.pos + lead);
    this.pos = end;
    const quoted = /^\s*"((?:[^"\\]|\\.)*)"\s*;?\s*(?:#.*)?$/.exec(raw);
    if (quoted) {
      return { text: (quoted[1] as string).replace(/\\"/g, '"'), line: this.line, col };
    }
    const hash = raw.search(/(^|\s)#/);
    if (hash !== -1) raw = raw.slice(0, hash);
    raw = raw.trim().replace(/;$/, "").trim();
    return { text: raw, line: this.line, col };
  }
}
