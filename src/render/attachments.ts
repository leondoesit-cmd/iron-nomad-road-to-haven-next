import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { crate, jerryCan, plate, rivets, signPlate, spareTyre, strap, heavyGun } from './parts';
import { partDef } from '../data';
import { PANEL_TAG, partMeta, partTag } from './bodyParts';
import { basketOn, bedKitOn, cageOn, isHolderModel } from './cargoParts';
import type { Fit } from '../sim/parts';
import { engineDims, type Dims } from '../sim/engineSize';
import type { HoodState } from '../sim/engines';
import { drawEngine, engineExtent } from './engineModels';

/**
 * How fitted parts look. Every chassis hands over a `Mounts` record (where its bumpers, roof, doors and bonnet are),
 * and each part draws itself against those numbers, so one definition fits a moped, a hatchback and a van.
 * All coordinates are in the frame the chassis model is built in.
 */
export interface Mounts {
  /** Half width of the body at door height. */
  hw: number;
  /** Front bumper face (z > 0), its centre height and half width. */
  front: { z: number; y: number; hw: number };
  /** Rear bumper face (z < 0). */
  rear: { z: number; y: number; hw: number };
  /** Top surface of the bonnet. */
  hood?: { y: number; z0: number; z1: number; hw: number };
  /** Top surface of the roof. */
  roof?: { y: number; z0: number; z1: number; hw: number };
  /** Boot lid or pickup bed floor. */
  trunk?: { y: number; z0: number; z1: number; hw: number };
  /** Door zone down the flank. */
  side: { y0: number; y1: number; z0: number; z1: number };
  /** The flank has real doors that swing (a car): their plating goes with them. */
  doors?: boolean;
  /** Height of the sill under the doors. */
  sill: number;
  /** Where a fixed front gun sits, just above the bonnet. */
  gun?: { x: number; y: number; z: number };
  /** A two-wheeler or quad: parts are drawn smaller and panniers replace cans. */
  narrow?: boolean;
  /** Wheel radius, so racks and pipes can stay clear of the tyres. */
  wheelR: number;
  /** Height of the floor of the engine bay, where the engine mounts sit. Default: just above the sill. */
  bayFloor?: number;
}

/** Lamps are registered through the rig so cached shells can replay them onto each instance. */
export interface Rig {
  /** A headlamp: round of radius `r` in a chrome bucket, or with `w` and `h` a rectangular lens whose housing the caller draws. */
  lamp(x: number, y: number, z: number, r: number, bucket?: boolean, w?: number, h?: number): void;
  tail(x: number, y: number, z: number, w?: number, h?: number, amber?: boolean): void;
  /** Where a fixed gun's muzzle flash appears. */
  muzzle(x: number, y: number, z: number): void;
}

/** What the engine in the bay looks like from outside. Derived from the build, so cached shells key off the fitted part ids. */
export interface EngineLook {
  /** The engine part in the bay: its model, its family colours and its real size. */
  id: string;
  /** Aftermarket quality 1..3, or 0 for a factory engine (even one carried over from another car). */
  mk: number;
  /** Not the engine this chassis was built with. */
  swapped: boolean;
  blown: boolean;
  diesel: boolean;
  /** Engine size class minus bay size class: how far it overshoots. */
  oversize: number;
  /** Size class of the engine itself. */
  size: number;
  /** The bay has been stripped. */
  empty: boolean;
  /** The engine's condition as a wear value 0 (new) to 1 (wrecked), in steps of a third so cached shells are shared. */
  wear: number;
  /** A whole bonnet, one with a hole cut in it, or none. */
  hood: HoodState;
}

export interface CoolingLook {
  /** Aftermarket quality 1..3, or 0 for the factory core. */
  mk: number;
  /** Rating in kW, to tell a big core from a small one. */
  kw: number;
  empty: boolean;
}

export interface KitLook {
  paint: number;
  stripe: number;
  stripeColor: number;
  seed: number;
  fit: Fit;
  wear: number;
  engine?: EngineLook;
  cooling?: CoolingLook;
}

const steel = (w = 0.7) => S.steel(0x565a5d, w);
const dark = () => S.steel(0x2c2f31, 0.6);
const chromeMat = () => S.chrome(0xc4c8cc);

function rnd(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The bonnet's joint: it hinges at its rear edge, so the panel can swing up (see `Bodywork`). Everything drawn between this
 * and `end()` goes up with it: the pressed panel, its vents and scoops, the plating over it, the engine that pokes through.
 */
export function markHood(b: MeshBuilder, m: Mounts) {
  const h = m.hood!;
  b.mark(PANEL_TAG.hood, partMeta({ kind: 'hood', pivot: [0, h.y - 0.04, h.z0 - 0.1] }));
}

/** A door's joint, for what is bolted over it: the same tag as the door itself, so it swings with it. */
function markDoor(b: MeshBuilder, m: Mounts, sx: 1 | -1) {
  b.mark(partTag('door', sx), partMeta({ kind: 'door', side: sx, pivot: [sx * (m.hw - 0.07), (m.side.y0 + m.side.y1) / 2, m.side.z1] }));
}

const mkOf = (fit: Fit, slot: keyof Fit) => (fit[slot] ? partDef(fit[slot]!.id).mk : 0);

// ---------------------------------------------------------------- performance parts

/**
 * Ceramic composite tiles in a grid over a rectangle on a flank (`sx` the side, the tiles facing out): square tiles with a
 * gap between, a bolt at each corner, alternate ones a shade off so the grid reads.
 */
function tiles(b: MeshBuilder, x: number, sx: number, y0: number, y1: number, z0: number, z1: number, t: number) {
  const s = 0.2;
  const nz = Math.max(1, Math.round((z1 - z0) / s));
  const ny = Math.max(1, Math.round((y1 - y0) / s));
  const tz = (z1 - z0) / nz;
  const ty = (y1 - y0) / ny;
  const a = S.paint(0xb4ac90, 0.4);
  const c = S.paint(0xa49c80, 0.45);
  const bolt = S.steel(0x3a3c3e, 0.6);
  b.box(x - sx * t * 0.3, (y0 + y1) / 2, (z0 + z1) / 2, t * 0.5, y1 - y0, z1 - z0, S.steel(0x2a2c2e, 0.7));
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < ny; j++) {
      const zz = z0 + (i + 0.5) * tz;
      const yy = y0 + (j + 0.5) * ty;
      b.box(x + sx * t * 0.25, yy, zz, t, ty - 0.012, tz - 0.012, (i + j) % 2 ? a : c);
      b.add('ico', x + sx * t * 0.8, yy + ty * 0.36, zz + tz * 0.36, 0.022, 0.022, 0.022, bolt);
    }
  }
}

/**
 * Plates over the doors, bonnet and roof, and what they are made of says what grade they are. Mk1 is scrap: a mismatched
 * patchwork of rusty sheet, a road sign and a panel off another car, hung crooked on bolts and wire. Mk2 is a workshop's
 * welded plate: square-cut sheets in grey primer with a weld bead round each and rivets down the seams, the bonnet plated
 * too. Mk3 is military: bolted ceramic tiles in a grid on the doors and a course along the sill, plate on the bonnet and
 * roof, slat bars over the side glass.
 */
