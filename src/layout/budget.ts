// Deterministic work budget for the layout. The expensive searches (A* expansions, repair candidates,
// label slot scans, whole-layout retries) charge abstract work units here instead of reading a clock,
// so a layout is cut off at the same point on every machine and its output stays byte-identical.
// A search that finds the budget exhausted stops and keeps the best result it has; nothing throws.

export class Budget {
  /** Units charged so far. */
  spent = 0;
  /** Units charged per unit of work: the strict profile's scans cost more wall time per unit than the legacy ones (dagre-layout.ts). */
  weight = 1;
  constructor(public limit: number) {}

  get exhausted(): boolean {
    return this.spent >= this.limit;
  }

  spend(units: number): void {
    this.spent += units * this.weight;
  }
}
