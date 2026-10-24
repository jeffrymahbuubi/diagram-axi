// Text measurement for CJK, emoji and other non-Latin scripts. The "actual" widths below were read from the
// real renderer (Chrome on Windows 11, 20 px Excalifont + Xiaolai + system fonts) with
// `node scripts/calibrate-text.mjs`; measure() must stay within 10% of them without a browser.

import { describe, expect, it } from "vitest";
import { measure, measureWrapped } from "../src/layout/measure.js";

const SIZE = 20;
const width = (text: string, size = SIZE): number => measure(text, size).width;

/** [label, text, rendered width in px at 20 px]. */
const CALIBRATION: Array<[string, string, number]> = [
  ["latin", "Hello World service", 177.46],
  ["latin-digits", "Order #1234 (v2.0)", 191.84],
  ["cjk", "中文区域", 80],
  ["cjk-long", "用户认证与授权服务模块", 220],
  ["trad-cjk", "客戶端", 60],
  ["hiragana", "こんにちは", 100],
  ["katakana", "カタカナテスト", 140],
  ["hangul", "안녕하세요 시스템", 155.47],
  ["mixed latin + cjk", "API 网关 Gateway", 180.08],
  ["mixed cjk + digits", "订单 #42 处理", 137.38],
  ["fullwidth", "ＡＢＣ１２３", 120],
  ["cjk punctuation", "你好，世界。「测试」", 200],
  ["cyrillic", "Привет мир сервис", 176.1],
  ["greek", "Αθήνα υπηρεσία", 144.38],
  ["arabic", "مرحبا بالعالم", 83.83],
  ["hebrew", "שלום עולם", 84.91],
  ["thai", "สวัสดีชาวโลก", 112.33],
  ["devanagari", "नमस्ते दुनिया", 103.51],
  ["latin-ext", "Žluťoučký kůň café", 187.2],
  ["emoji", "🚀", 27.47],
  ["emoji x3", "🚀🔥✅", 82.39],
  ["emoji in text", "Deploy 🚀 done ✅", 188.47],
  ["bmp emoji symbols", "⚠ ✔ ★ ☎", 123.05],
  ["zwj family", "👨‍👩‍👧", 25.06],
  ["skin tone", "👍🏽", 27.47],
  ["flags", "🇯🇵🇹🇼", 39.4],
  ["variation selector", "❤️ ☀️", 62.92],
  ["combining marks", "éà", 22.02],
  ["arrows and math", "→ ← ↔ ≤ ≥ ∑", 136.59],
];

describe("measure: calibrated against the real renderer", () => {
  it.each(CALIBRATION)("%s is within 10%% of the rendered width", (_label, text, actual) => {
    const ratio = width(text) / actual;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });
});

describe("measure: character classes", () => {
  it("measures East Asian wide and fullwidth characters at one em", () => {
    for (const ch of ["中", "愛", "あ", "ア", "ー", "，", "Ａ", "０", "、", "「", "㐀", "𠀀"]) {
      expect(width(ch), ch).toBe(SIZE);
    }
    expect(width("中文", 16)).toBe(32);
  });

  it("measures one emoji glyph per grapheme, ZWJ sequences and modifiers included", () => {
    const one = width("🚀");
    expect(one).toBeGreaterThanOrEqual(1.1 * SIZE);
    expect(one).toBeLessThanOrEqual(1.4 * SIZE);
    for (const seq of ["👨‍👩‍👧", "👩‍💻", "👍🏽", "👨🏽‍💻", "🏳️‍🌈", "❤️", "1️⃣", "✔️"]) {
      expect(width(seq), seq).toBe(one);
    }
    expect(width("🚀🚀")).toBe(2 * one);
    // A skin-tone modifier alone and a lone ZWJ are not sequences.
    expect(width("‍")).toBe(0);
  });

  it("treats combining marks, variation selectors and zero-width characters as zero width", () => {
    const e = width("e");
    expect(width("é")).toBe(e);
    expect(width("é̀")).toBe(e);
    expect(width("a​b")).toBe(width("ab"));
    expect(width("a️b")).toBe(width("ab"));
  });

  it("treats a regional-indicator pair as one flag, not two letters", () => {
    expect(width("🇯🇵")).toBeLessThan(2 * width("🚀"));
    expect(width("🇯🇵🇹🇼")).toBe(2 * width("🇯🇵"));
  });

  it("keeps Latin widths exact (no change from the font tables)", () => {
    expect(width("Hello World service")).toBeCloseTo(177.8, 1);
    expect(width("Žluťoučký kůň café")).toBeCloseTo(187.2, 1);
  });

  it("scales linearly with font size", () => {
    for (const text of ["中文", "🚀", "Привет", "mixed 中文 🚀"]) {
      expect(width(text, 40)).toBeCloseTo(2 * width(text, 20), 1);
    }
  });

  it("is deterministic and finite for arbitrary code points", () => {
    const odd = "\u{10FFFF}\u{E000}\uD800x\u{1F000}͸\u{2FFFF}";
    const w = width(odd);
    expect(Number.isFinite(w)).toBe(true);
    expect(w).toBe(width(odd));
  });

  it("measures wrapped CJK labels by the same widths", () => {
    const m = measureWrapped("订单 已处理 完成 订单 已处理 完成", 16, 100);
    expect(m.lines.length).toBeGreaterThan(1);
    expect(m.width).toBeGreaterThan(0);
  });
});
