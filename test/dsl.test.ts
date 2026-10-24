import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Diagnostic, Graph } from "../src/dsl/ast.js";
import { parse } from "../src/dsl/parser.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const edges = (g: Graph) => g.edges.map((e) => `${e.from}${e.label ? `(${e.label})` : ""}>${e.to}`);
const ok = (text: string) => {
  const r = parse(text);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r;
};

describe("fixtures parse", () => {
  it("arch.exd", () => {
    const { graph, diagnostics } = parse(fixture("arch.exd"));
    expect(diagnostics).toEqual([]);
    expect(graph.direction).toBe("RIGHT");
    expect(graph.title).toBe("Order pipeline");
    expect(graph.nodes.map((n) => [n.id, n.shape, n.label])).toEqual([
      ["web", "rect", "Web app"],
      ["mobile", "rect", "Mobile app"],
      ["api", "rect", "API Gateway"],
      ["auth", "diamond", "Auth?"],
      ["orders", "rect", "Order svc"],
      ["db", "cylinder", "Orders DB"],
      ["cache", "cylinder", "Redis"],
    ]);
    expect(graph.nodes.find((n) => n.id === "api")?.color).toBe("purple");
    expect(graph.nodes.some((n) => n.implicit)).toBe(false);
    expect(graph.edges.map((e) => [e.from, e.to, e.arrow, e.label])).toEqual([
      ["web", "api", "solid", "HTTPS"],
      ["mobile", "api", "solid", "HTTPS"],
      ["api", "auth", "solid", "JWT"],
      ["auth", "api", "dashed", "401"],
      ["api", "orders", "solid", undefined],
      ["orders", "db", "solid", undefined],
      ["api", "cache", "dotted", "read-through"],
    ]);
    expect(graph.groups).toEqual([
      { id: "edge", title: "Edge", color: "blue", flags: [], children: ["web", "mobile"], groups: [], line: 3, col: 1 },
    ]);
    // positions are 1-based and point at the id / arrow
    expect(graph.nodes.find((n) => n.id === "auth")).toMatchObject({ line: 9, col: 8 });
    expect(graph.edges[0]).toMatchObject({ line: 8, col: 13 });
  });

  it("pipeline.exd", () => {
    const { graph, diagnostics } = parse(fixture("pipeline.exd"));
    expect(diagnostics).toEqual([]);
    expect(graph.direction).toBeUndefined();
    expect(graph.title).toBe("CI pipeline");
    expect(graph.nodes.map((n) => n.id)).toEqual(["commit", "build", "test", "deploy", "prod", "lint", "report", "notes"]);
    expect(graph.nodes.find((n) => n.id === "build")?.label).toBe("Build\nimage");
    expect(graph.nodes.find((n) => n.id === "test")?.shape).toBe("ellipse");
    expect(graph.nodes.find((n) => n.id === "lint")?.color).toBe("teal");
    expect(graph.nodes.find((n) => n.id === "report")).toMatchObject({ color: "orange", flags: ["dashed"] });
    expect(edges(graph)).toEqual([
      "commit>build",
      "build>test",
      "test>deploy",
      "deploy>prod",
      "lint>build",
      "test>report",
      "build(see #42)>notes",
    ]);
    expect(graph.edges.find((e) => e.to === "report")?.arrow).toBe("both");
    expect(graph.edges.find((e) => e.to === "notes")?.arrow).toBe("line");
  });

  it("flow.exd", () => {
    const { graph, diagnostics } = parse(fixture("flow.exd"));
    expect(diagnostics).toEqual([]);
    expect(graph.direction).toBe("DOWN");
    expect(graph.nodes).toHaveLength(5);
    expect(graph.nodes.find((n) => n.id === "check")).toMatchObject({ shape: "diamond", color: "yellow", flags: ["bold"] });
    expect(edges(graph)).toEqual(["start>check", "check(yes)>process", "check(no)>reject", "process>done", "reject>done"]);
    expect(graph.edges[2]?.arrow).toBe("dashed");
  });

  it("nested-groups.exd", () => {
    const { graph, diagnostics } = parse(fixture("nested-groups.exd"));
    expect(diagnostics).toEqual([]);
    expect(graph.direction).toBe("LEFT");
    const g = Object.fromEntries(graph.groups.map((x) => [x.id, x]));
    expect(graph.groups.map((x) => x.id)).toEqual(["cloud", "app", "cache", "data"]);
    expect(g.cloud).toMatchObject({ title: "Cloud", color: "blue", children: ["lb"], groups: ["app", "data"] });
    expect(g.app).toMatchObject({ color: "green", flags: ["dashed"], children: ["api", "worker"], groups: ["cache"] });
    expect(g.cache).toMatchObject({ children: ["redis"], groups: [] });
    expect(g.data).toMatchObject({ color: "purple", children: ["db"], groups: [] });
    expect(graph.nodes.map((n) => n.id)).toEqual(["lb", "api", "worker", "redis", "db", "user"]);
    expect(edges(graph)).toEqual(["user>lb", "lb>api", "api>redis", "api>db", "worker>db"]);
  });
});

