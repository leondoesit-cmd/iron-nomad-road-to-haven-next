/**
 * Nar's yard: a scrap shack on a cracked salt flat east of Dustwell, where the story begins. Uncle Nar Divad lies sick on a
 * mattress under the torn roof, and the rickshaw trike he was building stands in pieces round him: the frame on its stand,
 * the engine, the wheels and the cab lying where he left them.
 *
 * Everything here is in the yard's own frame: metres, ground at y = 0, +Z out of the open front (the way you drive out),
 * +X to the left as you look out. `yardWorld` turns a yard point into the world. Pure data, no three.js.
 */

export interface YardPose {
  x: number;
  z: number;
  /** Facing, radians: 0 looks down +Z. */
  yaw: number;
}

/**
 * Where the yard stands in the open world, and which way its open front faces. Spec'd in legs.json `open.yard`. The facing is
 * a quarter turn (a multiple of pi / 2) so the yard's boxes stay boxes in the world's axes.
 */
export interface YardPlace {
  x: number;
  z: number;
  yaw: number;
  /** Ground level of the flat the yard stands on. */
  y: number;
}

/** A thing lying in the yard at the start of the story, to be lifted and fitted. */
export interface YardItem {
  id: string;
  /** A part id, or one of the loose kinds. */
  what: { part: string; cond: number } | { fuel: number } | { oil: number } | { food: 'dogfood' };
  x: number;
  z: number;
  /** Height above the ground it rests at (a can on the bench). */
  y?: number;
  yaw: number;
}

/**
 * Nar's lean-to, to the left of the garage as you look in from its open front, the big rusty skip beside it: a small
 * bent-frame canopy over the pallet he lies on. It has a frame of its own, centred on the middle of the pallet, his head to
 * its -z and its open foot end to +z; (x, z) is where that middle stands in the yard and `yaw` how far the whole place is
 * turned (positive: its open foot end swung round toward the garage and the skip). x0/x1 are its legs, z0/z1 its two
 * arches, in its own frame.
 */
export const YARD_SHELTER = { x: -11.7, z: 0.7, yaw: Math.PI / 4, x0: -1.2, x1: 0.95, z0: -1.25, z1: 1.25, top: 2.05 };

/** A point of the lean-to's own frame in the yard frame. */
export function shelterYard(lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(YARD_SHELTER.yaw);
  const s = Math.sin(YARD_SHELTER.yaw);
  return { x: YARD_SHELTER.x + lx * c + lz * s, z: YARD_SHELTER.z - lx * s + lz * c };
}

/** Nar on his pallet: where his hips are, which way his head points (to the back of the lean-to), and the top of the pallet. */
export const YARD_NAR: YardPose & { y: number } = { ...shelterYard(0, 0.03), yaw: Math.PI + YARD_SHELTER.yaw, y: 0.13 };
/** The cooking corner in front of the lean-to: a fire burning in a rusty basin, by a rebar rack hung with cans. */
export const YARD_FIRE = { x: -9.3, z: 6.0 };
/** The bare trike frame on its stand, facing out of the yard. */
export const YARD_TRIKE: YardPose = { x: 0.6, z: 0.4, yaw: 0 };
/** Where you wake up: at the foot of Nar's lean-to, turned a little aside so he shows beside you on the pallet. */
export const YARD_WAKE: YardPose = { x: -10.2, z: 3.5, yaw: 3.2 };

