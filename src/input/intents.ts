/** Standard-mapping gamepad button indices. The same indices are used for keyboard-synthesised buttons. */
export const Btn = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  Back: 8,
  Start: 9,
  L3: 10,
  R3: 11,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
  /** Not a physical button: the first / third person switch, driven by whatever the player binds to it. */
  View: 16,
  /** Not a physical button: jump, driven by whatever the player binds to it (A on a pad, shared with interact). */
  Jump: 17,
  /** Not a physical button: the map, driven by whatever the player binds to it (D-pad right on a pad). */
  Map: 18,
  /** Not a physical button: the inventory, driven by whatever the player binds to it (D-pad left on a pad). */
  Inventory: 19,
  /** Not physical buttons: the four chores, driven by keys. A pad reaches them through the quick belt. */
  Eat: 20,
  Drink: 21,
  Piss: 22,
  Shit: 23,
  /** Not a physical button: call your ride to you, driven by a key. A pad reaches it through the command wheel. */
  Summon: 24,
  // 25 is reserved for the drugs shortcut (the inventory work adds `Drugs: 25`).
} as const;
/** Logical buttons, including View, Jump, Map and Inventory. 25 is reserved. */
export const BTN_COUNT = 26;
export type BtnName = keyof typeof Btn;

export type DeviceKind = 'pad' | 'keyboard';

/**
 * Everything the simulation needs to know about one player's input this tick.
 * The sim never reads devices directly, so replays and tests can inject intents.
 */
export interface PlayerIntent {
  device: DeviceKind | 'none';
  /** Left stick, x right-positive, y forward-positive. */
  move: [number, number];
  /** Right stick, x right-positive, y up-positive. */
  look: [number, number];
  /** Mouse / trackpad look this tick as an angle in radians (x right-positive, y up-positive). Zero unless the pointer is captured. */
  lookDelta: [number, number];
  /** True while this seat is aimed by a captured mouse: pitch is free and is not recentred like Q/E aiming. */
  mouse: boolean;
  /** Analog triggers 0..1. */
  lt: number;
  rt: number;
  held: number;
  pressed: number;
  released: number;
  /** For hold-detection: seconds each button has been held. */
  heldTime: Float32Array;
  /** How long each button had been held when it was released; only meaningful on the frame `released` has its bit. */
  releasedAfter: Float32Array;
  /** Full left-stick rotations completed this tick (pin break). */
  stickLoops: number;
  /** Driving: handbrake. Pad: A. Keyboard: the sprint key. */
  handbrake: boolean;
  /** On foot: sprint. Pad: L3. Keyboard: the sprint key. */
  sprint: boolean;
  /** Menu direction edges this tick: 1 up, 2 down, 4 left, 8 right (with key repeat). */
  nav: number;
  /** Mouse wheel notches this tick while the pointer is captured: 1 next tool, -1 previous. */
  toolStep: number;
  /** Aim assist multiplier for this device. */
  aimAssist: number;
}

export function newIntent(): PlayerIntent {
  return {
    device: 'none',
    move: [0, 0],
    look: [0, 0],
    lookDelta: [0, 0],
    mouse: false,
    lt: 0,
    rt: 0,
    held: 0,
    pressed: 0,
    released: 0,
    heldTime: new Float32Array(BTN_COUNT),
    releasedAfter: new Float32Array(BTN_COUNT),
    stickLoops: 0,
    handbrake: false,
    sprint: false,
    nav: 0,
    toolStep: 0,
    aimAssist: 1,
  };
}

export const NAV = { up: 1, down: 2, left: 4, right: 8 } as const;

export const isHeld = (i: PlayerIntent, b: number) => (i.held & (1 << b)) !== 0;
export const wasPressed = (i: PlayerIntent, b: number) => (i.pressed & (1 << b)) !== 0;
export const wasReleased = (i: PlayerIntent, b: number) => (i.released & (1 << b)) !== 0;
export const heldFor = (i: PlayerIntent, b: number) => (isHeld(i, b) ? i.heldTime[b] : 0);
