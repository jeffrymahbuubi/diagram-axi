// Advance widths (in em) for code points the Excalifont/Cascadia metrics tables do not cover
// (outside U+0020-U+024F): CJK and fullwidth forms, emoji, and the other scripts that Excalidraw draws
// with the Xiaolai CJK fallback or a system font.
//
// The numbers are measured, not guessed: scripts/calibrate-text.mjs renders each sample with the real
// renderer (Chrome on Windows 11; font stack `Excalifont, Xiaolai, sans-serif, Segoe UI Emoji`) and reads
// the rendered text width. Per-script values are means over many glyphs, so a label is within a few
// percent and a single glyph can be off by more. Glyphs from system fonts (Arabic, Hebrew, Thai, symbols,
// emoji) vary a little by platform; emoji use one value between Windows (Segoe UI Emoji ~1.37 em) and
// Noto/Apple Color Emoji (~1.25 em) so a layout is the same on every machine.

/** Width of one emoji (a whole ZWJ / skin-tone / variation-selector sequence is one glyph). */
export const EMOJI_EM = 1.3;

export interface Advance {
  /** Advance in em. */
  em: number;
  /** Index of the first UTF-16 unit after the consumed code point(s). */
  next: number;
}

const EXT_PICTO = /\p{Extended_Pictographic}/u;
const MARK = /[\p{Mn}\p{Me}]/u;
const MARK_SPACING = /\p{Mc}/u;
const UPPER = /\p{Lu}/u;

/** Extended_Pictographic code points that render as plain text glyphs (not the emoji font). */
function textPictograph(cp: number): number | undefined {
  if (cp === 0x2194 || cp === 0x2195) return arrowEm(cp);
  if (cp === 0x2122) return 1.0; // TM
  if (cp === 0x25aa || cp === 0x25ab) return 0.35;
  if (cp >= 0x2660 && cp <= 0x2667) return 0.6; // card suits
  return undefined;
}

function arrowEm(cp: number): number {
  if (cp === 0x2190 || cp === 0x2192 || cp === 0x2194) return 1.0;
  if (cp === 0x2191 || cp === 0x2193 || cp === 0x2195) return 0.5;
  return 0.86;
}

/** Zero-advance code points: combining marks, joiners, variation selectors, tags, format controls. */
function isZeroWidth(cp: number): boolean {
  if (cp >= 0x200b && cp <= 0x200f) return true; // ZWSP, ZWNJ, ZWJ, LRM, RLM
  if (cp >= 0x202a && cp <= 0x202e) return true; // bidi embeddings
  if (cp >= 0x2060 && cp <= 0x206f) return true; // word joiner, invisible operators
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // variation selectors
  if (cp === 0xfeff) return true;
  if (cp >= 0xe0000 && cp <= 0xe01ef) return true; // tags, supplementary variation selectors
  return cp >= 0x300 && MARK.test(String.fromCodePoint(cp));
}

