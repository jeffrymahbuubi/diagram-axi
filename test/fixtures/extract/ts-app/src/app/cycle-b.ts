import { pingA } from "./cycle-a.js";

export function pingB(n: number): number {
  return n > 0 ? pingA(n - 1) : 0;
}
