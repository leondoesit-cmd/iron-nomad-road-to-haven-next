import { Btn, BTN_COUNT, NAV, newIntent, type PlayerIntent } from './intents';
import { radialDeadzone, clamp } from '../core/math';
import {
  ACTION_BY_ID,
  PROMPT_ACTION,
  actionsFor,
  defaultBindings,
  exportBindings,
  importBindings,
  keyLabel,
  live,
  mouseShort,
  padLabel,
  padPhysical,
  viewSharesSheet,
  type ActionId,
  type Bindings,
} from './bindings';

export type Slot = { kind: 'pad'; index: number } | { kind: 'kb'; set: 1 | 2 };

export interface Settings {
  /** Per-player options, per the pause menu. */
  rumble: [boolean, boolean];
  aimAssist: [number, number];
  invertLookY: [boolean, boolean];
  /** Mouse / trackpad look multiplier for the keyboard seat. */
  mouseSens: number;
  /** Hold (false) or toggle (true) for crouch / headlights. */
  toggleCrouch: [boolean, boolean];
  /** Gamepad sprint: one click of the stick keeps sprinting until you stop (true), or hold it down (false). */
  toggleSprint: [boolean, boolean];
  deadzone: number;
  /** Right-stick look speed per seat. */
  lookSens: [number, number];
  /** Turn speed of the keyboard look keys. */
  keyTurn: number;
  /** Which seat is currently in first person; remembered between legs and runs. */
  firstPerson: [boolean, boolean];
  /** Horizontal field of view in first person, degrees. */
  fpFov: number;
  /** Horizontal field of view of the chase camera, degrees. */
  chaseFov: number;
  /** How strongly the first-person view is drawn as a body camera sees it (barrel lens, colour fringes, dark rim), 0 to 1. */
  fpLens: number;
  /** Which physical input drives which action, per device. */
  bindings: Bindings;
}

export const defaultSettings = (): Settings => ({
  rumble: [true, true],
  aimAssist: [1, 1],
  invertLookY: [false, false],
  mouseSens: 1,
  toggleCrouch: [true, true],
  toggleSprint: [true, true],
  deadzone: 0.15,
  lookSens: [1, 1],
  keyTurn: 1,
  firstPerson: [false, false],
  fpFov: 100,
  chaseFov: 110,
  fpLens: 0.7,
  bindings: defaultBindings(),
});

/** A tap on a button shared between two actions (view and the convoy sheet) is shorter than this; holding past it picks the hold action. */
export const TAP_SECONDS = 0.3;

/** Keys that must not scroll or trigger browser behaviour. */
const BLOCK = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace', 'Slash', 'Space', 'BracketLeft', 'BracketRight', 'Quote', 'Backslash',
]);

/** What a rebinding request produced: a new input, a cancel, or a request to unbind. */
export type CaptureResult = { value: number | string } | 'cancel' | 'clear';

/** Samples both gamepads and the shared keyboard and writes one PlayerIntent per player each fixed tick. */
export class InputManager {
  slots: [Slot | null, Slot | null] = [null, null];
  /** Seats in play: 1 for a solo run (either keyboard layout or any pad fills it), 2 for split screen. */
  seats: 1 | 2 = 2;
  intents: [PlayerIntent, PlayerIntent] = [newIntent(), newIntent()];
  settings: Settings = defaultSettings();
  /** Set when an assigned pad disconnects; the game pauses and shows a reconnect overlay. */
  disconnected: [boolean, boolean] = [false, false];
  nonStandard = new Set<number>();
  onDisconnect: (player: number) => void = () => {};
  onReconnect: (player: number) => void = () => {};
  onEscape: () => void = () => {};
  /** Last raw key edge events (consumed by menus). */
  private keys = new Set<string>();
  private keyPressedThisTick = new Set<string>();
  private kbSmooth: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  private prevHeld: [number, number] = [0, 0];
  private holdTime: [Float32Array, Float32Array] = [new Float32Array(BTN_COUNT), new Float32Array(BTN_COUNT)];
  /** Seconds a pad button shared by view (tap) and the convoy sheet (hold) has been down. */
  private shareT: [number, number] = [0, 0];
  /** Keys any layout currently binds, so the browser does not scroll or search on them. */
  private boundKeys = new Set<string>();
  /** A rebinding request in flight: the next press of this device resolves it, and the game ignores input meanwhile. */
  private pending: { device: 'pad' | 'kb' | 'mouse'; done: (r: CaptureResult) => void; down: Set<string> } | null = null;
  private muteT = 0;
  /** Fired when settings or bindings change and should be written to disk. */
  onChange: () => void = () => {};
  private stickAngle: [number, number] = [0, 0];
  private stickAccum: [number, number] = [0, 0];
  private navPrev: [number, number] = [0, 0];
  private navTimer: [number, number] = [0, 0];
  /** Test hook: when set, returned instead of navigator.getGamepads(). */
  mockPads: (Gamepad | null)[] | null = null;
  private joinPrev = new Map<number, boolean>();

