import type { LootContext } from '../sim/loot';

/**
 * Ofer Grand Mall, Petah Tikva: "HaKanyon HaGadol", the Big Mall, on Jabotinsky Road at the south-west entrance to the
 * city, and the cable-stayed footbridge that carries people over the road to its upper floor.
 *
 * From photographs of the real place: a long two-storey block faced in bands of cream and pale pink stone, a raised grey
 * box over the main entrance carrying the red sign (עופר הקניון הגדול פ״ת), a white cone over the round court, a grey
 * block clad in horizontal metal panels at one end with walls that lean out as they rise (H&M, GAP), and an angular
 * cantilevered roof over a corner of blue glass at the other. Inside, a round court with an oval void through the upper
 * floor, glass balustrades with a handrail, a pair of escalators climbing through the void, and shopfronts all round.
 * The footbridge has one white inclined mast, a fan of cables, a curved deck with a big tube along one edge, ribs, glass
 * panels and a white railing with hooked posts; at night a pink light runs under it.
 *
 * Invented to suit the engine: every size, which shop is where (the names are chains found in Israeli malls), and the
 * ramp the bridge comes down on. Here, driving into Petah Tikva from the south up Haim Ozer Street, the mall is on the
 * left in the first two blocks and the bridge crosses the street in front of its grey block.
 *
 * Pure data: the plan generator (`world/interiors.ts`, look 'mall'), the layout (`dressLandmarks`), the renderers
 * (`render/mallView.ts`, `render/footbridge.ts`) and the tests all read the same numbers from here.
 *
 * Frame: everything is in metres relative to the building's own footprint corner (its min-x, min-z corner). The mall
 * stands on the driver's left (+x), so its front, toward the street, is its min-x wall and faces -x; z runs north.
 */

export type ShopKind = 'clothes' | 'shoes' | 'home' | 'pharmacy' | 'super' | 'cafe' | 'food' | 'books' | 'electronics' | 'hardware' | 'outdoor';

export interface MallShop {
  id: string;
  /** The name on the fascia, as the shop writes it. */
  name: string;
  /** A Hebrew name, for the chains that sign in Hebrew. */
  he?: string;
  kind: ShopKind;
  level: 0 | 1;
  /** Which side of the mall street it is on, or the anchor store across the whole depth at the north end. */
  row: 'front' | 'back' | 'anchor';
  z0: number;
  z1: number;
  /** Fascia colours: background, lettering. */
  bg: string;
  fg: string;
}

const T = 0.3;

export const MALL = {
  /** Where the footprint stands in its lot: metres out from the lot's spine-side edge, and north from its south end. */
  inLot: { x: 3, z: 8 },
  w: 30,
  d: 120,
  levels: 2,
  levelH: 5.6,
  /** The shopfront walls either side of the mall street (x). */
  frontRow: 9,
  backRow: 21,
  /** The round court in the middle, across the whole depth (z). */
  court: { z0: 42, z1: 78 },
  /** The oval void through the upper floor and the roof, under the cone. */
  atrium: { x: 15, z: 60, rx: 7.5, rz: 10 },
  /** The pair of escalators climbing north through the void to arrive at its north tip. */
  escalator: { x: 15, gap: 1.7, width: 1.0, steps: 29, top: 70 },
  /** Where the anchor store (the grey block) begins (z). */
  anchor: 96,
  /** The upper-floor passage from the bridge door to the mall street, between ACE and the anchor (z). */
  passage: { z0: 88, z1: 96 },
  /** The footbridge door in the front wall of the upper floor: its middle (z) and width. */
  bridgeDoor: { z: 92, w: 4 },
  /** Fascia height: the glass and doors stop here and the shop's sign hangs above. */
  head: 3.6,
};

