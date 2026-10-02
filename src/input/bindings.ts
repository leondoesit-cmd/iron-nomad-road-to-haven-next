import { Btn } from './intents';

/**
 * Rebindable controls. The simulation only ever sees logical buttons (`Btn`), so a binding says which physical
 * input drives which action; `InputManager.sample` does the translation. Three kinds of device each keep their own map:
 * a gamepad scheme shared by both seats, one map per keyboard layout, and one for the mouse.
 */

export type Device = 'pad' | 'kb' | 'mouse';

export type ActionId =
  | 'moveUp'
  | 'moveDown'
  | 'moveLeft'
  | 'moveRight'
  | 'turnLeft'
  | 'turnRight'
  | 'fire'
  | 'aim'
  | 'melee'
  | 'reload'
  | 'horn'
  | 'swap'
  | 'interact'
  | 'jump'
  | 'vehicle'
  | 'crouch'
  | 'sprint'
  | 'view'
  | 'camera'
  | 'wheel'
  | 'prevBuild'
  | 'nextBuild'
  | 'sheet';

export interface ActionDef {
  id: ActionId;
  label: string;
  /** What it does in each mode, shown under the name in the settings list. */
  hint: string;
  group: 'move' | 'combat' | 'vehicle' | 'camera' | 'team';
  /** Logical button this action drives from a gamepad (the stick axes are not rebindable). */
  pad?: number;
  /** Logical buttons it drives from a key or mouse button. Fire is the exception and also drives the analog trigger. */
  btn?: number[];
  devices: Device[];
  /** Can be left unbound. Everything else is always bound, so nobody gets locked out. */
  optional?: boolean;
}

const KM: Device[] = ['kb', 'mouse'];
const ALL: Device[] = ['pad', 'kb', 'mouse'];

export const ACTIONS: ActionDef[] = [
  { id: 'moveUp', label: 'Move forward', hint: 'Also steer up in menus', group: 'move', devices: ['kb'] },
  { id: 'moveDown', label: 'Move back', hint: 'Also brake or reverse', group: 'move', devices: ['kb'] },
  { id: 'moveLeft', label: 'Move left', hint: 'Also steer left', group: 'move', devices: ['kb'] },
  { id: 'moveRight', label: 'Move right', hint: 'Also steer right', group: 'move', devices: ['kb'] },
  { id: 'turnLeft', label: 'Turn left', hint: 'Aim and look without the mouse', group: 'move', devices: ['kb'] },
  { id: 'turnRight', label: 'Turn right', hint: 'Aim and look without the mouse', group: 'move', devices: ['kb'] },
  { id: 'sprint', label: 'Sprint', hint: 'On foot: sprint · Driving: handbrake on keys · camera distance', group: 'move', pad: Btn.L3, btn: [Btn.L3], devices: ALL },
  { id: 'crouch', label: 'Crouch · lights', hint: 'On foot: crouch · Driving: tap lights, hold engine off', group: 'move', pad: Btn.B, btn: [Btn.B], devices: ALL },
  { id: 'fire', label: 'Fire · throttle', hint: 'On foot and gunner: fire · Driving: throttle on a pad', group: 'combat', pad: Btn.RT, btn: [Btn.RB, Btn.RT], devices: ALL },
  { id: 'aim', label: 'Aim · brake', hint: 'Aim down sights · Driving: brake or reverse on a pad', group: 'combat', pad: Btn.LT, btn: [Btn.LT], devices: ALL, optional: true },
  { id: 'melee', label: 'Melee · takedown', hint: 'Tap melee, hold takedown · Driving: front gun · Camp: next element', group: 'combat', pad: Btn.RB, btn: [Btn.RB], devices: ALL, optional: true },
  { id: 'reload', label: 'Reload', hint: 'Reload · hold swap utility · Driving: horn · Camp: watch post', group: 'combat', pad: Btn.X, btn: [Btn.X], devices: ALL },
  { id: 'horn', label: 'Horn', hint: 'Tap horn, hold siren (same button as reload on a pad)', group: 'vehicle', btn: [Btn.X], devices: ['kb'], optional: true },
  { id: 'swap', label: 'Swap tool', hint: 'Gun, wrench, crowbar, jerrycan · Camp: previous element', group: 'combat', pad: Btn.LB, btn: [Btn.LB], devices: ALL },
  { id: 'interact', label: 'Interact', hint: 'Hold to loot, repair, strip, siphon, refuel, revive · Driving: handbrake on a pad', group: 'team', pad: Btn.A, btn: [Btn.A], devices: ALL },
  { id: 'jump', label: 'Jump', hint: 'On foot: jump · On a pad this shares the interact button and jumps only when nothing is in reach', group: 'move', pad: Btn.Jump, btn: [Btn.Jump], devices: ALL, optional: true },
  { id: 'vehicle', label: 'Enter · exit vehicle', hint: 'Hold to bail out at speed · Shares the view button on a pad: tap view, hold this', group: 'vehicle', pad: Btn.Y, btn: [Btn.Y], devices: ALL },
  { id: 'view', label: 'First / third person', hint: 'Switch the camera on foot, driving and manning the gun', group: 'camera', pad: Btn.View, btn: [Btn.View], devices: ALL, optional: true },
  { id: 'camera', label: 'Reset camera · look back', hint: 'On foot: recentre · Driving: hold to look behind', group: 'camera', pad: Btn.R3, btn: [Btn.R3], devices: ALL, optional: true },
  { id: 'wheel', label: 'Ping · command wheel', hint: 'Tap to ping, hold for the wheel (aim with the look keys or stick)', group: 'team', pad: Btn.Up, btn: [Btn.Up], devices: ['pad', 'kb'], optional: true },
  { id: 'prevBuild', label: 'Build: previous', hint: 'Camp build mode on keys (a pad uses LB)', group: 'team', btn: [Btn.Left], devices: ['kb'], optional: true },
  { id: 'nextBuild', label: 'Build: next', hint: 'Camp build mode on keys (a pad uses RB)', group: 'team', btn: [Btn.Right], devices: ['kb'], optional: true },
  { id: 'sheet', label: 'Convoy sheet', hint: 'Hold for the convoy sheet', group: 'team', pad: Btn.Back, btn: [Btn.Back], devices: ALL, optional: true },
];

