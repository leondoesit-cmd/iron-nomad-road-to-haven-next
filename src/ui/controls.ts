import {
  ACTION_BY_ID,
  PAD_RESERVED,
  SHARED,
  actionsFor,
  assignBinding,
  clearBinding,
  defaultBindings,
  isReservedKey,
  keyLabel,
  mouseLabel,
  padLabel,
  type ActionDef,
  type ActionId,
  type Device,
} from '../input/bindings';
import { Btn, wasPressed } from '../input/intents';
import { FocusUI, type FocusItem } from './focus';
import type { Game } from '../game/game';

type Tab = 'pad' | 'kb0' | 'kb1' | 'mouse' | 'play';

const TABS: { id: Tab; label: string }[] = [
  { id: 'pad', label: 'Gamepad' },
  { id: 'kb0', label: 'Keyboard 1' },
  { id: 'kb1', label: 'Keyboard 2' },
  { id: 'mouse', label: 'Mouse' },
  { id: 'play', label: 'Camera & play' },
];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const pct = (v: number) => `${Math.round(v * 100)}%`;
const round = (v: number) => Math.round(v * 100) / 100;

/** One -/+ row in a tab: a name, the current value and a way to step it. */
interface Opt {
  id: string;
  label: string;
  value: () => string;
  step: (dir: number) => void;
}

/**
 * The control settings screen: rebind every action for the gamepad, both keyboard layouts and the mouse, and set the
 * look, camera and crouch options that go with them. Opened from the title and the pause menu.
 */
export class ControlsMenu {
  private tab: Tab = 'pad';
  private status = '';

  constructor(private game: Game) {}