/** Everything the mall sells, floor by floor, south to north. */
export const MALL_SHOPS: MallShop[] = [
  // Ground floor, the street side.
  { id: 'zara', name: 'ZARA', kind: 'clothes', level: 0, row: 'front', z0: T, z1: 14, bg: '#f4f2ee', fg: '#151515' },
  { id: 'mango', name: 'MANGO', kind: 'clothes', level: 0, row: 'front', z0: 14, z1: 24, bg: '#f4f2ee', fg: '#1a1a1a' },
  { id: 'golf', name: 'GOLF & CO', kind: 'home', level: 0, row: 'front', z0: 24, z1: 33, bg: '#e8e2d6', fg: '#3a3a3a' },
  { id: 'aroma', name: 'ARUMA', he: 'ארומה', kind: 'cafe', level: 0, row: 'front', z0: 33, z1: 42, bg: '#141414', fg: '#ffffff' },
  { id: 'gap', name: 'GAP', kind: 'clothes', level: 0, row: 'front', z0: 78, z1: 87, bg: '#1f2a5c', fg: '#ffffff' },
  { id: 'ae', name: 'AMERICAN EAGLE', kind: 'clothes', level: 0, row: 'front', z0: 87, z1: 96, bg: '#14264a', fg: '#ffffff' },
  // Ground floor, the car park side.
  { id: 'superpharm', name: 'SUPER-PHARM', he: 'סופר-פארם', kind: 'pharmacy', level: 0, row: 'back', z0: T, z1: 20, bg: '#d4141e', fg: '#ffffff' },
  { id: 'fox', name: 'FOX', kind: 'clothes', level: 0, row: 'back', z0: 20, z1: 31, bg: '#151515', fg: '#ffffff' },
  { id: 'castro', name: 'CASTRO', kind: 'clothes', level: 0, row: 'back', z0: 31, z1: 42, bg: '#f2f0ea', fg: '#111111' },
  { id: 'steimatzky', name: 'STEIMATZKY', he: 'סטימצקי', kind: 'books', level: 0, row: 'back', z0: 78, z1: 87, bg: '#1d3f8a', fg: '#ffffff' },
  { id: 'ksp', name: 'KSP', kind: 'electronics', level: 0, row: 'back', z0: 87, z1: 96, bg: '#f5cf16', fg: '#141414' },
  { id: 'hm', name: 'H&M', kind: 'clothes', level: 0, row: 'anchor', z0: 96, z1: 120 - T, bg: '#ffffff', fg: '#e3000f' },
  // Upper floor, the street side: the bridge comes in between ACE and the anchor.
  { id: 'bershka', name: 'BERSHKA', kind: 'clothes', level: 1, row: 'front', z0: T, z1: 14, bg: '#f4f2ee', fg: '#151515' },
  { id: 'pullbear', name: 'PULL&BEAR', kind: 'clothes', level: 1, row: 'front', z0: 14, z1: 28, bg: '#2a2f33', fg: '#ffffff' },
  { id: 'footlocker', name: 'FOOT LOCKER', kind: 'shoes', level: 1, row: 'front', z0: 28, z1: 42, bg: '#121212', fg: '#ffffff' },
  { id: 'ace', name: 'ACE', kind: 'hardware', level: 1, row: 'front', z0: 78, z1: 88, bg: '#d71920', fg: '#ffffff' },
  // Upper floor, the car park side.
  { id: 'foodcourt', name: 'FOOD COURT', he: 'מתחם המזון', kind: 'food', level: 1, row: 'back', z0: T, z1: 22, bg: '#f0bf2c', fg: '#2a160a' },
  { id: 'shufersal', name: 'SHUFERSAL', he: 'שופרסל', kind: 'super', level: 1, row: 'back', z0: 22, z1: 42, bg: '#e2231a', fg: '#ffffff' },
  { id: 'idigital', name: 'iDIGITAL', kind: 'electronics', level: 1, row: 'back', z0: 78, z1: 87, bg: '#f2f2f2', fg: '#222222' },
  { id: 'maxstock', name: 'MAX STOCK', he: 'מקס סטוק', kind: 'home', level: 1, row: 'back', z0: 87, z1: 96, bg: '#f36f21', fg: '#ffffff' },
  { id: 'lametayel', name: 'LAMETAYEL', he: 'למטייל', kind: 'outdoor', level: 1, row: 'anchor', z0: 96, z1: 120 - T, bg: '#2f7a3a', fg: '#ffffff' },
];

