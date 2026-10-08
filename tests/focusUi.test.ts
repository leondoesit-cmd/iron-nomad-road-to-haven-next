import { describe, expect, it } from 'vitest';
import { FocusUI, type FocusItem } from '../src/ui/focus';
import { Btn, NAV, newIntent } from '../src/input/intents';
import type { InputManager } from '../src/input/input';

// Shared menu focus (`ui/focus.ts`): the rings move as they should, and an idle menu costs no DOM writes per tick.

/** Just enough of an element: a class list that counts its writes, a box, a data key and a click listener. */
function fakeEl(fid: string, x: number, y: number, writes: { n: number }) {
  const classes = new Set<string>();
  const listeners: (() => void)[] = [];
  return {
    dataset: { fid },
    isConnected: true,
    classList: {
      add: (...c: string[]) => {
        writes.n++;
        for (const k of c) classes.add(k);
      },
      remove: (...c: string[]) => {
        writes.n++;
        for (const k of c) classes.delete(k);
      },
      contains: (c: string) => classes.has(c),
    },
    has: (c: string) => classes.has(c),
    getBoundingClientRect: () => ({ left: x, top: y, width: 80, height: 30 }),
    addEventListener: (_: string, h: () => void) => listeners.push(h),
    removeEventListener: () => {},
    click: () => listeners.forEach((h) => h()),
  };
}
type El = ReturnType<typeof fakeEl>;

function menu(n: number, writes = { n: 0 }) {
  // A column of buttons, 50 px apart.
  const els = Array.from({ length: n }, (_, i) => fakeEl(`b${i}`, 100, i * 50, writes));
  const pressed: string[] = [];
  const items: FocusItem[] = els.map((el) => ({ el: el as unknown as HTMLElement, press: (p) => void pressed.push(`${el.dataset.fid}:${p}`) }));
  return { els, items, pressed, writes };
}

function input() {
  const intents = [newIntent(), newIntent()];
  intents[0].device = 'keyboard';
  intents[1].device = 'pad';
  return { intents, rumble: () => {} } as unknown as InputManager & { intents: ReturnType<typeof newIntent>[] };
}

const ringOf = (els: El[], p: number) => els.findIndex((e) => e.has(`f${p}`));

describe('menu focus', () => {
  it('draws each ring once and writes nothing more while the menu sits still', () => {
    const m = menu(6);
    const f = new FocusUI();
    f.active = true;
    f.setItems(m.items);
    expect(ringOf(m.els, 0)).toBe(0);
    expect(ringOf(m.els, 1)).toBe(0);
    const inp = input();
    m.writes.n = 0;
    for (let i = 0; i < 300; i++) f.update(inp);
    expect(m.writes.n).toBe(0);
  });

  it('moves a ring to the nearest item in the pressed direction, and only that ring', () => {
    const m = menu(4);
    const f = new FocusUI();
    f.active = true;
    f.setItems(m.items);
    const inp = input();
    inp.intents[0].nav = NAV.down;
    f.update(inp);
    inp.intents[0].nav = 0;
    expect(f.cursor[0]).toBe(1);
    expect(ringOf(m.els, 0)).toBe(1);
    expect(ringOf(m.els, 1)).toBe(0);
    // Nothing further down past the last one; nothing above the first.
    inp.intents[1].nav = NAV.up;
    f.update(inp);
    expect(f.cursor[1]).toBe(0);
    // Each element carries only the ring of whoever is on it.
    expect(m.els.filter((e) => e.has('f0')).length).toBe(1);
    expect(m.els.filter((e) => e.has('f1')).length).toBe(1);
  });

  it('confirms with A (and fire on a keyboard), cancels with B', () => {
    const m = menu(3);
    const f = new FocusUI();
    let cancelled = -1;
    f.onCancel = (p) => (cancelled = p);
    f.active = true;
    f.setItems(m.items);
    f.cursor = [2, 1];
    const inp = input();
    inp.intents[0].pressed = 1 << Btn.RT;
    inp.intents[1].pressed = 1 << Btn.A;
    f.update(inp);
    expect(m.pressed).toEqual(['b2:0', 'b1:1']);
    inp.intents[0].pressed = 0;
    inp.intents[1].pressed = 1 << Btn.B;
    f.update(inp);
    expect(cancelled).toBe(1);
  });

  it('shows one ring for a menu with an owner, and for one seat', () => {
    const m = menu(3);
    const f = new FocusUI();
    f.active = true;
    f.owner = 1;
    f.cursor = [0, 2];
    f.setItems(m.items);
    expect(ringOf(m.els, 0)).toBe(-1);
    expect(ringOf(m.els, 1)).toBe(2);
    f.owner = null;
    f.seats = 1;
    f.paint();
    expect(ringOf(m.els, 0)).toBe(0);
    expect(ringOf(m.els, 1)).toBe(-1);
    // Inactive: no rings at all.
    f.active = false;
    f.paint();
    expect(m.els.some((e) => e.has('f0') || e.has('f1'))).toBe(false);
  });

  it('keeps focus by key across a re-render and draws the ring on the new element', () => {
    const a = menu(4);
    const f = new FocusUI();
    f.active = true;
    f.setItems(a.items);
    f.cursor = [2, 3];
    f.paint();
    const keys = f.keys();
    const b = menu(4);
    f.setItems(b.items, keys);
    expect(f.cursor).toEqual([2, 3]);
    expect(ringOf(b.els, 0)).toBe(2);
    expect(ringOf(b.els, 1)).toBe(3);
    // A click acts for player one.
    b.els[1].click();
    expect(b.pressed).toEqual(['b1:0']);
    f.clear();
    expect(b.els.some((e) => e.has('f0') || e.has('f1'))).toBe(false);
  });
});