function armorKit(b: MeshBuilder, m: Mounts, mk: number, look: KitLook) {
  const sideH = Math.max(0.2, m.side.y1 - m.side.y0);
  const zc = (m.side.z0 + m.side.z1) / 2;
  const yc = (m.side.y0 + m.side.y1) / 2;
  const len = m.side.z1 - m.side.z0;
  const primer = S.paint(0x6a6c68, 0.55);
  const rust = S.rust(0x6a3a22);
  const thick = 0.02 + mk * 0.008;
  const armorId = look.fit.armor?.id;
  const r = rnd(look.seed + 3);
  for (const sx of [1, -1]) {
    const x = sx * (m.hw + thick / 2 + 0.005);
    b.mark(partTag('slot', `armor:${sx}`), partMeta({ kind: 'slot', id: armorId, slot: 'armor', mk, side: sx as 1 | -1, pivot: [x, yc, zc] }));
    if (mk <= 1) {
      // Scrap: three sheets of whatever was lying about, overlapping and out of true, wired and bolted on.
      const SHEETS = [rust, S.steel(0x7a7e82, 0.85), S.paint(0x4d6a82, 0.85), S.paint(0xc9b084, 0.9), S.paint(0x8c2e26, 0.85)];
      for (let i = 0; i < 3; i++) {
        const w = len * (0.36 + r() * 0.12);
        const z = m.side.z0 + len * (0.18 + i * 0.32) + (r() - 0.5) * 0.06;
        const sheet = SHEETS[Math.floor(r() * SHEETS.length)];
        const tilt = (r() - 0.5) * 0.12;
        if (i === 1 && r() < 0.5 && !m.narrow) signPlate(b, x + sx * 0.012, yc + (r() - 0.5) * 0.04, z, w, sideH * 0.86, [0xe8c030, 0xc2402e, 0x2a5a9a][Math.floor(r() * 3)], 0, sx * Math.PI / 2, tilt);
        else plate(b, x + sx * i * 0.006, yc + (r() - 0.5) * 0.05, z, w, sideH * (0.8 + r() * 0.16), thick, sheet, 0, sx * Math.PI / 2, tilt, false);
        rivets(b, [x + sx * (thick + 0.008), yc + sideH * 0.3, z - w * 0.35], [x + sx * (thick + 0.008), yc + sideH * 0.3, z + w * 0.35], 2, 0.016, S.steel(0x2a2c2e));
      }
      // Wire twisted round the frame where a bolt would not hold.
      for (const z of [m.side.z0 + len * 0.3, m.side.z0 + len * 0.66]) b.rod(x + sx * (thick + 0.006), yc - sideH * 0.45, z, x + sx * (thick + 0.006), yc + sideH * 0.45, z + 0.02, 0.004, S.steel(0x8a8e92, 0.5), 4);
    } else if (mk === 2) {
      // Workshop plate: two square sheets per side in primer, a weld bead round each, rivets along the joint.
      for (const [dz, w] of [[0.24, 0.47], [-0.25, 0.45]] as [number, number][]) {
        const z = zc + len * dz;
        plate(b, x, yc, z, len * w, sideH, thick, primer, 0, sx * Math.PI / 2, 0, false);
        const bx = x + sx * (thick / 2 + 0.004);
        const bead = S.metal(0x5a524a, 0.7);
        b.box(bx, yc + sideH / 2 - 0.01, z, 0.008, 0.012, len * w - 0.02, bead);
        b.box(bx, yc - sideH / 2 + 0.01, z, 0.008, 0.012, len * w - 0.02, bead);
      }
      rivets(b, [x + sx * (thick / 2 + 0.006), yc - sideH * 0.42, zc], [x + sx * (thick / 2 + 0.006), yc + sideH * 0.42, zc], 5);
      rivets(b, [x + sx * (thick / 2 + 0.006), yc + sideH * 0.42, m.side.z0 + 0.05], [x + sx * (thick / 2 + 0.006), yc + sideH * 0.42, m.side.z1 - 0.05], 8);
    } else {
      // Military: a grid of ceramic tiles on the door, a second course along the sill.
      tiles(b, x, sx, m.side.y0, m.side.y1, m.side.z0 + 0.03, m.side.z1 - 0.03, thick);
      if (!m.narrow) tiles(b, x + sx * 0.014, sx, m.side.y0 - 0.14, m.side.y0 - 0.01, m.side.z0 - 0.1, m.side.z1 + 0.1, thick);
    }
    b.end();
  }
  if (m.narrow) return;
  const col = mk >= 3 ? S.paint(0xaeb2ae, 0.45) : primer;
  if (mk >= 2 && m.hood) {
    b.mark(partTag('slot', 'armor:hood'), partMeta({ kind: 'slot', id: armorId, slot: 'armor', mk, pivot: [0, m.hood.y, m.hood.z0] }));
    plate(b, 0, m.hood.y + 0.018, (m.hood.z0 + m.hood.z1) / 2, m.hood.hw * 1.55, m.hood.z1 - m.hood.z0 - 0.1, thick, col, -Math.PI / 2, 0, 0);
    b.end();
  }
  if (mk >= 3 && m.roof) {
    b.mark(partTag('slot', 'armor:roof'), partMeta({ kind: 'slot', id: armorId, slot: 'armor', mk, pivot: [0, m.roof.y, (m.roof.z0 + m.roof.z1) / 2] }));
    plate(b, 0, m.roof.y + 0.02, (m.roof.z0 + m.roof.z1) / 2, m.roof.hw * 1.5, m.roof.z1 - m.roof.z0 - 0.08, thick, col, -Math.PI / 2, 0, 0);
    // Slatted window armour: bars across the glass line.
    for (let i = 0; i < 5; i++) {
      const z = m.roof.z1 - 0.1 - i * ((m.roof.z1 - m.roof.z0 - 0.2) / 5);
      for (const sx of [1, -1]) b.box(sx * (m.hw - 0.01), m.side.y1 + 0.18 + r() * 0.02, z, 0.025, 0.05, 0.22, dark());
    }
    b.end();
  }
}

// ---------------------------------------------------------------- the engine bay, as a volume

/** The real engine bay of a model: the room between the cowl, the radiator, the wings, the floor and the underside of the bonnet. */
export interface BayVolume {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  floor: number;
  /** Underside of the closed bonnet. */
  top: number;
  l: number;
  w: number;
  h: number;
}

/** Clearance an engine keeps from the bonnet and the wings when it is meant to fit. */
export const BAY_CLEAR = 0.03;

/** Derived from the mounts: the bonnet's height (a bonnet is 0.1 m of panel), its length and its half width, and the wing walls. */
export function bayVolume(m: Mounts): BayVolume | null {
  const h = m.hood;
  if (!h) return null;
  const floor = m.bayFloor ?? m.sill + 0.04;
  const top = h.y - 0.1;
  // Room under the cowl at the back, and the radiator, core and fan at the front.
  const z0 = h.z0 - 0.15;
  const z1 = h.z1 - 0.16;
  const hw = h.hw * 0.85;
  return { x0: -hw, x1: hw, z0, z1, floor, top, l: z1 - z0, w: hw * 2, h: top - floor };
}

/** Where an engine sits in its bay: centre of its base, and how far up it has been jacked to get it in under a bonnet it overshoots. */
export function enginePlacement(m: Mounts, e: EngineLook): { x: number; y: number; z: number; dims: Dims; lift: number } | null {
  const vol = bayVolume(m);
  if (!vol || e.empty) return null;
  const spec = partDef(e.id).engine;
  if (!spec) return null;
  // What is really drawn, not the box it is allowed (see `engineExtent`).
  const ext = engineExtent(e.id);
  const dims: Dims = { l: Math.min(ext.l, engineDims(spec).l), w: Math.min(ext.w, engineDims(spec).w), h: Math.min(ext.h, engineDims(spec).h) };
  const y = vol.floor + 0.03;
  let lift = 0;
  // A snug engine is wedged up on its mounts until the bonnet just clears it, and the bonnet bulges over what is left.
  if (e.oversize === 1 && e.hood === 'closed') lift = Math.max(0, Math.min(0.06, vol.top + 0.03 - (y + dims.h)));
  // Through a cut bonnet it is the other way round: the engine stands up through the hole, the further the bigger it is.
  else if (e.oversize > 0 && e.hood === 'cut' && m.hood) lift = Math.max(0, Math.min(0.28, m.hood.y + 0.01 + 0.06 + 0.05 * Math.min(3, e.oversize) - (y + dims.h)));
  const z = vol.z1 - dims.l / 2 - 0.02;
  return { x: 0, y: y + lift, z, dims, lift };
}

