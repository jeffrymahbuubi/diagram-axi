// `inspect <scene|dsl>`: aggregates without rendering a file; native .d2/.mmd (and .exd with an explicit engine)
// are counted from the engine's geometry (inspect-native.ts).

import { extname } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Direction, Graph } from "../dsl/ast.js";
import { layout } from "../layout/dagre-layout.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import type { SceneData } from "../render/outputs.js";
import { buildScene } from "../scene/build.js";
import { summarize } from "../scene/summary.js";
import { detectSource, resolveEngine } from "../engines/detect.js";
import { BROWSER_PATH_FLAG, D2_PATH_FLAG, ENGINE_FLAG, KIND_FLAG, LAYOUT_FLAG, SKETCH_FLAG } from "./engine-io.js";
import { idList, inspectEngine } from "./inspect-native.js";
import { TOOL, arg, displayPath, failParse, flagBool, flagStr, parseDsl, plural, qualityBlock, qualityFor, readSource } from "./shared.js";

const ALL_FIELDS = ["nodes", "edges", "groups", "size", "shapes", "fonts", "colors", "unresolved", "quality"];

interface Unresolved {
  kind: string;
  id: string;
  detail: string;
}

interface Refs {
  nodes: string[];
  edges: string[];
  groups: string[];
  unresolved: Unresolved[];
}

interface Loose {
  id?: string;
  type?: string;
  isDeleted?: boolean;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
}

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const strip = (id: string): string => id.replace(/^(node|zone-g|zone)-/, "");

/** Node, edge and group ids plus dangling arrow ends, read from the scene elements. */
function sceneRefs(scene: SceneData): Refs {
  const live = (scene.elements as Loose[]).filter((e) => e && !e.isDeleted);
  const shapeIds = new Set(live.filter((e) => SHAPE_TYPES.has(e.type ?? "")).map((e) => e.id ?? ""));
  const refs: Refs = { nodes: [], edges: [], groups: [], unresolved: [] };
  for (const e of live) {
    const id = e.id ?? "";
    if (SHAPE_TYPES.has(e.type ?? "")) {
      if (id.startsWith("zone-")) refs.groups.push(strip(id));
      else if (!id.startsWith("cap-")) refs.nodes.push(strip(id));
    } else if (e.type === "arrow") {
      const ends = (["startBinding", "endBinding"] as const).map((key) => {
        const side = key === "startBinding" ? "start" : "end";
        const target = e[key]?.elementId;
        if (!target) {
          refs.unresolved.push({ kind: "unbound-end", id, detail: `${side} is not attached to a shape` });
          return "?";
        }
        if (!shapeIds.has(target)) {
          refs.unresolved.push({ kind: "dangling-binding", id, detail: `${side} binds to missing element '${target}'` });
        }
        return strip(target);
      });
      refs.edges.push(`${ends[0]}>${ends[1]}`);
    }
  }
  return refs;
}

/** The quality block; a scene the checker cannot read (foreign or malformed elements) reports why instead of failing. */
function qualityLine(scene: SceneData, graph: Graph | undefined, direction: Direction | undefined): string {
  try {
    return qualityBlock(qualityFor(scene, graph, direction));
  } catch (err) {
    return `quality: unavailable, the layout checker could not read this scene (${(err as Error).message})`;
  }
}

const rows = (o: Record<string, number>, a: string, b: string): Array<Record<string, unknown>> =>
  Object.entries(o)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => ({ [a]: k, [b]: n }));

function isScene(file: string, text: string): boolean {
  const ext = extname(file).toLowerCase();
  if (ext === ".excalidraw" || ext === ".json") return true;
  if (ext === ".exd") return false;
  return text.trimStart().startsWith("{");
}

function parseScene(text: string, file: string): SceneData {
  let data: Partial<SceneData> | null;
  try {
    data = JSON.parse(text) as Partial<SceneData> | null;
  } catch (err) {
    throw new AxiError(`'${displayPath(file)}' is not valid JSON: ${(err as Error).message}`, "pass a .excalidraw scene or an .exd DSL file");
  }
  if (!data || data.type !== "excalidraw" || !Array.isArray(data.elements)) {
    throw new AxiError(`'${displayPath(file)}' is not an Excalidraw scene`, 'a scene needs "type": "excalidraw" and an elements array');
  }
  return data as SceneData;
}

