// Token-tuned DSL reference slices served by `syntax [topic]` and embedded in
// SKILL.md. Each slice (rendered, including its help[] block) stays under
// SLICE_TOKEN_BUDGET tokens, estimated as chars/4; test/guide.test.ts enforces
// the budget and that every `example` parses without diagnostics. The rules
// describe what src/dsl/parser.ts actually does; keep them in sync.

import { emitBlock, emitList } from "../output/toon.js";
import { helpBlock } from "../output/suggest.js";

export const SLICE_TOKEN_BUDGET = 350;

export interface Slice {
  topic: string;
  summary: string;
  rules: string[];
  /** Complete, parseable DSL (one string, newline separated). */
  example?: string;
  /** Next-step commands; `$` stands for the tool prefix. */
  help: string[];
}

export const SLICES: Slice[] = [
  {
    topic: "nodes",
    summary: "ids, shapes, labels",
    rules: [
      "id[Label] rectangle | id(Label) ellipse | id{Label} diamond | id[(Label)] cylinder (database)",
      "ids: letters, digits, _ ; declare a node once, then reuse the bare id in edges",
      "\\n inside a label is a line break; labels are one line of source",
      "an id first seen in an edge becomes a rectangle labelled with its id (warning implicit-node)",
      "redeclaring an id with another label or shape is an error",
    ],
    example: ["web[Web app]", "api(API\\nGateway)", "auth{Valid?}", "db[(Orders DB)]"].join("\n"),
    help: ["$ syntax edges", "$ syntax style", "$ check <file.exd>"],
  },
  {
    topic: "edges",
    summary: "arrows, labels, chains, fan-out",
    rules: [
      "a -> b solid | a --> b dashed | a -.-> b dotted | a -- b plain line | a <-> b both heads",
      "label: ':' ends the arrows, the rest of the line is the label: a -> b : HTTPS",
      'unquoted, # starts a comment; quote a label to keep it: a -> b : "issue #5". A label applies to every edge of its statement',
      "chain: a -> b -> c makes 2 edges; fan-out: a, b -> c, d makes 4 edges",
      "nodes can be declared inline: api -> db[(DB)]; edges take no color, declare the node on its own line",
    ],
    example: ["api[API]", "web[Web], mobile[Mobile] -> api : HTTPS", "api -> auth{Auth?} -> db[(DB)]", "auth --> api : 401", "api -.-> cache[(Redis)]"].join("\n"),
    help: ["$ syntax groups", "$ syntax style", "$ check <file.exd>"],
  },
  {
    topic: "groups",
    summary: "zones around nodes, nesting",
    rules: [
      'group id "Title" :color,flag {   ...   }   (the closing } goes on its own line)',
      "nodes declared between the braces sit inside the zone; title and style are optional",
      "groups nest; keep nesting to 2 levels (check warns deeper)",
      "a node or group belongs to one group; node and group ids share one namespace",
      "groups cannot be edge ends: connect a node inside them",
    ],
    example: ['group cloud "Cloud" :blue {', "  api[API]", '  group data "Data" :green,dashed {', "    db[(Postgres)]", "  }", "}", "user(User) -> api -> db"].join("\n"),
    help: ["$ syntax style", "$ syntax example", "$ draw <file.exd> --png"],
  },
  {
    topic: "style",
    summary: "colors, flags, direction, title, comments",
    rules: [
      "node or group style: ':color' then ',flag's; a node's style goes on its own line: api[API] :purple,bold",
      "colors: blue green orange purple red yellow teal pink; uncolored nodes are light blue, cylinders teal",
      "flags: dashed dotted bold sketchy (one color max, color first; ':dashed' alone is fine)",
      "dir RIGHT sets the layout (DOWN UP LEFT; aliases TB TD BT LR RL) and beats --direction",
      'title "Text" adds a heading; both are top-level lines, ":" after dir/title is optional',
      "# starts a comment; ';' separates statements on one line",
    ],
    example: ['title "Checkout"', "dir LR", "cart[Cart] :orange", "pay{Paid?} :yellow,bold", "ship(Ship) :green,dashed", "cart -> pay -> ship; pay --> cart : no  # retry"].join("\n"),
    help: ["$ syntax example", "$ syntax groups", "$ draw <file.exd> --png"],
  },
  {
    topic: "tips",
    summary: "limits that keep layouts clean",
    rules: [
      "<= 2 arrows per node pair: merge with \\n labels, a -> b : first\\nsecond",
      "<= 8 arrows on one node: group or split. Diamonds are for decisions only, <= 4 arrows",
      "edge labels <= 3 words; one a <-> b for a request/response pair with the same label",
      "node labels <= 40 chars per line (break with \\n); groups nest 2 deep",
      "<= ~25 nodes per diagram: split into overview + detail",
      "dir RIGHT for pipelines and architecture, dir DOWN for flowcharts and trees",
      "check and draw print warnings and a quality: line with fixes; apply them, rerun",
    ],
    example: ["dir RIGHT", "web[Web] -> api[API] : HTTPS", "api <-> db[(DB)] : SQL", "api -> jobs[Queue] : enqueue\\nretry", "jobs -> worker[Worker]"].join("\n"),
    help: ["$ check <file.exd>", "$ syntax example"],
  },
  {
    topic: "example",
    summary: "a complete diagram to copy",
    rules: ["save as order.exd, then: $ draw order.exd --png  (writes order.excalidraw and order.png)"],
    example: [
      'title "Order pipeline"',
      "dir RIGHT",
      'group edge "Edge" :blue {',
      "  web[Web app]",
      "  mobile[Mobile app]",
      "}",
      "api[API Gateway] :purple",
      "web, mobile -> api : HTTPS",
      "api -> auth{Auth?} : JWT",
      "auth --> api : 401",
      "api -> orders[Order svc] -> db[(Orders DB)]",
      "api -.-> cache[(Redis)] : read-through",
    ].join("\n"),
    help: ["$ draw <file.exd> --png", "$ check <file.exd>", "$ syntax edges"],
  },
];