/** Stand an engine model in `b` at a place, in real size. */
function placeEngine(b: MeshBuilder, id: string, wear: number, x: number, y: number, z: number) {
  const sub = new MeshBuilder();
  sub.jitter = 0.02;
  drawEngine(sub, id, { wear });
  b.appendMatrix(sub, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
}

/** How far a bulge over the engine stands above the bonnet's top surface, metres: 0 when the engine fits flat. */
export function bulgeHeight(m: Mounts, e: EngineLook): number {
  if (e.oversize !== 1 || e.hood !== 'closed') return 0;
  const pl = enginePlacement(m, e);
  const h = m.hood;
  if (!pl || !h) return 0;
  // The bonnet's top surface is 0.01 above its mount height; leave 0.035 of sheet over the engine.
  return Math.max(0.04, pl.y + pl.dims.h + 0.035 - (h.y + 0.01));
}

/**
 * Engine visible from outside. An engine that fits shows nothing above the bonnet at all (it is in the bay, see `bayKit`). One
 * that overshoots by a step (snug) raises a painted bulge in the bonnet; a tighter one holds the bonnet propped open on its own
 * (the hood panel is posed by `Bodywork`, from `bayFit`), and one that is far too big cannot be closed over at all: the bonnet is
 * cut (`cutHoodKit`) or taken off. On a bike or quad the motor simply hangs out where everyone can see it.
 */
function engineKit(b: MeshBuilder, m: Mounts, e: EngineLook, look: KitLook, hoodOff = false) {
  const mk = e.mk;
  if (!m.hood) {
    // Bikes and quads: a bigger expansion chamber along the flank.
    const x = m.hw * 0.9;
    if (mk > 0) {
      b.pipe(
        [
          [x, m.sill + 0.02, m.front.z * 0.2],
          [x + 0.04, m.sill, m.rear.z * 0.3],
          [x + 0.05, m.sill + 0.04, m.rear.z * 0.8],
        ],
        0.028 + mk * 0.006,
        chromeMat(),
        8,
      );
      b.limb(x + 0.04, m.sill, m.rear.z * 0.3, x + 0.05, m.sill + 0.04, m.rear.z * 0.85, 0.06 + mk * 0.01, 0.045, chromeMat(), 12);
    }
    if (e.swapped && e.size >= 2) {
      // A car engine bolted in where a bike motor used to be: the real thing, hanging out of the frame for everyone to see.
      placeEngine(b, e.id, e.wear, 0, m.sill + 0.05, (m.side.z0 + m.side.z1) / 2 - 0.1);
    }
    return;
  }
  // With the bonnet off the whole engine is on show (see `bayKit`), so nothing needs to poke through it.
  if (hoodOff) {
    if (e.diesel && e.swapped) dieselStack(b, m);
    return;
  }
  const bulge = bulgeHeight(m, e);
  const h = m.hood;
  if (bulge > 0) {
    const pl = enginePlacement(m, e)!;
    // Whatever is raised on the bonnet is bolted to it: it swings up with the panel.
    markHood(b, m);
    const body = S.paint(look.paint, Math.min(1, look.wear + 0.1));
    const w = Math.min(h.hw * 1.7, pl.dims.w + 0.1);
    const len = Math.min(h.z1 - h.z0 - 0.1, pl.dims.l * 0.78);
    // A pressed dome the shape of the engine's top, with a dark seam where it meets the bonnet and louvres for the heat.
    b.rbox(0, h.y + 0.01 + bulge * 0.5, pl.z, w, bulge, len, Math.min(0.07, bulge * 0.9), body);
    b.box(0, h.y + 0.014, pl.z, w * 1.02, 0.008, len * 1.02, S.plastic(0x0c0c0c));
    for (let i = 0; i < 4; i++) b.box(0, h.y + 0.01 + bulge + 0.002, pl.z - len * 0.3 + i * len * 0.2, w * 0.6, 0.006, 0.02, S.plastic(0x0c0c0c));
    b.end();
  }
  // A blown petrol engine's supercharger stands up through a hole cut in a factory bonnet, its bug-catcher scoop on top; an
  // aftermarket turbo diesel breathes through a scoop raised over its intake.
  const hp = bodyPart(look.fit, 'hood');
  if ((!hp || hp.stock) && e.hood === 'closed' && bulge === 0) {
    const pl = enginePlacement(m, e);
    if (pl && e.blown && !e.diesel) blowerKit(b, m, pl, look);
    else if (pl && e.blown && e.diesel && e.mk >= 2) intakeScoop(b, m, pl, look);
  }
  if (e.diesel && e.swapped) dieselStack(b, m);
}

/** A roots blower through the bonnet: the hole's chrome ring, the ribbed case, the belt snout, and a bug-catcher on top. */
function blowerKit(b: MeshBuilder, m: Mounts, pl: { z: number; dims: Dims }, look: KitLook) {
  const h = m.hood!;
  const w = Math.min(h.hw * 0.9, Math.max(0.26, pl.dims.w * 0.5));
  const l = Math.min(h.z1 - h.z0 - 0.2, Math.max(0.34, pl.dims.l * 0.48));
  const z = Math.min(h.z1 - l / 2 - 0.08, pl.z);
  const y = h.y + 0.01;
  const alu = S.metal(0xc4c8cc, 0.3);
  const chrome = chromeMat();
  markHood(b, m);
  b.box(0, y + 0.002, z, w + 0.08, 0.004, l + 0.08, S.metal(0x0a0a0a, 0.2));
  b.rbox(0, y + 0.012, z, w + 0.1, 0.02, l + 0.1, 0.008, chrome);
  b.rbox(0, y + 0.1, z, w, 0.18, l, 0.03, alu);
  for (let i = 0; i < 5; i++) for (const sx of [1, -1]) b.box(sx * (w / 2 + 0.006), y + 0.06 + i * 0.025, z, 0.01, 0.012, l * 0.86, S.metal(0x8a8e92, 0.4));
  b.cyl(0, y + 0.1, z + l / 2 + 0.05, 0.14, 0.1, 0.14, S.steel(0x1c1e20), Math.PI / 2, 0, 0, 14);
  b.cyl(0, y + 0.1, z + l / 2 + 0.11, 0.12, 0.02, 0.12, chrome, Math.PI / 2, 0, 0, 14);
  // The bug-catcher: a chrome box with its mouth to the wind and two butterflies in it.
  const sy = y + 0.25;
  b.rbox(0, sy, z + 0.02, w * 0.86, 0.13, l * 0.6, 0.02, chrome, -0.08, 0, 0);
  b.box(0, sy + 0.005, z + 0.02 + l * 0.3 + 0.004, w * 0.72, 0.09, 0.008, S.metal(0x050505, 0.2));
  for (const sx of [1, -1]) b.box(sx * w * 0.18, sy + 0.005, z + 0.02 + l * 0.3 + 0.01, 0.006, 0.07, 0.02, alu, 0, 0.6, 0);
  b.end();
  void look;
}

/** A raised intake scoop over a turbo diesel's air box, in the body colour, with a mesh in its mouth. */
function intakeScoop(b: MeshBuilder, m: Mounts, pl: { z: number; dims: Dims }, look: KitLook) {
  const h = m.hood!;
  const w = Math.min(h.hw * 1.1, Math.max(0.3, pl.dims.w * 0.6));
  const l = Math.min(h.z1 - h.z0 - 0.2, 0.42);
  const z = Math.min(h.z1 - l / 2 - 0.1, pl.z + 0.05);
  const body = S.paint(look.paint, Math.min(1, look.wear + 0.1));
  markHood(b, m);
  b.rbox(0, h.y + 0.05, z, w, 0.1, l, 0.03, body, -0.06, 0, 0);
  b.box(0, h.y + 0.06, z + l / 2 + 0.006, w * 0.84, 0.06, 0.008, S.metal(0x050505, 0.2));
  for (let i = 0; i < 6; i++) b.box(-w * 0.36 + i * (w * 0.72) / 5, h.y + 0.06, z + l / 2 + 0.012, 0.006, 0.06, 0.006, S.steel(0x3a3c3e));
  b.end();
}

/**
 * The bonnet with a hole cut in it (`hood_cut`): a ragged opening sized for the engine under it, the torn steel curled up round
 * the edge, and a dark pit. It is part of the bonnet, so it lifts with it. Whatever stands taller than the bay comes up through it.
 */
function cutHoodKit(b: MeshBuilder, m: Mounts, look: KitLook) {
  const h = m.hood;
  if (!h) return;
  const e = look.engine;
  const pl = e && !e.empty ? enginePlacement(m, { ...e, oversize: 0 }) : null;
  const len = Math.min(h.z1 - h.z0 - 0.12, (pl?.dims.l ?? 0.55) * 0.9);
  const wid = Math.min(h.hw * 1.6, (pl?.dims.w ?? 0.5) * 0.92);
  const zc = pl?.z ?? (h.z0 + h.z1) / 2;
  const y = h.y + 0.014;
  const bare = S.steel(0x8a8e92, 0.9);
  const rust = S.rust(0x7a3f22);
  const pit = S.steel(0x0c0c0c, 0.2);
  markHood(b, m);
  b.rbox(0, y, zc, wid, 0.012, len, 0.004, pit);
  // The cut edge: jagged teeth of torn steel all round, bent up at different angles. Seeded, so a car's hood is always the same.
  const r = rnd(look.seed + 211);
  const teeth = (n: number, at: (t: number) => [number, number], yaw: number, size: number) => {
    for (let i = 0; i < n; i++) {
      const [x, z] = at((i + 0.5) / n);
      const tilt = 0.5 + r() * 0.8;
      const sz = size * (0.7 + r() * 0.7);
      b.rbox(x, y + 0.012 + Math.sin(tilt) * sz * 0.4, z, sz * 0.7, 0.008, sz, 0.002, r() > 0.55 ? rust : bare, -tilt * Math.cos(yaw), yaw, tilt * Math.sin(yaw));
    }
  };
  teeth(7, (t) => [-wid / 2 + t * wid, len / 2 + zc], 0, 0.07);
  teeth(7, (t) => [-wid / 2 + t * wid, -len / 2 + zc], Math.PI, 0.07);
  teeth(6, (t) => [wid / 2, zc - len / 2 + t * len], Math.PI / 2, 0.07);
  teeth(6, (t) => [-wid / 2, zc - len / 2 + t * len], -Math.PI / 2, 0.07);
  // A bright scratched rim where the cutter ran.
  const rim = S.metal(0xd0d4d8, 0.3);
  b.box(0, y + 0.005, zc + len / 2, wid, 0.004, 0.012, rim);
  b.box(0, y + 0.005, zc - len / 2, wid, 0.004, 0.012, rim);
  b.box(wid / 2, y + 0.005, zc, 0.012, 0.004, len, rim);
  b.box(-wid / 2, y + 0.005, zc, 0.012, 0.004, len, rim);
  b.end();
}

/** A diesel in a car that left the factory on petrol: an upright exhaust stack behind the cab. */
function dieselStack(b: MeshBuilder, m: Mounts) {
  const z = m.roof ? m.roof.z0 - 0.02 : m.rear.z + 0.5;
  const top = (m.roof?.y ?? m.side.y1) + 0.12;
  const x = -(m.hw + 0.05);
  b.pipe([[x, m.sill + 0.05, z - 0.25], [x, m.sill + 0.12, z], [x, top, z]], 0.045, chromeMat(), 8);
  b.cyl(x, top + 0.04, z, 0.12, 0.05, 0.12, S.steel(0x2a2c2f), 0, 0, 0, 10);
}

/** A radiator that is not the factory one shows through the grille: a finned core, coloured tanks, fans on the big ones. */
function coolingKit(b: MeshBuilder, m: Mounts, c: CoolingLook) {
  if (c.mk <= 0 || c.empty) return;
  const F = m.front.z;
  const y = m.front.y + (m.narrow ? 0.06 : 0.16);
  const w = Math.max(0.14, m.front.hw * (m.narrow ? 1.5 : 1.3));
  const hgt = (m.narrow ? 0.14 : 0.2) + c.mk * 0.04;
  const alu = c.mk >= 3 ? S.metal(0xc4c8cc, 0.4) : c.mk === 2 ? S.metal(0xa8acb0, 0.5) : S.steel(0x3a3d40, 0.7);
  b.rbox(0, y, F - 0.025, w * 2, hgt, 0.07, 0.015, alu);
  const n = Math.max(4, Math.round(w * 11));
  for (let i = 0; i < n; i++) b.box(-w + (i + 0.5) * ((w * 2) / n), y, F + 0.012, 0.008, hgt * 0.8, 0.01, dark());
  if (c.mk >= 2) {
    // Coloured end tanks and a hose up to the engine.
    for (const sx of [1, -1]) {
      b.rbox(sx * (w + 0.015), y, F - 0.025, 0.05, hgt + 0.03, 0.08, 0.015, S.paint(c.mk >= 3 ? 0xe07a1a : 0xc23a1a, 0.4));
      b.pipe([[sx * (w + 0.03), y + hgt * 0.4, F - 0.03], [sx * (w + 0.06), y + hgt * 0.9, F - 0.2]], 0.014, S.rubber(0x1c1c1e), 6);
    }
  }
  if (c.mk >= 3 || c.kw >= 400) {
    // A second core behind the first, and twin fans showing at the sides.
    b.rbox(0, y - hgt * 0.35, F - 0.1, w * 1.9, hgt * 0.6, 0.06, 0.012, S.metal(0x6a6e72, 0.5));
    for (const sx of [1, -1]) {
      b.cyl(sx * w * 0.5, y, F - 0.07, hgt * 0.85, 0.03, hgt * 0.85, S.plastic(0x141414), Math.PI / 2, 0, 0, 14);
      b.cyl(sx * w * 0.5, y, F - 0.05, hgt * 0.2, 0.04, hgt * 0.2, S.steel(0x5a5d60), Math.PI / 2, 0, 0, 8);
    }
  }
}

/** A fixed front gun on the bonnet for chassis with a front mount: one barrel, two, or a shielded heavy. */
function weaponKit(b: MeshBuilder, rig: Rig, m: Mounts, mk: number, native: boolean) {
  const g = m.gun;
  if (!g) return;
  const stand = dark();
  const place = (x: number, scale: number, shield: boolean) => {
    const gun = new MeshBuilder();
    heavyGun(gun, 0.9, shield);
    b.appendMatrix(gun, new THREE.Matrix4().compose(new THREE.Vector3(g.x + x, g.y, g.z), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale)));
    b.box(g.x + x, g.y - 0.13 * scale, g.z, 0.07, 0.2 * scale, 0.07, stand);
  };
  if (!native) {
    // A welded post and cradle for a gun the chassis did not come with.
    b.pipe(
      [
        [-0.28, g.y - 0.18, g.z - 0.12],
        [-0.16, g.y - 0.02, g.z],
        [0.16, g.y - 0.02, g.z],
        [0.28, g.y - 0.18, g.z - 0.12],
      ],
      0.018,
      stand,
      6,
    );
  }
  if (mk <= 1) {
    place(0, 0.75, false);
  } else if (mk === 2) {
    place(-0.17, 0.7, false);
    place(0.17, 0.7, false);
  } else {
    place(0, 1.05, true);
    b.rbox(0.36, g.y - 0.05, g.z - 0.1, 0.16, 0.2, 0.3, 0.02, S.paint(0x4a5532, 0.7));
  }
  rig.muzzle(0, g.y, g.z + 0.95 * (mk >= 3 ? 1.05 : 0.75));
}