describe("statements", () => {
  it("fan-out in both directions", () => {
    expect(edges(ok("a, b -> c").graph)).toEqual(["a>c", "b>c"]);
    expect(edges(ok("a -> b, c").graph)).toEqual(["a>b", "a>c"]);
    expect(edges(ok("a, b -> c, d").graph)).toEqual(["a>c", "a>d", "b>c", "b>d"]);
  });

  it("a chain of 3 gives 2 edges, of 4 gives 3", () => {
    expect(edges(ok("a -> b -> c").graph)).toEqual(["a>b", "b>c"]);
    expect(ok("a -> b -> c -> d").graph.edges).toHaveLength(3);
  });

  it("each arrow kind", () => {
    const r = ok("a -> b --> c -- d <-> e -.-> f");
    expect(r.graph.edges.map((e) => e.arrow)).toEqual(["solid", "dashed", "line", "both", "dotted"]);
  });

  it("arrows and hyphenated ids need no spaces", () => {
    expect(edges(ok("a->b-->c").graph)).toEqual(["a>b", "b>c"]);
    expect(edges(ok("web-app-->db-1").graph)).toEqual(["web-app>db-1"]);
  });

  it("a label applies to every edge of the statement", () => {
    expect(edges(ok("a, b -> c -> d : go").graph)).toEqual(["a(go)>c", "b(go)>c", "c(go)>d"]);
  });

  it("literal \\n in labels becomes a newline", () => {
    const { graph } = ok("a[Line one\\nLine two]\nb(x \\n y) -> c : up\\ndown");
    expect(graph.nodes[0]?.label).toBe("Line one\nLine two");
    expect(graph.nodes[1]?.label).toBe("x\ny");
    expect(graph.edges[0]?.label).toBe("up\ndown");
  });

  it("all four shapes", () => {
    const { graph } = ok("a[R]\nb(E)\nc{D}\nd[(C)]");
    expect(graph.nodes.map((n) => n.shape)).toEqual(["rect", "ellipse", "diamond", "cylinder"]);
  });

  it("[(text) more] is a rect when no )] closes it", () => {
    const n = ok("a[(draft) notes]").graph.nodes[0];
    expect(n).toMatchObject({ shape: "rect", label: "(draft) notes" });
  });

  it("comments, blank lines, semicolons, CRLF and BOM", () => {
    const text = "﻿a[A]; b[B] # trailing\r\n\r\n# top\r\na -> b : x # note\r\n";
    const { graph } = ok(text);
    expect(graph.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(graph.edges[0]?.label).toBe("x");
    expect(graph.nodes[0]).toMatchObject({ line: 1, col: 1 }); // BOM is not counted
    expect(graph.edges[0]).toMatchObject({ line: 4, col: 3 });
  });

  it("quoted edge labels may contain # and ;", () => {
    expect(ok('a -> b : "issue #5; fixed"').graph.edges[0]?.label).toBe("issue #5; fixed");
  });

  it("colon rule: edge colon is a label, node colon is a style", () => {
    const { graph } = ok("a[A] :red,bold\nb[B]\na -> b :blue");
    expect(graph.nodes[0]).toMatchObject({ color: "red", flags: ["bold"] });
    expect(graph.edges[0]?.label).toBe("blue");
    expect(graph.nodes[1]?.color).toBeUndefined();
  });

  it("directives accept an optional colon, and mixed case", () => {
    expect(ok("dir RIGHT").graph.direction).toBe("RIGHT");
    expect(ok("direction: up").graph.direction).toBe("UP");
    expect(ok("title: \"T\"").graph.title).toBe("T");
    expect(ok("dir TB").graph.direction).toBe("DOWN");
  });

  it("keywords stay usable as node ids", () => {
    const { graph } = ok("title[Title]\ngroup[G] -> dir");
    expect(graph.nodes.map((n) => n.id)).toEqual(["title", "group", "dir"]);
  });

  it("redeclaring identically is fine and a bare style updates the node", () => {
    const { graph } = ok("a[A]\na[A] :green\na -> a");
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.color).toBe("green");
    expect(edges(graph)).toEqual(["a>a"]);
  });
});

