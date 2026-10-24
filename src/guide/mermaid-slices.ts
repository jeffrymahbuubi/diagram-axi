// Token-tuned Mermaid 12 native-syntax slices served by `syntax mermaid <topic>`
// (wired by U6). Same Slice shape and budget as slices.ts; every `example` is
// complete Mermaid source. Syntax per mermaid.js.org/syntax.

import type { Slice } from "./slices.js";
import { renderNativeSlice } from "./d2-slices.js";

export const MERMAID_SLICES: Slice[] = [
  {
    topic: "state",
    summary: "stateDiagram-v2: states, transitions, composites, choice",
    rules: [
      "first line: stateDiagram-v2; [*] is start and end; transition: A --> B: label",
      'name a state: Idle: Waiting for work   or   state "Long name" as s1',
      "composite: state Active { [*] --> Run  Run --> [*] }; fork/join/choice: state c <<choice>>",
      "note: note right of A : text (left or right)",
      "ids are single words; transition labels follow the colon",
    ],
    example: [
      "stateDiagram-v2",
      "  [*] --> Idle",
      "  Idle --> Active: start",
      "  state Active {",
      "    [*] --> Running",
      "    Running --> Paused: pause",
      "    Paused --> Running: resume",
      "  }",
      "  state ok <<choice>>",
      "  Active --> ok: finish",
      "  ok --> Done: passed",
      "  ok --> Idle: failed",
      "  Done --> [*]",
      "  note right of Idle : waits for a job",
    ].join("\n"),
    help: ["$ draw machine.mmd --png", "$ syntax mermaid timeline", "$ syntax mermaid example"],
  },
  {
    topic: "timeline",
    summary: "timeline: periods, events, sections",
    rules: [
      "first line: timeline; optional title Text; each row is: period : event",
      "several events: period : event one : event two (or a following line starting with a colon)",
      "section Name groups the periods after it and shares one color; <br> breaks a line",
      "periods and events are free text; every row needs at least one event",
    ],
    example: [
      "timeline",
      "  title Product history",
      "  section Build",
      "    2023 : Prototype : Seed round",
      "    2024 : Beta launch",
      "  section Grow",
      "    2025 : 1.0 release<br>10k users",
      "         : Series A",
    ].join("\n"),
    help: ["$ draw history.mmd --png", "$ syntax mermaid gitgraph", "$ syntax mermaid mindmap"],
  },
  {
    topic: "gitgraph",
    summary: "gitGraph: commits, branches, merges, tags",
    rules: [
      "first line: gitGraph; ALWAYS give commits an explicit id: commit id: \"c1\" (auto ids are random, renders differ)",
      "branch dev (switches to it), checkout main, merge dev id: \"m1\" tag: \"v1.0\"",
      "commit options: id: \"x\" tag: \"v1\" type: NORMAL|REVERSE|HIGHLIGHT",
      "cherry-pick id: \"c2\" (commit must be on another branch; a merge commit also needs parent: \"id\")",
      "keep ids unique, quoted, and branch names free of spaces",
    ],
    example: [
      "gitGraph",
      '  commit id: "c1"',
      '  commit id: "c2"',
      "  branch dev",
      '  commit id: "d1"',
      '  commit id: "d2" type: HIGHLIGHT',
      "  checkout main",
      '  commit id: "c3"',
      '  merge dev id: "m1" tag: "v1.0"',
      '  commit id: "c4" type: REVERSE',
    ].join("\n"),
    help: ["$ draw flow.mmd --png", "$ syntax mermaid mindmap", "$ syntax mermaid example"],
  },
  {
    topic: "mindmap",
    summary: "mindmap: indentation tree, node shapes",
    rules: [
      "first line: mindmap; the hierarchy is the indentation (spaces only, one root)",
      "default shape is plain text; id[square] id(rounded) id((circle)) id))bang(( id)cloud( id{{hexagon}}",
      "root((Text)) is the usual circle root; give shaped nodes a short id first",
      "one idea per line, no arrows; keep <= 3 levels and <= 6 children per node",
    ],
    example: [
      "mindmap",
      "  root((Launch))",
      "    Product",
      "      Docs",
      "      Pricing[Pricing page]",
      "    Marketing",
      "      Blog",
      "      Events(Meetups)",
      "    Support{{On call}}",
    ].join("\n"),
    help: ["$ draw plan.mmd --png", "$ syntax mermaid state", "$ syntax mermaid example"],
  },
  {
    topic: "example",
    summary: "a complete Mermaid diagram to copy",
    rules: ["save as login.mmd, then: $ draw login.mmd --png  (writes login.svg and login.png beside it; the .mmd is never rewritten)"],
    example: [
      "stateDiagram-v2",
      "  [*] --> SignedOut",
      "  SignedOut --> Checking: submit",
      "  Checking --> SignedIn: valid",
      "  Checking --> SignedOut: invalid",
      "  SignedIn --> SignedOut: logout",
      "  SignedIn --> [*]",
    ].join("\n"),
    help: ["$ draw login.mmd --png", "$ check login.mmd", "$ syntax mermaid gitgraph"],
  },
];

export const MERMAID_TOPICS: string[] = MERMAID_SLICES.map((s) => s.topic);

/** One Mermaid slice, or undefined for an unknown topic. */
export function renderMermaidSlice(topic: string, tool: string): string | undefined {
  const s = MERMAID_SLICES.find((x) => x.topic === topic);
  return s ? renderNativeSlice("mermaid", s, tool) : undefined;
}