/** Fuel cans on the rear quarters, a long-range tank underneath, or panniers on a bike. */
function utilityKit(b: MeshBuilder, m: Mounts, mk: number, look: KitLook) {
  const r = rnd(look.seed + 9);
  const cols = [0x55603e, look.paint, 0xb0301e, 0xc89a2a];
  const utlId = look.fit.utility?.id;
  const tag = (sx: number, pivot: [number, number, number]) => b.mark(partTag('slot', `utility:${sx}`), partMeta({ kind: 'slot', id: utlId, slot: 'utility', mk, side: sx as -1 | 0 | 1, pivot }));
  if (m.narrow) {
    for (const sx of [1, -1]) {
      tag(sx, [sx * m.rear.hw, m.rear.y, m.rear.z + 0.55]);
      b.rbox(sx * (m.rear.hw + 0.12 + mk * 0.02), m.rear.y - 0.02, m.rear.z + 0.55, 0.18 + mk * 0.03, 0.26, 0.4, 0.04, S.leather(0x3a3228, 0.7));
      b.box(sx * (m.rear.hw + 0.12 + mk * 0.02), m.rear.y + 0.12, m.rear.z + 0.55, 0.19 + mk * 0.03, 0.02, 0.2, S.steel(0x6a6c6e));
      b.end();
    }
    return;
  }
  const z = m.rear.z + 0.42;
  for (const sx of [1, -1]) {
    const x = sx * (m.hw + 0.13);
    tag(sx, [sx * m.hw, m.sill + 0.12, z]);
    b.box(x - sx * 0.07, m.sill + 0.12, z, 0.14, 0.03, 0.34, dark());
    jerryCan(b, x, m.sill + 0.135, z, cols[Math.floor(r() * cols.length)], sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    if (mk >= 3) jerryCan(b, x, m.sill + 0.135, z + 0.34, cols[Math.floor(r() * cols.length)], sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    strap(b, [[x - sx * 0.1, m.sill + 0.12, z - 0.14], [x - sx * 0.1, m.sill + 0.5, z - 0.14], [x + sx * 0.1, m.sill + 0.5, z - 0.14]]);
    b.end();
  }
  if (mk >= 2) {
    // A cylindrical tank slung under the tail, with a hose up to the filler.
    const d = 0.26 + (mk - 2) * 0.08;
    tag(0, [0, m.sill, m.rear.z + 0.62]);
    b.cyl(0, m.sill - 0.02, m.rear.z + 0.62, d, m.hw * 1.5, d, S.steel(0x6a6e72, 0.55), 0, 0, Math.PI / 2, 18);
    for (const sx of [1, -1]) b.box(sx * m.hw * 0.62, m.sill + 0.08, m.rear.z + 0.62, 0.04, 0.3, 0.06, dark());
    b.pipe([[m.hw * 0.72, m.sill, m.rear.z + 0.62], [m.hw * 0.86, m.sill + 0.3, m.rear.z + 0.5], [m.hw + 0.02, m.sill + 0.5, m.rear.z + 0.42]], 0.015, S.rubber(0x1c1c1e), 6);
    b.end();
  }
}

// ---------------------------------------------------------------- bolt-on mounts

function frontKit(b: MeshBuilder, m: Mounts, id: string) {
  const F = m.front.z;
  const y = m.front.y;
  const hw = m.front.hw;
  const tube = S.steel(0x34373a, 0.7);
  if (id === 'fr_bull') {
    for (const sx of [1, -1]) {
      b.pipe([[sx * hw * 0.98, y - 0.16, F - 0.05], [sx * hw, y - 0.1, F + 0.12], [sx * hw, y + 0.28, F + 0.1], [sx * hw * 0.7, y + 0.4, F - 0.02]], 0.032, tube, 8);
      b.rod(sx * hw * 0.35, y - 0.12, F + 0.1, sx * hw * 0.35, y + 0.3, F + 0.06, 0.026, tube, 8);
    }
    b.rod(-hw, y + 0.28, F + 0.1, hw, y + 0.28, F + 0.1, 0.032, tube, 8);
    b.rod(-hw, y - 0.1, F + 0.12, hw, y - 0.1, F + 0.12, 0.032, tube, 8);
    b.rod(-hw * 0.7, y + 0.4, F - 0.02, hw * 0.7, y + 0.4, F - 0.02, 0.028, tube, 8);
  } else if (id === 'fr_blade') {
    plate(b, 0, y - 0.04, F + 0.28, hw * 2.15, 0.7, 0.06, S.steel(0x6a6e72, 0.85), -0.5, 0, 0);
    for (const sx of [1, -1]) {
      b.rod(sx * hw * 0.7, y + 0.05, F - 0.1, sx * hw * 0.7, y - 0.1, F + 0.32, 0.04, S.steel(0x3a3c3e), 8);
      b.rod(sx * hw * 0.7, y - 0.2, F - 0.1, sx * hw * 0.7, y - 0.28, F + 0.3, 0.035, S.steel(0x3a3c3e), 8);
    }
    b.box(0, y + 0.22, F + 0.2, hw * 2.1, 0.07, 0.06, S.paint(0xc9a22a, 0.7));
  } else {
    b.rbox(0, y - 0.05, F + 0.1, hw * 2.05, 0.3, 0.1, 0.02, S.steel(0x5a5e60, 0.8));
    for (let i = 0; i < 7; i++) b.add('cone12', -hw * 0.9 + i * ((hw * 1.8) / 6), y - 0.05, F + 0.3, 0.08, 0.34, 0.08, S.steel(0x8a8e92, 0.5), Math.PI / 2, 0, 0);
    for (const sx of [1, -1]) b.add('cone12', sx * (hw + 0.04), y - 0.05, F - 0.1, 0.08, 0.3, 0.08, S.steel(0x8a8e92, 0.5), 0, 0, -sx * Math.PI / 2);
  }
}

function roofKit(b: MeshBuilder, rig: Rig, m: Mounts, id: string, look: KitLook) {
  const ro = m.roof;
  if (!ro) return;
  const r = rnd(look.seed + 21);
  const L = ro.z1 - ro.z0;
  const zc = (ro.z0 + ro.z1) / 2;
  const hw = ro.hw;
  if (id === 'rf_rack' || isHolderModel(id)) {
    // Rails, baskets and nets only hold what is put in them (see sim/cargo.ts): no load is painted on.
    basketOn(b, ro, id);
  } else if (id === 'rf_light') {
    const z = ro.z1 - 0.12;
    b.rbox(0, ro.y + 0.07, z, hw * 1.7, 0.1, 0.16, 0.03, S.plastic(0x181818));
    const n = 4;
    for (let i = 0; i < n; i++) {
      const x = -hw * 0.68 + (i / (n - 1)) * hw * 1.36;
      b.cyl(x, ro.y + 0.07, z + 0.07, 0.1, 0.06, 0.1, chromeMat(), Math.PI / 2, 0, 0, 12);
      rig.lamp(x, ro.y + 0.07, z + 0.1, 0.045, false);
    }
    for (const sx of [1, -1]) b.box(sx * hw * 0.5, ro.y + 0.01, z, 0.05, 0.06, 0.1, dark());
  } else {
    // Roll cage: two hoops over the cab and rails along the roof.
    const t = S.paint(0x2a2c2e, 0.6);
    const y = ro.y + 0.12;
    for (const z of [ro.z0 + 0.1, ro.z1 - 0.1]) {
      b.pipe([[m.hw, m.side.y0 + 0.1, z], [m.hw * 0.96, m.side.y1 + 0.2, z], [hw * 0.8, y, z], [-hw * 0.8, y, z], [-m.hw * 0.96, m.side.y1 + 0.2, z], [-m.hw, m.side.y0 + 0.1, z]], 0.026, t, 8);
    }
    for (const sx of [1, -1]) b.pipe([[sx * hw * 0.8, y, ro.z0 + 0.1], [sx * hw * 0.8, y, ro.z1 - 0.1]], 0.024, t, 8);
    b.rod(-hw * 0.8, y, ro.z0 + 0.1, hw * 0.8, y, ro.z1 - 0.1, 0.02, t, 6);
  }
}

function rearKit(b: MeshBuilder, m: Mounts, id: string, look: KitLook) {
  const z = m.rear.z;
  if (id === 'rr_spare') {
    const rad = Math.max(0.28, m.wheelR * 0.95);
    b.box(0, m.rear.y + 0.2, z - 0.04, 0.2, 0.14, 0.05, dark());
    spareTyre(b, 0, m.rear.y + 0.38, z - 0.13, rad, 0.2, Math.PI / 2, 0);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.cyl(Math.cos(a) * 0.06, m.rear.y + 0.38 + Math.sin(a) * 0.06, z - 0.25, 0.03, 0.025, 0.03, S.steel(0x5a5d60), Math.PI / 2, 0, 0, 6);
    }
  } else if (id === 'rr_wing') {
    const base = (m.trunk?.y ?? m.rear.y + 0.45) + 0.04;
    const y = base + 0.3;
    const zz = z + 0.3;
    for (const sx of [1, -1]) {
      b.rod(sx * m.rear.hw * 0.62, base, zz, sx * m.rear.hw * 0.62, y, zz, 0.02, dark(), 6);
      b.box(sx * m.rear.hw * 0.98, y + 0.03, zz, 0.025, 0.1, 0.34, S.paint(look.paint, 0.4));
    }
    b.rbox(0, y + 0.03, zz, m.rear.hw * 1.96, 0.025, 0.32, 0.01, S.paint(look.stripe ? look.stripeColor : 0x1e1e20, 0.4), -0.12, 0, 0);
  } else if (isHolderModel(id)) {
    cageOn(b, m, id);
  } else {
    // Cargo box: on the boot or bed when there is one, else a carrier behind the bumper.
    const col = S.steel(0x4a4e50, 0.75);
    if (m.trunk) {
      const t = m.trunk;
      const L = (t.z1 - t.z0) * 0.9;
      b.rbox(0, t.y + 0.26, (t.z0 + t.z1) / 2, t.hw * 1.8, 0.5, L, 0.03, col);
      b.box(0, t.y + 0.52, (t.z0 + t.z1) / 2, t.hw * 1.84, 0.02, L + 0.02, dark());
      rivets(b, [-t.hw * 0.86, t.y + 0.5, t.z0 + 0.1], [t.hw * 0.86, t.y + 0.5, t.z0 + 0.1], 7);
      b.box(0, t.y + 0.3, t.z0 - 0.0, 0.14, 0.05, 0.02, S.metal(0xaaaaaa));
    } else {
      b.box(0, m.rear.y - 0.05, z - 0.2, m.rear.hw * 1.6, 0.04, 0.5, dark());
      b.rbox(0, m.rear.y + 0.18, z - 0.22, m.rear.hw * 1.5, 0.4, 0.46, 0.03, col);
      b.box(0, m.rear.y + 0.4, z - 0.22, m.rear.hw * 1.54, 0.02, 0.5, dark());
    }
  }
}

function sideKit(b: MeshBuilder, m: Mounts, id: string) {
  const zc = (m.side.z0 + m.side.z1) / 2;
  const len = m.side.z1 - m.side.z0;
  for (const sx of [1, -1]) {
    const x = sx * (m.hw + 0.07);
    b.mark(partTag('slot', `side:${sx}`), partMeta({ kind: 'slot', id, slot: 'side', mk: partDef(id).mk, side: sx as 1 | -1, pivot: [sx * m.hw, m.sill + 0.05, zc] }));
    if (id === 'sd_skirt') {
      const t = S.steel(0x34373a, 0.7);
      b.pipe([[x, m.sill - 0.03, m.side.z0 - 0.1], [x, m.sill - 0.03, m.side.z1 + 0.1]], 0.036, t, 8);
      for (let i = 0; i < 4; i++) {
        const z = m.side.z0 + (i / 3) * len;
        b.rod(x, m.sill - 0.03, z, sx * (m.hw - 0.02), m.sill + 0.08, z, 0.018, t, 6);
      }
    } else if (id === 'sd_plate') {
      const h = Math.max(0.22, (m.side.y1 - m.side.y0) * 0.9);
      plate(b, sx * (m.hw + 0.05), (m.side.y0 + m.side.y1) / 2 - 0.02, zc + len * 0.3, len * 0.42, h, 0.03, S.steel(0x4c5154, 0.8), 0, sx * Math.PI / 2, 0);
      plate(b, sx * (m.hw + 0.05), (m.side.y0 + m.side.y1) / 2, zc - len * 0.2, len * 0.5, h * 1.05, 0.03, S.rust(0x6a3a22), 0, sx * Math.PI / 2, 0);
      plate(b, sx * (m.hw + 0.05), m.sill + 0.16, m.rear.z + 0.55, 0.7, 0.3, 0.03, S.steel(0x4c5154, 0.8), 0, sx * Math.PI / 2, 0);
    } else {
      const c = chromeMat();
      b.pipe([[x, m.sill + 0.02, m.side.z1 + 0.05], [x + sx * 0.02, m.sill - 0.02, zc], [x, m.sill + 0.02, m.side.z0 - 0.05]], 0.034, c, 8);
      b.box(x + sx * 0.02, m.sill + 0.08, zc, 0.03, 0.08, len * 0.7, S.steel(0x2a2c2e, 0.5));
      b.cyl(x, m.sill + 0.02, m.side.z0 - 0.07, 0.06, 0.03, 0.06, S.metal(0x1a1612, 0.9), Math.PI / 2, 0, 0, 10);
    }
    b.end();
  }
}

// ---------------------------------------------------------------- body panels

/** The part on a body slot (bonnet, a door), if it is not the factory one, and whether the mount is stripped bare. */
export function bodyPart(fit: Fit, slot: 'hood' | 'doorL' | 'doorR'): { id: string; off: boolean; stock: boolean } | null {
  const it = fit[slot];
  if (!it) return null;
  const d = partDef(it.id);
  return { id: it.id, off: !!d.empty, stock: !!d.stock };
}
export const panelOff = (fit: Fit, slot: 'hood' | 'doorL' | 'doorR') => !!bodyPart(fit, slot)?.off;
/** A door whose steel is not drawn in the body: stripped off, or replaced by canvas. */
export const doorSkipsSteel = (fit: Fit, slot: 'doorL' | 'doorR') => {
  const p = bodyPart(fit, slot);
  return !!p && (p.off || p.id === 'door_light');
};

/** The bonnet on the car: vents, a scoop, or armour plate over the paint. */
function hoodKit(b: MeshBuilder, m: Mounts, id: string, look: KitLook) {
  const h = m.hood;
  if (!h) return;
  const len = h.z1 - h.z0;
  const zc = (h.z0 + h.z1) / 2;
  const dk = S.plastic(0x0c0c0c);
  if (id === 'hood_vent') {
    for (let i = 0; i < 6; i++) for (const sx of [1, -1]) b.box(sx * h.hw * 0.42, h.y + 0.014, h.z0 + 0.12 + i * ((len - 0.3) / 5), h.hw * 0.5, 0.018, 0.035, dk, 0, 0, sx * 0.08);
  } else if (id === 'hood_scoop') {
    const body = S.paint(look.paint, Math.min(1, look.wear + 0.2));
    b.rbox(0, h.y + 0.08, zc + len * 0.08, h.hw * 0.72, 0.14, len * 0.4, 0.05, body, -0.08, 0, 0);
    b.box(0, h.y + 0.085, zc + len * 0.08 + len * 0.2, h.hw * 0.6, 0.09, 0.02, dk);
    for (let i = 0; i < 3; i++) b.box(0, h.y + 0.085, zc + len * 0.08 + len * 0.2 - 0.03 - i * 0.05, h.hw * 0.56, 0.007, 0.012, S.steel(0x2a2c2e));
  } else if (id === 'hood_armor') {
    const sheet = S.steel(0x4a4d50, 0.85);
    plate(b, 0, h.y + 0.025, zc, h.hw * 2.05, len * 0.96, 0.035, sheet, -Math.PI / 2, 0, 0);
    // A bar across the front edge and a slot for the driver to watch the road over.
    b.rbox(0, h.y + 0.06, h.z1 - 0.1, h.hw * 1.9, 0.05, 0.06, 0.015, S.steel(0x2a2c2e, 0.8));
    rivets(b, [-h.hw * 0.9, h.y + 0.05, h.z0 + 0.06], [h.hw * 0.9, h.y + 0.05, h.z0 + 0.06], 8);
  }
}

/** A door that is not steel: a roll-up canvas flap, or a plated or armoured door over the paint. */
function doorKit(b: MeshBuilder, m: Mounts, sx: 1 | -1, id: string, look: KitLook) {
  if (m.narrow) return;
  const x = sx * (m.hw - 0.01);
  const y = (m.side.y0 + m.side.y1) / 2;
  const h = m.side.y1 - m.side.y0;
  const len = m.side.z1 - m.side.z0;
  const zc = (m.side.z0 + m.side.z1) / 2;
  if (id === 'door_light') {
    const canvas = S.cloth(0x8a7a52, 0.9);
    b.rbox(x + sx * 0.02, y - 0.02, zc, 0.03, h * 0.9, len * 0.94, 0.015, canvas);
    // Rolled up at the top, tied off with a strap, grommets down the edges.
    b.capsule(x + sx * 0.04, y + h * 0.5, zc - len * 0.46, x + sx * 0.04, y + h * 0.5, zc + len * 0.46, 0.035, canvas, 8);
    for (const dz of [-0.28, 0.28]) b.torus(x + sx * 0.045, y + h * 0.5, zc + dz * len, 0.04, 0.008, S.cloth(0xd6a21e, 0.6), 0, Math.PI / 2, 0, 5, 10);
    for (let i = 0; i < 5; i++) b.cyl(x + sx * 0.04, y - h * 0.38, zc - len * 0.42 + i * len * 0.21, 0.02, 0.012, 0.02, S.steel(0x2a2c2e), 0, 0, Math.PI / 2, 6);
    b.box(x + sx * 0.04, y - 0.04, zc + len * 0.36, 0.014, 0.02, 0.14, S.steel(0x2a2c2e));
  } else if (id === 'door_plate') {
    const sheet = S.steel(0x5a5d60, 0.8);
    plate(b, x + sx * 0.03, y - 0.02, zc, len * 0.84, h * 0.82, 0.025, sheet, 0, sx * (Math.PI / 2), 0);
    rivets(b, [x + sx * 0.05, y + h * 0.3, zc - len * 0.36], [x + sx * 0.05, y + h * 0.3, zc + len * 0.36], 6);
    rivets(b, [x + sx * 0.05, y - h * 0.3, zc - len * 0.36], [x + sx * 0.05, y - h * 0.3, zc + len * 0.36], 6);
  } else if (id === 'door_armor') {
    const sheet = S.steel(0x3a3d40, 0.85);
    plate(b, x + sx * 0.04, y, zc, len * 0.92, h * 1.05, 0.045, sheet, 0, sx * (Math.PI / 2), 0);
    b.box(x + sx * 0.075, y + h * 0.22, zc, 0.01, 0.045, len * 0.62, S.glass(0x10181c));
    b.box(x + sx * 0.075, y - h * 0.05, zc + len * 0.34, 0.016, 0.03, 0.14, S.steel(0x9a9ea2));
    rivets(b, [x + sx * 0.07, y + h * 0.42, zc - len * 0.4], [x + sx * 0.07, y + h * 0.42, zc + len * 0.4], 7);
    rivets(b, [x + sx * 0.07, y - h * 0.42, zc - len * 0.4], [x + sx * 0.07, y - h * 0.42, zc + len * 0.4], 7);
  }
  void look;
}

/** The gap where a door was: a sill rail, the jamb posts, and the seat edge showing through. */
function doorOffKit(b: MeshBuilder, m: Mounts, sx: 1 | -1) {
  if (m.narrow) return;
  const x = sx * (m.hw - 0.07);
  const len = m.side.z1 - m.side.z0;
  const zc = (m.side.z0 + m.side.z1) / 2;
  const h = m.side.y1 - m.side.y0;
  const y = (m.side.y0 + m.side.y1) / 2;
  const steelDark = S.steel(0x2a2c2e, 0.85);
  b.rbox(x, m.side.y0 + 0.02, zc, 0.15, 0.07, len, 0.02, steelDark);
  for (const z of [m.side.z0 + 0.03, m.side.z1 - 0.03]) b.rbox(x, y, z, 0.12, h, 0.06, 0.015, steelDark);
  // The hinges are still on the post, with nothing hanging off them.
  for (const dy of [0.28, -0.28]) b.cyl(x + sx * 0.05, y + dy * h, m.side.z1 - 0.03, 0.04, 0.09, 0.04, S.steel(0x7a7e82, 0.5), 0, 0, 0, 8);
  // The seat behind it is the cabin's own (see `interior.ts`), fully visible through the gap.
}

/**
 * The engine bay with the bonnet up (or off): the real room under it, and the engine standing in it at its real size with the
 * radiator, hoses, battery and the rest of what makes a bay look like one. Every engine is its own model (`engineModels.ts`),
 * so a V8 and a scooter motor are not mistaken for each other. A stripped bay is empty mounts. The bay is derived from the
 * model's own bonnet (`bayVolume`), the same room the fit rules use.
 */
export function bayKit(b: MeshBuilder, m: Mounts, look: KitLook, _floor?: number) {
  void _floor;
  const h = m.hood;
  const vol = bayVolume(m);
  if (!h || !vol) return;
  const e = look.engine;
  const c = look.cooling;
  const { floor, top, z0, z1 } = vol;
  const hw = vol.x1;
  const zc = (z0 + z1) / 2;
  const len = z1 - z0 + 0.1;
  const height = top - floor;
  const tray = S.steel(0x1c1e20, 0.8);
  const wall = S.steel(0x2a2d30, 0.8);
  // Floor, the two wing walls (with the strut towers over the wheels) and the firewall at the cowl.
  b.rbox(0, floor - 0.02, zc, hw * 2 + 0.1, 0.04, len, 0.01, tray);
  for (const sx of [1, -1]) {
    b.rbox(sx * (hw + 0.03), floor + height / 2, zc, 0.06, height, len, 0.015, wall);
    b.rbox(sx * (hw - 0.07), top - 0.06, z0 + 0.18, 0.2, 0.12, 0.2, 0.03, S.steel(0x3a3d40, 0.7));
    b.cyl(sx * (hw - 0.07), top, z0 + 0.18, 0.1, 0.03, 0.1, S.steel(0x7a7e82, 0.5), 0, 0, 0, 10);
  }
  b.rbox(0, floor + height / 2, z0 - 0.02, hw * 2 + 0.1, height, 0.05, 0.01, S.steel(0x15171a, 0.8));
  // Radiator support and the factory core (an aftermarket one is drawn by `coolingKit`, in the grille).
  const ry = floor + height * 0.45;
  b.rbox(0, ry, z1 + 0.02, hw * 1.7, height * 0.78, 0.05, 0.015, S.steel(0x34383b, 0.8));
  if (c && !c.empty && c.mk <= 0) {
    b.rbox(0, ry, z1 - 0.01, hw * 1.5, height * 0.62, 0.06, 0.012, S.steel(0x3a3d40, 0.7));
    for (let i = 0; i < 12; i++) b.box(-hw * 0.7 + i * ((hw * 1.4) / 11), ry, z1 - 0.045, 0.01, height * 0.55, 0.01, S.steel(0x1c1d1f, 0.6));
  }
  // Battery, washer bottle and a brake booster: the clutter that stops a bay looking like a box.
  b.rbox(hw - 0.17, floor + 0.12, z0 + 0.2, 0.2, 0.2, 0.3, 0.02, S.plastic(0x1a2a1a, 0.4));
  b.box(hw - 0.17, floor + 0.23, z0 + 0.2, 0.05, 0.02, 0.04, S.chrome());
  b.rbox(-hw + 0.14, floor + 0.14, z0 + 0.14, 0.14, 0.22, 0.1, 0.02, S.plastic(0x2a5a7a, 0.4));
  b.cyl(-hw + 0.3, floor + height * 0.78, z0 + 0.06, 0.18, 0.1, 0.18, S.steel(0x2a2c2e, 0.7), Math.PI / 2, 0, 0, 12);
  if (!e || e.empty) {
    // Empty mounts: the cradle's feet and a cross-member, bolts where it sat.
    for (const dz of [-0.2, 0.2]) b.box(0, floor + 0.07, zc + dz * len, hw * 1.7, 0.05, 0.06, S.steel(0x4a4d50, 0.8));
    return;
  }
  const pl = enginePlacement(m, e);
  if (!pl) return;
  const { dims } = pl;
  // Mounts under the engine, with a spacer block when it has been jacked up to get it in.
  for (const sx of [1, -1]) {
    b.rbox(sx * dims.w * 0.42, floor + 0.01 + pl.lift / 2, pl.z, 0.07, 0.04 + pl.lift, dims.l * 0.4, 0.01, S.steel(0x3a3d40, 0.8));
  }
  b.rbox(0, floor + 0.01, pl.z, hw * 1.7, 0.03, 0.08, 0.01, S.steel(0x3a3d40, 0.8));
  placeEngine(b, e.id, e.wear, pl.x, pl.y, pl.z);
  // Hoses from the radiator to the engine: the top hose to the thermostat housing, the bottom hose to the water pump.
  const front = pl.z + dims.l / 2;
  const hose = S.rubber(0x1c1c1e);
  b.pipe([[hw * 0.4, ry + height * 0.3, z1 - 0.08], [hw * 0.3, pl.y + dims.h * 0.7, front + 0.02], [dims.w * 0.2, pl.y + dims.h * 0.62, front - 0.04]], 0.026, hose, 6);
  b.pipe([[-hw * 0.4, ry - height * 0.3, z1 - 0.08], [-hw * 0.25, pl.y + dims.h * 0.2, front + 0.02], [-dims.w * 0.15, pl.y + dims.h * 0.3, front - 0.04]], 0.026, hose, 6);
  // A fan shroud behind the core, sized to the engine.
  const fr = Math.min(0.22, height * 0.38, hw * 0.4);
  b.cyl(0, ry, z1 - 0.1, fr * 2, 0.04, fr * 2, S.plastic(0x141414, 0.5), Math.PI / 2, 0, 0, 16);
  b.cyl(0, ry, z1 - 0.12, fr * 0.4, 0.05, fr * 0.4, S.steel(0x7a7e82, 0.5), Math.PI / 2, 0, 0, 8);
}

// ---------------------------------------------------------------- drivetrain

/**
 * The visible parts of the rest of the machine. Exhaust: a quiet one has a fat can, a free-flow one a chrome tip, race
 * headers run down the sill, and straight-pipe stacks stand behind the cab. Springs: coil-overs in the arches, in a
 * colour for the grade. Gearbox: a bigger driveshaft and transfer case under the floor.
 */
function exhaustKit(b: MeshBuilder, m: Mounts, id: string, off: boolean) {
  const x = m.hw * 0.5;
  const rz = m.rear.z;
  const y = m.sill + 0.04;
  if (off) {
    // The exhaust is gone: an open stub hanging off the manifold.
    b.cyl(x, y + 0.04, rz + 0.3, 0.07, 0.12, 0.07, S.metal(0x3a2a1a, 0.9), Math.PI / 2, 0, 0, 8);
    return;
  }
  const chrome = chromeMat();
  const narrow = !!m.narrow;
  if (id === 'exh_free') {
    b.pipe([[x, y + 0.03, rz + 0.8], [x, y + 0.02, rz - 0.02]], 0.03, S.metal(0x6e5a4a, 0.8), 8);
    b.cyl(x, y + 0.02, rz - 0.04, 0.09, 0.14, 0.09, chrome, Math.PI / 2, 0, 0, 12);
  } else if (id === 'exh_quiet') {
    b.cyl(x, y + 0.02, rz + 0.45, narrow ? 0.12 : 0.2, 0.7, narrow ? 0.12 : 0.2, S.steel(0x4a4d50, 0.8), Math.PI / 2, 0, 0, 14);
    b.pipe([[x, y + 0.02, rz + 0.1], [x, y + 0.02, rz - 0.02]], 0.022, S.metal(0x6e5a4a, 0.8), 8);
  } else if (id === 'exh_race') {
    // Side-exit pipes along the sill, ending behind the front wheel.
    for (const sx of narrow ? [1] : [1, -1]) {
      const px = sx * (m.hw + 0.03);
      b.pipe([[px * 0.9, m.sill + 0.12, m.side.z1 - 0.1], [px, m.sill + 0.02, m.side.z1 - 0.3], [px, m.sill + 0.02, m.side.z0 + 0.15]], 0.04, chrome, 8);
      b.cyl(px, m.sill + 0.02, m.side.z0 + 0.12, 0.1, 0.05, 0.1, S.steel(0x2a2c2e), Math.PI / 2, 0, 0, 10);
    }
  } else if (id === 'exh_stack') {
    const top = (m.roof?.y ?? m.side.y1 + 0.5) + 0.28;
    const z = m.roof ? m.roof.z0 - 0.02 : rz + 0.55;
    for (const sx of narrow ? [1] : [1, -1]) {
      const px = sx * (m.hw + 0.06);
      b.pipe([[sx * x, y, z - 0.3], [px, m.sill + 0.12, z], [px, top, z]], 0.05, chrome, 8);
      b.cyl(px, top + 0.04, z, 0.13, 0.05, 0.13, S.steel(0x2a2c2f), 0, 0, 0, 10);
    }
  }
}

function springKit(b: MeshBuilder, m: Mounts, id: string, wheels: [number, number][]) {
  if (m.narrow) return;
  const col = id === 'sus_air' ? 0x1c1c1e : id === 'sus_long' ? 0x2a7a3a : id === 'sus_heavy' ? 0xe0a01a : 0x3a6ab8;
  const R = m.wheelR;
  for (const [wx, wz] of wheels) {
    const sx = Math.sign(wx) || 1;
    const x = wx - sx * 0.2;
    const y0 = R * 1.3;
    const y1 = R * 2 + 0.15;
    b.cyl(x, (y0 + y1) / 2, wz, 0.06, y1 - y0, 0.06, S.metal(0x8a8e92, 0.4), 0, 0, 0, 8);
    if (id === 'sus_air') {
      b.cyl(x, (y0 + y1) / 2, wz, 0.2, (y1 - y0) * 0.8, 0.2, S.rubber(col), 0, 0, 0, 12);
      for (const t of [0.12, 0.88]) b.torus(x, y0 + (y1 - y0) * t, wz, 0.1, 0.014, S.steel(0x3a3d40), Math.PI / 2, 0, 0, 5, 12);
    } else {
      const n = id === 'sus_long' ? 8 : 6;
      for (let i = 0; i < n; i++) b.torus(x, y0 + 0.03 + i * ((y1 - y0 - 0.06) / (n - 1)), wz, 0.09, 0.013, S.paint(col, 0.35), Math.PI / 2, 0, 0, 5, 12);
      if (id === 'sus_long') b.cyl(x + sx * 0.1, (y0 + y1) / 2, wz, 0.05, (y1 - y0) * 0.6, 0.05, S.paint(col, 0.35), 0, 0, 0, 8);
    }
  }
}

function gearboxKit(b: MeshBuilder, m: Mounts, mk: number) {
  const y = m.sill - 0.02;
  const z0 = m.side.z0;
  const z1 = m.side.z1;
  const col = mk >= 3 ? S.metal(0xb89a52, 0.5) : S.metal(0x6a6e72, 0.6);
  b.cyl(0, y, (z0 + z1) / 2, 0.08, z1 - z0, 0.08, S.steel(0x3a3d40, 0.8), Math.PI / 2, 0, 0, 8);
  b.rbox(0, y + 0.01, (z0 + z1) / 2 + 0.2, 0.28, 0.18, 0.36, 0.03, col);
}

// ---------------------------------------------------------------- paint

/** Stripes on the bonnet, roof and boot, or hazard bars along the flanks. */
function paintDetails(b: MeshBuilder, m: Mounts, look: KitLook) {
  if (look.stripe === 1) {
    const col = S.paint(look.stripeColor, 0.5);
    for (const [top, zs] of [[m.hood, 0], [m.roof, 0], [m.trunk, 0]] as const) {
      if (!top) continue;
      void zs;
      // The boot lid's stripes belong to the lid: they swing up with it instead of staying behind on the car.
      const lid = top === m.trunk;
      if (lid) b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: [0, top.y - 0.04, top.z1 + 0.05] }));
      for (const sx of [1, -1]) b.box(sx * 0.13, top.y + 0.006, (top.z0 + top.z1) / 2, 0.12, 0.004, top.z1 - top.z0 - 0.04, col);
      if (lid) b.end();
    }
  } else if (look.stripe === 3) {
    const col = S.paint(look.stripeColor, 0.5);
    const len = m.side.z1 - m.side.z0;
    const n = Math.max(3, Math.round(len / 0.34));
    for (const sx of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const z = m.side.z0 + 0.1 + (i / (n - 1)) * (len - 0.2);
        b.box(sx * (m.hw + 0.004), m.side.y0 + 0.12, z, 0.004, 0.1, 0.14, col, 0, 0, 0.0);
      }
    }
  }
}

