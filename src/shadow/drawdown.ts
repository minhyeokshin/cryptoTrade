export class DrawdownTracker {
  peak: number;
  mdd = 0;
  current = 0;
  constructor(initial: number) {
    if (initial <= 0) throw new Error('Initial equity must be positive');
    this.peak = initial;
  }
  observe(equity: number): { current: number; mdd: number; peak: number } {
    if (!Number.isFinite(equity)) throw new Error('Invalid equity');
    this.peak = Math.max(this.peak, equity);
    this.current = Math.max(0, 1 - equity / this.peak);
    this.mdd = Math.max(this.mdd, this.current);
    return { current: this.current, mdd: this.mdd, peak: this.peak };
  }
}
