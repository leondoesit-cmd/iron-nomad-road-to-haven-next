/** Existing quality levels, with time hysteresis so resizing GPU targets cannot chase every frame. */
export class AdaptiveResolution {
  private ema = 16;
  private pressure = 0;
  private direction = 0;

  reset() { this.ema = 16; this.pressure = 0; this.direction = 0; }

  update(frameMs: number, scale: number): number {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return scale;
    this.ema += (frameMs - this.ema) * 0.06;
    const direction = this.ema > 21 && scale > 0.6 ? -1 : this.ema < 15.5 && scale < 1 ? 1 : 0;
    if (direction !== this.direction) this.pressure = 0;
    this.direction = direction;
    // A paused/tab-throttled frame must not exhaust the settling interval by itself.
    this.pressure += Math.min(frameMs, 50);
    if (!direction || this.pressure < (direction < 0 ? 250 : 500)) return scale;
    this.pressure = 0;
    return Math.max(0.6, Math.min(1, Math.round((scale + direction * 0.05) * 20) / 20));
  }
}
