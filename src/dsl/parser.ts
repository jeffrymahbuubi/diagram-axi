// Recursive-descent parser for exd. `parse(text)` never throws on bad input:
// the first error stops parsing and is returned as the last diagnostic
// (severity "error"); warnings gathered before it are kept.
//
// Colon rule (`:` is overloaded):
//   - in an edge statement (`a -> b : text`) a `:` after the last ref ALWAYS
//     starts the edge label, which is the raw rest of the line (quote it to
//     keep a `#`: `: "issue #5"`). A chain/fan-out label applies to every
//     edge the statement creates.
//   - in a standalone node declaration (`api[API] :purple`) or a group header
//     (`group g "T" :blue {`) a `:` starts a style: COLOR then `,flag`s.
//   - after `dir` / `title` the colon is an optional separator.
// So an edge cannot carry inline node styles; declare the node on its own line.

import type { ColorName, Direction, Edge, Graph, Group, Node, ParseOptions, ParseResult, ShapeKind, StyleFlag } from "./ast.js";
import { ParseError, didYouMean, makeError, makeWarning, nearest } from "./diagnostics.js";
import { Lexer } from "./lexer.js";
import { COLORS, DIRECTIONS, FLAGS, isColor, isFlag, type Token } from "./tokens.js";

interface Ref {
  id: string;
  line: number;
  col: number;
  shape?: { kind: ShapeKind; label: string; raw: string; line: number; col: number };
}

interface Style {
  color?: ColorName;
  flags: StyleFlag[];
}

const SHAPE_BRACKETS: Record<ShapeKind, [string, string]> = {
  rect: ["[", "]"],
  ellipse: ["(", ")"],
  diamond: ["{", "}"],
  cylinder: ["[(", ")]"],
};

const DIRECTION_ALIASES: Record<string, Direction> = { TB: "DOWN", TD: "DOWN", BT: "UP", LR: "RIGHT", RL: "LEFT" };

/** Splits on a literal `\n`, trims each piece; "" when nothing but whitespace remains. */
function labelText(raw: string): string {
  const parts = raw.split("\\n").map((p) => p.trim());
  return parts.every((p) => p === "") ? "" : parts.join("\n");
}

function describe(t: Token): string {
  if (t.kind === "NEWLINE") return "end of line";
  if (t.kind === "EOF") return "end of file";
  if (t.kind === "STRING") return `string ${t.raw}`;
  return `'${t.raw}'`;
}

class Parser {
  private readonly lex: Lexer;
  private look: Token | undefined;
  readonly graph: Graph = { nodes: [], edges: [], groups: [] };
  readonly diagnostics: ParseResult["diagnostics"] = [];
  private readonly nodes = new Map<string, Node>();
  private readonly groups = new Map<string, Group>();
  private readonly owner = new Map<string, string>(); // node id -> group id
  private readonly implicitWarn = new Map<string, ParseResult["diagnostics"][number]>();
  private readonly stack: Group[] = [];

  constructor(text: string) {
    this.lex = new Lexer(text);
  }

  // ---- token plumbing -------------------------------------------------

  private peek(): Token {
    return (this.look ??= this.lex.next());
  }

  private next(): Token {
    const t = this.peek();
    this.look = undefined;
    return t;
  }

  /** Throws the right error for an unexpected token (lexical errors win). */
  private fail(t: Token, expected: string, suggestion: string): never {
    if (t.kind === "ERROR" && t.error) throw new ParseError(t.error);
    throw new ParseError(makeError("expected-token", t.line, t.col, `expected ${expected}, found ${describe(t)}`, suggestion));
  }

  private err(code: Parameters<typeof makeError>[0], at: { line: number; col: number }, message: string, suggestion: string): never {
    throw new ParseError(makeError(code, at.line, at.col, message, suggestion));
  }

  private endStatement(): void {
    const t = this.peek();
    if (t.kind === "NEWLINE" || t.kind === "SEMI") this.next();
    else if (t.kind !== "EOF" && t.kind !== "RBRACE")
      this.fail(t, "end of line", `put one statement per line (or separate them with ';'), or add ',' for fan-out: a, b -> c`);
  }

