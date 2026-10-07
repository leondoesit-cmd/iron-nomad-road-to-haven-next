/** Optional work shares a single wall-time allowance across all simulation ticks of a rendered frame. */
export class FrameBudget {
  spent = 0;
  reset() { this.spent = 0; }
  available(limit: number) { return this.spent < limit; }
  charge(milliseconds: number) { this.spent += Math.max(0, milliseconds); }
}
