// Fuzz profiles: parameter objects consumed by scripts/qa/gen.mjs (see docs/plans/2026-10-23-qa-edge-cases-fuzz-plan.md, section 2).
//
// Every profile = DEFAULTS + overrides. Ranges are [min, max] inclusive. `gated:false` profiles are report-only:
// printed and written to the report, but excluded from the gated pass rate (user decision: dense and stress-60
// are report-only for iterations 1-2; `--gate-all` makes them count). `rtlOnly` profiles run only with `--rtl`.

export const DEFAULT_COUNT = 60;

const DEFAULTS = {
  gated: true,
  rtlOnly: false,
  topo: "dag", // dag | multi | hubs | random | layered | tiny
  nodes: [4, 10],
  density: [1, 1.5], // edges per node (dag, random, layered)
  maxEdges: 20, // hard upper bound the generator never exceeds (tests assert it)
  back: [0, 1], // dag: extra back edges
  recip: [0, 0], // dag: reciprocal pairs added next to existing edges
  loopP: 0.03, // chance per node of a self-loop
  labelP: 0.5, // chance an edge carries a label
  edgeWords: [1, 3],
  edgeMultilineP: 0,
  edgeLongP: 0, // ~60 character edge label
  nodeWords: [1, 3],
  nodeOneCharP: 0,
  nodeLongP: 0, // ~70 character node label
  nodeMultilineP: 0.05,
  shapes: [["rect", 60], ["ellipse", 15], ["diamond", 15], ["cylinder", 10]],
  arrows: [["solid", 74], ["dashed", 10], ["dotted", 5], ["line", 3], ["both", 8]],
  colorP: 0.3,
  flagP: 0.1,
  titleP: 0.3,
  titleLongP: 0.1,
  wsP: 0, // padded / newline-edged labels
  bracketP: 0.03, // labels containing the other bracket kinds
  hashP: 0.02, // edge labels containing `#` (emitted quoted)
  unicodeP: 0,
  rtl: false,
  implicitP: 0.15, // chance a case declares some nodes inline on their first edge or leaves them implicit
  mergeP: 0.3, // chance a case merges same-label runs into chain / fan-out statements
  groups: { min: 0, max: 1, depth: 1, emptyP: 0, singleP: 0, titleMax: 24, untitledP: 0.15, coverage: 0.8 },
  crossP: undefined, // groups: probability an edge crosses a group boundary (undefined = unconstrained)
  edgesFirstP: 0, // groups: chance the edges are emitted before the groups (declare-after-use)
};

const def = (over) => ({ ...DEFAULTS, ...over, groups: { ...DEFAULTS.groups, ...(over.groups ?? {}) } });

