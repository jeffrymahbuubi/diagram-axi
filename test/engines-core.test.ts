// Engine core (U1): neutral model + toScene, detect, registry, cache, fetch, excalidraw adapter.

import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { CACHE_DIR_ENV, engineCacheDir, toolCacheDir } from "../src/engines/cache.js";
import { detectKind, detectSource, parseKind, resolveEngine, type SourceType } from "../src/engines/detect.js";
import { excalidrawEngine } from "../src/engines/excalidraw/index.js";
import { downloadVerified, fetchArchive, sha256Hex, untar } from "../src/engines/fetch.js";
import { curveToPolyline, sampleCubic, toScene, type NeutralScene } from "../src/engines/neutral.js";
import { engineFor, engineForExt, engineIds, engines, registerEngine, resetEngines } from "../src/engines/registry.js";
import type { Engine } from "../src/engines/types.js";
import { parse } from "../src/dsl/parser.js";
import { UsageError } from "../src/output/errors.js";
import { analyzeScene } from "../src/quality/analyze.js";
import { findBrowser, type InstalledBrowser } from "../src/render/browser.js";
import { fontCacheDirectory } from "../src/render/fonts.js";
import type { SceneData } from "../src/render/outputs.js";
import { renderScene } from "../src/render/render.js";

// ---- neutral model ----

/** 3 nodes (a, b inside zone z; c outside), 1 zone with a title, 3 edges (straight, elbow, curved), at negative coordinates. */
function basicNeutral(): NeutralScene {
  const curve = curveToPolyline(
    [
      { x: -60, y: 305 },
      { x: -160, y: 305 },
      { x: -120, y: 120 },
      { x: -120, y: -10 },
    ],
    true,
  );
  return {
    nodes: [
      { id: "z", kind: "zone", box: { x: -200, y: -100, w: 400, h: 300 }, shape: "rectangle" },
      { id: "a", kind: "node", box: { x: -180, y: -60, w: 120, h: 50 }, shape: "rectangle", parent: "z" },
      { id: "b", kind: "node", box: { x: 60, y: -60, w: 120, h: 50 }, shape: "ellipse", parent: "z" },
      { id: "c", kind: "node", box: { x: -60, y: 280, w: 120, h: 50 }, shape: "hexagon" },
    ],
    edges: [
      { id: "a->b", src: "a", dst: "b", poly: [[-60, -35], [60, -35]], label: { x: -30, y: -45, w: 60, h: 20 }, text: "calls" },
      { id: "b->c", src: "b", dst: "c", poly: [[120, -10], [120, 150], [0, 150], [0, 280]] },
      { id: "c->a", src: "c", dst: "a", poly: curve.map((p): [number, number] => [p.x, p.y]) },
    ],
    labels: [
      { ownerId: "z", box: { x: -190, y: -96, w: 40, h: 16 }, text: "Zone" },
      { ownerId: "a", box: { x: -150, y: -45, w: 60, h: 20 }, text: "A" },
    ],
  };
}

