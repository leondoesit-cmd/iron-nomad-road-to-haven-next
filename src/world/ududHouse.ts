/**
 * Udud and Nuhat's house: a single-storey family home in its fenced garden, squeezed in among the apartment blocks at the
 * north end of Petah Tikva, on the boulevard, where the second mission ends. Amirat is at the grill on the covered patio, and everyone with a name who is not out on the
 * road is in the garden: Lag Karab with his cake, Ro with his burger and beer, Udud in his canvas chair, Nuhat talking, Iati
 * with a drink by the orange trees, Nar Divad resting at the head of the table (once he has been brought here).
 *
 * The house's own frame: metres, y = 0 on the patio, the house behind -Z, the garden toward +Z, the front gate and the
 * driveway out at -Z on the right (+X). `houseWorld` turns a house point into the world. Pure data, no three.js: the model is
 * `render/amiratGarden.ts` (drawn from these same numbers), the cast `render/partyCast.ts`, the mission `game/partyMission.ts`.
 */

export const HOUSE_NAME = "Udud & Nuhat's house";

/** The plot, house frame. The house's walls, the covered patio, the side passage to the front garden and gate, the lawn's end. */
export const GARDEN_BOUNDS = {
  patio: { minX: -7, maxX: 4.8, minZ: -4.7, maxZ: -1.45 },
  house: { minX: -7, maxX: 4.8, minZ: -10.7, maxZ: -4.7 },
  passage: { minX: 4.8, maxX: 7, minZ: -14.3, maxZ: -1.45 },
  frontGarden: { minX: 7 - 14 / 3, maxX: 7, minZ: -14.3, maxZ: -10.7 },
  lawnEnd: 7.9,
} as const;

/** Where everything in the garden stands (x, z, and a facing where it has one). */
export const GARDEN_LAYOUT = {
  trees: [[5.85, 2.8], [0, 3.8], [-4.7, 4.6]] as const,
  /**
   * The white chairs round the coffee table (x, z, yaw): Nuhat's by the house door, the Karab brothers' opposite the sofa,
   * and Iati's at the table's far end by the way out to the side passage. Udud's canvas chair is his own.
   */
  chairs: [[1.1, -3.3, Math.PI / 2], [2.85, -1.95, Math.PI], [3.85, -1.95, Math.PI], [4.5, -3.0, -Math.PI / 2]] as const,
  sofa: [3.3, -4.14] as const,
  coffee: [3.3, -2.8] as const,
  trampoline: [4.1, 4.65] as const,
  slide: [-3.7, 0.8] as const,
  /** The grill out on the lawn and Amirat behind it, facing the patio and everyone round the coffee table. */
  grill: [0, 0.95] as const,
  grillYaw: Math.PI,
  amirat: [0, 1.8] as const,
  /** The cool box beside the grill. */
  cooler: [-0.95, 1.05] as const,
  prep: [0.7, -4.1] as const,
  storage: [-6.67, -3.95] as const,
  fridge: [-6.67, -2.75] as const,
};

/** Seat heights: the white garden chairs, and the sofa's cushions as they give under someone. */
export const SEAT = { chair: 0.4785, sofa: 0.48 };
/** The coffee table's top (its middle is `GARDEN_LAYOUT.coffee`; an oval 1.58 by 0.88). */
export const COFFEE_TOP = 0.47;

/** The driveway outside the gate, out toward the road: a pad to leave a car or the trike on. House frame. */
export const DRIVEWAY = { minX: 0.5, maxX: 7.5, minZ: -26.5, maxZ: -14.3 };

/** The front gate: its middle on the fence line. It is shut until someone rings and is buzzed in. */
export const GATE = { x: (GARDEN_BOUNDS.passage.minX + GARDEN_BOUNDS.passage.maxX) / 2, z: GARDEN_BOUNDS.frontGarden.minZ, w: 1.28 };
/** The intercom on the gate's latch post, street side, and where you stand to ring it. */
export const BUZZER = { x: GATE.x + GATE.w / 2, y: 1.36, z: GATE.z - 0.04, standZ: GATE.z - 0.7 };
/** How long after the buzzer is rung the gate is buzzed open, seconds. */
export const BUZZ_DELAY = 5;