  /** Pointer-lock mouse state. Deltas are in CSS pixels, accumulated between fixed ticks. */
  mouseLocked = false;
  private mouseDX = 0;
  private mouseDY = 0;
  private mouseBtns = 0;
  /** Buttons pressed since the last sample, so a trackpad tap (down and up within a few ms) is not lost between ticks. */
  private mouseTap = 0;
  private wheelAcc = 0;
  /** Whether the game is in a state where clicking should capture the pointer (set by Game). */
  canCapture: () => boolean = () => false;
  /** Fired when the browser releases the pointer (Esc, alt-tab) so the game can pause. */
  onPointerLost: () => void = () => {};

  constructor(private target: Window) {
    live.mouseSeat = -1;
    live.mouseLocked = false;
    this.bindingsChanged();
    target.addEventListener('keydown', (e) => {
      // A pending rebinding takes every key (Esc cancels it for any device), so nothing else reacts, not even the pause key.
      if (this.pending && (this.pending.device === 'kb' || e.code === 'Escape' || (this.pending.device === 'mouse' && e.code === 'Delete'))) {
        e.preventDefault();
        if (!e.repeat) this.finishCapture(e.code === 'Escape' ? 'cancel' : e.code === 'Delete' ? 'clear' : { value: e.code });
        return;
      }
      if (BLOCK.has(e.code) || (this.boundKeys.has(e.code) && !e.ctrlKey && !e.metaKey)) e.preventDefault();
      if (!this.keys.has(e.code)) this.keyPressedThisTick.add(e.code);
      this.keys.add(e.code);
      // While captured, Esc only releases the pointer; the release handler pauses the game.
      if (e.code === 'Escape' && !e.repeat) {
        if (this.mouseLocked) this.release();
        else this.onEscape();
      }
    });
    target.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      // macOS sends no keyup for keys let go while Cmd is down (Cmd+Shift+4 does not even blur the window), so drop them
      // all when Cmd comes up; any still held come straight back on the next auto-repeat.
      if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.keys.clear();
    });
    target.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('gamepaddisconnected', (e) => {
      const pad = (e as GamepadEvent).gamepad;
      for (let p = 0; p < 2; p++) {
        const s = this.slots[p];
        if (s && s.kind === 'pad' && s.index === pad.index) {
          this.disconnected[p] = true;
          this.onDisconnect(p);
        }
      }
    });
    target.addEventListener('gamepadconnected', (e) => {
      const pad = (e as GamepadEvent).gamepad;
      for (let p = 0; p < 2; p++) {
        const s = this.slots[p];
        if (s && s.kind === 'pad' && s.index === pad.index && this.disconnected[p]) {
          this.disconnected[p] = false;
          this.onReconnect(p);
        }
      }
    });
  }

  /** Radians of look per CSS pixel of mouse movement at sensitivity 1. */
  static readonly MOUSE_RAD_PER_PX = 0.0022;

  /** Hook the mouse to the game canvas: click to capture, then movement aims. Left fires, right aims down sights. */
  attachMouse(canvas: HTMLElement) {
    const doc = canvas.ownerDocument;
    this.target.addEventListener('mousedown', (e) => {
      if (this.pending?.device === 'mouse') {
        e.preventDefault();
        e.stopPropagation();
        this.finishCapture({ value: e.button });
        return;
      }
      if (!this.mouseLocked) {
        if (e.button === 0 && this.mouseSeat() >= 0 && this.canCapture()) this.capture(canvas);
        return;
      }
      this.mouseBtns |= 1 << e.button;
      this.mouseTap |= 1 << e.button;
      e.preventDefault();
    });
    this.target.addEventListener('mouseup', (e) => {
      this.mouseBtns &= ~(1 << e.button);
    });
    this.target.addEventListener(
      'wheel',
      (e) => {
        if (!this.mouseLocked) return;
        e.preventDefault();
        // Trackpads send many small deltas; a notch is a mouse wheel click or a swipe's worth. Firefox counts lines (3 a
        // notch) and Windows Chrome 100 px a notch, so go through pixels and never bank more than about one step.
        const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
        this.wheelAcc = Math.max(-1.2, Math.min(1.2, this.wheelAcc + px / 70));
      },
      { passive: false },
    );
    this.target.addEventListener('contextmenu', (e) => {
      if (this.mouseLocked || this.canCapture() || this.pending?.device === 'mouse') e.preventDefault();
    });
    this.target.addEventListener('mousemove', (e) => {
      if (!this.mouseLocked) return;
      // Chrome occasionally reports a huge jump when the lock engages; drop those.
      if (Math.abs(e.movementX) > 500 || Math.abs(e.movementY) > 500) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    doc.addEventListener('pointerlockchange', () => {
      const was = this.mouseLocked;
      this.mouseLocked = doc.pointerLockElement === canvas;
      this.mouseDX = this.mouseDY = 0;
      if (!this.mouseLocked) {
        this.mouseBtns = 0;
        if (was) this.onPointerLost();
      }
    });
    this.target.addEventListener('blur', () => (this.mouseBtns = 0));
  }

  capture(canvas: HTMLElement) {
    try {
      const r = canvas.requestPointerLock() as unknown;
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      /* needs a user gesture or unsupported */
    }
  }

  release() {
    if (this.mouseLocked) document.exitPointerLock?.();
  }

  /** The seat the mouse drives: the first keyboard seat (set 1 preferred), or -1 when nobody plays on keyboard. */
  mouseSeat(): number {
    let best = -1;
    for (let p = 0; p < 2; p++) {
      const s = this.slots[p];
      if (s?.kind === 'kb' && (best < 0 || s.set === 1)) best = p;
    }
    return best;
  }

  /** Mouse movement captured since the last tick and not yet applied to the sim, in radians, for smooth per-frame cameras. */
  pendingLook(player: number): [number, number] {
    if (!this.mouseLocked || this.mouseSeat() !== player) return [0, 0];
    const k = InputManager.MOUSE_RAD_PER_PX * this.settings.mouseSens;
    return [this.mouseDX * k, 0 - this.mouseDY * k * (this.settings.invertLookY[player] ? -1 : 1)];
  }

  pads(): (Gamepad | null)[] {
    if (this.mockPads) return this.mockPads;
    try {
      return Array.from(navigator.getGamepads?.() ?? []);
    } catch {
      return [];
    }
  }

  isKeyDown(code: string) {
    return this.keys.has(code);
  }
  wasKeyPressed(code: string) {
    return this.keyPressedThisTick.has(code);
  }

  /**
   * Lobby: "Press A to join". First pad pressed becomes Player 1, second Player 2.
   * Keyboard fallback joins with F (P1) and Right Shift (P2). Solo: whichever of the two is pressed first.
   */
  pollJoin(): void {
    for (const pad of this.pads()) {
      if (!pad || !pad.connected) continue;
      if (pad.mapping !== 'standard') this.nonStandard.add(pad.index);
      if (this.slots.some((s) => s && s.kind === 'pad' && s.index === pad.index)) continue;
      const pressed = !!pad.buttons[Btn.A]?.pressed;
      const was = this.joinPrev.get(pad.index) ?? false;
      this.joinPrev.set(pad.index, pressed);
      if (pressed && !was) {
        const free = this.slots.findIndex((s) => s === null);
        if (free >= 0 && free < this.seats) this.slots[free] = { kind: 'pad', index: pad.index };
      }
    }
    const kb = this.settings.bindings.kb;
    if (kb[0].fire && this.keys.has(kb[0].fire) && !this.slots.some((s) => s?.kind === 'kb' && s.set === 1)) this.assignKb(1);
    if (kb[1].fire && this.keys.has(kb[1].fire) && !this.slots.some((s) => s?.kind === 'kb' && s.set === 2)) this.assignKb(2);
  }

  /** Solo or split screen. Going solo keeps the first device that joined and frees the second seat. */
  setSeats(n: 1 | 2) {
    this.seats = n;
    if (n === 1) {
      if (!this.slots[0]) this.slots[0] = this.slots[1];
      this.slots[1] = null;
    }
  }

  private assignKb(set: 1 | 2) {
    if (this.seats === 1) {
      if (!this.slots[0]) this.slots[0] = { kind: 'kb', set };
      return;
    }
    // The keyboard sets fill a preferred seat: set 1 prefers P1, set 2 prefers P2.
    const pref = set === 1 ? 0 : 1;
    const idx = this.slots[pref] === null ? pref : this.slots.findIndex((s) => s === null);
    if (idx >= 0) this.slots[idx] = { kind: 'kb', set };
  }

  swapSeats() {
    if (this.seats < 2) return;
    this.slots = [this.slots[1], this.slots[0]];
  }

  get joined() {
    return this.slots.filter(Boolean).length;
  }

  /** Fill empty seats with keyboard sets (used for quick-play and automated tests). */
  autoJoinKeyboard() {
    if (!this.slots[0]) this.slots[0] = { kind: 'kb', set: 1 };
    if (this.seats === 2 && !this.slots[1]) this.slots[1] = { kind: 'kb', set: 2 };
  }

  // ------------------------------------------------------------------ rebinding

  /** Call after editing `settings.bindings` in place: refreshes the blocked-key set and the HUD's prompt labels. */
  bindingsChanged() {
    const b = this.settings.bindings;
    live.bindings = b;
    this.boundKeys.clear();
    for (const map of b.kb) for (const code of Object.values(map)) if (code) this.boundKeys.add(code);
  }

  get capturing() {
    return this.pending !== null;
  }

  /**
   * Wait for the next press on a device and hand it to `done`. While waiting, the game sees no input at all, so the
   * press cannot also confirm a menu item. Keyboard: Esc cancels, Delete unbinds. Pad: Start cancels. Mouse: Esc cancels.
   */
  captureNext(device: 'pad' | 'kb' | 'mouse', done: (r: CaptureResult) => void) {
    this.finishCapture('cancel');
    // Buttons already down when the request starts do not count until released and pressed again.
    const down = new Set<string>();
    for (const pad of this.pads()) {
      if (!pad?.connected) continue;
      pad.buttons.forEach((b, i) => b.pressed && down.add(`${pad.index}:${i}`));
    }
    this.pending = { device, done, down };
  }

  cancelCapture() {
    this.finishCapture('cancel');
  }

  private finishCapture(r: CaptureResult) {
    const c = this.pending;
    if (!c) return;
    this.pending = null;
    this.muteT = 0.3;
    c.done(r);
  }

  private scanPadCapture() {
    const c = this.pending;
    if (!c || c.device !== 'pad') return;
    for (const pad of this.pads()) {
      if (!pad?.connected) continue;
      for (let b = 0; b < 16; b++) {
        const key = `${pad.index}:${b}`;
        const on = !!pad.buttons[b]?.pressed || (pad.buttons[b]?.value ?? 0) > 0.5;
        if (!on) {
          c.down.delete(key);
          continue;
        }
        if (c.down.has(key)) continue;
        this.finishCapture(b === Btn.Start ? 'cancel' : { value: b });
        return;
      }
    }
  }

  /** Whether this seat's sheet button is the shared tap-for-view, hold-for-sheet one (its hold has already waited out the tap). */
  sheetIsHold(player: number): boolean {
    return this.slots[player]?.kind === 'pad' && viewSharesSheet(this.settings.bindings.pad);
  }

  // ------------------------------------------------------------------ settings storage

  exportSettings(): Record<string, unknown> {
    const s = this.settings;
    return {
      rumble: s.rumble,
      aimAssist: s.aimAssist,
      invertLookY: s.invertLookY,
      mouseSens: s.mouseSens,
      toggleCrouch: s.toggleCrouch,
      toggleSprint: s.toggleSprint,
      deadzone: s.deadzone,
      lookSens: s.lookSens,
      keyTurn: s.keyTurn,
      firstPerson: s.firstPerson,
      fpFov: s.fpFov,
      chaseFov: s.chaseFov,
      fpLens: s.fpLens,
      bindings: exportBindings(s.bindings),
    };
  }

  /** Read settings saved by `exportSettings`, ignoring anything missing or out of range. */
  importSettings(raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const s = this.settings;
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
    const pair = <T>(v: unknown, ok: (x: unknown) => x is T, d: [T, T]): [T, T] => (Array.isArray(v) && ok(v[0]) && ok(v[1]) ? [v[0], v[1]] : d);
    const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
    const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
    s.rumble = pair(r.rumble, isBool, s.rumble);
    s.invertLookY = pair(r.invertLookY, isBool, s.invertLookY);
    s.toggleCrouch = pair(r.toggleCrouch, isBool, s.toggleCrouch);
    s.toggleSprint = pair(r.toggleSprint, isBool, s.toggleSprint);
    s.firstPerson = pair(r.firstPerson, isBool, s.firstPerson);
    const aa = pair(r.aimAssist, isNum, s.aimAssist);
    s.aimAssist = [clamp(aa[0], 0, 2), clamp(aa[1], 0, 2)];
    const ls = pair(r.lookSens, isNum, s.lookSens);
    s.lookSens = [clamp(ls[0], 0.4, 2.5), clamp(ls[1], 0.4, 2.5)];
    s.mouseSens = num(r.mouseSens, 0.2, 3, s.mouseSens);
    s.deadzone = num(r.deadzone, 0.05, 0.4, s.deadzone);
    s.keyTurn = num(r.keyTurn, 0.4, 2.5, s.keyTurn);
    s.fpFov = num(r.fpFov, 70, 120, s.fpFov);
    s.chaseFov = num(r.chaseFov, 70, 130, s.chaseFov);
    s.fpLens = num(r.fpLens, 0, 1, s.fpLens);
    if (r.bindings) s.bindings = importBindings(r.bindings);
    this.bindingsChanged();
  }

  // ------------------------------------------------------------------ sampling

  /** Sample devices into intents. Call once per fixed tick. */
  sample(dt: number): void {
    this.scanPadCapture();
    // While a rebinding is pending, and briefly after, the game sees nothing: the press must not also act.
    const mute = this.pending !== null || this.muteT > 0;
    if (this.muteT > 0) this.muteT = Math.max(0, this.muteT - dt);
    const pads = this.pads();
    const bind = this.settings.bindings;
    live.mouseLocked = this.mouseLocked;
    live.mouseSeat = this.mouseSeat();
    for (let p = 0; p < 2; p++) {
      const slot = this.slots[p];
      const it = this.intents[p];
      let held = 0;
      let phys = 0;
      let mx = 0;
      let my = 0;
      let lx = 0;
      let ly = 0;
      let lt = 0;
      let rt = 0;
      let handbrake = false;
      let sprint = false;
      let ldx = 0;
      let ldy = 0;
      let usingMouse = false;
      it.aimAssist = this.settings.aimAssist[p];
      it.toolStep = 0;
      if (slot?.kind !== 'pad') this.shareT[p] = 0;

      if (slot?.kind === 'pad') {
        it.device = 'pad';
        const pad = pads[slot.index];
        if (pad && pad.connected) {
          const dz = this.settings.deadzone;
          [mx, my] = radialDeadzone(pad.axes[0] ?? 0, -(pad.axes[1] ?? 0), dz, 1);
          // Response curve: steeper for steering, linear for aim.
          mx = Math.sign(mx) * Math.abs(mx) ** 1.35;
          [lx, ly] = radialDeadzone(pad.axes[2] ?? 0, -(pad.axes[3] ?? 0), dz, 1);
          if (this.settings.invertLookY[p]) ly = -ly;
          // What is physically down. Triggers are analog values, so they count past a small threshold.
          const value = (b: number) => pad.buttons[b]?.value ?? (pad.buttons[b]?.pressed ? 1 : 0);
          for (let b = 0; b < 16; b++) {
            const down = b === Btn.LT || b === Btn.RT ? value(b) > 0.12 : !!pad.buttons[b]?.pressed;
            if (down) phys |= 1 << b;
          }
          // Then which action each button drives, per the pad bindings.
          const shared = viewSharesSheet(bind.pad);
          for (const a of actionsFor('pad')) {
            if (shared && (a.id === 'view' || a.id === 'sheet')) continue;
            const b = padPhysical(bind.pad, a.id);
            if (b === undefined) continue;
            if (a.id === 'fire') rt = b === Btn.LT || b === Btn.RT ? value(b) : phys & (1 << b) ? 1 : 0;
            else if (a.id === 'aim') lt = b === Btn.LT || b === Btn.RT ? value(b) : phys & (1 << b) ? 1 : 0;
            else if (phys & (1 << b)) held |= 1 << a.pad!;
          }
          if (shared) {
            // One button, two jobs: a quick tap switches the view, holding it shows the convoy sheet.
            const b = bind.pad.sheet!;
            if (phys & (1 << b)) {
              this.shareT[p] += dt;
              if (this.shareT[p] >= TAP_SECONDS) held |= 1 << Btn.Back;
            } else {
              if (this.shareT[p] > 0 && this.shareT[p] < TAP_SECONDS) held |= 1 << Btn.View;
              this.shareT[p] = 0;
            }
          } else this.shareT[p] = 0;
          held = lt > 0.12 ? held | (1 << Btn.LT) : held & ~(1 << Btn.LT);
          held = rt > 0.12 ? held | (1 << Btn.RT) : held & ~(1 << Btn.RT);
          // Start is reserved, never bound to an action, so it passes straight through: it pauses and starts a run.
          if (phys & (1 << Btn.Start)) held |= 1 << Btn.Start;
          handbrake = !!(held & (1 << Btn.A));
          sprint = !!(held & (1 << Btn.L3));
        }
      } else if (slot?.kind === 'kb') {
        it.device = 'keyboard';
        it.aimAssist = this.settings.aimAssist[p] * 1.5; // 50% stronger aim assist without analog sticks
        const k = bind.kb[slot.set - 1];
        const key = (a: ActionId) => {
          const c = k[a];
          // A tap that went down and up between two ticks still counts once.
          return !!c && (this.keys.has(c) || this.keyPressedThisTick.has(c));
        };
        const tx = (key('moveRight') ? 1 : 0) - (key('moveLeft') ? 1 : 0);
        const ty = (key('moveUp') ? 1 : 0) - (key('moveDown') ? 1 : 0);
        const sm = this.kbSmooth[p];
        // Digital keys ramp so steering is analog-ish.
        sm[0] = approach(sm[0], tx, (tx !== 0 ? 7 : 11) * dt);
        sm[1] = approach(sm[1], ty, (ty !== 0 ? 7 : 11) * dt);
        mx = sm[0];
        my = sm[1];
        lx = (key('turnRight') ? 1 : 0) - (key('turnLeft') ? 1 : 0);
        // The same action table drives keys and mouse buttons: fire also pulls the analog trigger, aim the left one.
        const apply = (a: ActionId) => {
          if (a === 'fire') {
            held |= (1 << Btn.RB) | (1 << Btn.RT);
            rt = 1;
          } else if (a === 'aim') {
            lt = 1;
            held |= 1 << Btn.LT;
          } else if (a === 'sprint') {
            sprint = true;
            handbrake = true;
            held |= 1 << Btn.L3;
          } else for (const b of ACTION_BY_ID[a].btn ?? []) held |= 1 << b;
        };
        for (const a of actionsFor('kb')) if (key(a.id)) apply(a.id);
        if (this.mouseLocked && this.mouseSeat() === p) {
          usingMouse = true;
          const pend = this.pendingLook(p);
          ldx = pend[0];
          ldy = pend[1];
          this.mouseDX = this.mouseDY = 0;
          if (Math.abs(this.wheelAcc) >= 1) {
            it.toolStep = Math.sign(this.wheelAcc);
            this.wheelAcc -= it.toolStep;
          }
          // Free aim with the mouse needs far less assist than Q/E turning.
          it.aimAssist = this.settings.aimAssist[p] * 0.6;
          for (const a of actionsFor('mouse')) {
            const mb = bind.mouse[a.id];
            if (mb !== undefined && (this.mouseBtns | this.mouseTap) & (1 << mb)) apply(a.id);
          }
        }
      } else {
        it.device = 'none';
      }

      if (mute) {
        held = 0;
        phys = 0;
        mx = my = lx = ly = lt = rt = ldx = ldy = 0;
        handbrake = sprint = false;
        this.shareT[p] = 0;
      }

      it.move[0] = mx;
      it.move[1] = my;
      it.look[0] = lx;
      it.look[1] = ly;
      it.lookDelta[0] = ldx;
      it.lookDelta[1] = ldy;
      it.mouse = usingMouse;
      it.lt = lt;
      it.rt = rt;
      it.handbrake = handbrake;
      it.sprint = sprint;
      const prev = this.prevHeld[p];
      it.pressed = held & ~prev;
      it.released = prev & ~held;
      it.held = held;
      for (let b = 0; b < BTN_COUNT; b++) {
        if (held & (1 << b)) this.holdTime[p][b] += dt;
        else {
          // The frame it lets go, remember how long it was down: `heldTime` is already back to zero by then.
          it.releasedAfter[b] = it.released & (1 << b) ? this.holdTime[p][b] : 0;
          this.holdTime[p][b] = 0;
        }
      }
      it.heldTime = this.holdTime[p];
      this.prevHeld[p] = held;

      // Menu navigation edges with key repeat, from the left stick / move keys and the pad D-pad (always the physical one).
      let dirs = 0;
      const dpad = it.device === 'pad' ? phys : 0;
      if (my > 0.6 || dpad & (1 << Btn.Up)) dirs |= NAV.up;
      if (my < -0.6 || dpad & (1 << Btn.Down)) dirs |= NAV.down;
      if (mx < -0.6 || dpad & (1 << Btn.Left)) dirs |= NAV.left;
      if (mx > 0.6 || dpad & (1 << Btn.Right)) dirs |= NAV.right;
      it.nav = 0;
      if (dirs !== this.navPrev[p]) {
        it.nav = dirs & ~this.navPrev[p];
        this.navTimer[p] = 0.38;
      } else if (dirs) {
        this.navTimer[p] -= dt;
        if (this.navTimer[p] <= 0) {
          it.nav = dirs;
          this.navTimer[p] = 0.12;
        }
      }
      this.navPrev[p] = dirs;

      // Left-stick rotation counter (pin break): counts completed full turns.
      it.stickLoops = 0;
      const mag = Math.hypot(mx, my);
      if (mag > 0.6) {
        const ang = Math.atan2(my, mx);
        let d = ang - this.stickAngle[p];
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.stickAccum[p] += Math.abs(d);
        this.stickAngle[p] = ang;
        while (this.stickAccum[p] >= Math.PI * 2) {
          this.stickAccum[p] -= Math.PI * 2;
          it.stickLoops++;
        }
      } else {
        this.stickAccum[p] = Math.max(0, this.stickAccum[p] - dt * 2);
      }
    }
    this.keyPressedThisTick.clear();
    this.mouseTap = 0;
  }

  /** Rumble where the browser supports it (Chrome and Edge). Silently ignored elsewhere. */
  rumble(player: number, strong: number, weak: number, ms: number) {
    if (!this.settings.rumble[player]) return;
    const slot = this.slots[player];
    if (slot?.kind !== 'pad') return;
    const pad = this.pads()[slot.index] as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, o: object) => Promise<unknown> } }) | null;
    try {
      pad?.vibrationActuator?.playEffect?.('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) });
    } catch {
      /* feature-detected, ignore failures */
    }
  }

  /** Any joined device pressed this button this tick (for shared menus). */
  anyPressed(b: number): number {
    for (let p = 0; p < 2; p++) if (this.intents[p].pressed & (1 << b)) return p;
    return -1;
  }
}

function approach(c: number, t: number, step: number) {
  if (c < t) return Math.min(t, c + step);
  if (c > t) return Math.max(t, c - step);
  return c;
}

/**
 * The text for a button prompt: the key or button the player actually bound to the action behind a logical name
 * ('A', 'RT', ...). Falls back to the name itself.
 */
export function promptLabel(slot: Slot | null, name: string): string {
  const id = PROMPT_ACTION[name];
  if (!id) return name;
  const b = live.bindings;
  if (slot?.kind === 'kb') {
    // Under a captured mouse the mouse button is the one to press.
    if (live.mouseLocked) {
      const mb = b.mouse[id];
      if (mb !== undefined && ACTION_BY_ID[id].devices.includes('mouse')) return mouseShort(mb);
    }
    // Keys have no melee or aim of their own by default: the fire key stands in, as it does in play.
    const code = b.kb[slot.set - 1][id] ?? (id === 'melee' || id === 'aim' ? b.kb[slot.set - 1].fire : undefined);
    return code ? keyLabel(code) : name;
  }
  return padLabel(padPhysical(b.pad, id));
}