describe("groups", () => {
  it("single-line group with adjacent brace and diamond inside", () => {
    const { graph } = ok('group g{ a{Q?}; b[B] }\ngroup h "H" :pink { c[C] }');
    expect(graph.groups.map((g) => [g.id, g.title, g.color, g.children])).toEqual([
      ["g", undefined, undefined, ["a", "b"]],
      ["h", "H", "pink", ["c"]],
    ]);
    expect(graph.nodes[0]?.shape).toBe("diamond");
  });

  it("nodes created implicitly inside a group join it; existing ones do not move", () => {
    const { graph } = parse("x[X]\ngroup g {\n x -> y\n}\n");
    expect(graph.groups[0]?.children).toEqual(["y"]);
  });
});

describe("warnings", () => {
  it("AE4: undeclared edge endpoint becomes an implicit node with a warning", () => {
    const r = parse("a[A] -> b\n");
    expect(r.graph.nodes.find((n) => n.id === "b")).toMatchObject({ label: "b", shape: "rect", implicit: true, line: 1, col: 9 });
    expect(r.diagnostics).toEqual([
      {
        line: 1,
        col: 9,
        code: "implicit-node",
        severity: "warning",
        message: "'b' used before declaration; labelled with its id",
        suggestion: "declare it with a label: b[Label]",
      },
    ]);
  });

  it("an implicit node is reported once, and not at all when declared later", () => {
    expect(parse("a -> b\nb -> a").diagnostics.map((d) => d.code)).toEqual(["implicit-node", "implicit-node"]);
    const r = parse("a[A] -> b\nb[Bee] :red");
    expect(r.diagnostics).toEqual([]);
    expect(r.graph.nodes[1]).toMatchObject({ id: "b", label: "Bee", color: "red", line: 2, col: 1 });
    expect(r.graph.nodes[1]?.implicit).toBeUndefined();
  });
});

type Expect = { code: Diagnostic["code"]; line: number; col: number; message: string; suggestion: string };
const errorCases: [string, Expect][] = [
  [
    "unclosed-label.exd", // AE2
    { code: "expected-token", line: 4, col: 9, message: "expected ']' to close label, found '->'", suggestion: "close the label: api[API] -> db" },
  ],
  [
    "duplicate-node.exd",
    {
      code: "duplicate-node",
      line: 3,
      col: 1,
      message: "node 'a' is already declared as [A] at line 1, col 1",
      suggestion: "reference the existing node with just 'a', or use a different id for the new one",
    },
  ],
  [
    "unknown-color.exd",
    { code: "unknown-color", line: 1, col: 11, message: "unknown color 'blu'", suggestion: "did you mean 'blue'? valid colors: blue, green, orange, purple, red, yellow, teal, pink" },
  ],
  [
    "unknown-flag.exd",
    { code: "unknown-flag", line: 1, col: 16, message: "unknown style flag 'dash'", suggestion: "did you mean 'dashed'? valid flags: dashed, dotted, bold, sketchy" },
  ],
  [
    "unknown-direction.exd",
    { code: "unknown-direction", line: 1, col: 5, message: "unknown direction 'SIDEWAYS'", suggestion: "use one of DOWN, RIGHT, UP, LEFT, e.g. dir RIGHT" },
  ],
  [
    "empty-label.exd",
    { code: "empty-label", line: 2, col: 2, message: "label of 'b' is empty", suggestion: "give it text: b[Label]" },
  ],
  [
    "unclosed-group.exd",
    {
      code: "unclosed-group",
      line: 1,
      col: 1,
      message: "group 'g' is never closed, reached end of file",
      suggestion: "add a '}' on its own line after the last statement of group 'g'",
    },
  ],
  [
    "missing-target.exd",
    { code: "expected-token", line: 2, col: 5, message: "expected a node id after '->', found end of line", suggestion: "add a target: c -> next" },
  ],
  [
    "two-statements.exd",
    {
      code: "expected-token",
      line: 2,
      col: 6,
      message: "expected end of line, found 'c'",
      suggestion: "put one statement per line (or separate them with ';'), or add ',' for fan-out: a, b -> c",
    },
  ],
];