/** The shut gate's leaf as a box, house frame: what blocks the way until it opens. */
export function gateLeafBox(): HouseSolid {
  return { x: GATE.x, z: GATE.z, hx: GATE.w / 2, hz: 0.06, h: 1.9 };
}

/**
 * Where each person in the garden is and what they are doing. `x, z` is where their feet are (or, for an eater, the eater's
 * frame: feet at the origin facing +Z), `yaw` the way they face. Seated people sit on a chair at `seat` height, drawn with
 * them. Whoever is out on the road in a player's seat is not here, and their place stays empty.
 */
export type PartyActivity = 'grill' | 'cake' | 'burger' | 'lounge' | 'talk' | 'drink' | 'smoke' | 'chat';

/** What a seated person holds: a glass of tea, a bottle of beer, a pita sandwich out of its paper, a joint. */
export type PartyHeld = 'tea' | 'bottle' | 'pita' | 'joint';

export interface PartySpot {
  hero: 'chinsky' | 'leo' | 'nar' | 'lag' | 'amirat' | 'iati' | 'ro' | 'nuhat' | 'udud';
  x: number;
  z: number;
  yaw: number;
  activity: PartyActivity;
  /** True for the canvas chair, which comes with Udud; everyone else sits on the garden's sofa and chairs, or stands. */
  chair: boolean;
  /** Height of what they sit on (`SEAT`), for the seated. */
  seat?: number;
  held?: PartyHeld;
}

const [SX, SZ] = GARDEN_LAYOUT.sofa;
const C = GARDEN_LAYOUT.chairs;
/** Where someone sitting on the sofa has their feet: the cushions' front, a hand in from the back. */
const SOFA_Z = SZ + 0.16;

/** Udud's canvas chair, beside Nuhat's by the house door, facing the coffee table. */
export const UDUD_CHAIR = { x: 1.2, z: -2.25, yaw: Math.PI / 2 };

export const PARTY: PartySpot[] = [
  { hero: 'amirat', x: GARDEN_LAYOUT.amirat[0], z: GARDEN_LAYOUT.amirat[1], yaw: GARDEN_LAYOUT.grillYaw, activity: 'grill', chair: false },
  // The hosts nearest the house door: Nuhat on the white chair telling a story, Udud in his canvas chair beside her.
  { hero: 'nuhat', x: C[0][0], z: C[0][1], yaw: C[0][2], activity: 'talk', chair: false, seat: SEAT.chair },
  { hero: 'udud', x: UDUD_CHAIR.x, z: UDUD_CHAIR.z, yaw: UDUD_CHAIR.yaw, activity: 'lounge', chair: true },
  // Nar on the sofa's end nearest the way out, with a glass of tea; Iati on the chair beside him by the way out, smoking.
  { hero: 'nar', x: SX + 0.79, z: SOFA_Z, yaw: 0, activity: 'drink', chair: false, seat: SEAT.sofa, held: 'tea' },
  { hero: 'iati', x: C[3][0], z: C[3][1], yaw: C[3][2], activity: 'smoke', chair: false, seat: SEAT.chair, held: 'joint' },
  // The Karab brothers opposite the sofa: Ro with his burger off the crowded table, Lag with the cake on his knees.
  { hero: 'ro', x: C[1][0], z: C[1][1], yaw: C[1][2], activity: 'burger', chair: false, seat: SEAT.chair },
  { hero: 'lag', x: C[2][0], z: C[2][1], yaw: C[2][2], activity: 'cake', chair: false, seat: SEAT.chair },
  // Chinsky and Leo, when neither is out on the road, on the rest of the sofa with a pita sandwich each.
  { hero: 'chinsky', x: SX, z: SOFA_Z, yaw: 0, activity: 'chat', chair: false, seat: SEAT.sofa, held: 'pita' },
  { hero: 'leo', x: SX - 0.79, z: SOFA_Z, yaw: 0, activity: 'chat', chair: false, seat: SEAT.sofa, held: 'pita' },
];

/** Where the house stands in the world. Spec'd in legs.json `open.house`; the facing is a quarter turn, so its boxes stay boxes. */
export interface HousePlace {
  x: number;
  z: number;
  yaw: number;
  /** World height of the patio (the frame's y = 0). */
  y: number;
}