/** East Asian Wide / Fullwidth blocks: one em per glyph. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, ideographic space + CJK symbols and punctuation
    (cp >= 0x3041 && cp <= 0x312f) || // Hiragana, Katakana, Bopomofo
    (cp >= 0x3190 && cp <= 0x33ff) || // kanbun, CJK strokes, enclosed and compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xf900 && cp <= 0xfaff) || // compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff01 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3ffff) // Extensions B-G
  );
}

const isRegional = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff;

/** The em width of one non-table code point (never an emoji sequence), or undefined to use the average. */
function singleEm(cp: number): number | undefined {
  if (cp >= 0x250 && cp <= 0x2af) return 0.52; // IPA
  if (cp <= 0x2ff) return 0.3; // spacing modifiers
  if (cp >= 0x370 && cp <= 0x3ff) return UPPER.test(String.fromCodePoint(cp)) ? 0.69 : 0.52; // Greek
  if (cp >= 0x400 && cp <= 0x52f) return UPPER.test(String.fromCodePoint(cp)) ? 0.69 : 0.54; // Cyrillic
  if (cp >= 0x530 && cp <= 0x58f) return 0.62; // Armenian
  if (cp >= 0x590 && cp <= 0x5ff) return 0.5; // Hebrew
  if (cp >= 0x600 && cp <= 0x6ff) return cp >= 0x660 && cp <= 0x669 ? 0.53 : 0.33; // Arabic: joined forms are narrow
  if ((cp >= 0x750 && cp <= 0x77f) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return 0.33;
  if (cp >= 0x900 && cp <= 0x97f) return MARK_SPACING.test(String.fromCodePoint(cp)) ? 0.25 : 0.61; // Devanagari
  if (cp >= 0xe01 && cp <= 0xe5b) return 0.56; // Thai
  if (cp >= 0x1100 && cp <= 0x11ff) return 0.84; // Hangul Jamo
  if (cp >= 0x1e00 && cp <= 0x1eff) return UPPER.test(String.fromCodePoint(cp)) ? 0.69 : 0.56; // Latin Extended Additional
  if (cp >= 0x2000 && cp <= 0x200a) return 0.4; // spaces
  if (cp >= 0x2010 && cp <= 0x206f) return GENERAL_PUNCT[cp] ?? 0.5;
  if (cp >= 0x20a0 && cp <= 0x20cf) return 0.65; // currency
  if (cp >= 0x2100 && cp <= 0x214f) return 0.8; // letterlike
  if (cp >= 0x2190 && cp <= 0x21ff) return arrowEm(cp);
  if (cp >= 0x2200 && cp <= 0x22ff) return 0.6; // math operators
  if (cp >= 0x2300 && cp <= 0x23ff) return 0.8; // misc technical
  if (cp >= 0x2500 && cp <= 0x257f) return 0.73; // box drawing
  if (cp >= 0x2580 && cp <= 0x259f) return 0.75; // block elements
  if (cp >= 0x25a0 && cp <= 0x25ff) return cp === 0x25a0 || cp === 0x25a1 || cp === 0x25cb || cp === 0x25cf ? 0.6 : 0.9; // shapes
  if (cp >= 0x2600 && cp <= 0x27bf) return 0.8; // misc symbols, dingbats rendered as text
  if (cp >= 0x2b00 && cp <= 0x2bff) return 0.9;
  if (cp >= 0x3130 && cp <= 0x318f) return 0.84; // Hangul compatibility Jamo
  if (cp >= 0xac00 && cp <= 0xd7a3) return 0.92; // Hangul syllables
  if (cp >= 0xff61 && cp <= 0xffdc) return 0.5; // halfwidth katakana and Hangul
  if (cp >= 0xffe8 && cp <= 0xffee) return 0.5;
  return undefined;
}

const GENERAL_PUNCT: Record<number, number> = {
  0x2010: 0.4, 0x2011: 0.4, 0x2012: 0.55, 0x2013: 0.7, 0x2014: 0.94, 0x2015: 0.94,
  0x2018: 0.27, 0x2019: 0.3, 0x201a: 0.3, 0x201b: 0.27, 0x201c: 0.41, 0x201d: 0.43, 0x201e: 0.43,
  0x2020: 0.55, 0x2021: 0.56, 0x2022: 0.52, 0x2026: 0.71, 0x2030: 1.3, 0x2039: 0.51, 0x203a: 0.38,
};

/**
 * Advance of the code point `cp` at `line[i]` (a code point that is not in the font metrics table).
 * An emoji consumes its whole sequence (variation selectors, skin tones, ZWJ joins, keycaps, tags) and a
 * regional-indicator pair its two halves; `avgEm` is the fallback for scripts with no table here.
 */
export function extAdvance(line: string, i: number, cp: number, avgEm: number): Advance {
  const next = i + (cp > 0xffff ? 2 : 1);
  if (isRegional(cp)) {
    const nx = line.codePointAt(next);
    if (nx !== undefined && isRegional(nx)) return { em: 1.0, next: next + 2 }; // flag: Windows draws two letters
    return { em: 0.5, next };
  }
  if (isWide(cp) && cp !== 0x3099 && cp !== 0x309a) return { em: 1.0, next };
  if (isEmojiBase(line, cp, next)) return emojiSequence(line, next);
  if (isZeroWidth(cp)) return { em: 0, next };
  return { em: singleEm(cp) ?? avgEm, next };
}

/** True for an emoji that the emoji font draws: Extended_Pictographic, except symbols drawn as text. */
function isEmojiBase(line: string, cp: number, next: number): boolean {
  if (cp < 0x203c || !EXT_PICTO.test(String.fromCodePoint(cp))) return false;
  const text = textPictograph(cp);
  // A text symbol followed by VS16 is still requested as emoji.
  return text === undefined || line.charCodeAt(next) === 0xfe0f;
}

/** One glyph for the emoji plus everything that attaches to it. */
export function emojiSequence(line: string, from: number): Advance {
  let j = from;
  for (;;) {
    const c = line.codePointAt(j);
    if (c === undefined) break;
    const w = c > 0xffff ? 2 : 1;
    if (c === 0xfe0f || c === 0xfe0e || c === 0x20e3 || (c >= 0x1f3fb && c <= 0x1f3ff) || (c >= 0xe0020 && c <= 0xe007f)) {
      j += w;
    } else if (c === 0x200d) {
      const after = line.codePointAt(j + 1);
      if (after !== undefined && EXT_PICTO.test(String.fromCodePoint(after))) {
        j += 1 + (after > 0xffff ? 2 : 1);
      } else break;
    } else break;
  }
  return { em: EMOJI_EM, next: j };
}