describe("neutral model", () => {
  it("sampleCubic ends on the last control point and returns n points", () => {
    const pts = sampleCubic({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }, 12);
    expect(pts).toHaveLength(12);
    expect(pts[11]).toEqual({ x: 20, y: 10 });
  });

  it("curveToPolyline leaves straight routes alone and samples curves from p0", () => {
    const straight = [{ x: 0, y: 0 }, { x: 5, y: 5 }];
    expect(curveToPolyline(straight, false)).toBe(straight);
    const curved = curveToPolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 3 }], true);
    expect(curved).toHaveLength(13);
    expect(curved[0]).toEqual({ x: 0, y: 0 });
  });

  it("toScene uses the scene id conventions and binds arrows and labels", () => {
    const els = toScene(basicNeutral());
    const ids = els.map((e) => e.id);
    expect(ids).toEqual([
      "zone-g-z",
      "zone-title-z",
      "node-a",
      "node-b",
      "node-c",
      "label-a",
      "edge-0",
      "edge-1",
      "edge-2",
      "edge-label-0",
    ]);
    const byId = new Map(els.map((e) => [e.id, e]));
    expect(byId.get("node-b")!.type).toBe("ellipse");
    expect(byId.get("node-c")!.type).toBe("rectangle"); // hexagon approximated by its (inset) box
    expect(byId.get("node-a")!.groupIds).toEqual(["group-z"]);
    expect(byId.get("zone-g-z")!.groupIds).toEqual(["group-z"]);
    expect(byId.get("node-c")!.groupIds).toEqual([]);
    expect(byId.get("edge-1")!.startBinding).toMatchObject({ elementId: "node-b" });
    expect(byId.get("edge-1")!.endBinding).toMatchObject({ elementId: "node-c" });
    expect(byId.get("edge-label-0")!.containerId).toBe("edge-0");
    expect(byId.get("edge-label-0")!.labelPosition).toBeCloseTo(0.5, 2);
    expect(byId.get("label-a")!.containerId).toBe("node-a");
    expect(byId.get("node-a")!.boundElements).toEqual(expect.arrayContaining([{ id: "label-a", type: "text" }, { id: "edge-0", type: "arrow" }]));
    expect(byId.get("edge-2")!.points!.length).toBeGreaterThan(10);
  });

  it("toScene translates negative origins so nothing lies at x < 0 or y < 0", () => {
    const els = toScene(basicNeutral());
    for (const e of els) {
      expect(e.x).toBeGreaterThanOrEqual(0);
      expect(e.y).toBeGreaterThanOrEqual(0);
      if (e.type === "arrow") {
        for (const [px, py] of e.points!) {
          expect(e.x + px!).toBeGreaterThanOrEqual(0);
          expect(e.y + py!).toBeGreaterThanOrEqual(0);
        }
      }
    }
    expect(Math.min(...els.map((e) => e.x))).toBe(20);
    expect(Math.min(...els.map((e) => e.y))).toBe(20);
  });

  it("analyzeScene accepts the output: no hard finding, nothing outside the canvas", () => {
    const { findings, stats } = analyzeScene({ elements: toScene(basicNeutral()) });
    expect(findings.filter((f) => f.severity === "hard")).toEqual([]);
    expect(findings.find((f) => f.code === "label-outside-canvas")).toBeUndefined();
    expect(stats).toMatchObject({ nodes: 3, edges: 3, zones: 1 });
  });

  it("an empty model yields no elements; edges to unknown ids stay unbound", () => {
    expect(toScene({ nodes: [], edges: [], labels: [] })).toEqual([]);
    const els = toScene({
      nodes: [{ id: "a", kind: "node", box: { x: 0, y: 0, w: 50, h: 50 }, shape: "rectangle" }],
      edges: [{ id: "e", src: "a", dst: "ghost", poly: [[50, 25], [120, 25]] }],
      labels: [],
    });
    const arrow = els.find((e) => e.type === "arrow")!;
    expect(arrow.startBinding).toMatchObject({ elementId: "node-a" });
    expect(arrow.endBinding).toBeNull();
  });

  it("a cyclic or dangling parent chain does not hang", () => {
    const els = toScene({
      nodes: [
        { id: "x", kind: "zone", box: { x: 0, y: 0, w: 100, h: 100 }, shape: "rectangle", parent: "y" },
        { id: "y", kind: "zone", box: { x: 0, y: 0, w: 100, h: 100 }, shape: "rectangle", parent: "x" },
        { id: "n", kind: "node", box: { x: 10, y: 10, w: 20, h: 20 }, shape: "rectangle", parent: "missing" },
      ],
      edges: [],
      labels: [],
    });
    expect(els.map((e) => e.id)).toEqual(["zone-g-x", "zone-g-y", "node-n"]);
  });
});

// ---- detect ----

