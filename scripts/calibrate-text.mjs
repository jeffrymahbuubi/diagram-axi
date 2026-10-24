// Calibrates src/layout/measure.ts against the real renderer: draws text elements with the installed
// browser (same page, fonts and route as `render`), injects the exported SVG and reads each text's
// rendered width, then prints measured-vs-actual per sample.
//
//   npm run build && node scripts/calibrate-text.mjs [--json] [--size 20] [--samples file.json] [--fonts-url none]
//
// Non-Latin glyphs outside Xiaolai (Arabic, Hebrew, Thai, emoji, ...) come from the system fonts, so the
// "actual" column for them is platform dependent (this tool reports the machine it runs on).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = pathToFileURL(join(root, "dist") + "/");
const imp = (p) => import(new URL(p, dist).href);
const { measure } = await imp("layout/measure.js");
const { findBrowser } = await imp("render/browser.js");
const { createFontLoader, parseFontsUrl } = await imp("render/fonts.js");
const { FONT_PATH, ORIGIN, PAGE_HTML } = await imp("render/page.js");

const args = process.argv.slice(2);
const flag = (n) => args.indexOf(`--${n}`);
const size = flag("size") >= 0 ? Number(args[flag("size") + 1]) : 20;
const fontsUrl = flag("fonts-url") >= 0 ? args[flag("fonts-url") + 1] : undefined;

const BUILTIN = [
  ["latin", "Hello World service"],
  ["latin-digits", "Order #1234 (v2.0)"],
  ["cjk-short", "中文"],
  ["cjk", "中文区域"],
  ["cjk-long", "用户认证与授权服务模块"],
  ["trad-cjk", "客戶端"],
  ["kana-hira", "こんにちは"],
  ["kana-kata", "カタカナテスト"],
  ["hangul", "안녕하세요 시스템"],
  ["mixed-lat-cjk", "API 网关 Gateway"],
  ["mixed-cjk-digits", "订单 #42 处理"],
  ["fullwidth", "ＡＢＣ１２３"],
  ["cjk-punct", "你好，世界。「测试」"],
  ["cyrillic", "Привет мир сервис"],
  ["greek", "Αθήνα υπηρεσία"],
  ["arabic", "مرحبا بالعالم"],
  ["hebrew", "שלום עולם"],
  ["thai", "สวัสดีชาวโลก"],
  ["devanagari", "नमस्ते दुनिया"],
  ["latin-ext", "Žluťoučký kůň café"],
  ["emoji-1", "🚀"],
  ["emoji-3", "🚀🔥✅"],
  ["emoji-text", "Deploy 🚀 done ✅"],
  ["emoji-bmp", "⚠ ✔ ★ ☎"],
  ["emoji-zwj", "👨‍👩‍👧"],
  ["emoji-skin", "👍🏽"],
  ["emoji-flag", "🇯🇵🇹🇼"],
  ["emoji-vs", "❤️ ☀️"],
  ["combining", "éà"],
  ["math-arrows", "→ ← ↔ ≤ ≥ ∑"],
];

const SAMPLES = flag("samples") >= 0 ? JSON.parse(readFileSync(args[flag("samples") + 1], "utf8")) : BUILTIN;

const fixture =JSON.parse(readFileSync(join(root, "test", "fixtures", "render-smoke.excalidraw"), "utf8"));
const proto = fixture.elements.find((e) => e.type === "text");
const elements = SAMPLES.map(([id, text], i) => ({
  ...proto,
  id: `s${i}`,
  index: `a${String(i).padStart(2, "0")}`,
  x: 0,
  y: i * 40,
  width: 100,
  height: size * 1.25,
  fontSize: size,
  text,
  originalText: text,
  containerId: null,
  autoResize: true,
  boundElements: null,
}));

const info = await findBrowser(process.env.DIAGRAM_AXI_BROWSER_PATH);
const fonts = createFontLoader({ mirrors: parseFontsUrl(fontsUrl), deadline: Date.now() + 60_000, distDirectory: dist });
const rendererSource = readFileSync(new URL("renderer.js", dist));
const browser = await (info.kind === "firefox" ? firefox : chromium).launch({
  executablePath: info.path,
  channel: info.kind === "firefox" ? "moz-firefox" : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ serviceWorkers: "block" });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: PAGE_HTML });
    if (url.pathname === "/renderer.js") return route.fulfill({ contentType: "text/javascript", body: rendererSource });
    if (FONT_PATH.test(url.pathname)) {
      const font = await fonts.load(url.pathname.slice("/fonts/".length, -".woff2".length));
      return font ? route.fulfill({ contentType: "font/woff2", body: font }) : route.abort();
    }
    return route.abort();
  });
  await page.goto(`${ORIGIN}/`);
  const actual = await page.evaluate(
    async ({ elements, moduleUrl }) => {
      const fontSet = document.fonts;
      const load = fontSet.load.bind(fontSet);
      fontSet.load = async (f, t) => {
        try {
          return await load(f, t);
        } catch (e) {
          await Promise.allSettled([...fontSet].filter((x) => x.status === "loading").map((x) => x.loaded));
          throw e;
        }
      };
      const { exportScene } = await new Function("u", "return import(u)")(moduleUrl);
      const svg = await exportScene({
        type: "svg",
        data: { elements, files: {}, appState: {} },
        config: { padding: 20, canvasBackgroundColor: "#fff", scale: 1, theme: "light" },
      });
      document.body.appendChild(svg);
      await document.fonts.ready;
      await Promise.allSettled([...document.fonts].filter((f) => f.status === "loading").map((f) => f.loaded));
      const out = [];
      svg.querySelectorAll("text").forEach((t) => out.push(t.getBBox().width));
      // Canvas measurement with the same stack, as a cross-check of the SVG number.
      const family = svg.querySelector("text")?.getAttribute("font-family");
      return { widths: out, family };
    },
    { elements, moduleUrl: `${ORIGIN}/renderer.js` },
  );
  const rows = SAMPLES.map(([id, text], i) => {
    const m = measure(text, size).width;
    const a = actual.widths[i];
    return { id, text, measured: m, actual: Math.round(a * 100) / 100, ratio: Math.round((m / a) * 1000) / 1000 };
  });
  if (flag("json") >= 0) console.log(JSON.stringify({ family: actual.family, size, rows }, null, 1));
  else {
    console.log(`font-family: ${actual.family}  size: ${size}px  browser: ${info.name}`);
    for (const r of rows) {
      const flagStr = Math.abs(r.ratio - 1) > 0.1 ? "  <-- >10%" : "";
      console.log(`${r.id.padEnd(17)} ${String(r.measured).padStart(8)} ${String(r.actual).padStart(8)} ${r.ratio.toFixed(3)}${flagStr}  ${r.text}`);
    }
  }
  if (fonts.warning()) console.log(`fonts: ${fonts.warning()}`);
} finally {
  await browser.close();
}
