import { Btn, NAV, wasPressed } from '../input/intents';
import type { InputManager } from '../input/input';

export interface FocusItem {
  el: HTMLElement;
  /** Called when a player presses A on this item (or clicks it with the mouse as player 0). */
  press: (player: number) => void;
  disabled?: boolean;
}

/**
 * Shared menus with two coloured cursors. Each player moves their own focus ring with the stick, D-pad or move keys
 * and presses A (or the interact / fire key) to act. Cancel (B) is delivered to `onCancel`.
 */
export class FocusUI {
  items: FocusItem[] = [];
  cursor: [number, number] = [0, 0];
  active = false;
  /** Cursors shown: 1 when playing solo, so no second ring sits on a button nobody controls. */
  seats: 1 | 2 = 2;
  /** When set, only this player has a cursor: a menu that belongs to one person (an inventory) ignores the other pad. */
  owner: number | null = null;
  onCancel: (player: number) => void = () => {};
  /** Extra per-tick hook so panels can read other buttons (e.g. LB/RB tab switching). */
  onTick: ((input: InputManager) => void) | null = null;
  private clickHandlers = new WeakMap<HTMLElement, (e: MouseEvent) => void>();

  setItems(items: FocusItem[], keepFocusByKey?: (string | null)[]) {
    this.items = items.filter((i) => i.el.isConnected);
    for (let p = 0; p < 2; p++) {
      if (keepFocusByKey && keepFocusByKey[p]) {
        const idx = this.items.findIndex((i) => i.el.dataset.fid === keepFocusByKey[p]);
        if (idx >= 0) this.cursor[p] = idx;
      }
      this.cursor[p] = Math.min(this.cursor[p], Math.max(0, this.items.length - 1));
    }
    for (const it of this.items) {
      it.el.classList.add('focusable');
      const prev = this.clickHandlers.get(it.el);
      if (prev) it.el.removeEventListener('click', prev);
      const h = () => {
        if (!it.disabled) it.press(0);
      };
      this.clickHandlers.set(it.el, h);
      it.el.addEventListener('click', h);
    }
    this.paint();
  }

  /** Keys of the currently focused elements, for re-focusing after a re-render. */
  keys(): (string | null)[] {
    return [0, 1].map((p) => this.items[this.cursor[p]]?.el.dataset.fid ?? null);
  }

  clear() {
    for (const it of this.items) it.el.classList.remove('focusable', 'f0', 'f1');
    this.items = [];
  }

  paint() {
    for (const it of this.items) it.el.classList.remove('f0', 'f1');
    for (let p = 0; p < this.seats; p++) {
      if (!this.active || (this.owner !== null && p !== this.owner)) continue;
      const cur = this.items[this.cursor[p]];
      cur?.el.classList.add(`f${p}`);
    }
  }

  private move(p: number, dir: number) {
    const cur = this.items[this.cursor[p]];
    if (!cur) return;
    const r = cur.el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best = -1;
    let bs = Infinity;
    this.items.forEach((it, i) => {
      if (i === this.cursor[p]) return;
      const b = it.el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return;
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      const dx = bx - cx;
      const dy = by - cy;
      let along = 0;
      let across = 0;
      if (dir === NAV.up) {
        along = -dy;
        across = dx;
      } else if (dir === NAV.down) {
        along = dy;
        across = dx;
      } else if (dir === NAV.left) {
        along = -dx;
        across = dy;
      } else {
        along = dx;
        across = dy;
      }
      if (along <= 4) return;
      const score = along + Math.abs(across) * 2.4;
      if (score < bs) {
        bs = score;
        best = i;
      }
    });
    if (best >= 0) {
      this.cursor[p] = best;
      // Long menus scroll: keep the focused row in view.
      this.items[best].el.scrollIntoView?.({ block: 'nearest' });
    }
  }

  /** Call every fixed tick while the menu is open. */
  update(input: InputManager) {
    if (!this.active) return;
    for (let p = 0; p < 2; p++) {
      if (this.owner !== null && p !== this.owner) continue;
      const it = input.intents[p];
      if (it.device === 'none') continue;
      for (const d of [NAV.up, NAV.down, NAV.left, NAV.right]) {
        if (it.nav & d) {
          this.move(p, d);
          input.rumble(p, 0, 0.05, 20);
        }
      }
      const confirm = wasPressed(it, Btn.A) || (it.device === 'keyboard' && wasPressed(it, Btn.RT));
      if (confirm) {
        const cur = this.items[this.cursor[p]];
        if (cur && !cur.disabled) cur.press(p);
      }
      if (wasPressed(it, Btn.B)) this.onCancel(p);
    }
    this.onTick?.(input);
    this.paint();
  }
}
