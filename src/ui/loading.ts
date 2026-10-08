/**
 * The loading veil: the screen dims and a small label names what is loading, the moment a menu starts something heavy
 * (a new run, a reload, the next morning). It goes up before the main thread goes busy, so the press always answers at
 * once, and comes down with a short fade once the new scene has been drawn behind it.
 */

const CSS = `
#loadveil{position:fixed;inset:0;z-index:40;background:rgba(8,6,4,.9);opacity:0;transition:opacity .18s ease-out;pointer-events:auto;cursor:progress}
#loadveil.on{opacity:1}
#loadveil.out{transition:opacity .45s ease-in;opacity:0}
#loadveil .lv-box{position:absolute;right:calc(36px * var(--u, 1));bottom:calc(30px * var(--u, 1));min-width:calc(190px * var(--u, 1));text-align:right}
#loadveil .lv-what{font:500 calc(15px * var(--u, 1)) var(--font, sans-serif);letter-spacing:.24em;color:var(--paper-dim, #c9bd9f);text-transform:uppercase}
#loadveil .lv-word{font:500 calc(12px * var(--u, 1)) var(--mono, monospace);letter-spacing:.3em;color:var(--amber, #ffb454);margin-bottom:6px}
#loadveil .lv-bar{margin-top:8px;height:2px;background:rgba(255,180,84,.18);overflow:hidden}
#loadveil .lv-bar i{display:block;height:100%;width:34%;background:var(--amber, #ffb454);animation:lvslide 1.1s ease-in-out infinite}
@keyframes lvslide{0%{transform:translateX(-110%)}100%{transform:translateX(310%)}}
@media (prefers-reduced-motion: reduce){#loadveil .lv-bar i{animation:none;width:100%;opacity:.5}}
`;

let styled = false;

export class LoadingVeil {
  private el: HTMLElement | null = null;
  private hideTimer = 0;

  get visible() {
    return !!this.el && !this.el.classList.contains('out');
  }

  show(label: string) {
    if (typeof document === 'undefined') return;
    if (!styled) {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
      styled = true;
    }
    clearTimeout(this.hideTimer);
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.id = 'loadveil';
      this.el.setAttribute('role', 'status');
      this.el.setAttribute('aria-live', 'polite');
      document.body.appendChild(this.el);
    }
    this.el.innerHTML = `<div class="lv-box"><div class="lv-word">LOADING</div><div class="lv-what"></div><div class="lv-bar"><i></i></div></div>`;
    this.el.querySelector('.lv-what')!.textContent = label;
    this.el.classList.remove('out');
    this.el.style.pointerEvents = '';
    // Read layout once, so the fade-in transition runs from 0 rather than starting at the end.
    void this.el.offsetWidth;
    this.el.classList.add('on');
  }

  hide() {
    const el = this.el;
    if (!el) return;
    el.classList.add('out');
    el.style.pointerEvents = 'none';
    this.hideTimer = window.setTimeout(() => {
      if (this.el !== el) return;
      el.remove();
      this.el = null;
    }, 480);
  }
}