describe("detect", () => {
  const D2_SEQ = "shape: sequence_diagram\na -> b: hi\n";
  const table: [string, SourceType, string, string | undefined, string, string][] = [
    // [label, type, source, --kind, expected kind, expected from]
    ["exd plain", "exd", "a -> b\n", undefined, "graph", "default"],
    ["exd ignores header-like comments", "exd", "# kind: sequence\na -> b\n", undefined, "graph", "default"],
    ["excalidraw scene", "excalidraw", "{}", undefined, "graph", "default"],
    ["d2 plain", "d2", "a -> b\n", undefined, "graph", "default"],
    ["d2 sequence keyword", "d2", D2_SEQ, undefined, "sequence", "keyword"],
    ["d2 class keyword inside a block", "d2", "User: { shape: class\n id: int }\n", undefined, "class", "keyword"],
    ["d2 sql_table keyword", "d2", "t: {\n  shape: sql_table\n  id: int\n}\n", undefined, "erd", "keyword"],
    ["d2 keyword in a comment is ignored", "d2", "# shape: sequence_diagram\na -> b\n", undefined, "graph", "default"],
    ["d2 header beats keyword", "d2", "# kind: class\n" + D2_SEQ, undefined, "class", "header"],
    ["d2 header alias", "d2", "\n# kind: ER diagram\na -> b\n", undefined, "erd", "header"],
    ["d2 flag beats header", "d2", "# kind: class\na -> b\n", "erd", "erd", "flag"],
    ["mermaid flowchart", "mmd", "flowchart TD\n a --> b\n", undefined, "graph", "keyword"],
    ["mermaid graph LR", "mmd", "graph LR\n a --> b\n", undefined, "graph", "keyword"],
    ["mermaid sequence", "mmd", "sequenceDiagram\n A->>B: hi\n", undefined, "sequence", "keyword"],
    ["mermaid state v2", "mmd", "stateDiagram-v2\n [*] --> A\n", undefined, "state", "keyword"],
    ["mermaid state v1", "mmd", "stateDiagram\n [*] --> A\n", undefined, "state", "keyword"],
    ["mermaid timeline", "mmd", "timeline\n title t\n 2020 : x\n", undefined, "timeline", "keyword"],
    ["mermaid gitGraph", "mmd", 'gitGraph\n commit id: "a"\n', undefined, "gitgraph", "keyword"],
    ["mermaid mindmap", "mmd", "mindmap\n root((r))\n", undefined, "mindmap", "keyword"],
    ["mermaid class", "mmd", "classDiagram\n A <|-- B\n", undefined, "class", "keyword"],
    ["mermaid er", "mmd", "erDiagram\n A ||--o{ B : has\n", undefined, "erd", "keyword"],
    ["mermaid frontmatter then keyword", "mmd", "---\nconfig:\n  layout: elk\n---\nsequenceDiagram\n A->>B: x\n", undefined, "sequence", "keyword"],
    ["mermaid init directive then keyword", "mmd", '%%{init: {"theme":"base"}}%%\nmindmap\n root\n', undefined, "mindmap", "keyword"],
    ["mermaid header beats keyword", "mmd", "%% kind: state\nflowchart TD\n a --> b\n", undefined, "state", "header"],
    ["mermaid unknown diagram type", "mmd", 'pie\n "a": 1\n', undefined, "graph", "default"],
    ["mermaid flag", "mmd", "flowchart TD\n a --> b\n", "timeline", "timeline", "flag"],
  ];

  it.each(table)("%s", (_label, type, source, flag, kind, from) => {
    expect(detectKind(type, source, flag)).toMatchObject({ kind, from });
  });

  it("an unknown --kind is a usage error; an unknown header kind is ignored with a warning", () => {
    expect(() => detectKind("d2", "a -> b", "pizza")).toThrow(UsageError);
    const r = detectKind("mmd", "%% kind: pizza\nmindmap\n root\n");
    expect(r).toMatchObject({ kind: "mindmap", from: "keyword" });
    expect(r.warning).toMatch(/pizza/);
  });

  it("parseKind normalizes spelling", () => {
    expect(parseKind("State-Diagram_v2")).toBe("state");
    expect(parseKind(" gitGraph ")).toBe("gitgraph");
    expect(parseKind("nope")).toBeUndefined();
  });

  it("detectSource maps extensions, with or without a path", () => {
    expect(detectSource("a/b/login.mmd")).toEqual({ engine: "mermaid", sourceType: "mmd" });
    expect(detectSource(".D2")).toEqual({ engine: "d2", sourceType: "d2" });
    expect(detectSource("x.exd")).toEqual({ engine: "excalidraw", sourceType: "exd" });
    expect(detectSource("x.excalidraw")).toEqual({ engine: "excalidraw", sourceType: "excalidraw" });
    expect(detectSource("x.svg")).toBeUndefined();
    expect(detectSource("README")).toBeUndefined();
  });

  it("resolveEngine: .exd takes any engine, native sources only their own (conflict = usage error)", () => {
    const exd = detectSource("a.exd")!;
    expect(resolveEngine(exd, undefined)).toBe("excalidraw");
    expect(resolveEngine(exd, "d2")).toBe("d2");
    expect(() => resolveEngine(exd, "visio")).toThrow(UsageError);
    const d2 = detectSource("a.d2")!;
    expect(resolveEngine(d2, "d2")).toBe("d2");
    expect(resolveEngine(d2, "auto")).toBe("d2");
    expect(() => resolveEngine(d2, "mermaid")).toThrow(/conflicts/);
    expect(() => resolveEngine(detectSource("a.mmd")!, "excalidraw")).toThrow(UsageError);
  });
});