/** The parts of the trike and the bits of kit lying round the yard. */
export const YARD_ITEMS: YardItem[] = [
  { id: 'engine', what: { part: 'eng_594', cond: 0.62 }, x: -2.3, z: 1.9, yaw: 0.5 },
  { id: 'frontWheel', what: { part: 'tyre_trike', cond: 0.58 }, x: -1.0, z: 3.4, yaw: 1.2 },
  { id: 'smallWheelA', what: { part: 'tyre_trike_r', cond: 0.74 }, x: 2.6, z: -3.3, yaw: 0.2 },
  { id: 'smallWheelB', what: { part: 'tyre_trike_r', cond: 0.66 }, x: 4.4, z: 1.6, yaw: -0.7 },
  { id: 'cab', what: { part: 'rr_rickshaw', cond: 0.7 }, x: 3.6, z: -0.9, yaw: Math.PI / 2 },
  { id: 'liftKit', what: { part: 'sus_lift', cond: 0.8 }, x: -5.2, z: 1.2, yaw: 0.9 },
  { id: 'fuel', what: { fuel: 4 }, x: 4.9, z: 3.6, yaw: 0.4 },
  // The oil can stands in a rusty tray beside Nar's feet.
  { id: 'oil', what: { oil: 0.5 }, ...shelterYard(0.7, 1.72), y: 0.04, yaw: 0.3 + YARD_SHELTER.yaw },
  { id: 'dogfood', what: { food: 'dogfood' }, x: -0.4, z: -4.35, y: 0.92, yaw: 0 },
];

/** Keep-clear circles round the gameplay spots: the yard's model and colliders stay out of them. */
export const YARD_CLEAR: { x: number; z: number; r: number }[] = [
  // Round Nar on his pallet: the skip stands right beside him, so it is a tight circle.
  { x: YARD_NAR.x, z: YARD_NAR.z, r: 1.0 },
  { x: YARD_TRIKE.x, z: YARD_TRIKE.z, r: 1.9 },
  { x: YARD_WAKE.x, z: YARD_WAKE.z, r: 0.7 },
  ...YARD_ITEMS.filter((i) => i.y === undefined).map((i) => ({ x: i.x, z: i.z, r: i.id === 'cab' ? 1.2 : 0.7 })),
  // The way out: a lane from the trike to the open front.
  { x: YARD_TRIKE.x, z: 3.5, r: 1.6 },
  { x: YARD_TRIKE.x, z: 6, r: 1.8 },
];

/**
 * The yard's solid pieces, yard frame: fence, frame posts, bench, the skip and the rest. Each is an axis-aligned box
 * (half sizes `hx`, `hz`) from the ground up to `h`. Built by `render/narYardModel.ts` alongside the model.
 */
export interface YardSolid {
  x: number;
  z: number;
  hx: number;
  hz: number;
  h: number;
  /** Physics only: the camera, bullets and the dead pass (a rope, a thin rail). */
  thin?: boolean;
}

/** The whole yard fits in this half size; the ground under it is levelled. */
export const YARD_HALF = 15;

