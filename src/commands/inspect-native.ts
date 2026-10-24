// `inspect` for the d2 and mermaid engines (KTD7): a native .d2 / .mmd file, or an .exd translated with an
// explicit engine, is rendered in memory and counted from the engine's geometry, so there is one source
// of truth and no second parser. Kinds without geometry report `nodes/edges: n/a` plus their aggregates.

import type { EngineId, EngineRenderOptions } from "../engines/types.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import { truncate, truncationNote } from "../output/truncate.js";
import { checkLayoutFlag, engineQuality, factsOf, getEngine, layoutOf, nativeEngineLine, resolveInput } from "./engine-io.js";
import { TOOL, arg, displayPath, failParse, flagBool, flagStr, parseDsl } from "./shared.js";

const ID_LIMIT = 800;

/** `name[N]: a,b,c`, cut at a whole id past ID_LIMIT chars unless `full`. */
export function idList(name: string, items: string[], full: boolean): { text: string; cut: boolean } {
  const joined = items.join(",");
  const head = `${name}[${items.length}]: `;
  const t = truncate(joined, full ? Infinity : ID_LIMIT);
  if (!t.truncated) return { text: head + joined, cut: false };
  const at = t.text.lastIndexOf(",");
  return { text: head + (at > 0 ? t.text.slice(0, at) : t.text) + "\n" + truncationNote(t), cut: true };
}

const ENGINE_FIELDS = ["nodes", "edges", "groups", "size", "shapes", "quality"];

export async function inspectEngine(
  file: string,
  engineId: EngineId,
  fields: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const full = flagBool(flags, "full");
  const resolved = await resolveInput(file, flags);
  const engine = await getEngine(engineId);
  const layoutFlag = checkLayoutFlag(engine, flags);

  let source = resolved.text;
  if (!resolved.native) {
    const { graph, errors } = parseDsl(resolved.text);
    if (errors[0]) return failParse(errors[0], file);
    if (graph.nodes.length === 0) {
      print([`scene: 0 nodes, 0 edges, 0 groups in ${displayPath(file)}`, helpBlock([`${TOOL} syntax example`, `${TOOL} draw --help`])].join("\n"));
      return 0;
    }
    if (!engine.translate) throw new Error(`the ${engine.id} engine cannot translate .exd`);
    source = engine.translate(graph, { ...(graph.direction ? { direction: graph.direction } : {}), ...(layoutFlag ? { layout: layoutFlag } : {}), ...(flagBool(flags, "sketch") ? { sketch: true } : {}) }).source;
  }

  const ro: EngineRenderOptions = { png: false };
  const browserPath = flagStr(flags, "browser-path");
  if (browserPath) ro.browserPath = browserPath;
  if (layoutFlag) ro.layout = layoutFlag;
  if (flagBool(flags, "sketch")) ro.sketch = true;
  const res = await engine.render(source, ro);

  const facts = factsOf(engine, res);
  const layout = layoutOf(engine, res, resolved.kind, flags);
  const neutral = res.neutral;
  const nodes = neutral?.nodes.filter((n) => n.kind === "node") ?? [];
  const zones = neutral?.nodes.filter((n) => n.kind === "zone") ?? [];
  const name = displayPath(file);

  const head = facts.nodes === undefined
    ? `scene: nodes/edges n/a (kind ${resolved.kind}) in ${name}`
    : `scene: ${facts.nodes} node${facts.nodes === 1 ? "" : "s"}, ${facts.edges ?? 0} edge${facts.edges === 1 ? "" : "s"}, ${facts.groups ?? 0} group${facts.groups === 1 ? "" : "s"} in ${name}`;
  const lines = [head, resolved.native ? nativeEngineLine(engine.id, resolved.sourceType) : `engine: ${engine.id}`, `kind: ${resolved.kind}`];
  if (layout) lines.push(`layout: ${layout}`);
  let cut = false;
  for (const f of ENGINE_FIELDS.filter((x) => fields.includes(x))) {
    if (f === "nodes" || f === "groups") {
      const ids = (f === "nodes" ? nodes : zones).map((n) => n.id);
      if (facts.nodes === undefined) lines.push(`${f}: n/a`);
      else {
        const r = idList(f, ids, full);
        cut ||= r.cut;
        lines.push(r.text);
      }
    } else if (f === "edges") {
      if (facts.nodes === undefined || !neutral) lines.push("edges: n/a");
      else {
        const r = idList("edges", neutral.edges.map((e) => `${e.src || "?"}>${e.dst || "?"}`), full);
        cut ||= r.cut;
        lines.push(r.text);
      }
    } else if (f === "size") {
      lines.push(`size: ${facts.width}x${facts.height} px`);
    } else if (f === "shapes") {
      const counts: Record<string, number> = {};
      for (const n of nodes) counts[n.shape] = (counts[n.shape] ?? 0) + 1;
      lines.push(emitList("shapes", Object.entries(counts).map(([kind, count]) => ({ kind, count })), ["kind", "count"]));
    } else {
      lines.push((await engineQuality(engine, res, resolved.kind, layout, flagBool(flags, "sketch"))).block);
    }
  }
  const skipped = fields.filter((f) => !ENGINE_FIELDS.includes(f));
  if (skipped.length > 0) lines.push(`n/a for ${engine.id} sources: ${skipped.join(", ")}`);
  const extra = Object.entries(facts.extra);
  if (extra.length > 0) lines.push(`stats: ${extra.map(([k, v]) => `${k} ${v}`).join(", ")}`);

  const help = [`${TOOL} draw ${arg(file)} --png`, `${TOOL} check ${arg(file)}`];
  if (cut) help.unshift(`${TOOL} inspect ${arg(file)} --full`);
  lines.push(helpBlock(help.slice(0, 3)));
  print(lines.join("\n"));
  return 0;
}

