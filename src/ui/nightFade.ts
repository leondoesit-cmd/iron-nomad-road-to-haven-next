/**
 * The short fade to black while a night is slept through: the screen dims with a line of text, holds while the camp is made
 * ready, and lifts on the dawn report. Plain DOM with inline styles, over the game and the HUD but under the menus.
 */
export class NightFade {
  private el: HTMLElement | null = null;
  private text: HTMLElement | null = null;
  /** Seconds it takes to go dark, and to lift again. */
  static readonly IN = 0.9;
  static readonly OUT = 1.1;

  private ensure(): HTMLElement | null {
    if (this.el) return this.el;
    const host = typeof document !== 'undefined' ? document.getElementById?.('ui') : null;
    if (!host) return null;
    const el = document.createElement('div');
    el.className = 'nightfade';
    el.style.cssText =
      'position:absolute;inset:0;background:#050403;opacity:0;pointer-events:none;display:flex;align-items:center;justify-content:center;' +
      `transition:opacity ${NightFade.IN}s ease-in`;
    const t = document.createElement('div');
    t.style.cssText = 'font-family:Oswald,sans-serif;font-size:clamp(14px,1.6vw,22px);letter-spacing:.22em;text-transform:uppercase;color:#c9bd9f;opacity:.85';
    el.appendChild(t);
    // Over the HUD halves (the game hides those while the night passes) and under the overlay root, where the dawn report is
    // drawn: positioned siblings with no z-index paint in document order.
    const overlay = document.getElementById('overlay');
    host.insertBefore(el, overlay);
    this.el = el;
    this.text = t;
    return el;
  }

  /** Go dark, with a line of text in the middle. */
  show(text: string) {
    const el = this.ensure();
    if (!el || !this.text) return;
    this.text.textContent = text;
    el.style.transition = `opacity ${NightFade.IN}s ease-in`;
    // Read back so the change from 0 is a transition, not a jump.
    void el.offsetWidth;
    el.style.opacity = '1';
  }

  /** Lift again, slowly, onto whatever is behind it now. */
  hide() {
    const el = this.el;
    if (!el) return;
    el.style.transition = `opacity ${NightFade.OUT}s ease-out`;
    el.style.opacity = '0';
  }

  /** Gone at once (a quit to the title mid-fade). */
  clear() {
    if (!this.el) return;
    this.el.style.transition = 'none';
    this.el.style.opacity = '0';
  }
}