export const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a])) as Record<ActionId, ActionDef>;

export const actionsFor = (d: Device) => ACTIONS.filter((a) => a.devices.includes(d));

/**
 * Actions that may sit on one pad button on purpose. Jump rides on interact: the player only jumps when the press
 * has nothing to interact with, so the two never fight.
 */
const coexists = (a: ActionId, b: ActionId) => (a === 'jump' && b === 'interact') || (a === 'interact' && b === 'jump');

/** Marks a pad `view` binding that rides on the vehicle button: tap switches view, hold enters or exits. */
export const SHARED = -2;

export type PadMap = Partial<Record<ActionId, number>>;
export type KeyMap = Partial<Record<ActionId, string>>;
export type MouseMap = Partial<Record<ActionId, number>>;

export interface Bindings {
  pad: PadMap;
  kb: [KeyMap, KeyMap];
  mouse: MouseMap;
}

const PAD_DEFAULT: PadMap = {
  sprint: Btn.L3,
  crouch: Btn.B,
  fire: Btn.RT,
  aim: Btn.LT,
  melee: Btn.RB,
  reload: Btn.X,
  swap: Btn.LB,
  interact: Btn.A,
  jump: Btn.A,
  vehicle: Btn.Y,
  view: SHARED,
  camera: Btn.R3,
  wheel: Btn.Up,
  sheet: Btn.Back,
};

const KB_DEFAULT: [KeyMap, KeyMap] = [
  {
    moveUp: 'KeyW', moveDown: 'KeyS', moveLeft: 'KeyA', moveRight: 'KeyD',
    turnLeft: 'KeyZ', turnRight: 'KeyX', fire: 'KeyT', interact: 'KeyE', jump: 'Space', vehicle: 'KeyF', crouch: 'KeyC',
    sprint: 'ShiftLeft', wheel: 'KeyG', reload: 'KeyR', horn: 'KeyH', swap: 'KeyQ', prevBuild: 'Digit1', nextBuild: 'Digit2',
    view: 'KeyB', camera: 'KeyY', sheet: 'Tab',
  },
  {
    moveUp: 'ArrowUp', moveDown: 'ArrowDown', moveLeft: 'ArrowLeft', moveRight: 'ArrowRight',
    turnLeft: 'BracketLeft', turnRight: 'BracketRight', fire: 'ShiftRight', interact: 'Slash', jump: 'KeyO', vehicle: 'Enter', crouch: 'Period',
    sprint: 'ControlRight', wheel: 'Backspace', reload: 'Comma', horn: 'KeyM', swap: 'KeyN', prevBuild: 'Semicolon', nextBuild: 'Quote',
    view: 'KeyP', camera: 'KeyL', sheet: 'Backslash',
  },
];

const MOUSE_DEFAULT: MouseMap = { fire: 0, aim: 2, view: 1 };

export function defaultBindings(): Bindings {
  return { pad: { ...PAD_DEFAULT }, kb: [{ ...KB_DEFAULT[0] }, { ...KB_DEFAULT[1] }], mouse: { ...MOUSE_DEFAULT } };
}