/** The whole plot, driveway included, house frame: what is cleared of everything else and floored. */
export const PLOT = { minX: -7.3, maxX: 7.6, minZ: DRIVEWAY.minZ, maxZ: GARDEN_BOUNDS.lawnEnd + 0.3 };

/** A house point in the world. */
export function houseWorld(p: { x: number; z: number; yaw: number }, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

/** A world point in the house's frame. */
export function houseLocal(p: { x: number; z: number; yaw: number }, x: number, z: number): { x: number; z: number } {
  const dx = x - p.x;
  const dz = z - p.z;
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** A house facing turned into the world. */
export const houseYaw = (p: { yaw: number }, yaw: number) => yaw + p.yaw;

/**
 * Where the house is on this terrain, from its spec. Its plot is levelled (`houseGround`) to the ground where the driveway
 * meets the road, so the drive runs off the road flat; the patio sits a few centimetres above that.
 */
export function placeHouse(spec: { x: number; z: number; yaw: number } | undefined, ground: (x: number, z: number) => number): HousePlace | undefined {
  if (!spec) return undefined;
  const yaw = Math.round(spec.yaw / (Math.PI / 2)) * (Math.PI / 2);
  const p = { x: spec.x, z: spec.z, yaw };
  let sum = 0;
  for (const lx of [DRIVEWAY.minX + 1, (DRIVEWAY.minX + DRIVEWAY.maxX) / 2, DRIVEWAY.maxX - 1]) {
    const w = houseWorld(p, lx, DRIVEWAY.minZ);
    sum += ground(w.x, w.z);
  }
  return { ...p, y: sum / 3 + PATIO_LIFT };
}

/** How far the patio stands above the levelled plot. */
export const PATIO_LIFT = 0.015;
/** How far round the plot the levelling eases back into the land, and (much shorter) out toward the road. */
const PAD_EDGE = 7;
const PAD_EDGE_ROAD = 1.5;

/** The ground with the house's plot levelled into it: flat under the plot, easing back to `v` round it. */
export function houseGround(p: HousePlace, x: number, z: number, v: number): number {
  const dx = x - p.x;
  const dz = z - p.z;
  if (dx * dx + dz * dz > 60 * 60) return v;
  const l = houseLocal(p, x, z);
  const ox = Math.max(PLOT.minX - l.x, 0, l.x - PLOT.maxX);
  const oz = Math.max(l.z - PLOT.maxZ, 0) + Math.max(PLOT.minZ - l.z, 0) * (PAD_EDGE / PAD_EDGE_ROAD);
  const d = Math.hypot(ox, oz);
  if (d >= PAD_EDGE) return v;
  const t = d / PAD_EDGE;
  const w = 1 - t * t * (3 - 2 * t);
  return v + (p.y - PATIO_LIFT - v) * w;
}

/** True inside the fence (house, patio, lawn, passage and front garden), house frame. */
export function inGarden(lx: number, lz: number): boolean {
  const B = GARDEN_BOUNDS;
  if (lx >= -7 && lx <= 7 && lz >= B.patio.minZ && lz <= B.lawnEnd) return true;
  return lx >= B.frontGarden.minX && lx <= 7 && lz >= B.frontGarden.minZ && lz <= B.patio.minZ;
}

/** A solid piece, house frame: an axis-aligned box from the floor up to `h`. `thin` ones block people and cars only. */
export interface HouseSolid {
  x: number;
  z: number;
  hx: number;
  hz: number;
  h: number;
  thin?: boolean;
}

const box = (minX: number, maxX: number, minZ: number, maxZ: number, h: number, thin = false): HouseSolid => ({ x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2, h, thin });
const at = (x: number, z: number, hx: number, hz: number, h: number, thin = false): HouseSolid => ({ x, z, hx, hz, h, thin });

/** Everything in the garden that people and cars bump into. */
export function houseSolids(): HouseSolid[] {
  const B = GARDEN_BOUNDS;
  const L = GARDEN_LAYOUT;
  const g = B.frontGarden;
  const F = 0.05;
  const out: HouseSolid[] = [
    // The house itself, roof and all.
    box(B.house.minX, B.house.maxX, B.house.minZ, B.house.maxZ, 3.45),
    // The fence: left side, the back, the right side down to the gate, the front garden's left side and the gate line, which
    // leaves the open gate clear.
    box(-7 - F, -7 + F, B.house.maxZ, B.lawnEnd, 1.7, true),
    box(-7, 7, B.lawnEnd - F, B.lawnEnd + F, 1.7, true),
    box(7 - F, 7 + F, g.minZ, B.lawnEnd, 1.7, true),
    box(g.minX - F, g.minX + F, g.minZ, g.maxZ, 1.7, true),
    box(g.minX, GATE.x - GATE.w / 2, g.minZ - F, g.minZ + F, 1.7, true),
    box(GATE.x + GATE.w / 2, 7, g.minZ - F, g.minZ + F, 1.7, true),
    // The patio cover's posts along the lawn edge.
    ...[-6.85, -3.45, 0, 4.65].map((x) => at(x, B.patio.maxZ + 0.17, 0.06, 0.06, 2.7, true)),
    // The grill out on the lawn, the prep table, the storage unit and the little fridge.
    at(L.grill[0], L.grill[1], 0.68, 0.37, 0.95),
    at(L.prep[0], L.prep[1], 0.5, 0.5, 0.78, true),
    at(L.storage[0], L.storage[1], 0.28, 0.65, 1.86),
    at(L.fridge[0], L.fridge[1], 0.24, 0.24, 0.68),
    // The sofa and coffee table, and the white chairs.
    at(L.sofa[0], L.sofa[1], 1.32, 0.44, 0.9),
    at(L.coffee[0], L.coffee[1], 0.78, 0.43, 0.48, true),
    ...L.chairs.map(([x, z]) => at(x, z, 0.26, 0.26, 0.9, true)),
    // The trampoline, the slide, the orange trees' trunks.
    at(L.trampoline[0], L.trampoline[1], 1.45, 1.45, 2.3, true),
    at(L.slide[0], L.slide[1] + 0.45, 0.33, 1.4, 1.55, true),
    ...L.trees.map(([x, z]) => at(x, z, 0.12, 0.12, 2.2, true)),
    // The cool box by the grill, the olive in its pot, the gas cylinders' cage by the street door, the street lamp.
    at(L.cooler[0], L.cooler[1], 0.3, 0.2, 0.42, true),
    at(-6.2, -1.9, 0.36, 0.36, 1.6, true),
    at(2.8, -10.93, 0.4, 0.25, 1.5),
    at(7.42, -14.85, 0.16, 0.16, 5, true),
  ];
  // Everyone at the party (and Udud's chair): nobody walks through them.
  for (const s of PARTY) out.push(at(s.x, s.z, s.activity === 'lounge' ? 0.4 : 0.3, s.activity === 'lounge' ? 0.4 : 0.3, s.seat !== undefined || s.chair ? 1.3 : 1.8, true));
  return out;
}

/** World boxes from house-frame solids (a quarter turn swaps the half sizes). */
export function houseBoxes(p: HousePlace, solids: HouseSolid[]): { minX: number; maxX: number; minZ: number; maxZ: number; h: number; thin: boolean }[] {
  const swap = Math.abs(Math.sin(p.yaw)) > 0.5;
  return solids.map((s) => {
    const c = houseWorld(p, s.x, s.z);
    const hx = swap ? s.hz : s.hx;
    const hz = swap ? s.hx : s.hz;
    return { minX: c.x - hx, maxX: c.x + hx, minZ: c.z - hz, maxZ: c.z + hz, h: s.h, thin: !!s.thin };
  });
}

/** The plot's footprint in the world (min/max corners): what is cleared. */
export function plotRect(p: HousePlace): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return worldRect(p, PLOT.minX, PLOT.maxX, PLOT.minZ, PLOT.maxZ);
}

/** How far short of the road the floor slab stops: nothing solid stands on the road's shoulder. */
export const FLOOR_SHORT = 3.5;

/** What is floored (world min/max corners): the plot, but for the end of the driveway on the road's shoulder. */
export function floorRect(p: HousePlace): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return worldRect(p, PLOT.minX, PLOT.maxX, PLOT.minZ + FLOOR_SHORT, PLOT.maxZ);
}

function worldRect(p: HousePlace, x0: number, x1: number, z0: number, z1: number) {
  const a = houseWorld(p, x0, z0);
  const b = houseWorld(p, x1, z1);
  return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
}