  // ---- program ----------------------------------------------------------

  run(): void {
    for (;;) {
      const t = this.peek();
      if (t.kind === "EOF") break;
      if (t.kind === "NEWLINE" || t.kind === "SEMI") this.next();
      else if (t.kind === "RBRACE") {
        this.next();
        if (!this.stack.pop()) this.err("expected-token", t, "unexpected '}' with no open group", "remove the '}' or open a group first: group id \"Title\" {");
      } else this.statement();
    }
    const open = this.stack[this.stack.length - 1];
    if (open) {
      this.err("unclosed-group", open, `group '${open.id}' is never closed, reached end of file`, `add a '}' on its own line after the last statement of group '${open.id}'`);
    }
  }

  private statement(): void {
    const t = this.peek();
    if (t.kind !== "ID") this.fail(t, "a node id, 'group' or a directive", "start the line with a node id such as api[API], or write an edge: a -> b");
    const first = this.next();
    const nx = this.peek();
    const kw = first.value;
    if ((kw === "dir" || kw === "direction") && (nx.kind === "ID" || nx.kind === "COLON")) return this.direction(first);
    if (kw === "title" && (nx.kind === "STRING" || nx.kind === "COLON" || nx.kind === "ID")) return this.title(first);
    if (kw === "group" && nx.kind === "ID") return this.group(first);
    this.refStatement(first);
  }

  // ---- directives ----------------------------------------------------

  private topLevelOnly(kw: Token): void {
    if (this.stack.length)
      this.err("expected-token", kw, `'${kw.value}' is only allowed at the top level, found inside group '${(this.stack[this.stack.length - 1] as Group).id}'`, `move the '${kw.value}' line outside the group`);
  }

  private direction(kw: Token): void {
    this.topLevelOnly(kw);
    if (this.peek().kind === "COLON") this.next();
    const t = this.next();
    if (t.kind !== "ID") this.fail(t, "a direction (DOWN, RIGHT, UP or LEFT)", `${kw.value} RIGHT`);
    const up = t.value.toUpperCase();
    const dir = (DIRECTIONS as readonly string[]).includes(up) ? (up as Direction) : DIRECTION_ALIASES[up];
    if (!dir) {
      const hit = nearest(up, DIRECTIONS);
      this.err("unknown-direction", t, `unknown direction '${t.value}'`, hit ? `did you mean '${hit}'? valid directions: ${DIRECTIONS.join(", ")}` : `use one of ${DIRECTIONS.join(", ")}, e.g. ${kw.value} RIGHT`);
    }
    this.graph.direction = dir;
    this.endStatement();
  }

  private title(kw: Token): void {
    this.topLevelOnly(kw);
    if (this.peek().kind === "COLON") this.next();
    const t = this.next();
    if (t.kind !== "STRING") this.fail(t, "a quoted title string", 'title "Order pipeline"');
    if (t.value.trim() === "") this.err("empty-label", t, "title is empty", 'give it text: title "Order pipeline"');
    this.graph.title = t.value;
    this.endStatement();
  }

  // ---- groups ---------------------------------------------------------

  private group(kw: Token): void {
    const idTok = this.next();
    this.lex.groupHeader = true; // `{` now opens the body instead of a diamond label
    let title: string | undefined;
    if (this.peek().kind === "STRING") {
      const s = this.next();
      if (s.value.trim() === "") this.err("empty-label", s, `group '${idTok.value}' has an empty title`, `give it text: group ${idTok.value} "Title" {`);
      title = s.value;
    }
    let style: Style = { flags: [] };
    if (this.peek().kind === "COLON") {
      this.next();
      style = this.style();
    }
    const open = this.peek();
    if (open.kind !== "LBRACE") {
      this.lex.groupHeader = false;
      this.fail(open, `'{' to open group '${idTok.value}'`, `group ${idTok.value}${title ? ` "${title}"` : ""} {`);
    }
    this.next();
    if (this.groups.has(idTok.value) || this.nodes.has(idTok.value))
      this.err("duplicate-node", idTok, `'${idTok.value}' is already used as ${this.groups.has(idTok.value) ? "a group" : "a node"} id`, `pick a different group id, e.g. ${idTok.value}_group`);
    const g: Group = { id: idTok.value, flags: style.flags, children: [], groups: [], line: kw.line, col: kw.col };
    if (title !== undefined) g.title = title;
    if (style.color) g.color = style.color;
    this.stack[this.stack.length - 1]?.groups.push(g.id);
    this.groups.set(g.id, g);
    this.graph.groups.push(g);
    this.stack.push(g);
  }