export function defaultFor(device: Device, set: 0 | 1 = 0): PadMap | KeyMap | MouseMap {
  const d = defaultBindings();
  return device === 'pad' ? d.pad : device === 'kb' ? d.kb[set] : d.mouse;
}

/** Physical pad buttons that cannot be bound: Start pauses, and menus depend on it. */
export const PAD_RESERVED = new Set<number>([Btn.Start]);
/** Physical buttons a pad action can take. */
export const PAD_BUTTONS = [Btn.A, Btn.B, Btn.X, Btn.Y, Btn.LB, Btn.RB, Btn.LT, Btn.RT, Btn.Back, Btn.L3, Btn.R3, Btn.Up, Btn.Down, Btn.Left, Btn.Right];

/** Keys the game keeps for itself or that would fight the browser. */
export function isReservedKey(code: string): boolean {
  return code === 'Escape' || /^F\d+$/.test(code) || code === 'MetaLeft' || code === 'MetaRight' || code === 'ContextMenu' || code === 'AltLeft' || code === 'AltRight' || code === 'CapsLock' || code === 'NumLock';
}

/** The physical button an action reads from a pad, following a shared view binding to the vehicle button. */
export function padPhysical(map: PadMap, a: ActionId): number | undefined {
  const v = map[a];
  if (v === SHARED) return map.vehicle;
  return v;
}

/** True when tap-for-view and hold-for-vehicle ride on one pad button. */
export function viewSharesVehicle(map: PadMap): boolean {
  return map.view === SHARED && map.vehicle !== undefined;
}

type AnyMap<V> = Partial<Record<ActionId, V>>;

/**
 * Bind an input to an action. If another action in the same map already uses it, the two swap, so nothing is ever
 * double-bound by accident and nobody loses a required control. Returns the action that was moved, or null.
 * On a pad, binding view to the vehicle button (or the reverse) is the deliberate tap / hold share.
 */
export function assignBinding<V extends number | string>(device: Device, map: AnyMap<V>, id: ActionId, value: V): ActionId | null {
  const pool = actionsFor(device).map((a) => a.id);
  if (device === 'pad') {
    const pad = map as PadMap;
    const next = value as number;
    if (id === 'view' && next === pad.vehicle) {
      pad.view = SHARED;
      return null;
    }
    if (id === 'vehicle' && pad.view !== SHARED && next === pad.view) {
      // Binding vehicle onto the view button: they now share it.
      pad.vehicle = next;
      pad.view = SHARED;
      return null;
    }
    // A shared view follows the vehicle button, so it is never the one that clashes.
    const viewOwns = pad.view !== undefined && pad.view !== SHARED && pad.view === next;
    const clash = pool.find((a) => a !== id && a !== 'view' && pad[a] === next && !coexists(a, id)) ?? (viewOwns && id !== 'view' ? 'view' : undefined);
    const prev = pad[id];
    pad[id] = next;
    if (clash) {
      // The displaced action takes the button this one left. If that was the shared vehicle button, which the vehicle
      // action still holds, it gets a button nobody uses instead.
      const home = prev === SHARED ? PAD_BUTTONS.find((b) => !Object.values(pad).includes(b)) : prev;
      if (home === undefined) delete pad[clash];
      else pad[clash] = home;
      // Jump rides with interact, so it follows it off the button.
      if (clash === 'interact' && id !== 'jump' && pad.jump === next) {
        if (home === undefined) delete pad.jump;
        else pad.jump = home;
      }
    }
    return clash ?? null;
  }
  const clash = pool.find((a) => a !== id && map[a] === value);
  const prev = map[id];
  map[id] = value;
  if (clash) {
    if (prev === undefined) delete map[clash];
    else map[clash] = prev;
  }
  return clash ?? null;
}

/** Remove an optional binding. Returns false when the action must stay bound. */
export function clearBinding(device: Device, map: AnyMap<number | string>, id: ActionId): boolean {
  if (!ACTION_BY_ID[id].optional || device === 'pad') return false;
  delete map[id];
  return true;
}

// ------------------------------------------------------------------------------------------- labels

const PAD_NAMES: Record<number, string> = {
  [Btn.A]: 'A',
  [Btn.B]: 'B',
  [Btn.X]: 'X',
  [Btn.Y]: 'Y',
  [Btn.LB]: 'LB',
  [Btn.RB]: 'RB',
  [Btn.LT]: 'LT',
  [Btn.RT]: 'RT',
  [Btn.Back]: 'Back',
  [Btn.Start]: 'Start',
  [Btn.L3]: 'L3',
  [Btn.R3]: 'R3',
  [Btn.Up]: 'D-pad ↑',
  [Btn.Down]: 'D-pad ↓',
  [Btn.Left]: 'D-pad ←',
  [Btn.Right]: 'D-pad →',
};

