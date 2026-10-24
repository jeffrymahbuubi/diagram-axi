// The engine registry: commands ask for engines here and never import engine internals (KTD1).

import { UsageError } from "../output/errors.js";
import { d2Engine } from "./d2/index.js";
import { excalidrawEngine } from "./excalidraw/index.js";
import { mermaidEngine } from "./mermaid/index.js";
import type { Engine, EngineId } from "./types.js";

/** Registration order is display order (`engines` command, help text). */
const BUILTIN: Engine[] = [excalidrawEngine, d2Engine, mermaidEngine];

const registered = new Map<EngineId, Engine>(BUILTIN.map((e) => [e.id, e]));

/** Adds or replaces an engine (tests, plugins). */
export function registerEngine(engine: Engine): void {
  registered.set(engine.id, engine);
}

/** Restores the built-in set (after a test registered fakes). */
export function resetEngines(): void {
  registered.clear();
  for (const e of BUILTIN) registered.set(e.id, e);
}

export function engines(): Engine[] {
  return [...registered.values()];
}

export function engineIds(): EngineId[] {
  return engines().map((e) => e.id);
}

export function hasEngine(id: string): id is EngineId {
  return registered.has(id as EngineId);
}

/** The engine with this id; a usage error listing the known ids otherwise. */
export function engineFor(id: string): Engine {
  const engine = registered.get(id as EngineId);
  if (!engine) throw new UsageError(`unknown engine '${id}'`, `use --engine ${engineIds().join("|")}`);
  return engine;
}

/** The engine that reads files with this extension (`.d2`, `d2`, case-insensitive); undefined when none does. */
export function engineForExt(ext: string): Engine | undefined {
  const e = (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase();
  return engines().find((x) => x.capabilities.sourceExt === e || x.capabilities.extraExts?.includes(e));
}