// ---- registry ----

describe("registry", () => {
  afterEach(() => resetEngines());

  it("lists the excalidraw engine and resolves ids and extensions", () => {
    expect(engineIds()[0]).toBe("excalidraw");
    expect(engineFor("excalidraw")).toBe(excalidrawEngine);
    expect(engineForExt(".exd")).toBe(excalidrawEngine);
    expect(engineForExt("EXD")).toBe(excalidrawEngine);
    expect(engineForExt(".excalidraw")).toBe(excalidrawEngine);
    expect(engineForExt(".png")).toBeUndefined();
  });

  it("an unknown engine is a usage error that lists the known ids", () => {
    expect(() => engineFor("visio")).toThrow(UsageError);
    expect(() => engineFor("visio")).toThrow(/unknown engine 'visio'/);
  });

  it("registerEngine adds engines that engineForExt finds; resetEngines drops them", () => {
    const fake: Engine = {
      ...excalidrawEngine,
      id: "d2",
      capabilities: { ...excalidrawEngine.capabilities, sourceExt: ".d2", extraExts: undefined },
    };
    registerEngine(fake);
    expect(engineFor("d2")).toBe(fake);
    expect(engineForExt(".d2")).toBe(fake);
    expect(engines().map((e) => e.id)).toEqual(["excalidraw", "d2", "mermaid"]);
    resetEngines();
    // d2 is a built-in now: resetting restores the real engine instead of dropping the id
    expect(engineFor("d2")).not.toBe(fake);
  });
});

// ---- cache ----

describe("cache", () => {
  const saved = process.env[CACHE_DIR_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[CACHE_DIR_ENV];
    else process.env[CACHE_DIR_ENV] = saved;
  });

  it("defaults to the parent of the font cache directory", () => {
    delete process.env[CACHE_DIR_ENV];
    expect(toolCacheDir()).toBe(dirname(fontCacheDirectory()));
    expect(engineCacheDir("d2", "0.9.0")).toBe(join(dirname(fontCacheDirectory()), "engines", "d2", "0.9.0"));
  });

  it("DIAGRAM_AXI_CACHE_DIR overrides it", () => {
    process.env[CACHE_DIR_ENV] = join(tmpdir(), "dg-cache");
    expect(engineCacheDir("d2", "0.9.0")).toBe(join(tmpdir(), "dg-cache", "engines", "d2", "0.9.0"));
  });

  it("rejects names and versions that could leave the cache", () => {
    expect(() => engineCacheDir("..", "1")).toThrow();
    expect(() => engineCacheDir("d2", "../x")).toThrow();
    expect(() => engineCacheDir("d2/x", "1")).toThrow();
    expect(() => engineCacheDir("", "1")).toThrow();
  });
});

// ---- fetch (local http server, never the network) ----