export const PROFILES = {
  "realistic-small": def({
    nodes: [4, 10],
    density: [1, 1.5],
    maxEdges: 16,
    labelP: 0.6,
    groups: { min: 0, max: 1, depth: 1 },
  }),
  "realistic-medium": def({
    nodes: [10, 25],
    density: [1.2, 1.8],
    maxEdges: 46,
    back: [1, 2],
    recip: [1, 1],
    labelP: 0.5,
    groups: { min: 1, max: 3, depth: 2 },
  }),
  "multi-edge": def({
    topo: "multi",
    nodes: [3, 8],
    maxEdges: 60,
    multiK: [[2, 40], [3, 30], [4, 20], [5, 10]],
    labelP: 0.9,
    loopP: 0.3,
    arrows: [["solid", 55], ["dashed", 10], ["dotted", 5], ["line", 5], ["both", 25]],
    groups: { min: 0, max: 0 },
  }),
  "labels-heavy": def({
    nodes: [5, 12],
    density: [1.5, 1.5],
    maxEdges: 26,
    labelP: 1,
    edgeWords: [3, 12],
    edgeMultilineP: 0.2,
    edgeLongP: 0.1,
    nodeWords: [1, 5],
    nodeOneCharP: 0.15,
    nodeLongP: 0.1,
    nodeMultilineP: 0.2,
    wsP: 0.08,
    bracketP: 0.12,
    hashP: 0.05,
    groups: { min: 0, max: 1, depth: 1 },
  }),
  "groups-nested": def({
    nodes: [6, 20],
    density: [1, 1],
    maxEdges: 40,
    labelP: 0.5,
    loopP: 0.15,
    crossP: 0.7,
    edgesFirstP: 0.08,
    groups: { min: 2, max: 6, depth: 3, emptyP: 0.1, singleP: 0.2, titleMax: 40, untitledP: 0.15, coverage: 0.85 },
  }),
  hubs: def({
    topo: "hubs",
    nodes: [6, 15],
    maxEdges: 30,
    labelP: 0.7,
    mergeP: 0.6,
    groups: { min: 0, max: 0 },
  }),
  dense: def({
    gated: false,
    topo: "random",
    nodes: [12, 25],
    density: [2.5, 2.5],
    maxEdges: 70,
    labelP: 0.4,
    groups: { min: 0, max: 2, depth: 1 },
  }),
  "stress-60": def({
    gated: false,
    topo: "layered",
    nodes: [50, 70],
    density: [1.3, 1.3],
    maxEdges: 110,
    labelP: 0.3,
    groups: { min: 2, max: 4, depth: 2, coverage: 0.7 },
  }),
  tiny: def({
    topo: "tiny",
    nodes: [1, 3],
    maxEdges: 3,
    labelP: 0.5,
    loopP: 0.4,
    groups: { min: 0, max: 1, depth: 1 },
  }),
  unicode: def({
    nodes: [4, 10],
    density: [1, 1],
    maxEdges: 12,
    labelP: 0.8,
    unicodeP: 0.8,
    groups: { min: 0, max: 1, depth: 1 },
  }),
  // Only with --rtl: Arabic / Hebrew, combining marks and ZWJ emoji sequences. Report-only (Excalidraw's RTL text is uneven).
  "unicode-rtl": def({
    gated: false,
    rtlOnly: true,
    nodes: [4, 10],
    density: [1, 1],
    maxEdges: 12,
    labelP: 0.8,
    unicodeP: 0.85,
    rtl: true,
    groups: { min: 0, max: 1, depth: 1 },
  }),
};

export const PROFILE_ORDER = Object.keys(PROFILES);

/** Profiles that run by default (everything except `rtlOnly`). */
export const DEFAULT_PROFILES = PROFILE_ORDER.filter((p) => !PROFILES[p].rtlOnly);

// ---- vocabulary ----
export const NODE_WORDS = [
  "Client", "API", "Gateway", "Auth", "Cache", "Queue", "Worker", "Database", "Scheduler", "Router",
  "Parser", "Validator", "Billing", "Search", "Index", "Storage", "Notifier", "Mailer", "Logger", "Monitor",
  "Planner", "Executor", "Reviewer", "Loader", "Exporter", "Proxy", "Session", "Token", "Orders", "Users",
  "Payments", "Inventory", "Shipping", "Report", "Metrics", "Alerts", "Config", "Registry", "Broker", "Stream",
];

export const EDGE_WORDS = [
  "request", "response", "read", "write", "retry", "emit", "sync", "poll", "ack", "fail", "ok", "yes", "no",
  "validate", "publish", "subscribe", "fetch", "store", "route", "notify", "cache hit", "on error", "every 5s",
  "batch", "stream", "commit", "rollback", "timeout", "approve", "reject", "enqueue", "dispatch", "deploy",
  "trigger", "query", "update",
];

export const ID_WORDS = [
  "api", "db", "cache", "queue", "worker", "auth", "gw", "svc", "web", "app", "cron", "bus", "store", "ui",
  "mq", "lb", "cdn", "dns", "log", "mon", "job", "task", "rule", "step", "stage", "node_a", "edge_b",
];

export const GROUP_WORDS = ["Frontend", "Backend", "Data layer", "Edge", "Platform", "Workers", "Security", "Observability", "Tenant", "Region", "Pipeline", "Cluster", "Zone", "Core", "Services"];

export const UNICODE_POOLS = {
  cjk: ["用户", "接口", "数据库", "缓存", "队列", "服务", "认证", "日志", "请求", "结果", "ユーザー", "データ", "서버", "처리"],
  emoji: ["🚀", "💾", "✅", "❌", "👤", "🔥", "📨", "🌏", "⚙️"],
  rtl: ["مرحبا", "خدمة", "قاعدة البيانات", "שלום", "שרת", "מסד נתונים"],
  combining: ["école", "ñino", "äöü", "Z͡àl̨go"],
  zwj: ["👨‍👩‍👧", "🏳‍🌈", "👩‍💻"],
};