  // ---- style -----------------------------------------------------------

  /** After ':' -> COLOR { "," FLAG }. A lone flag (`:dashed`) is accepted too. */
  private style(): Style {
    const out: Style = { flags: [] };
    const t = this.next();
    if (t.kind !== "ID") this.fail(t, "a color name after ':'", "style syntax is :color or :color,flag, e.g. :blue or :teal,dashed");
    if (isColor(t.value)) out.color = t.value;
    else if (isFlag(t.value)) out.flags.push(t.value);
    else {
      const hit = nearest(t.value, [...COLORS, ...FLAGS]);
      this.err("unknown-color", t, `unknown color '${t.value}'`, `${hit ? `did you mean '${hit}'? ` : ""}valid colors: ${COLORS.join(", ")}`);
    }
    while (this.peek().kind === "COMMA") {
      this.next();
      const f = this.next();
      if (f.kind !== "ID") this.fail(f, "a style flag after ','", `valid flags: ${FLAGS.join(", ")}`);
      if (isFlag(f.value)) {
        if (!out.flags.includes(f.value)) out.flags.push(f.value);
      } else if (isColor(f.value)) {
        this.err("unknown-flag", f, `'${f.value}' is a color, not a flag; only one color is allowed and it comes first`, `write the color first: :${f.value},${FLAGS[0]}`);
      } else this.err("unknown-flag", f, `unknown style flag '${f.value}'`, didYouMean(f.value, FLAGS, "flags"));
    }
    return out;
  }

  // ---- nodes and edges -------------------------------------------------

  private refs(first: Token | undefined, expected: string, suggestion: string): Ref[] {
    const out: Ref[] = [];
    let id = first;
    for (;;) {
      if (!id) {
        id = this.next();
        if (id.kind !== "ID") this.fail(id, expected, suggestion);
      }
      const ref: Ref = { id: id.value, line: id.line, col: id.col };
      if (this.peek().kind === "SHAPE") {
        const s = this.next();
        const kind = s.shape as ShapeKind;
        const [o, c] = SHAPE_BRACKETS[kind];
        const label = labelText(s.value);
        if (label === "") this.err("empty-label", s, `label of '${id.value}' is empty`, `give it text: ${id.value}${o}Label${c}`);
        ref.shape = { kind, label, raw: s.raw, line: s.line, col: s.col };
      }
      out.push(ref);
      if (this.peek().kind !== "COMMA") return out;
      this.next();
      id = undefined;
      expected = "a node id after ','";
      suggestion = `list nodes as a, b -> c`;
    }
  }