export const padLabel = (b: number | undefined) => (b === undefined ? 'Unbound' : (PAD_NAMES[b] ?? `Button ${b}`));

const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Del',
  ShiftLeft: 'L-Shift',
  ShiftRight: 'R-Shift',
  ControlLeft: 'L-Ctrl',
  ControlRight: 'R-Ctrl',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  IntlBackslash: '<',
  NumpadEnter: 'Num Enter',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Insert: 'Ins',
};

export function keyLabel(code: string | undefined): string {
  if (!code) return 'Unbound';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

const MOUSE_NAMES = ['Left click', 'Middle click', 'Right click', 'Side button 1', 'Side button 2'];
const MOUSE_SHORT = ['LMB', 'MMB', 'RMB', 'M4', 'M5'];
export const MOUSE_BUTTONS = 5;
export const mouseLabel = (b: number | undefined) => (b === undefined ? 'Unbound' : (MOUSE_NAMES[b] ?? `Button ${b + 1}`));
export const mouseShort = (b: number | undefined) => (b === undefined ? '—' : (MOUSE_SHORT[b] ?? `M${b + 1}`));

/** Prompt names the HUD and tips use for a logical button, and the action behind each. */
export const PROMPT_ACTION: Record<string, ActionId> = {
  A: 'interact',
  B: 'crouch',
  X: 'reload',
  Y: 'vehicle',
  LB: 'swap',
  RB: 'melee',
  LT: 'aim',
  RT: 'fire',
  L3: 'sprint',
  R3: 'camera',
};

// --------------------------------------------------------------------------------------- persistence

/** JSON-safe form: an unbound optional action is null, so it stays unbound instead of snapping back to its default. */
export function exportBindings(b: Bindings): unknown {
  const out = <V>(map: AnyMap<V>, device: Device) => Object.fromEntries(actionsFor(device).map((a) => [a.id, map[a.id] ?? null]));
  return { pad: out(b.pad, 'pad'), kb: [out(b.kb[0], 'kb'), out(b.kb[1], 'kb')], mouse: out(b.mouse, 'mouse') };
}

/** Merge saved bindings over the defaults, dropping anything malformed, reserved or double-bound. */
export function importBindings(raw: unknown): Bindings {
  const b = defaultBindings();
  if (!raw || typeof raw !== 'object') return b;
  const r = raw as { pad?: unknown; kb?: unknown; mouse?: unknown };
  const take = <V extends number | string>(src: unknown, device: Device, into: AnyMap<V>, valid: (v: unknown) => v is V) => {
    if (!src || typeof src !== 'object') return;
    const s = src as Record<string, unknown>;
    const seen = new Map<unknown, ActionId>();
    const next: AnyMap<V> = {};
    for (const a of actionsFor(device)) {
      const v = s[a.id];
      if (v === undefined) {
        next[a.id] = into[a.id];
        continue;
      }
      if (v === null) {
        if (a.optional && device !== 'pad') delete next[a.id];
        else next[a.id] = into[a.id];
        continue;
      }
      if (valid(v)) next[a.id] = v;
      else next[a.id] = into[a.id];
    }
    // Reject duplicates a hand-edited save could contain: later ones fall back to the default.
    for (const a of actionsFor(device)) {
      const v = next[a.id];
      if (v === undefined || v === SHARED) continue;
      const other = seen.get(v);
      if (other && !coexists(other, a.id)) next[a.id] = into[a.id];
      else seen.set(v, a.id);
    }
    for (const k of Object.keys(into) as ActionId[]) delete into[k];
    Object.assign(into, next);
  };
  const padOk = (v: unknown): v is number => typeof v === 'number' && (v === SHARED || (PAD_BUTTONS as number[]).includes(v));
  const keyOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 24 && !isReservedKey(v);
  const mouseOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MOUSE_BUTTONS;
  take(r.pad, 'pad', b.pad as AnyMap<number>, padOk);
  if (Array.isArray(r.kb)) {
    take(r.kb[0], 'kb', b.kb[0] as AnyMap<string>, keyOk);
    take(r.kb[1], 'kb', b.kb[1] as AnyMap<string>, keyOk);
  }
  take(r.mouse, 'mouse', b.mouse as AnyMap<number>, mouseOk);
  // A shared view needs a vehicle button to ride on.
  if (b.pad.view === SHARED && b.pad.vehicle === undefined) b.pad.view = Btn.Y;
  return b;
}

/**
 * The bindings the HUD reads for its button prompts. The InputManager points this at its own bindings, so a prompt
 * shows the key or button the player actually set rather than the default.
 */
export const live = { bindings: defaultBindings(), mouseSeat: -1, mouseLocked: false };