/** What lies in each kind of shop (see `sim/loot.ts`). */
export const SHOP_USE: Record<ShopKind, LootContext> = {
  clothes: 'house',
  shoes: 'house',
  home: 'house',
  pharmacy: 'pharmacy',
  super: 'shop',
  cafe: 'kitchen',
  food: 'kitchen',
  books: 'office',
  electronics: 'office',
  hardware: 'shop',
  outdoor: 'shop',
};

/** A shop's floor in building coordinates: the row decides x. */
export function shopRect(s: MallShop): { x0: number; x1: number; z0: number; z1: number } {
  const x0 = s.row === 'back' ? MALL.backRow : T;
  const x1 = s.row === 'front' ? MALL.frontRow : MALL.w - T;
  return { x0, x1, z0: s.z0, z1: s.z1 };
}

/** The two escalators: the middle of each one's first riser, its width, and the rise and going of its steps. */
export function mallEscalators(): { x: number; z: number; width: number; steps: number; rise: number; tread: number }[] {
  const e = MALL.escalator;
  const rise = MALL.levelH / (e.steps - 1);
  // Thirty degrees, as escalators are built.
  const tread = rise / Math.tan(Math.PI / 6);
  const z = e.top - (e.steps - 1) * tread;
  return [-1, 1].map((s) => ({ x: e.x + (s * e.gap) / 2, z, width: e.width, steps: e.steps, rise, tread }));
}

/** Half-width (x) of the oval void at a z, or 0 outside it. */
export function atriumHalf(z: number): number {
  const a = MALL.atrium;
  const t = (z - a.z) / a.rz;
  return Math.abs(t) >= 1 ? 0 : a.rx * Math.sqrt(1 - t * t);
}

/**
 * The void as rectangles inside the oval (building coordinates), in bands short enough that the oval edge moves no more
 * than a hand's width across any of them: the upper floor is solid everywhere outside these, so nobody falls through a
 * crack at the edge, and the balustrade stands on the sliver of floor left inside the oval.
 */
export function atriumBands(): { x0: number; x1: number; z0: number; z1: number }[] {
  const a = MALL.atrium;
  const out: { x0: number; x1: number; z0: number; z1: number }[] = [];
  const zs: number[] = [a.z - a.rz];
  let last = 0;
  for (let z = a.z - a.rz + 0.05; z < a.z + a.rz; z += 0.05) {
    const h = atriumHalf(z);
    if (Math.abs(h - last) > 0.22 || z - zs[zs.length - 1] > 1.5) {
      zs.push(z);
      last = h;
    }
  }
  zs.push(a.z + a.rz);
  for (let i = 0; i + 1 < zs.length; i++) {
    const za = zs[i];
    const zb = zs[i + 1];
    // The narrower end of the band keeps the hole inside the oval.
    const h = Math.min(atriumHalf(za + 1e-6), atriumHalf(zb - 1e-6));
    if (h < 0.15) continue;
    out.push({ x0: a.x - h, x1: a.x + h, z0: za, z1: zb });
  }
  return out;
}

/** Points round the oval (building coordinates), `n` of them, running clockwise seen from above (+z is toward the viewer's bottom). */
export function atriumRim(n: number, grow = 0): [number, number][] {
  const a = MALL.atrium;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([a.x + Math.cos(t) * (a.rx + grow), a.z + Math.sin(t) * (a.rz + grow)]);
  }
  return out;
}

/** The balustrade round the void leaves a gap where the escalators arrive, at the north tip. */
export function rimOpen(x: number, z: number): boolean {
  const e = MALL.escalator;
  return z > MALL.atrium.z && Math.abs(x - e.x) < e.gap / 2 + e.width / 2 + 0.3;
}

// ------------------------------------------------------------------ the footbridge

/**
 * The footbridge, in its own frame: the origin is the foot of the upper-floor door on the mall's front wall, at the
 * ground, and the deck leaves it heading -x (out over the street). It runs straight across, swings round to the south
 * on a curve hung from the mast, and comes down a ramp to the pavement beyond.
 */
export const FOOTBRIDGE = {
  /** Deck top over the street: the mall's upper floor. */
  y: MALL.levelH,
  width: 4,
  /** The straight run from the door, then the curve's radius, then the ramp down. */
  straight: 27,
  radius: 12,
  ramp: 40,
  /** The mast's foot (at the centre of the curve) and its head, leaning away from the deck. */
  mast: { x: -27, z: -12, topX: -23, topY: 27, topZ: -16 },
};