/** One ustar entry: header block + padded data. `type` "5" = directory; `long` writes a GNU long-name record first. */
function tarEntry(name: string, data: Buffer | null, opts: { type?: string; mode?: number; long?: boolean } = {}): Buffer {
  const body = data ?? Buffer.alloc(0);
  const record = (n: string, content: Buffer, type: string, mode: number): Buffer => {
    const h = Buffer.alloc(512);
    h.write(n.slice(0, 100), 0, "utf8");
    h.write(mode.toString(8).padStart(7, "0") + "\0", 100, "latin1");
    h.write("0000000\0", 108, "latin1");
    h.write("0000000\0", 116, "latin1");
    h.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
    h.write("00000000000\0", 136, "latin1");
    h.write("        ", 148, "latin1");
    h.write(type, 156, "latin1");
    h.write("ustar\0", 257, "latin1");
    h.write("00", 263, "latin1");
    const sum = [...h].reduce((a, b) => a + b, 0);
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
    return Buffer.concat([h, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
  };
  const parts: Buffer[] = [];
  if (opts.long) parts.push(record("././@LongLink", Buffer.from(name + "\0"), "L", 0o644));
  parts.push(record(name, body, opts.type ?? "0", opts.mode ?? 0o644));
  return Buffer.concat(parts);
}
const tarball = (...entries: Buffer[]): Buffer => Buffer.concat([...entries, Buffer.alloc(1024)]);

describe("fetch", () => {
  const longPath = "d2-v0.9.0/" + "deep/".repeat(30) + "long.txt";
  const archive = gzipSync(
    tarball(
      tarEntry("d2-v0.9.0/", null, { type: "5", mode: 0o755 }),
      tarEntry("d2-v0.9.0/bin/d2", Buffer.from("fake-binary"), { mode: 0o755 }),
      tarEntry(longPath, Buffer.from("long"), { long: true }),
      tarEntry("d2-v0.9.0/README.md", Buffer.from("hello\n")),
    ),
  );
  const sha = sha256Hex(archive);
  let server: Server;
  let base = "";
  let hits = 0;
  let work: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (req.url === "/d2.tgz") {
        res.writeHead(200, { "content-type": "application/gzip" }).end(archive);
      } else if (req.url === "/redir") {
        res.writeHead(302, { location: "/d2.tgz" }).end();
      } else if (req.url === "/garbage.tgz") {
        res.writeHead(200).end("not a gzip file");
      } else {
        res.writeHead(404).end("nope");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => {
    server.close();
  });
  afterEach(() => {
    if (work) rmSync(work, { recursive: true, force: true });
    work = undefined;
  });
  const fresh = (): string => (work = mkdtempSync(join(tmpdir(), "dg-fetch-")));
  const leftovers = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

  for (const useSystemTar of [true, false]) {
    it(`downloads through a redirect, verifies and extracts atomically (${useSystemTar ? "system tar" : "zlib extractor"})`, async () => {
      const root = fresh();
      const dest = join(root, "engines", "d2", "0.9.0");
      const r = await fetchArchive({ url: `${base}/redir`, sha256: sha, dest, useSystemTar });
      expect(r).toMatchObject({ dir: dest, reused: false, bytes: archive.length });
      expect(readFileSync(join(dest, "d2-v0.9.0", "bin", "d2"), "utf8")).toBe("fake-binary");
      expect(readFileSync(join(dest, "d2-v0.9.0", "README.md"), "utf8")).toBe("hello\n");
      expect(readFileSync(join(dest, longPath), "utf8")).toBe("long");
      expect(leftovers(dirname(dest))).toEqual(["0.9.0"]); // no temp dir, no .tgz
    });
  }

  it("rejects a wrong sha256 and leaves no partial directory", async () => {
    const root = fresh();
    const dest = join(root, "engines", "d2", "0.9.0");
    await expect(fetchArchive({ url: `${base}/d2.tgz`, sha256: "0".repeat(64), dest })).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(dest)).toBe(false);
    expect(leftovers(dirname(dest))).toEqual([]);
  });

  it("rejects HTTP errors and a corrupt archive cleanly", async () => {
    const root = fresh();
    const dest = join(root, "d2");
    await expect(fetchArchive({ url: `${base}/missing`, sha256: sha, dest })).rejects.toThrow(/HTTP 404/);
    const garbage = Buffer.from("not a gzip file");
    await expect(fetchArchive({ url: `${base}/garbage.tgz`, sha256: sha256Hex(garbage), dest })).rejects.toThrow(/archive/);
    expect(leftovers(root)).toEqual([]);
  });

  it("reuses an existing destination without a request", async () => {
    const root = fresh();
    const dest = join(root, "d2");
    await fetchArchive({ url: `${base}/d2.tgz`, sha256: sha, dest });
    const before = hits;
    const again = await fetchArchive({ url: `${base}/d2.tgz`, sha256: "0".repeat(64), dest });
    expect(again).toMatchObject({ reused: true, bytes: 0 });
    expect(hits).toBe(before);
  });

  it("reports an unreachable server as an error with a suggestion", async () => {
    await expect(downloadVerified("http://127.0.0.1:1/x.tgz", sha, 2000)).rejects.toMatchObject({ suggestion: expect.stringMatching(/network/) });
  });

  it("untar refuses paths that escape the target", async () => {
    const root = fresh();
    await expect(untar(tarball(tarEntry("../evil.txt", Buffer.from("x"))), root)).rejects.toThrow(/unsafe path/);
    await expect(untar(tarball(tarEntry("/abs.txt", Buffer.from("x"))), root)).rejects.toThrow(/unsafe path/);
    await expect(untar(tarball(tarEntry("a/../../b.txt", Buffer.from("x"))), root)).rejects.toThrow(/unsafe path/);
    expect(leftovers(dirname(root)).includes("evil.txt")).toBe(false);
  });
});

// ---- excalidraw adapter ----

const smokeText = readFileSync(fileURLToPath(new URL("./fixtures/render-smoke.excalidraw", import.meta.url)), "utf8");
const flowText = readFileSync(fileURLToPath(new URL("./fixtures/flow.exd", import.meta.url)), "utf8");

describe("excalidraw engine", () => {
  it("declares its capabilities", () => {
    expect(excalidrawEngine.capabilities).toMatchObject({ kinds: ["graph"], sourceExt: ".exd", geometry: true });
    expect(excalidrawEngine.detectKind("anything")).toBe("graph");
  });

  it("translate produces a scene that validates, whose geometry the checker accepts", async () => {
    const { graph } = parse(flowText);
    const { source, losses } = excalidrawEngine.translate!(graph, {});
    expect(losses).toEqual([]);
    expect(JSON.parse(source)).toMatchObject({ type: "excalidraw" });
    expect(await excalidrawEngine.validate(source)).toEqual([]);
    const scene = JSON.parse(source) as SceneData;
    const g = excalidrawEngine.geometry!({ svg: "", width: 0, height: 0, browser: "", elements: scene.elements as never });
    expect(g.rulesSkipped).toEqual([]);
    expect(analyzeScene({ elements: g.elements }).findings.filter((f) => f.severity === "hard")).toEqual([]);
  });

  it("translate honours the direction option unless the DSL has a direction line", () => {
    const { graph } = parse("a -> b\n");
    const down = JSON.parse(excalidrawEngine.translate!(graph, { direction: "DOWN" }).source) as SceneData;
    const right = JSON.parse(excalidrawEngine.translate!(graph, { direction: "RIGHT" }).source) as SceneData;
    const pos = (s: SceneData, id: string) => (s.elements as { id: string; x: number; y: number }[]).find((e) => e.id === id)!;
    expect(pos(down, "node-b").y).toBeGreaterThan(pos(down, "node-a").y);
    expect(pos(right, "node-b").x).toBeGreaterThan(pos(right, "node-a").x);
  });

  it("validate reports DSL errors with positions and bad scenes without throwing", async () => {
    const dsl = await excalidrawEngine.validate("a -> \n");
    expect(dsl.length).toBeGreaterThan(0);
    expect(dsl[0]).toMatchObject({ line: 1 });
    expect((await excalidrawEngine.validate('{"type":"nope"}'))[0]).toMatchObject({ code: "invalid-scene" });
    expect((await excalidrawEngine.validate("{ not json"))[0]).toMatchObject({ code: "invalid-scene" });
  });

  it("render refuses .exd text with a pointer to draw", async () => {
    await expect(excalidrawEngine.render("a -> b\n")).rejects.toThrow(/\.excalidraw scene/);
  });

  it("status never throws and reports the renderer version", async () => {
    const s = await excalidrawEngine.status({ browserPath: join(tmpdir(), "no-such-browser") });
    expect(s.status).toBe("browser-missing");
    expect(s.png).toBe("none");
    expect(s.version).toBeTruthy();
  });

  describe("with a browser", () => {
    let browser: InstalledBrowser | undefined;
    beforeAll(async () => {
      browser = await findBrowser().catch(() => undefined);
    });
    const need = (ctx: TestContext) => {
      if (!browser) ctx.skip("no browser installed");
    };

    it("render equals renderScene for the render-smoke scene (acceptance)", async (ctx) => {
      need(ctx);
      const scene = JSON.parse(smokeText) as SceneData;
      const direct = await renderScene({ scene, png: true, svg: true, scale: 1, padding: 20, transparent: false, timeoutMs: 30_000, browserPath: browser!.path });
      const viaEngine = await excalidrawEngine.render(smokeText, { png: true, browserPath: browser!.path });
      expect(viaEngine.svg).toBe(direct.svg);
      expect(Buffer.from(viaEngine.png!).equals(Buffer.from(direct.png!))).toBe(true);
      expect({ w: viaEngine.width, h: viaEngine.height, b: viaEngine.browser }).toEqual({ w: direct.width, h: direct.height, b: direct.browser });
      expect(viaEngine.elements!.length).toBe(scene.elements.length);
    });

    it("status finds the browser", async (ctx) => {
      need(ctx);
      expect(await excalidrawEngine.status({ browserPath: browser!.path })).toMatchObject({ status: "ready", png: "browser", path: browser!.path });
    });

    it("render without png returns only the SVG", async (ctx) => {
      need(ctx);
      const r = await excalidrawEngine.render(smokeText, { browserPath: browser!.path });
      expect(r.png).toBeUndefined();
      expect(r.svg).toContain("<svg");
    });
  });
});