export const inspectCommand: CommandModule = {
  spec: {
    name: "inspect",
    summary: "Print aggregates (nodes, edges, groups, size) of a .excalidraw scene, .exd DSL file or native .d2/.mmd file",
    args: [{ name: "file", required: true, description: ".excalidraw, .exd, .d2 or .mmd file path" }],
    flags: [
      {
        name: "fields",
        type: "string",
        default: "nodes,edges,groups,size",
        description: "comma-separated aggregates from: nodes, edges, groups, size, shapes, fonts, colors, unresolved, quality",
      },
      { name: "full", type: "boolean", description: "do not truncate id lists" },
      ENGINE_FLAG,
      KIND_FLAG,
      SKETCH_FLAG,
      LAYOUT_FLAG,
      BROWSER_PATH_FLAG,
      D2_PATH_FLAG,
    ],
    examples: [
      "diagram-axi inspect out/arch.excalidraw",
      "diagram-axi inspect diagram.exd --fields nodes,shapes,unresolved --full",
      "diagram-axi inspect login.mmd",
    ],
  },
  async run(parsed) {
    const file = parsed.positionals[0]!;
    const fields = (flagStr(parsed.flags, "fields") ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    const bad = fields.filter((f) => !ALL_FIELDS.includes(f));
    if (bad.length > 0 || fields.length === 0) {
      throw new UsageError(`unknown field '${bad[0] ?? ""}' for --fields`, `valid fields: ${ALL_FIELDS.join(", ")}`);
    }
    if (!fields.includes("quality")) fields.push("quality"); // the layout verdict is always part of an inspection
    const full = flagBool(parsed.flags, "full");

    const detected = file === "-" ? undefined : detectSource(file);
    if (detected) resolveEngine(detected, flagStr(parsed.flags, "engine"));
    const asked = flagStr(parsed.flags, "engine");
    if (detected?.sourceType === "d2" || detected?.sourceType === "mmd") return inspectEngine(file, detected.engine, fields, parsed.flags);
    if ((asked === "d2" || asked === "mermaid") && detected?.sourceType !== "excalidraw") return inspectEngine(file, asked, fields, parsed.flags);
    if (extname(file).toLowerCase() === ".svg") {
      throw new AxiError("an .svg has no source to measure", "inspect the .d2, .mmd, .exd or .excalidraw file it was drawn from");
    }

    const text = await readSource(file);
    const dsl = !isScene(file, text);
    let scene: SceneData | undefined;
    let graphOf: Graph | undefined;
    let direction: Direction | undefined;
    const implicit: Unresolved[] = [];
    if (dsl) {
      const { graph, errors, warnings } = parseDsl(text);
      if (errors[0]) return failParse(errors[0], file);
      for (const w of warnings.filter((d) => d.code === "implicit-node")) {
        implicit.push({ kind: "implicit-node", id: /^'([^']*)'/.exec(w.message)?.[1] ?? "", detail: `line ${w.line}, col ${w.col}: labelled with its id` });
      }
      if (graph.nodes.length > 0) {
        graphOf = graph;
        direction = graph.direction ?? "DOWN";
        scene = buildScene(graph, layout({ graph, direction }));
      }
    } else {
      scene = parseScene(text, file);
    }

    const name = displayPath(file);
    const summary = scene ? summarize(scene) : undefined;
    if (!scene || !summary || summary.nodes + summary.edges + summary.groups === 0) {
      const help = dsl ? [`${TOOL} syntax example`, `${TOOL} draw --help`] : [`${TOOL} draw --help`, `${TOOL} syntax example`];
      print([`scene: 0 nodes, 0 edges, 0 groups in ${name}`, helpBlock(help)].join("\n"));
      return 0;
    }

    const refs = sceneRefs(scene);
    const lines = [`scene: ${plural(summary.nodes, "node")}, ${plural(summary.edges, "edge")}, ${plural(summary.groups, "group")} in ${name}`];
    let cut = false;
    for (const f of ALL_FIELDS.filter((x) => fields.includes(x))) {
      if (f === "nodes" || f === "edges" || f === "groups") {
        const r = idList(f, refs[f], full);
        cut ||= r.cut;
        lines.push(r.text);
      } else if (f === "size") {
        lines.push(`size: ${summary.bounds.width}x${summary.bounds.height} px`);
      } else if (f === "shapes") {
        lines.push(emitList("shapes", rows(summary.shapes, "kind", "count"), ["kind", "count"]));
      } else if (f === "fonts") {
        lines.push(emitList("fonts", rows(summary.fonts, "font", "texts"), ["font", "texts"]));
      } else if (f === "colors") {
        lines.push(emitList("colors", rows(summary.colors, "fill", "nodes"), ["fill", "nodes"]));
      } else if (f === "quality") {
        lines.push(qualityLine(scene, graphOf, direction));
      } else {
        const all = [...implicit, ...refs.unresolved] as unknown as Array<Record<string, unknown>>;
        lines.push(emitList("unresolved", all, ["kind", "id", "detail"]));
      }
    }

    const help = dsl
      ? [`${TOOL} draw ${arg(file)} --png`, `${TOOL} check ${arg(file)}`]
      : [`${TOOL} render ${arg(file)} --png`, `${TOOL} inspect ${arg(file)} --fields shapes,fonts,colors,unresolved`];
    if (cut) help.unshift(`${TOOL} inspect ${arg(file)} --full`);
    lines.push(helpBlock(help.slice(0, 3)));
    print(lines.join("\n"));
    return 0;
  },
};