describe("errors", () => {
  it.each(errorCases)("%s", (file, want) => {
    const { diagnostics } = parse(fixture(`errors/${file}`));
    const last = diagnostics[diagnostics.length - 1];
    expect(last).toEqual({ ...want, severity: "error" });
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(1);
  });

  it("every error has a concrete suggestion and parsing stops at the first one", () => {
    const { graph, diagnostics } = parse("a[A]\nb[B -> c\nd[D]\ne[");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(2);
    expect(graph.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  const inline: [string, string, Partial<Diagnostic>][] = [
    ["unclosed label at end of line", "a(Hello", { col: 8, message: "expected ')' to close label, found end of line", suggestion: "close the label: a(Hello)" }],
    ["unclosed cylinder", "  db[(Orders -> x", { col: 14, message: "expected ')]' to close label, found '->'", suggestion: "close the label: db[(Orders)] -> x" }],
    ["unclosed diamond", "a{Ok? --> b", { col: 7, message: "expected '}' to close label, found '-->'" }],
    ["unclosed string", 'title "Oops', { col: 12, suggestion: 'close the string: title "Oops"' }],
    ["unexpected character", "a -> b @", { col: 8, message: "unexpected character '@'" }],
    ["lone dash", "a - b", { col: 3, message: "unexpected character '-'" }],
    ["bare id", "lonely", { code: "expected-token", message: "expected a label or an arrow after 'lonely', found end of file" }],
    ["fan-out without arrow", "a, b", { message: "expected an arrow after 'a, b', found end of file", suggestion: "a, b -> target" }],
    ["trailing comma", "a, -> b", { col: 4, message: "expected a node id after ',', found '->'" }],
    ["title without quotes", "title Hello", { col: 7, message: "expected a quoted title string, found 'Hello'", suggestion: 'title "Order pipeline"' }],
    ["empty title", 'title ""', { code: "empty-label", col: 7 }],
    ["missing direction", "dir:", { message: "expected a direction (DOWN, RIGHT, UP or LEFT), found end of file" }],
    ["empty edge label", "a -> b :", { code: "empty-label", col: 9, suggestion: "add label text after ':' or drop the ':'" }],
    ["color where flag expected", "a[A] :blue,red", { code: "unknown-flag", col: 12 }],
    ["style without color", "a[A] :", { code: "expected-token", message: "expected a color name after ':', found end of file" }],
    ["missing group brace", 'group g "G"\n', { message: "expected '{' to open group 'g', found end of line", suggestion: 'group g "G" {' }],
    ["stray close brace", "a[A]\n}", { line: 2, col: 1, message: "unexpected '}' with no open group" }],
    ["directive inside group", "group g {\n dir UP\n}", { line: 2, col: 2, message: "'dir' is only allowed at the top level, found inside group 'g'" }],
    ["group id reused", "group g {\n}\ngroup g {\n}", { code: "duplicate-node", line: 3, col: 7 }],
    ["node id equals group id", "group g {\n}\ng[G]", { code: "duplicate-node", line: 3, col: 1, message: "'g' is a group, not a node" }],
    ["edge to a group", "group g {\n}\na[A] -> g", { code: "duplicate-node", line: 3, col: 9 }],
    ["shape without id", "[Web] -> x", { col: 1, message: "expected a node id, 'group' or a directive, found '[Web]'" }],
    ["redeclare with another shape", "a{Q}\na[Q]", { code: "duplicate-node", line: 2, col: 1 }],
  ];
  it.each(inline)("%s", (_name, text, want) => {
    const { diagnostics } = parse(text);
    const last = diagnostics[diagnostics.length - 1] as Diagnostic;
    expect(last.severity).toBe("error");
    expect(last.suggestion).toBeTruthy();
    expect(last).toMatchObject({ code: "expected-token", line: 1, ...want });
  });
});