export const TOPICS: string[] = SLICES.map((s) => s.topic);

const INDEX_COVERS: Record<string, string> = {
  nodes: "shapes [] () {} [()], ids, labels",
  edges: "arrows, labels, chains, fan-out",
  groups: "zones and nesting",
  style: "colors, flags, dir, title, comments",
  tips: "limits that keep layouts clean",
  example: "a complete diagram to copy",
};

function withTool(lines: string[], tool: string): string[] {
  return lines.map((l) => l.replace(/\$ /g, tool + " "));
}

function indent(text: string): string[] {
  return text.split("\n").map((l) => "  " + l);
}

/** The topic index (printed by `syntax` with no topic). */
export function renderIndex(tool: string): string {
  const rows = SLICES.map((s) => ({ topic: s.topic, covers: INDEX_COVERS[s.topic] ?? s.summary }));
  return [
    "syntax: exd, a boxes-and-arrows text DSL; one statement per line",
    emitList("topics", rows, ["topic", "covers"]),
    helpBlock([`${tool} syntax example`, `${tool} syntax nodes`, `${tool} draw <file.exd> --png`]),
  ].join("\n");
}

/** One slice, ending with help[] next steps. Returns undefined for an unknown topic. */
export function renderSlice(topic: string, tool: string): string | undefined {
  if (topic === "index") return renderIndex(tool);
  const s = SLICES.find((x) => x.topic === topic);
  if (!s) return undefined;
  const parts = [`syntax: ${s.topic}, ${s.summary}`, emitBlock("rules", withTool(s.rules, tool))];
  if (s.example) parts.push(["example:", ...indent(s.example)].join("\n"));
  parts.push(helpBlock(withTool(s.help, tool)));
  return parts.join("\n");
}
