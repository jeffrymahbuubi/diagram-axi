// Deterministic ids, seeds and fractional indices.

/** FNV-1a (32-bit) folded to 31 bits, so it is a positive int32 like Excalidraw seeds. */
export function fnv31(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}

/** Element ids derived from DSL ids (node and group ids live in separate namespaces). */
export const ids = {
  title: "title",
  node: (id: string) => `node-${id}`,
  nodeLabel: (id: string) => `label-${id}`,
  cap: (id: string) => `cap-${id}`,
  /** `zone-g-` vs `zone-title-`: a group called `title-a` must not share an id with the title text of group `a`. */
  zone: (id: string) => `zone-g-${id}`,
  zoneTitle: (id: string) => `zone-title-${id}`,
  edge: (index: number) => `edge-${index}`,
  edgeLabel: (index: number) => `edge-label-${index}`,
  /** groupIds entry shared by a zone, its title and everything inside it. */
  group: (id: string) => `group-${id}`,
  /** groupIds entry tying a cylinder body to its cap. */
  cylinder: (id: string) => `cyl-${id}`,
};

// ---- fractional indexing: port of rocicorp/fractional-indexing for the "append" case ----

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0]!;
const SMALLEST_INTEGER = "A00000000000000000000000000";

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const len = integerLength(key.charAt(0));
  if (len > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, len);
}

/** Increment the integer part of a key; undefined on overflow of the largest integer. */
function incrementInteger(x: string): string | undefined {
  const head = x.charAt(0);
  const digs = x.slice(1).split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) + 1;
    if (d === DIGITS.length) {
      digs[i] = ZERO;
    } else {
      digs[i] = DIGITS[d]!;
      carry = false;
    }
  }
  if (carry) {
    if (head === "Z") return "a" + ZERO;
    if (head === "z") return undefined;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > "a") digs.push(ZERO);
    else digs.pop();
    return h + digs.join("");
  }
  return head + digs.join("");
}

/** Key strictly after `a` (or the first key `a0` when `a` is null). */
export function keyAfter(a: string | null): string {
  if (a === null) return "a" + ZERO;
  const ia = integerPart(a);
  if (ia === SMALLEST_INTEGER) throw new Error("invalid order key");
  const next = incrementInteger(ia);
  if (next === undefined) throw new Error("order key overflow");
  return next;
}

/** `count` strictly increasing keys: a0, a1, ..., az, b00, b01, ... */
export function indexSequence(count: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    prev = keyAfter(prev);
    out.push(prev);
  }
  return out;
}