export interface DeckPoint {
  x: number;
  y: number;
  z: number;
  /** Unit direction of travel, from the door toward the foot of the ramp. */
  dx: number;
  dz: number;
  /** Distance along the deck from the door. */
  s: number;
  /** 0 on the straight, 1 on the curve, 2 on the ramp. */
  part: 0 | 1 | 2;
}

/** The deck's centre-line, sampled every `step` metres or so, in the bridge's own frame. */
export function deckLine(step = 1): DeckPoint[] {
  const B = FOOTBRIDGE;
  const out: DeckPoint[] = [];
  const n0 = Math.max(2, Math.ceil(B.straight / step));
  for (let i = 0; i < n0; i++) {
    const s = (i / n0) * B.straight;
    out.push({ x: -s, y: B.y, z: 0, dx: -1, dz: 0, s, part: 0 });
  }
  const arc = (Math.PI / 2) * B.radius;
  const n1 = Math.max(4, Math.ceil(arc / step));
  for (let i = 0; i < n1; i++) {
    const t = Math.PI / 2 + (i / n1) * (Math.PI / 2);
    const x = -B.straight + Math.cos(t) * B.radius;
    const z = -B.radius + Math.sin(t) * B.radius;
    // Clockwise seen from above: from heading -x round to heading -z.
    out.push({ x, y: B.y, z, dx: -Math.sin(t), dz: Math.cos(t), s: B.straight + (i / n1) * arc, part: 1 });
  }
  const n2 = Math.max(4, Math.ceil(B.ramp / step));
  for (let i = 0; i <= n2; i++) {
    const u = i / n2;
    out.push({ x: -B.straight - B.radius, y: B.y * (1 - u), z: -B.radius - u * B.ramp, dx: 0, dz: -1, s: B.straight + arc + u * B.ramp, part: 2 });
  }
  return out;
}

/** The deck's surface height at a point in the bridge frame, or null off the deck. */
export function deckHeightAt(x: number, z: number): number | null {
  const B = FOOTBRIDGE;
  const hw = B.width / 2;
  if (x <= 0.01 && x >= -B.straight && Math.abs(z) <= hw) return B.y;
  const cx = -B.straight;
  const cz = -B.radius;
  const r = Math.hypot(x - cx, z - cz);
  if (x <= cx + 0.01 && z >= cz - 0.01 && Math.abs(r - B.radius) <= hw) return B.y;
  const rx = -B.straight - B.radius;
  if (Math.abs(x - rx) <= hw && z <= cz && z >= cz - B.ramp) return B.y * (1 - (cz - z) / B.ramp);
  return null;
}

/** The slender columns under the bridge: one under the outer edge of the curve, two under the ramp. `top` is where each meets the deck's underside. */
export function bridgePiers(): { x: number; z: number; top: number }[] {
  const B = FOOTBRIDGE;
  const a = (Math.PI * 3) / 4;
  const ro = B.radius + B.width / 2 - 0.4;
  const rampX = -B.straight - B.radius;
  return [
    { x: -B.straight + Math.cos(a) * ro, z: -B.radius + Math.sin(a) * ro, top: B.y - 0.9 },
    ...[0.3, 0.6].map((u) => ({ x: rampX, z: -B.radius - u * B.ramp, top: B.y * (1 - u) - 0.35 })),
  ];
}

/**
 * Is a point on the ground (bridge frame) somewhere nothing can stand: under the low end of the ramp, or at the foot of
 * the mast or a pier? Higher up, the deck is overhead and the ground beneath it is open.
 */
export function footbridgeBlocks(x: number, z: number, r: number): boolean {
  const B = FOOTBRIDGE;
  const rampX = -B.straight - B.radius;
  if (Math.abs(x - rampX) < B.width / 2 + r && z < -B.radius - B.ramp * 0.5 + r && z > -B.radius - B.ramp - r) return true;
  if (Math.hypot(x - B.mast.x, z - B.mast.z) < 1.1 + r) return true;
  return bridgePiers().some((p) => Math.hypot(x - p.x, z - p.z) < 0.5 + r);
}
