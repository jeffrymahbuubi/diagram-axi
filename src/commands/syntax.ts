// `syntax [engine] [topic]`: token-tuned reference slices. `exd` is implied, so `syntax nodes` keeps
// working; `syntax d2 erd`, `syntax mermaid state` and `syntax routing` serve the native engines (U5).

import type { CommandModule } from "../cli/router.js";
import { D2_TOPICS, renderD2Slice } from "../guide/d2-slices.js";
import { MERMAID_TOPICS, renderMermaidSlice } from "../guide/mermaid-slices.js";
import { renderExtractSlice } from "../guide/extract-slice.js";
import { renderRoutingSlice } from "../guide/routing-slice.js";
import { TOPICS, renderSlice } from "../guide/slices.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";

const TOOL = "diagram-axi";

const NATIVE: Record<string, { topics: string[]; render: (topic: string, tool: string) => string | undefined; covers: string }> = {
  d2: { topics: D2_TOPICS, render: renderD2Slice, covers: "sequence, class and erd diagrams, style, layouts" },
  mermaid: { topics: MERMAID_TOPICS, render: renderMermaidSlice, covers: "state, timeline, gitgraph and mindmap diagrams" },
};

/** The `syntax d2` / `syntax mermaid` index. */
function nativeIndex(engine: string): string {
  const e = NATIVE[engine]!;
  return [
    `syntax: ${engine}, ${e.covers}; native .${engine === "d2" ? "d2" : "mmd"} files`,
    emitList("topics", e.topics.map((topic) => ({ topic })), ["topic"]),
    helpBlock([`${TOOL} syntax ${engine} example`, `${TOOL} syntax ${engine} ${e.topics[0]}`, `${TOOL} syntax routing`]),
  ].join("\n");
}

/** The exd index plus a pointer line to the other engines and routing. */
function exdIndex(): string {
  const base = renderSlice("index", TOOL) as string;
  const at = base.lastIndexOf("\nhelp[");
  const more = ["engines: d2: " + D2_TOPICS.join(" ") + "; mermaid: " + MERMAID_TOPICS.join(" ") + "; routing; extract"].join("\n");
  return at < 0 ? `${base}\n${more}` : `${base.slice(0, at)}\n${more}${base.slice(at)}`;
}

export const syntaxCommand: CommandModule = {
  spec: {
    name: "syntax",
    summary: "Show the exd DSL reference, or the d2 / mermaid / routing reference; pass a topic for one small slice",
    args: [
      { name: "engine", required: false, description: "exd (default) | d2 | mermaid | routing | extract; a bare exd topic works too" },
      { name: "topic", required: false, description: `exd: ${TOPICS.join(" | ")}; d2: ${D2_TOPICS.join(" | ")}; mermaid: ${MERMAID_TOPICS.join(" | ")}` },
    ],
    flags: [{ name: "engine", type: "string", values: ["exd", "d2", "mermaid"], description: "reference to read (same as the first argument)" }],
    examples: [`${TOOL} syntax`, `${TOOL} syntax edges`, `${TOOL} syntax d2 erd`, `${TOOL} syntax mermaid state`, `${TOOL} syntax routing`],
  },
  run(parsed) {
    const words = parsed.positionals.map((p) => p.toLowerCase());
    let engine = typeof parsed.flags["engine"] === "string" ? (parsed.flags["engine"] as string) : undefined;
    if (!engine && words[0] && (words[0] === "exd" || words[0] === "excalidraw" || words[0] === "routing" || words[0] === "extract" || NATIVE[words[0]])) engine = words.shift();
    if (engine === "excalidraw") engine = "exd";
    const topic = words[0];
    if (words.length > 1) throw new UsageError(`unexpected argument '${words[1]}'`, `usage: ${TOOL} syntax [engine] [topic]`);

    if (engine === "routing") {
      print(renderRoutingSlice(TOOL));
      return 0;
    }
    if (engine === "extract") {
      print(renderExtractSlice(TOOL));
      return 0;
    }
    const native = engine ? NATIVE[engine] : undefined;
    if (native) {
      const out = topic === undefined || topic === "index" ? nativeIndex(engine as string) : native.render(topic, TOOL);
      if (out === undefined) throw new UsageError(`unknown ${engine} topic '${topic}'`, `valid topics: ${native.topics.join(", ")}`);
      print(out);
      return 0;
    }
    if (topic === "routing") {
      print(renderRoutingSlice(TOOL));
      return 0;
    }
    if (topic === "extract") {
      print(renderExtractSlice(TOOL));
      return 0;
    }
    const out = topic === undefined || topic === "index" ? exdIndex() : renderSlice(topic, TOOL);
    if (out === undefined) {
      throw new UsageError(`unknown syntax topic '${topic}'`, `valid topics: ${TOPICS.join(", ")}; other references: d2, mermaid, routing, extract`);
    }
    print(out);
    return 0;
  },
};
