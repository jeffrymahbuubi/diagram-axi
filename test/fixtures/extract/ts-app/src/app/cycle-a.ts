import { pingB } from "./cycle-b.js";

export function pingA(n: number): number {
  return n > 0 ? pingB(n - 1) : 0;
}
