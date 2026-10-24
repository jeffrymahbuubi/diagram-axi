// Token-tuned D2 native-syntax slices served by `syntax d2 <topic>` (wired by
// U6). Same Slice shape and SLICE_TOKEN_BUDGET as slices.ts; every `example`
// is complete D2 source. Syntax per the D2 docs (d2lang.com/tour).

import { emitBlock } from "../output/toon.js";
import { helpBlock } from "../output/suggest.js";
import type { Slice } from "./slices.js";

export const D2_SLICES: Slice[] = [
  {
    topic: "sequence",
    summary: "sequence_diagram: actors, messages, spans, notes, groups",
    rules: [
      "first line: shape: sequence_diagram; actors appear left to right in declaration order: alice; bob",
      "message: alice -> bob: text   reply: bob -> alice: text   self: bob -> bob: text",
      "span (activation bar): alice.a -> bob.a: call  then  bob.a -> alice.a: ok",
      'note: bob."text" (a shape with no arrows); group: name: { arrows inside }',
      "declare every actor at top level before any group; the layout engine is ignored",
    ],
    example: [
      "shape: sequence_diagram",
      "alice; bob; db",
      "alice.a -> bob.a: login",
      "bob.a -> db: lookup",
      "db -> bob.a: row",
      "bob.a -> alice.a: token",
      'bob."checks password"',
      "retry: {",
      "  alice -> bob: again",
      "}",
    ].join("\n"),
    help: ["$ draw login.d2 --png", "$ syntax d2 class", "$ syntax mermaid state"],
  },
  {
    topic: "class",
    summary: "class shape: fields, methods, visibility",
    rules: [
      "x: { shape: class } then one row per member; a field's value is its type",
      "a key containing ( is a method and its value is the return type; no value means void",
      "visibility prefix: + public (default), - private, # protected (quote it: \"#audit()\" — a bare # starts a comment)",
      "method params without colons: +login(pw string): bool",
      "wrap a reserved word in quotes: \"label\": string",
      "relations are plain arrows between class ids: Admin -> User: extends",
    ],
    example: [
      "User: {",
      "  shape: class",
      "  +id: int",
      "  -email: string",
      "  +login(pw string): bool",
      "  \"#audit()\": void",
      "}",
      "Admin: {",
      "  shape: class",
      "  +grant(u User): void",
      "}",
      "Admin -> User: extends",
    ].join("\n"),
    help: ["$ draw model.d2 --png", "$ syntax d2 erd", "$ syntax d2 style"],
  },
  {
    topic: "erd",
    summary: "sql_table: columns, constraints, foreign keys",
    rules: [
      "x: { shape: sql_table } then one row per column: name: type",
      "constraint: { constraint: primary_key } shows PK; foreign_key shows FK; unique shows UNQ",
      "several: { constraint: [primary_key; unique] }",
      "relation: table.column -> table.column; elk and tala route to the exact row",
      "table names are ids; use a label (users: Users) only when they differ",
    ],
    example: [
      "users: {",
      "  shape: sql_table",
      "  id: int {constraint: primary_key}",
      "  email: varchar {constraint: unique}",
      "}",
      "orders: {",
      "  shape: sql_table",
      "  id: int {constraint: primary_key}",
      "  user_id: int {constraint: foreign_key}",
      "  total: decimal",
      "}",
      "orders.user_id -> users.id",
    ].join("\n"),
    help: ["$ draw schema.d2 --png --layout elk", "$ syntax d2 class", "$ syntax d2 style"],
  },
  {
    topic: "style",
    summary: "layout engines, sketch, near, style keys",
    rules: [
      "layout: --layout dagre|elk|tala on draw (tala needs the optional d2 binary and its plugin)",
      "in the file: vars: { d2-config: { layout-engine: elk; sketch: true } } (flags beat the file)",
      "near: title: Orders { near: top-center } (constants like bottom-right work on every layout; near another object only on tala)",
      "style.fill: \"#e7f5ff\"  style.stroke: \"#1971c2\"  style.stroke-dash: 5  style.border-radius: 8  style.bold: true",
      "direction: right (or down up left) at top level; shape: cylinder|diamond|cloud|person|hexagon",
    ],
    example: [
      "vars: {",
      "  d2-config: {",
      "    layout-engine: elk",
      "    sketch: true",
      "  }",
      "}",
      "direction: right",
      "title: Orders {",
      "  near: top-center",
      "  shape: text",
      "}",
      "api: API {style.fill: \"#e7f5ff\"}",
      "db: Orders DB {",
      "  shape: cylinder",
      "  style.stroke-dash: 5",
      "}",
      "api -> db: SQL",
    ].join("\n"),
    help: ["$ draw x.d2 --png --layout tala", "$ syntax d2 example", "$ syntax d2 sequence"],
  },
  {
    topic: "example",
    summary: "a complete D2 diagram to copy",
    rules: ["save as order.d2, then: $ draw order.d2 --png  (writes order.svg and order.png beside it; the .d2 is never rewritten)"],
    example: [
      "direction: right",
      "edge: Edge {",
      "  web: Web app",
      "  mobile: Mobile app",
      "}",
      "api: API Gateway",
      "edge.web -> api: HTTPS",
      "edge.mobile -> api: HTTPS",
      "api -> orders: Order svc",
      "orders -> db: SQL",
      "db: Orders DB {shape: cylinder}",
      "api -> cache: read-through {style.stroke-dash: 4}",
      "cache: Redis {shape: cylinder}",
    ].join("\n"),
    help: ["$ draw order.d2 --png", "$ check order.d2", "$ syntax d2 style"],
  },
];

export const D2_TOPICS: string[] = D2_SLICES.map((s) => s.topic);

function withTool(lines: string[], tool: string): string[] {
  return lines.map((l) => l.replace(/\$ /g, tool + " "));
}

/** Render one native-engine slice (shared by d2 and mermaid): rules, example, help[]. */
export function renderNativeSlice(engine: string, s: Slice, tool: string): string {
  const parts = [`syntax: ${[engine, s.topic].filter(Boolean).join(" ")}, ${s.summary}`, emitBlock("rules", withTool(s.rules, tool))];
  if (s.example) parts.push(["example:", ...withTool(s.example.split("\n"), tool).map((l) => "  " + l)].join("\n"));
  parts.push(helpBlock(withTool(s.help, tool)));
  return parts.join("\n");
}

/** One D2 slice, or undefined for an unknown topic. */
export function renderD2Slice(topic: string, tool: string): string | undefined {
  const s = D2_SLICES.find((x) => x.topic === topic);
  return s ? renderNativeSlice("d2", s, tool) : undefined;
}