  show(host: HTMLElement, fc: FocusUI, back: () => void) {
    const g = this.game;
    const input = g.input;
    const solo = g.solo;
    const seats = solo ? [0] : [0, 1];
    // Open on the tab for whatever the first seat is playing with.
    const first = input.slots[0];
    this.tab = first?.kind === 'kb' ? (first.set === 1 ? 'kb0' : 'kb1') : 'pad';
    this.status = '';
    const prevCancel = fc.onCancel;
    const prevActive = fc.active;
    const prevTick = fc.onTick;

    const seatName = (i: number, name: string) => (solo ? name : `P${i + 1} ${name.toLowerCase()}`);
    const num = (id: string, label: string, get: () => number, set: (v: number) => void, step: number, lo: number, hi: number, fmt: (v: number) => string = pct): Opt => ({
      id,
      label,
      value: () => fmt(get()),
      step: (dir) => set(clamp(round(get() + dir * step), lo, hi)),
    });
    const flag = (id: string, label: string, get: () => boolean, set: (v: boolean) => void, on: string, off: string): Opt => ({
      id,
      label,
      value: () => (get() ? on : off),
      step: () => set(!get()),
    });
    const perSeat = (id: string, label: string, make: (i: number) => Omit<Opt, 'id' | 'label'>): Opt[] =>
      seats.map((i) => ({ id: `${id}${i}`, label: seatName(i, label), ...make(i) }));
    const st = () => input.settings;

    const invert = perSeat('inv', 'Invert look Y', (i) => ({ value: () => (st().invertLookY[i] ? 'ON' : 'OFF'), step: () => (st().invertLookY[i] = !st().invertLookY[i]) }));
    const options = (): Opt[] => {
      switch (this.tab) {
        case 'pad':
          return [
            num('dz', 'Stick deadzone', () => st().deadzone, (v) => (st().deadzone = v), 0.05, 0.05, 0.4),
            ...perSeat('ls', 'Look sensitivity', (i) => {
              const o = num('', '', () => st().lookSens[i], (v) => (st().lookSens[i] = v), 0.1, 0.4, 2.5);
              return { value: o.value, step: o.step };
            }),
            ...perSeat('sp', 'Sprint', (i) => ({ value: () => (st().toggleSprint[i] ? 'CLICK ONCE' : 'HOLD'), step: () => (st().toggleSprint[i] = !st().toggleSprint[i]) })),
            ...invert,
          ];
        case 'kb0':
        case 'kb1':
          return [num('kt', 'Look key turn speed', () => st().keyTurn, (v) => (st().keyTurn = v), 0.1, 0.4, 2.5)];
        case 'mouse':
          return [num('ms', 'Mouse / trackpad sensitivity', () => st().mouseSens, (v) => (st().mouseSens = v), 0.1, 0.2, 3), ...invert];
        case 'play':
          return [
            // On foot the view is always the eyes; in a vehicle it is the seat's choice, and this is where it starts.
            ...perSeat('vw', 'Vehicle camera', (i) => ({
              value: () => (st().vehicleView[i] === 'first' ? 'FIRST PERSON' : 'THIRD PERSON'),
              step: () => {
                st().vehicleView[i] = st().vehicleView[i] === 'first' ? 'third' : 'first';
                const p = g.scene?.players[i];
                if (p) p.viewFirst = st().vehicleView[i] === 'first';
              },
            })),
            num('cfov', 'Field of view', () => st().chaseFov, (v) => (st().chaseFov = v), 5, 70, 130, (v) => `${Math.round(v)}°`),
            num('fov', 'First-person field of view', () => st().fpFov, (v) => (st().fpFov = v), 5, 70, 120, (v) => `${Math.round(v)}°`),
            num('lens', 'Bodycam lens (first person)', () => st().fpLens, (v) => (st().fpLens = v), 0.1, 0, 1, (v) => (v < 0.01 ? 'OFF' : `${Math.round(v * 100)}%`)),
            ...perSeat('cr', 'Crouch', (i) => ({ value: () => (st().toggleCrouch[i] ? 'TOGGLE' : 'HOLD'), step: () => (st().toggleCrouch[i] = !st().toggleCrouch[i]) })),
          ];
      }
    };

    // --------------------------------------------------------------- bindings per tab
    const device = (): Device => (this.tab === 'pad' ? 'pad' : this.tab === 'mouse' ? 'mouse' : 'kb');
    const kbSet = (): 0 | 1 => (this.tab === 'kb1' ? 1 : 0);
    const rows = (): ActionDef[] => (this.tab === 'play' ? [] : actionsFor(device()));

    /** What the binding button shows for an action on the current tab. */
    const bound = (a: ActionDef): string => {
      const b = input.settings.bindings;
      if (this.tab === 'pad') {
        const v = b.pad[a.id];
        if (a.id === 'view' && v === SHARED) return `${padLabel(b.pad.sheet)} · tap`;
        if (a.id === 'sheet' && b.pad.view === SHARED) return `${padLabel(v)} · hold`;
        return padLabel(v);
      }
      if (this.tab === 'mouse') return mouseLabel(b.mouse[a.id]);
      return keyLabel(b.kb[kbSet()][a.id]);
    };

    const startBind = (a: ActionDef) => {
      const dev = device();
      const word = dev === 'pad' ? 'a gamepad button' : dev === 'kb' ? 'a key' : 'a mouse button';
      const extra = dev === 'pad' ? 'Start cancels' : a.optional ? 'Esc cancels · Del unbinds' : 'Esc cancels';
      const cover = document.createElement('div');
      cover.className = 'capture';
      cover.innerHTML = `<div><b>Press ${word} for ${a.label}</b><br><small>${extra}</small></div>`;
      host.appendChild(cover);
      const finish = (msg: string) => {
        cover.remove();
        this.status = msg;
        const keys = fc.keys();
        render();
        fc.setItems(makeItems(), keys);
      };
      input.captureNext(dev, (r) => {
        if (r === 'cancel') return finish('');
        const b = input.settings.bindings;
        const map = dev === 'pad' ? b.pad : dev === 'mouse' ? b.mouse : b.kb[kbSet()];
        if (r === 'clear') {
          const ok = clearBinding(dev, map as Partial<Record<ActionId, number | string>>, a.id);
          input.bindingsChanged();
          input.onChange();
          return finish(ok ? `${a.label} unbound` : `${a.label} has to stay bound`);
        }
        if (dev === 'pad' && typeof r.value === 'number' && PAD_RESERVED.has(r.value)) return finish('Start is kept for pausing');
        if (dev === 'kb' && typeof r.value === 'string' && isReservedKey(r.value)) return finish(`${keyLabel(r.value)} is reserved: pick another key`);
        const moved = assignBinding(dev, map as Partial<Record<ActionId, number | string>>, a.id, r.value);
        input.bindingsChanged();
        input.onChange();
        g.audio.play('confirm');
        finish(moved ? `${a.label} set. ${ACTION_BY_ID[moved].label} took the old one.` : `${a.label} set`);
      });
    };

    const reset = () => {
      const d = defaultBindings();
      const b = input.settings.bindings;
      if (this.tab === 'pad') b.pad = d.pad;
      else if (this.tab === 'mouse') b.mouse = d.mouse;
      else if (this.tab === 'kb0') b.kb[0] = d.kb[0];
      else if (this.tab === 'kb1') b.kb[1] = d.kb[1];
      else {
        const s = input.settings;
        s.invertLookY = [false, false];
        s.toggleCrouch = [true, true];
        s.toggleSprint = [true, true];
        s.fpFov = 100;
        s.chaseFov = 110;
        s.fpLens = 0.7;
        s.vehicleView = ['third', 'third'];
        for (const p of g.scene?.players ?? []) p.viewFirst = false;
      }
      input.bindingsChanged();
      input.onChange();
      g.audio.play('click');
      this.status = 'Back to the defaults';
    };

    // --------------------------------------------------------------- drawing
    const render = () => {
      const opts = options();
      const optRow = (o: Opt) =>
        `<div class="item"><span>${o.label}</span><span style="display:flex;gap:6px;align-items:center"><button data-fid="${o.id}-" style="padding:0 8px">-</button><span style="min-width:110px;text-align:center;font-family:var(--mono)">${o.value()}</span><button data-fid="${o.id}+" style="padding:0 8px">+</button></span></div>`;
      const bindRow = (a: ActionDef) =>
        `<div class="item bind"><span class="aname">${a.label}<small>${a.hint}</small></span><button class="bindbtn" data-fid="bind:${a.id}">${bound(a)}</button></div>`;
      const note =
        this.tab === 'pad'
          ? 'Left stick moves and steers, right stick looks. On a pad, view and the convoy sheet share Back by default: tap it to switch view, hold it for the sheet. Sprint is one click of the left stick.'
          : this.tab === 'mouse'
            ? 'Click the game to capture the mouse. Moving looks around. Trackpads have left and right clicks only.'
            : this.tab === 'play'
              ? 'On foot you always see through your own eyes. The vehicle camera also switches in play with the view button. These settings apply to the seat named.'
              : this.tab === 'kb0'
                ? 'Keyboard 1 joins with its fire key. Both layouts work in solo.'
                : 'Keyboard 2 joins with its fire key. Both layouts work in solo.';
      host.innerHTML = `<div class="menu cmenu"><h2>Control settings</h2>
        <div class="ctabs">${TABS.map((t) => `<button class="ctab${t.id === this.tab ? ' on' : ''}" data-fid="tab:${t.id}">${t.label}</button>`).join('')}</div>
        <p class="cnote">${note}</p>
        <div class="list scroll">${rows().map(bindRow).join('')}${opts.map(optRow).join('')}</div>
        <div class="item foot"><span><button data-fid="reset">Reset this tab</button> <button data-fid="back">Back</button></span><span class="cstatus">${this.status || '&nbsp;'}</span></div>
      </div>`;
      host.querySelectorAll<HTMLElement>('.menu button, .menu .scroll').forEach((b) => (b.style.pointerEvents = 'auto'));
    };

    const q = (k: string) => host.querySelector<HTMLElement>(`[data-fid="${CSS.escape(k)}"]`)!;

    const makeItems = (): FocusItem[] => {
      const items: FocusItem[] = [];
      for (const t of TABS) items.push({ el: q(`tab:${t.id}`), press: () => switchTab(t.id) });
      for (const a of rows()) items.push({ el: q(`bind:${a.id}`), press: () => startBind(a) });
      for (const o of options()) {
        items.push({ el: q(`${o.id}-`), press: () => stepOpt(o, -1) });
        items.push({ el: q(`${o.id}+`), press: () => stepOpt(o, 1) });
      }
      items.push({ el: q('reset'), press: () => (reset(), refresh()) });
      items.push({ el: q('back'), press: () => done() });
      return items.filter((i) => i.el);
    };

    const refresh = () => {
      const keys = fc.keys();
      render();
      fc.setItems(makeItems(), keys);
    };
    const stepOpt = (o: Opt, dir: number) => {
      o.step(dir);
      input.onChange();
      g.audio.play('click');
      this.status = '';
      refresh();
    };
    const switchTab = (t: Tab) => {
      if (t === this.tab) return;
      this.tab = t;
      this.status = '';
      g.audio.play('click');
      render();
      const cur = TABS.findIndex((x) => x.id === t);
      fc.setItems(makeItems());
      fc.cursor = [cur, cur];
    };

    const done = () => {
      input.cancelCapture();
      fc.onCancel = prevCancel;
      fc.onTick = prevTick;
      fc.active = prevActive;
      back();
    };

    fc.active = true;
    fc.onCancel = () => {
      if (!input.capturing) done();
    };
    // LB / RB flip tabs, as in the ledger.
    fc.onTick = (inp) => {
      if (input.capturing) return;
      for (let p = 0; p < 2; p++) {
        const it = inp.intents[p];
        if (it.device === 'none') continue;
        const i = TABS.findIndex((x) => x.id === this.tab);
        if (wasPressed(it, Btn.LB)) switchTab(TABS[(i + TABS.length - 1) % TABS.length].id);
        else if (wasPressed(it, Btn.RB)) switchTab(TABS[(i + 1) % TABS.length].id);
      }
    };
    render();
    fc.setItems(makeItems());
    // Start on the bindings of the first tab, not on a tab button.
    const firstBind = TABS.length;
    fc.cursor = [firstBind, firstBind];
  }
}
