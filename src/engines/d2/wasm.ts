// The D2 runtime (KTD6): `@d2lang/d2` (the Go compiler as WASM in a worker thread), loaded lazily once
// per process. Only compile() and render() are used; the native binary is never called for either.

import { AxiError } from "../../output/errors.js";

/** `@d2lang/d2` version this engine is built against (package.json pin); same Go code as D2 v0.9.0. */
export const D2_WASM_PACKAGE_VERSION = "0.1.34";

export type D2Layout = "dagre" | "elk" | "tala";
export const D2_LAYOUTS: readonly D2Layout[] = ["dagre", "elk", "tala"];

/** Pixels around the drawing in the SVG (D2's own default is 100). */
export const D2_PAD = 32;

export interface D2Point {
  x: number;
  y: number;
}

/** The parts of d2target.Shape the engine reads. */
export interface D2Shape {
  id: string;
  type: string;
  pos: D2Point;
  width: number;
  height: number;
  level: number;
  /** Sequence-diagram groups (drawn over other shapes). */
  blend?: boolean;
  label?: string;
  labelWidth?: number;
  labelHeight?: number;
  labelPosition?: string;
  icon?: string | null;
  columns?: unknown[] | null;
  fields?: unknown[] | null;
}

export interface D2Connection {
  id: string;
  src: string;
  dst: string;
  srcArrow?: string;
  dstArrow?: string;
  label?: string;
  labelWidth?: number;
  labelHeight?: number;
  labelPosition?: string;
  labelPercentage?: number;
  strokeWidth?: number;
  route: D2Point[];
  isCurve?: boolean;
}

export interface D2Diagram {
  shapes: D2Shape[];
  connections: D2Connection[];
  [key: string]: unknown;
}

export interface D2CompileOptions {
  layout?: D2Layout;
  sketch?: boolean;
  themeID?: number;
  pad?: number;
}

export interface D2Compiled {
  diagram: D2Diagram;
  renderOptions: Record<string, unknown>;
}

/** One error from D2's compile: the range is `file,l0:c0:b0-l1:c1:b1` (0-based line and column, byte offsets). */
export interface D2RawError {
  range?: string;
  errmsg: string;
}

/** compile() rejected: `errors` holds every error D2 found, in one pass. */
export class D2CompileError extends Error {
  readonly errors: D2RawError[];
  constructor(errors: D2RawError[]) {
    super(errors.map((e) => e.errmsg).join("\n"));
    this.name = "D2CompileError";
    this.errors = errors;
  }
}

interface WorkerLike {
  ref?: () => void;
  unref?: () => void;
}

interface D2Instance {
  compile(source: string, options?: Record<string, unknown>): Promise<D2Compiled>;
  render(diagram: D2Diagram, options?: Record<string, unknown>): Promise<string>;
  version(): Promise<string>;
  dispose(): Promise<void>;
  ready?: Promise<unknown>;
  worker?: WorkerLike;
}

let instance: Promise<D2Instance> | undefined;
let busy = 0;

async function load(): Promise<D2Instance> {
  let mod: { D2: new () => D2Instance };
  try {
    // The package ships no types usable under NodeNext; the specifier in a variable keeps tsc from resolving it.
    const specifier = "@d2lang/d2";
    mod = (await import(specifier)) as { D2: new () => D2Instance };
  } catch (err) {
    throw new AxiError(`the D2 runtime (@d2lang/d2) could not be loaded: ${(err as Error).message}`, "run `npm install` in the tool's directory");
  }
  const d2 = new mod.D2();
  await d2.ready;
  // The worker thread must not keep the process alive between calls; each call re-refs it while it waits.
  d2.worker?.unref?.();
  return d2;
}

function d2(): Promise<D2Instance> {
  instance ??= load().catch((err: unknown) => {
    instance = undefined;
    throw err;
  });
  return instance;
}

/** Runs `fn` with the worker referenced, so the process stays alive while D2 works. */
async function work<T>(fn: (d: D2Instance) => Promise<T>): Promise<T> {
  const d = await d2();
  if (busy++ === 0) d.worker?.ref?.();
  try {
    return await fn(d);
  } finally {
    if (--busy === 0) d.worker?.unref?.();
  }
}

/** The error list inside a compile rejection's message; a non-JSON message becomes one position-less error. */
export function parseCompileErrors(message: string): D2RawError[] {
  try {
    const data: unknown = JSON.parse(message);
    if (Array.isArray(data) && data.length > 0) {
      const errors = data.filter((e): e is D2RawError => typeof e === "object" && e !== null && typeof (e as D2RawError).errmsg === "string");
      if (errors.length > 0) return errors;
    }
  } catch {
    // not JSON
  }
  return [{ errmsg: message }];
}

/** compile(): parse, resolve and lay out. Rejects with D2CompileError carrying every error. */
export async function d2Compile(source: string, o: D2CompileOptions = {}): Promise<D2Compiled> {
  const options: Record<string, unknown> = { layout: o.layout ?? "elk", pad: o.pad ?? D2_PAD };
  if (o.sketch) options.sketch = true;
  if (o.themeID !== undefined) options.themeID = o.themeID;
  try {
    return await work((d) => d.compile(source, options));
  } catch (err) {
    if (err instanceof AxiError) throw err;
    throw new D2CompileError(parseCompileErrors((err as Error).message ?? String(err)));
  }
}

/** SVG of a compiled diagram (render options as compile() resolved them; `sketch` and `scale` may be overridden). */
export async function d2RenderSvg(compiled: D2Compiled, extra: Record<string, unknown> = {}): Promise<string> {
  return work((d) => d.render(compiled.diagram, { ...compiled.renderOptions, ...extra }));
}

/** Version of the D2 compiler inside the WASM (loads the runtime). */
export async function d2WasmVersion(): Promise<string> {
  return work((d) => d.version());
}

/** Ends the worker thread (tests; the process otherwise exits without it). */
export async function disposeD2(): Promise<void> {
  const current = instance;
  instance = undefined;
  if (current) await (await current.catch(() => undefined))?.dispose();
}

/** The `data-d2-version` attribute D2 stamps into every SVG; removed so goldens survive patch upgrades. */
export function stripD2Version(svg: string): string {
  return svg.replace(/ data-d2-version="[^"]*"/, "");
}

/** Natural size of a D2 SVG: the outer viewBox (the size the diagram renders at, scale 1). */
export function svgSize(svg: string): { width: number; height: number } {
  const m = /^[\s\S]*?<svg[^>]*\sviewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  return m ? { width: Math.round(Number(m[1])), height: Math.round(Number(m[2])) } : { width: 0, height: 0 };
}