/** Everything in the yard a person or a vehicle bumps into, as `narYardModel` draws it. All clear of `YARD_CLEAR`. */
export const YARD_SOLIDS: YardSolid[] = [
  // The back fence, the short side run behind Nar's bed, and the torn wall hanging down the left side.
  { x: -0.28, z: -4.95, hx: 6.36, hz: 0.08, h: 2.3 },
  { x: -6.6, z: -3.25, hx: 0.08, hz: 1.72, h: 2.3 },
  { x: 6.16, z: -0.9, hx: 0.09, hz: 3.48, h: 2.55 },
  // The legs of the three frames (at z -4.2, -0.9, 2.4), leaning out from their feet to the shoulders.
  ...[-4.2, -0.9, 2.4].flatMap((z) => [
    { x: -5.66, z, hx: 0.42, hz: 0.07, h: 2.65 },
    { x: 5.66, z, hx: 0.42, hz: 0.07, h: 2.65 },
  ]),
  // The workbench (its top is the shelf the dog food stands on) and the lean-to's posts.
  { x: -0.2, z: -4.375, hx: 1.4, hz: 0.375, h: 0.92 },
  { x: -1.75, z: -3.72, hx: 0.06, hz: 0.06, h: 2.2 },
  { x: 1.35, z: -3.72, hx: 0.06, hz: 0.06, h: 2.2 },
  // The oil drum by the bench, the blue toolbox, the half tyre hanging on its ropes, the blocks by the wall.
  { x: 1.65, z: -4.48, hx: 0.3, hz: 0.3, h: 0.9 },
  { x: 3.15, z: -4.45, hx: 0.28, hz: 0.16, h: 0.28 },
  { x: 4.6, z: -3.3, hx: 0.3, hz: 0.84, h: 1.45 },
  { x: 5.47, z: -3.35, hx: 0.14, hz: 0.75, h: 0.4 },
  // The skip, the sacks against it, the teal crate, the drum lying in front, the cardboard box behind the bed.
  { x: -7.6, z: 1.0, hx: 0.95, hz: 1.9, h: 1.35 },
  { x: -6.35, z: -0.04, hx: 0.42, hz: 0.54, h: 0.8 },
  { ...shelterYard(1.25, 2.55), hx: 0.3, hz: 0.3, h: 0.35 },
  // Nar's lean-to (turned with it): the four legs of its two arches, the rusty sheet down its left side in three short
  // boxes, the big tin at its front corner.
  ...([[-1.2, -1.25], [0.95, -1.25], [-1.2, 1.25], [0.95, 1.25]] as const).map(([lx, lz]) => ({ ...shelterYard(lx, lz), hx: 0.07, hz: 0.07, h: 1.9 })),
  ...[-0.9, -0.25, 0.4].map((lz) => ({ ...shelterYard(-1.37, lz), hx: 0.24, hz: 0.24, h: 1.5 })),
  { ...shelterYard(-1.45, 1.6), hx: 0.28, hz: 0.28, h: 0.62 },
  // The cooking corner: the fire's basin, the rebar rack, the rusty stove stood on its corner.
  { x: -9.3, z: 6.0, hx: 0.45, hz: 0.45, h: 0.35 },
  { x: -11.6, z: 5.6, hx: 0.55, hz: 0.5, h: 3.0 },
  { x: -11.9, z: 7.3, hx: 0.7, hz: 0.35, h: 1.4 },
  { x: -6.2, z: 4.44, hx: 0.3, hz: 0.46, h: 0.6 },
  { x: -5.55, z: -4.45, hx: 0.26, hz: 0.26, h: 0.42 },
  // Behind the fence: the dead tree's trunk and the ochre hut.
  { x: 3.5, z: -6.6, hx: 0.25, hz: 0.25, h: 3 },
  { x: -4.6, z: -7.1, hx: 1.32, hz: 1.32, h: 2.6 },
];

/** A yard point in the world. */
export function yardWorld(p: YardPlace, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

/** A world point in the yard's frame. */
export function yardLocal(p: YardPlace, x: number, z: number): { x: number; z: number } {
  const dx = x - p.x;
  const dz = z - p.z;
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** A yard facing turned into the world. */
export const yardYaw = (p: YardPlace, yaw: number) => yaw + p.yaw;

/** Where the yard is on this terrain, from its spec, standing on the ground there. */
export function placeYard(spec: { x: number; z: number; yaw: number } | undefined, ground: (x: number, z: number) => number): YardPlace | undefined {
  if (!spec) return undefined;
  // Snap the facing to a quarter turn: the colliders are axis-aligned boxes.
  const yaw = Math.round(spec.yaw / (Math.PI / 2)) * (Math.PI / 2);
  return { x: spec.x, z: spec.z, yaw, y: ground(spec.x, spec.z) };
}

/** The yard's solid boxes in the world: min and max corners and height. */
export function yardBoxes(p: YardPlace, solids: YardSolid[]): { minX: number; maxX: number; minZ: number; maxZ: number; h: number; thin: boolean }[] {
  return solids.map((s) => {
    const c = yardWorld(p, s.x, s.z);
    // A quarter turn swaps the half sizes.
    const swap = Math.abs(Math.sin(p.yaw)) > 0.5;
    const hx = swap ? s.hz : s.hx;
    const hz = swap ? s.hx : s.hz;
    return { minX: c.x - hx, maxX: c.x + hx, minZ: c.z - hz, maxZ: c.z + hz, h: s.h, thin: !!s.thin };
  });
}