  private refStatement(first: Token): void {
    let left = this.refs(first, "", "");
    if (this.peek().kind !== "ARROW") {
      const only = left[0] as Ref;
      if (left.length === 1 && only.shape) {
        let style: Style | undefined;
        if (this.peek().kind === "COLON") {
          this.next();
          style = this.style();
        }
        this.declare(only, style);
        return this.endStatement();
      }
      const names = left.map((r) => r.id).join(", ");
      this.fail(
        this.peek(),
        left.length > 1 ? `an arrow after '${names}'` : `a label or an arrow after '${names}'`,
        left.length > 1 ? `${names} -> target` : `declare it: ${only.id}[Label]  or connect it: ${only.id} -> other`,
      );
    }
    let ids = left.map((r) => this.resolve(r));
    const made: Edge[] = [];
    while (this.peek().kind === "ARROW") {
      const arrow = this.next();
      const prev = left[left.length - 1] as Ref;
      const right = this.refs(undefined, `a node id after '${arrow.raw}'`, `add a target: ${prev.id} ${arrow.raw} next`);
      const to = right.map((r) => this.resolve(r));
      for (const from of ids)
        for (const target of to) {
          const e: Edge = { from, to: target, arrow: arrow.arrow ?? "solid", line: arrow.line, col: arrow.col };
          made.push(e);
          this.graph.edges.push(e);
        }
      left = right;
      ids = to;
    }
    if (this.peek().kind === "COLON") {
      this.next();
      const raw = this.lex.restOfLine();
      const text = labelText(raw.text);
      if (text === "") this.err("empty-label", raw, "edge label after ':' is empty", "add label text after ':' or drop the ':'");
      for (const e of made) e.label = text;
    }
    this.endStatement();
  }

  /** Declares (shape given) or references (bare id) a node; returns its id. */
  private resolve(ref: Ref): string {
    return ref.shape ? this.declare(ref).id : this.reference(ref).id;
  }

  private scopeCheck(id: string, at: { line: number; col: number }): void {
    if (this.groups.has(id))
      this.err("duplicate-node", at, `'${id}' is a group, not a node`, `use a different node id; groups cannot be connected, connect a node inside '${id}' instead`);
  }

  private join(node: Node): void {
    const scope = this.stack[this.stack.length - 1];
    if (scope && !this.owner.has(node.id)) {
      this.owner.set(node.id, scope.id);
      scope.children.push(node.id);
    }
  }

  private declare(ref: Ref, style?: Style): Node {
    const shape = ref.shape as NonNullable<Ref["shape"]>;
    this.scopeCheck(ref.id, ref);
    let node = this.nodes.get(ref.id);
    if (!node) {
      node = { id: ref.id, label: shape.label, shape: shape.kind, flags: [], line: ref.line, col: ref.col };
      this.nodes.set(node.id, node);
      this.graph.nodes.push(node);
    } else if (node.implicit) {
      // Declared after an edge used it: upgrade in place, drop the warning.
      node.label = shape.label;
      node.shape = shape.kind;
      node.line = ref.line;
      node.col = ref.col;
      delete node.implicit;
      const w = this.implicitWarn.get(node.id);
      const at = w ? this.diagnostics.indexOf(w) : -1;
      if (at >= 0) this.diagnostics.splice(at, 1);
    } else if (node.label !== shape.label || node.shape !== shape.kind) {
      const [o, c] = SHAPE_BRACKETS[node.shape];
      this.err(
        "duplicate-node",
        ref,
        `node '${ref.id}' is already declared as ${o}${node.label.replace(/\n/g, "\\n")}${c} at line ${node.line}, col ${node.col}`,
        `reference the existing node with just '${ref.id}', or use a different id for the new one`,
      );
    }
    this.join(node);
    if (style?.color) node.color = style.color;
    for (const f of style?.flags ?? []) if (!node.flags.includes(f)) node.flags.push(f);
    return node;
  }

  private reference(ref: Ref): Node {
    this.scopeCheck(ref.id, ref);
    const known = this.nodes.get(ref.id);
    if (known) return known;
    const node: Node = { id: ref.id, label: ref.id, shape: "rect", flags: [], implicit: true, line: ref.line, col: ref.col };
    this.nodes.set(node.id, node);
    this.graph.nodes.push(node);
    this.join(node);
    const w = makeWarning("implicit-node", ref.line, ref.col, `'${ref.id}' used before declaration; labelled with its id`, `declare it with a label: ${ref.id}[Label]`);
    this.implicitWarn.set(node.id, w);
    this.diagnostics.push(w);
    return node;
  }
}

export function parse(text: string, opts: ParseOptions = {}): ParseResult {
  void opts; // `file` is only for callers that format messages
  const p = new Parser(text);
  try {
    p.run();
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    p.diagnostics.push(e.diag);
  }
  return { graph: p.graph, diagnostics: p.diagnostics };
}