/** Everything a vehicle's fitted parts and paint add to its shell. */
export function addKit(b: MeshBuilder, rig: Rig, m: Mounts, look: KitLook, o: { nativeGun: boolean; wheels?: [number, number][]; bayFloor?: number }) {
  const fit = look.fit;
  paintDetails(b, m, look);
  const arm = mkOf(fit, 'armor');
  if (arm) armorKit(b, m, arm, look);
  const hood = bodyPart(fit, 'hood');
  if (look.engine && !look.engine.empty) engineKit(b, m, look.engine, look, !!hood?.off);
  if (look.cooling) coolingKit(b, m, look.cooling);
  if (m.hood) {
    if (hood?.off) bayKit(b, m, look);
    else if (hood?.id === 'hood_cut') cutHoodKit(b, m, look);
    else if (hood && !hood.stock) {
      markHood(b, m);
      hoodKit(b, m, hood.id, look);
      b.end();
    }
  }
  for (const [slot, sx] of [['doorL', 1], ['doorR', -1]] as const) {
    const d = bodyPart(fit, slot);
    if (!d) continue;
    if (d.off) doorOffKit(b, m, sx);
    else if (!d.stock) {
      // A plated or armoured door is the door: it swings with it. (A canvas flap is not a hinged panel.)
      const hinged = !!m.doors && d.id !== 'door_light';
      if (hinged) markDoor(b, m, sx);
      doorKit(b, m, sx, d.id, look);
      if (hinged) b.end();
    }
  }
  const exh = fit.exhaust ? partDef(fit.exhaust.id) : null;
  if (exh && !exh.stock) exhaustKit(b, m, exh.id, !!exh.empty);
  const sus = fit.suspension ? partDef(fit.suspension.id) : null;
  if (sus && !sus.stock && !sus.empty && o.wheels) springKit(b, m, sus.id, o.wheels);
  const gbx = fit.gearbox ? partDef(fit.gearbox.id) : null;
  if (gbx && !gbx.stock && !gbx.empty && gbx.mk >= 2) gearboxKit(b, m, gbx.mk);
  const wpn = mkOf(fit, 'weapon');
  if (wpn || o.nativeGun) weaponKit(b, rig, m, wpn, o.nativeGun);
  const utl = mkOf(fit, 'utility');
  const utlId = fit.utility?.id;
  if (utl && utlId && isHolderModel(utlId)) bedKitOn(b, m, utlId);
  else if (utl) utilityKit(b, m, utl, look);
  // Bolt-on modules are marked, so a hard enough knock can tear them off the merged body.
  const one = (slot: 'front' | 'roof' | 'rear', pivot: [number, number, number], draw: (id: string) => void) => {
    const it = fit[slot];
    if (!it) return;
    b.mark(partTag('slot', slot), partMeta({ kind: 'slot', id: it.id, slot, mk: partDef(it.id).mk, pivot }));
    draw(it.id);
    b.end();
  };
  one('front', [0, m.front.y, m.front.z - 0.05], (id) => frontKit(b, m, id));
  one('roof', [0, m.roof?.y ?? 1, m.roof ? (m.roof.z0 + m.roof.z1) / 2 : 0], (id) => roofKit(b, rig, m, id, look));
  one('rear', [0, m.rear.y + 0.25, m.rear.z], (id) => rearKit(b, m, id, look));
  if (fit.side) sideKit(b, m, fit.side.id);
}

/** A stable string for the parts fitted, used in shell cache keys. */
export function fitSignature(fit: Fit): string {
  return Object.keys(fit)
    .sort()
    .map((k) => `${k}:${fit[k as keyof Fit]!.id}`)
    .join(',');
}
