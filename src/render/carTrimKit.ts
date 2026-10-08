import * as THREE from 'three';
import { MeshBuilder, S, type Surf } from './builder';
import { jerryCan, rivets, spareTyre, strap } from './parts';
import { PANEL_TAG, partMeta, partTag } from './bodyParts';
import { bodyPart, type Mounts, type Rig } from './attachments';
import { panelAt } from './paintJob';
import type { Spec } from './carSpecs';
import type { VehicleDef } from '../data';
import type { Fit } from '../sim/parts';
import { PANELS, type PanelId, type PanelPaint } from '../sim/paint';
import { SCRAWLS, type CarTrim } from '../sim/carTrim';

/**
 * The trim of a found car drawn onto its shell (see sim/carTrim.ts for what is rolled): bumpers, the grille and lamps of its
 * year, the tail lamps of its body, roof rails, aerials, mud flaps, a spare and cans of its own, stencilled numbers, gang marks
 * and scrawled words, two-tone and primer and sun-bleached paint, war paint on a car that ran with a gang. Everything here
 * draws in the body's ground frame against the outline numbers of the chassis, and anything that hangs off a door, the
 * bonnet or the boot lid is marked with that panel's tag so it swings and tears off with it.
 *
 * Overlays (paint bands, stencils) stand a few millimetres proud of the panel they are on, never coplanar with it.
 */

/** Everything the trim drawers need about the car being built. */
export interface TrimCtx {
  b: MeshBuilder;
  rig: Rig;
  sp: Spec;
  def: VehicleDef;
  fit: Fit;
  t: CarTrim;
  /** The body paint as drawn (after fading), and its colour. */
  paint: Surf;
  paintHex: number;
  wear: number;
  seed: number;
  /** A burnt-out wreck: no bumpers, a wing or a quarter panel gone. */
  hulk: boolean;
  /** The user's own panel colours: the scheme leaves those panels alone. */
  panels?: PanelPaint;
}

/** How far an overlay stands proud of the panel under it: paint bands, then stencils over them. */
const LIFT_TONE = 0.003;
const LIFT_MARK = 0.0075;
const SKIN = 0.004;

/** The default trim of a chassis, for a car built without one: the bodies as they were before trims existed. */
export function baseTrim(id: Spec['id']): CarTrim {
  return {
    body: id === 'hatch' ? 'hatch5' : id === 'sedan' ? 'saloon' : id === 'pickup' ? 'pickup' : 'panel',
    sleeper: false,
    bumperF: 'steel',
    bumperR: 'steel',
    grille: 'bars',
    lamps: 'round',
    rims: 'steel',
    rimColor: 0x6a6c6e,
    oddWheel: -1,
    rails: false,
    mirrors: 'black',
    flaps: false,
    antenna: 0,
    spare: 'none',
    cans: 0,
    scheme: 'solid',
    tone: 'roof',
    second: 0xe9e4d6,
    patch: 'hood',
    stencil: 'none',
    glyph: 0,
    stencilColor: 0xf0ece0,
    raider: false,
  };
}

export function rnd(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Body geometry derived from the outline: zones along the flank, the door's run, the wheel arches. */
export function flankZones(sp: Spec, def: VehicleDef) {
  const R = def.physics.wheelRadius;
  const [wf, wr] = def.physics.wheelsZ;
  const gap = R + 0.1;
  const nose = sp.L / 2;
  return {
    R,
    wf,
    wr,
    gap,
    nose,
    hw: sp.W / 2,
    front: [nose - 0.1, wf + gap] as [number, number],
    door: [wf - gap, wr + gap] as [number, number],
    rear: [wr - gap, -nose + 0.1] as [number, number],
    archTop: R * 2 + 0.06,
  };
}

/** Bumper heights: the bar's centre line, front and rear. */
export const bumperY = (sp: Spec) => (sp.id === 'pickup' || sp.id === 'van' ? 0.46 : 0.4);

const doorMark = (b: MeshBuilder, sp: Spec, def: VehicleDef, sx: 1 | -1) => {
  const z = flankZones(sp, def);
  b.mark(partTag('door', sx), partMeta({ kind: 'door', side: sx, pivot: [sx * (z.hw - 0.07), (sp.sill + sp.belt) / 2, Math.max(z.door[0], z.door[1])] }));
};
const hoodMark = (b: MeshBuilder, sp: Spec) => b.mark(PANEL_TAG.hood, partMeta({ kind: 'hood', pivot: [0, sp.hood - 0.04, sp.wsBase] }));

// ---------------------------------------------------------------- bumpers

/**
 * Front and rear bumpers in the trim's style: a chrome bar with rubber overriders, a wrap-round plastic one with fog lamps, a
 * black steel channel with tow hooks, nothing but the rusty crash beam, or a tube bull bar over a plastic one. They carry the
 * `bumper` tags, so a hard knock (or an old shunt, see sim/cars.ts) takes them off.
 */
export function bumpers(c: TrimCtx) {
  const { b, sp, t, fit } = c;
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  const y = bumperY(sp);
  const front = c.hulk ? 'none' : t.bumperF === 'bull' && fit.front ? 'plastic' : t.bumperF;
  const rear = c.hulk ? 'none' : t.bumperR;
  const plastic: Surf = t.body === 'hot' || t.body === 'taxi' ? c.paint : S.plastic(0x232425, 0.55);
  const chrome = S.chrome(0xc8ccd0);
  const rubber = S.rubber(0x1a1a1a);
  const steel = S.steel(0x2a2c2e, 0.8);
  const rust = S.rust(0x6a3a22);
  for (const end of [1, -1] as const) {
    const style = end > 0 ? front : rear;
    const z = end * nose;
    const out = (d: number) => z + end * d;
    if (style === 'none') {
      // The bar has gone: the crash beam and its two brackets, rusting.
      b.box(0, y, out(-0.01), sp.W * 0.8, 0.08, 0.06, rust);
      for (const sx of [1, -1]) b.box(sx * hw * 0.55, y, out(-0.06), 0.06, 0.08, 0.12, steel);
      continue;
    }
    b.mark(partTag('bumper', end > 0 ? 'front' : 'rear'), partMeta({ kind: 'bumper', pivot: [0, y, out(-0.08)] }));
    if (style === 'chrome') {
      b.rbox(0, y + 0.02, out(0.07), sp.W + 0.06, 0.1, 0.1, 0.04, chrome);
      b.box(0, y + 0.02, out(0.122), sp.W * 0.9, 0.026, 0.006, rubber);
      for (const sx of [1, -1]) {
        b.rbox(sx * hw * 0.42, y + 0.02, out(0.13), 0.07, 0.17, 0.07, 0.025, rubber);
        // The ends wrap round to the wheel arch.
        b.rbox(sx * (hw + 0.005), y + 0.02, out(-0.07), 0.06, 0.1, 0.26, 0.03, chrome);
        b.box(sx * hw * 0.5, y - 0.06, out(0.0), 0.05, 0.08, 0.12, steel);
      }
    } else if (style === 'steel') {
      b.rbox(0, y, out(0.07), sp.W + 0.06, 0.2, 0.12, 0.015, steel);
      b.box(0, y + 0.105, out(0.07), sp.W + 0.02, 0.012, 0.14, S.steel(0x3a3c3e, 0.7));
      for (const sx of [1, -1]) b.torus(sx * hw * 0.55, y - 0.13, out(0.1), 0.045, 0.014, S.steel(0x5a5d60), 0, Math.PI / 2, 0, 5, 10);
      if (end < 0 && (sp.id === 'pickup' || sp.id === 'van')) {
        // A step bumper with a tow ball.
        b.rbox(0, y + 0.02, out(0.16), 0.5, 0.05, 0.18, 0.01, S.steel(0x4a4d50, 0.8));
        b.cyl(0, y + 0.08, out(0.18), 0.03, 0.08, 0.03, steel, 0, 0, 0, 8);
        b.sphereAt(0, y + 0.13, out(0.18), 0.03, S.chrome(0xa8acb0), false);
      }
    } else {
      // Plastic: a wrap-round moulding with an intake slot and, at the front, a pair of fog lamps.
      b.rbox(0, y, out(0.06), sp.W + 0.02, 0.22, 0.16, 0.06, plastic);
      for (const sx of [1, -1]) b.rbox(sx * (hw - 0.01), y, out(-0.12), 0.06, 0.2, 0.3, 0.04, plastic);
      b.box(0, y - 0.05, out(0.141), sp.W * 0.5, 0.06, SKIN, S.plastic(0x0c0c0c, 0.4));
      if (end > 0) {
        for (const sx of [1, -1]) {
          b.cyl(sx * hw * 0.66, y - 0.03, out(0.138), 0.1, 0.012, 0.1, S.chrome(0xa8acb0), Math.PI / 2, 0, 0, 12);
          b.cyl(sx * hw * 0.66, y - 0.03, out(0.142), 0.08, 0.008, 0.08, S.glass(0x8a8a7a), Math.PI / 2, 0, 0, 12);
        }
      }
    }
    b.end();
    if (style === 'bull' && end > 0) {
      // A tube bull bar over the (plastic) bumper: two uprights, a top hoop and a grille guard in front of the lamps.
      b.mark(partTag('bullbar'), partMeta({ kind: 'bullbar', pivot: [0, y, out(0.1)] }));
      const tube = S.steel(0x26282a, 0.65);
      const bh = sp.hood - 0.08 - y;
      const fz = out(0.2);
      for (const sx of [1, -1]) {
        b.pipe([[sx * hw * 0.42, y - 0.08, out(0.1)], [sx * hw * 0.42, y - 0.06, fz], [sx * hw * 0.42, y + bh, fz], [sx * hw * 0.2, y + bh + 0.06, fz - end * 0.04]], 0.028, tube, 8);
        b.box(sx * hw * 0.42, y - 0.04, out(0.14), 0.05, 0.08, 0.12, steel);
      }
      b.rod(-hw * 0.2, y + bh + 0.06, fz - 0.04, hw * 0.2, y + bh + 0.06, fz - 0.04, 0.028, tube, 8);
      b.rod(-hw * 0.42, y + 0.05, fz, hw * 0.42, y + 0.05, fz, 0.026, tube, 8);
      for (let i = 0; i < 4; i++) b.rod(-hw * 0.3 + i * hw * 0.2, y + 0.05, fz, -hw * 0.3 + i * hw * 0.2, y + bh * 0.9, fz, 0.012, tube, 6);
      b.end();
    }
  }
}

// ---------------------------------------------------------------- the front end

/**
 * Lamps and grille of the car's year: round lamps in chrome buckets, twin rounds, square or wide rectangular units in a
 * housing, and between them a grille of chrome bars, black mesh, vertical slats, an eggcrate, or a hole where it was
 * kicked in. Lamps go through the rig, so a cached shell replays them onto every instance.
 */
export function frontEnd(c: TrimCtx) {
  const { b, rig, sp, t } = c;
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  const big = sp.id === 'pickup' || sp.id === 'van';
  const y = sp.hood - 0.2;
  const chrome = S.chrome(0xc4c8cc);
  const black = S.plastic(0x141414, 0.5);
  let inner = hw - 0.3 - 0.13;
  for (const sx of [1, -1]) {
    if (t.lamps === 'twin') {
      rig.lamp(sx * (hw - 0.21), y, nose - 0.02, 0.078, true);
      rig.lamp(sx * (hw - 0.4), y, nose - 0.02, 0.078, true);
      inner = hw - 0.4 - 0.1;
    } else if (t.lamps === 'square') {
      const x = sx * (hw - 0.29);
      b.rbox(x, y, nose - 0.012, 0.31, 0.19, 0.06, 0.02, t.grille === 'bars' || t.grille === 'egg' ? chrome : black);
      b.box(x, y, nose + 0.012, 0.27, 0.15, 0.012, S.metal(0xb8bcc0, 0.2));
      rig.lamp(x, y, nose + 0.02, 0.08, false, 0.25, 0.13);
      inner = hw - 0.29 - 0.17;
    } else if (t.lamps === 'wide') {
      const x = sx * (hw - 0.26);
      b.rbox(x, y + 0.01, nose - 0.015, 0.42, 0.14, 0.07, 0.03, black, 0, sx * 0.08, 0);
      rig.lamp(x, y + 0.01, nose + 0.018, 0.06, false, 0.34, 0.1);
      // The indicator at the corner, wrapping round.
      b.rbox(sx * (hw - 0.03), y + 0.01, nose - 0.08, 0.04, 0.1, 0.12, 0.01, S.plastic(0xd88a1a, 0.3));
      inner = hw - 0.26 - 0.22;
    } else {
      rig.lamp(sx * (hw - 0.3), y, nose - 0.02, big ? 0.115 : 0.1, true);
      inner = hw - 0.3 - (big ? 0.13 : 0.12);
    }
    // Amber indicators under the lamps (the wide units carry their own).
    if (t.lamps !== 'wide') b.rbox(sx * (hw - 0.3), y - 0.13, nose + 0.0, 0.12, 0.04, 0.03, 0.01, S.plastic(0xd88a1a, 0.3));
  }
  const gw = Math.max(0.36, 2 * (inner - 0.02));
  const gh = t.lamps === 'wide' ? 0.15 : 0.2;
  const gy = y - 0.04;
  const gz = nose;
  const surround = t.grille === 'mesh' || t.grille === 'slats' ? black : chrome;
  if (t.grille === 'none' || c.hulk) {
    // Kicked in: a dark hole with the radiator's fins behind it and a jag of the old surround at the edge.
    b.box(0, gy, gz - 0.02, gw, gh, 0.03, S.metal(0x0a0a0a, 0.2));
    for (let i = 0; i < 14; i++) b.box(-gw * 0.45 + i * (gw * 0.9) / 13, gy, gz - 0.04, 0.008, gh * 0.85, 0.01, S.steel(0x4a4d50, 0.7));
    b.rbox(-gw * 0.4, gy + gh / 2, gz + 0.01, gw * 0.25, 0.03, 0.03, 0.01, black, 0, 0, 0.2);
    return;
  }
  b.rbox(0, gy, gz, gw + 0.05, gh + 0.05, 0.05, 0.015, surround);
  b.box(0, gy, gz + 0.022, gw, gh, 0.012, S.metal(0x0c0c0c, 0.2));
  const fz = gz + 0.032;
  if (t.grille === 'bars') {
    for (let i = 0; i < 5; i++) b.box(0, gy - gh * 0.38 + i * (gh * 0.76) / 4, fz, gw * 0.96, 0.014, 0.014, chrome);
  } else if (t.grille === 'mesh') {
    for (let i = 0; i < 6; i++) b.box(0, gy - gh * 0.42 + i * (gh * 0.84) / 5, fz, gw * 0.97, 0.007, 0.008, S.plastic(0x2a2a2a, 0.4));
    const n = Math.round(gw / 0.04);
    for (let i = 0; i <= n; i++) b.box(-gw * 0.48 + i * (gw * 0.96) / n, gy, fz, 0.007, gh * 0.95, 0.008, S.plastic(0x2a2a2a, 0.4));
  } else if (t.grille === 'slats') {
    const n = Math.max(7, Math.round(gw / 0.07));
    for (let i = 0; i < n; i++) b.box(-gw * 0.46 + i * (gw * 0.92) / (n - 1), gy, fz, 0.022, gh * 0.92, 0.02, c.paint);
  } else {
    for (let i = 0; i < 3; i++) b.box(0, gy - gh * 0.3 + i * gh * 0.3, fz, gw * 0.96, 0.016, 0.018, chrome);
    for (let i = 0; i < 7; i++) b.box(-gw * 0.45 + i * (gw * 0.9) / 6, gy, fz, 0.016, gh * 0.9, 0.018, chrome);
  }
  // A badge in the middle on most.
  if (t.glyph % 3 !== 0) b.cyl(0, gy + gh * 0.08, fz + 0.012, 0.07, 0.012, 0.05, chrome, Math.PI / 2, 0, 0, 12);
}

/**
 * Tail lamps by body: a saloon and a hatch have wide units across the corners, an estate, pickup and van tall ones up the
 * rear pillars, a taxi or patrol car its own bar. Plates at both ends; the hatch's rear plate is on its tailgate.
 */
export function tails(c: TrimCtx) {
  const { b, rig, sp, t } = c;
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  const tall = t.body === 'estate' || sp.id === 'pickup' || sp.id === 'van';
  for (const sx of [1, -1]) {
    if (tall) {
      const top = sp.id === 'van' ? sp.belt + 0.45 : sp.belt + 0.05;
      rig.tail(sx * (hw - 0.09), top - 0.18, -nose + 0.0, 0.13, 0.3);
      rig.tail(sx * (hw - 0.09), top - 0.4, -nose + 0.0, 0.13, 0.1, true);
    } else {
      rig.tail(sx * (hw - 0.2), sp.belt - 0.12, -nose + 0.0, 0.22, 0.11);
      rig.tail(sx * (hw - 0.2), sp.belt - 0.26, -nose + 0.0, 0.22, 0.06, true);
    }
  }
  // Plates.
  b.box(0, 0.55, nose + 0.075, 0.42, 0.14, 0.01, S.paint(0xd8cf9a, 0.95));
  if (sp.id === 'hatch') b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: [0, sp.roof + 0.02, sp.rwTop] }));
  b.box(0, 0.62, -nose - 0.075, 0.42, 0.14, 0.01, S.paint(0xd8cf9a, 0.95));
  if (sp.id === 'hatch') b.end();
}

// ---------------------------------------------------------------- lettering

type Stroke = [number, number][];
/** A stroke font on a 1 x 1.4 cell: enough letters for the words people spray on wrecks, and the digits. */
const GLYPHS: Record<string, Stroke[]> = {
  '0': [[[0, 0], [1, 0], [1, 1.4], [0, 1.4], [0, 0]], [[0, 0.1], [1, 1.3]]],
  '1': [[[0.55, 0], [0.55, 1.4], [0.2, 1.1]]],
  '2': [[[0, 1.4], [1, 1.4], [1, 0.7], [0, 0.7], [0, 0], [1, 0]]],
  '3': [[[0, 1.4], [1, 1.4], [1, 0], [0, 0]], [[0.3, 0.7], [1, 0.7]]],
  '4': [[[0, 1.4], [0, 0.7], [1, 0.7]], [[0.8, 1.4], [0.8, 0]]],
  '5': [[[1, 1.4], [0, 1.4], [0, 0.7], [1, 0.7], [1, 0], [0, 0]]],
  '6': [[[1, 1.4], [0, 1.4], [0, 0], [1, 0], [1, 0.7], [0, 0.7]]],
  '7': [[[0, 1.4], [1, 1.4], [0.35, 0]]],
  '8': [[[0, 0], [1, 0], [1, 1.4], [0, 1.4], [0, 0]], [[0, 0.7], [1, 0.7]]],
  '9': [[[1, 0.7], [0, 0.7], [0, 1.4], [1, 1.4], [1, 0], [0, 0]]],
  A: [[[0, 0], [0.5, 1.4], [1, 0]], [[0.22, 0.6], [0.78, 0.6]]],
  D: [[[0, 0], [0, 1.4], [0.6, 1.4], [1, 1.0], [1, 0.4], [0.6, 0], [0, 0]]],
  E: [[[1, 1.4], [0, 1.4], [0, 0], [1, 0]], [[0, 0.7], [0.7, 0.7]]],
  G: [[[1, 1.4], [0, 1.4], [0, 0], [1, 0], [1, 0.6], [0.5, 0.6]]],
  H: [[[0, 0], [0, 1.4]], [[1, 0], [1, 1.4]], [[0, 0.7], [1, 0.7]]],
  I: [[[0.5, 0], [0.5, 1.4]]],
  K: [[[0, 0], [0, 1.4]], [[1, 1.4], [0, 0.6]], [[0.35, 0.85], [1, 0]]],
  L: [[[0, 1.4], [0, 0], [1, 0]]],
  M: [[[0, 0], [0, 1.4], [0.5, 0.7], [1, 1.4], [1, 0]]],
  N: [[[0, 0], [0, 1.4], [1, 0], [1, 1.4]]],
  O: [[[0, 0], [1, 0], [1, 1.4], [0, 1.4], [0, 0]]],
  P: [[[0, 0], [0, 1.4], [1, 1.4], [1, 0.7], [0, 0.7]]],
  S: [[[1, 1.4], [0, 1.4], [0, 0.7], [1, 0.7], [1, 0], [0, 0]]],
  T: [[[0, 1.4], [1, 1.4]], [[0.5, 1.4], [0.5, 0]]],
  U: [[[0, 1.4], [0, 0], [1, 0], [1, 1.4]]],
  X: [[[0, 0], [1, 1.4]], [[0, 1.4], [1, 0]]],
  Y: [[[0, 1.4], [0.5, 0.7], [1, 1.4]], [[0.5, 0.7], [0.5, 0]]],
};

/** A plane to letter on: a centre, the reader's right and up, all in the body frame. Its normal is right x up. */
export interface Plane {
  o: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
}

const _d = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const Y_UP = new THREE.Vector3(0, 1, 0);

/** A painted stroke from p to q lying flat in the plane with normal n: a thin slab `w` wide, not a raised tube. */
function flatStroke(b: MeshBuilder, p: THREE.Vector3, q: THREE.Vector3, n: THREE.Vector3, w: number, surf: Surf) {
  _d.subVectors(q, p);
  const len = _d.length();
  if (len < 1e-4) return;
  _d.divideScalar(len);
  _s.crossVectors(n, _d).normalize();
  _m4.makeBasis(_d, _s, n);
  _e.setFromRotationMatrix(_m4, 'YXZ');
  b.box((p.x + q.x) / 2, (p.y + q.y) / 2, (p.z + q.z) / 2, len + w * 0.5, w, SKIN, surf, _e.x, _e.y, _e.z);
}

/** A painted disc of diameter `d` lying in the plane with normal n. */
function flatDisc(b: MeshBuilder, p: THREE.Vector3, n: THREE.Vector3, d: number, surf: Surf) {
  _q.setFromUnitVectors(Y_UP, n);
  _e.setFromQuaternion(_q, 'YXZ');
  b.cyl(p.x, p.y, p.z, d, SKIN, d, surf, _e.x, _e.y, _e.z, 20);
}

const normalOf = (pl: Plane) => _n.crossVectors(pl.right, pl.up).normalize().clone();

/** Spray `text` centred on a plane, letters `h` tall, as flat strokes with a hand's wobble. Returns its width. */
export function sprayText(b: MeshBuilder, pl: Plane, text: string, h: number, surf: Surf, r: () => number, wobble = 0.04, weight = 0.13): number {
  const cw = h / 1.4;
  const adv = cw * 1.35;
  const width = text.length * adv - (adv - cw);
  const n = normalOf(pl);
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const at = (out: THREE.Vector3, u: number, v: number) => out.copy(pl.o).addScaledVector(pl.right, u).addScaledVector(pl.up, v);
  for (let i = 0; i < text.length; i++) {
    const g = GLYPHS[text[i]];
    if (!g) continue;
    const x0 = -width / 2 + i * adv;
    const tilt = (r() - 0.5) * wobble * 2;
    for (const s of g) {
      for (let k = 0; k < s.length - 1; k++) {
        const [u0, v0] = s[k];
        const [u1, v1] = s[k + 1];
        const j = () => (r() - 0.5) * wobble * h;
        at(p, x0 + u0 * cw + j() + v0 * h * tilt, v0 * h - h / 2 + j());
        at(q, x0 + u1 * cw + j() + v1 * h * tilt, v1 * h - h / 2 + j());
        flatStroke(b, p, q, n, h * weight, surf);
      }
    }
  }
  return width;
}

/** A gang's mark, about `size` across: an arrow, a cross, claw slashes, a target, a skull, a lightning bolt. */
export function drawMark(b: MeshBuilder, pl: Plane, kind: number, size: number, surf: Surf) {
  const n = normalOf(pl);
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const at = (out: THREE.Vector3, u: number, v: number, lift = 0) => out.copy(pl.o).addScaledVector(pl.right, u * size).addScaledVector(pl.up, v * size).addScaledVector(n, lift);
  const line = (u0: number, v0: number, u1: number, v1: number, w = 0.12, s = surf, lift = 0) => {
    at(p, u0, v0, lift);
    at(q, u1, v1, lift);
    flatStroke(b, p, q, n, size * w, s);
  };
  switch (kind % 6) {
    case 0:
      // The convoy's arrow: a chevron over a shaft.
      line(-0.4, 0.05, 0, 0.45, 0.14);
      line(0.4, 0.05, 0, 0.45, 0.14);
      line(0, 0.4, 0, -0.45, 0.14);
      break;
    case 1:
      line(-0.42, -0.42, 0.42, 0.42, 0.16);
      line(-0.42, 0.42, 0.42, -0.42, 0.16);
      break;
    case 2:
      for (const d of [-0.28, 0, 0.28]) line(d - 0.15, 0.45, d + 0.15, -0.45, 0.1);
      break;
    case 3:
      for (let i = 0; i < 16; i++) {
        const a0 = (i / 16) * Math.PI * 2;
        const a1 = ((i + 1) / 16) * Math.PI * 2;
        line(Math.cos(a0) * 0.42, Math.sin(a0) * 0.42, Math.cos(a1) * 0.42, Math.sin(a1) * 0.42, 0.09);
      }
      line(-0.55, 0, 0.55, 0, 0.08);
      line(0, -0.55, 0, 0.55, 0.08);
      break;
    case 4: {
      // A skull: the cranium and jaw in the paint, the eye sockets and teeth dark over it.
      flatDisc(b, at(p, 0, 0.08), n, size * 0.72, surf);
      line(-0.2, -0.3, 0.2, -0.3, 0.2);
      const dark = S.paint(0x101010, 0.6);
      for (const u of [-0.15, 0.15]) flatDisc(b, at(p, u, 0.1, 0.002), n, size * 0.2, dark);
      for (const u of [-0.12, 0, 0.12]) line(u, -0.36, u, -0.22, 0.03, dark, 0.002);
      break;
    }
    default:
      line(0.15, 0.5, -0.2, 0.02, 0.12);
      line(-0.2, 0.02, 0.18, 0.02, 0.12);
      line(0.18, 0.02, -0.15, -0.5, 0.12);
  }
}

/** Tally marks in fives, `n` of them. */
function tally(b: MeshBuilder, pl: Plane, n: number, h: number, surf: Surf, r: () => number) {
  const nn = normalOf(pl);
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const step = h * 0.22;
  const groups = Math.ceil(n / 5);
  const width = groups * step * 5.5;
  let u = -width / 2;
  for (let i = 0; i < n; i++) {
    if (i % 5 === 4) {
      p.copy(pl.o).addScaledVector(pl.right, u - step * 4.3).addScaledVector(pl.up, -h * 0.35);
      q.copy(pl.o).addScaledVector(pl.right, u - step * 0.6).addScaledVector(pl.up, h * 0.35);
      flatStroke(b, p, q, nn, h * 0.09, surf);
      u += step * 1.5;
      continue;
    }
    const j = (r() - 0.5) * h * 0.06;
    p.copy(pl.o).addScaledVector(pl.right, u + j).addScaledVector(pl.up, -h / 2);
    q.copy(pl.o).addScaledVector(pl.right, u - j).addScaledVector(pl.up, h / 2);
    flatStroke(b, p, q, nn, h * 0.09, surf);
    u += step;
  }
}

/**
 * What has been painted on the car since it left the factory: a big number in a roundel on both doors and the bonnet, a gang
 * mark, words sprayed on a wreck, a tally. Stencils on doors and the bonnet are marked with their panel and go with it.
 */
export function stencils(c: TrimCtx) {
  const { b, sp, def, t } = c;
  if (t.stencil === 'none' || c.hulk) return;
  const z = flankZones(sp, def);
  const r = rnd(c.seed + 404);
  const col = S.paint(t.stencilColor, 0.5);
  const hood = bodyPart(c.fit, 'hood');
  const bonnetOk = !hood || (hood.stock && !hood.off);
  const doorOk = (slot: 'doorL' | 'doorR') => {
    const d = bodyPart(c.fit, slot);
    return !d || (d.stock && !d.off);
  };
  const doorZc = (z.door[0] + z.door[1]) / 2;
  const midY = (sp.sill + sp.belt) / 2 + 0.04;
  const sidePlane = (sx: 1 | -1, zc: number, y: number): Plane => ({ o: new THREE.Vector3(sx * (z.hw + LIFT_MARK), y, zc), right: new THREE.Vector3(0, 0, -sx), up: new THREE.Vector3(0, 1, 0) });
  const bonnetPlane = (): Plane => {
    const zc = (z.nose + sp.wsBase) / 2;
    return { o: new THREE.Vector3(0, sp.hood + 0.012 + LIFT_MARK, zc), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0.02, -1).normalize() };
  };
  if (t.stencil === 'number') {
    const txt = String(t.glyph);
    const h = Math.min(0.36, (sp.belt - sp.sill) * 0.55);
    const back = S.paint(t.stencilColor === 0x1a1a1a ? 0xf0ece0 : t.stencilColor, 0.45);
    const ink = S.paint(t.stencilColor === 0x1a1a1a || t.stencilColor === 0xe0be1a || t.stencilColor === 0xf0ece0 ? 0x161616 : 0xf0ece0, 0.45);
    for (const sx of [1, -1] as const) {
      if (!doorOk(sx > 0 ? 'doorL' : 'doorR')) continue;
      doorMark(b, sp, def, sx);
      // A roundel behind the number.
      b.cyl(sx * (z.hw + LIFT_MARK - 0.002), midY, doorZc, h * 1.7, SKIN, h * 1.7, back, 0, 0, Math.PI / 2, 24);
      sprayText(b, { ...sidePlane(sx, doorZc, midY), o: new THREE.Vector3(sx * (z.hw + LIFT_MARK + 0.002), midY, doorZc) }, txt, h, ink, r, 0.005, 0.17);
      b.end();
    }
    if (bonnetOk && t.glyph % 2 === 0) {
      hoodMark(b, sp);
      sprayText(b, bonnetPlane(), txt, Math.min(0.42, sp.W * 0.24), col, r, 0.008);
      b.end();
    }
  } else if (t.stencil === 'mark') {
    const sx: 1 | -1 = t.glyph % 2 ? 1 : -1;
    if (doorOk(sx > 0 ? 'doorL' : 'doorR')) {
      doorMark(b, sp, def, sx);
      drawMark(b, sidePlane(sx, doorZc, midY), t.glyph, (sp.belt - sp.sill) * 0.7, col);
      b.end();
    }
    if (bonnetOk && t.glyph >= 3) {
      hoodMark(b, sp);
      const pl = bonnetPlane();
      drawMark(b, pl, t.glyph, Math.min(0.6, sp.W * 0.35), col);
      b.end();
    }
  } else if (t.stencil === 'scrawl') {
    const word = SCRAWLS[t.glyph % SCRAWLS.length];
    // On the rear quarter, or for a van the side of the box, and the same again on the bonnet of some.
    const zc = sp.id === 'van' ? -0.9 : (z.rear[0] + z.rear[1]) / 2 + 0.05;
    const room = sp.id === 'van' ? 2.2 : Math.abs(z.rear[0] - z.rear[1]) + 0.3;
    const h = Math.min(0.22, room / (word.length * 0.98));
    const y = sp.id === 'van' ? sp.belt + 0.45 : midY;
    for (const sx of [1, -1] as const) sprayText(b, sidePlane(sx, zc, y), word, h, col, r);
    if (bonnetOk && t.glyph % 2 === 1) {
      hoodMark(b, sp);
      sprayText(b, bonnetPlane(), word, Math.min(0.2, (sp.W * 0.85) / (word.length * 0.98)), col, r);
      b.end();
    }
  } else if (t.stencil === 'tally') {
    if (doorOk('doorL')) {
      doorMark(b, sp, def, 1);
      tally(b, sidePlane(1, doorZc + 0.15, sp.belt - 0.18), t.glyph, 0.16, col, r);
      b.end();
    }
  }
}

// ---------------------------------------------------------------- paint schemes

/** The colour the body is painted as drawn: faded paint has gone chalky toward the dust. */
export function bodyColor(paint: number, t: CarTrim | null): number {
  if (t?.scheme === 'faded') return new THREE.Color(paint).lerp(new THREE.Color(0xb8ab94), 0.32).getHex();
  return paint;
}
/** How much worse the paint wears for the scheme. */
export const schemeWear = (t: CarTrim | null) => (t?.scheme === 'faded' ? 0.15 : t?.scheme === 'rusty' ? 0.25 : 0);

/**
 * Bands of the second colour: a lower two-tone along the sills, or both doors (a patrol car's). Each band rides on its
 * zone of the flank, and the door's is marked with the door so it swings with it.
 */
export function toneBands(c: TrimCtx) {
  const { b, sp, def, t } = c;
  if (t.scheme !== 'twoTone' || c.hulk || t.tone === 'roof') return;
  const z = flankZones(sp, def);
  const col = S.paint(t.second, Math.max(0.2, c.wear - 0.1));
  const x = z.hw + LIFT_TONE;
  const zones = [z.front, z.door, z.rear];
  for (const sx of [1, -1] as const) {
    const doorSlot = sx > 0 ? 'doorL' : 'doorR';
    const d = bodyPart(c.fit, doorSlot);
    const doorOn = !d || (d.stock && !d.off);
    zones.forEach(([a, e], i) => {
      if (t.tone === 'doors' && i !== 1) return;
      if (i === 1 && !doorOn) return;
      const y0 = sp.sill + 0.02;
      const y1 = t.tone === 'doors' ? sp.belt - 0.03 : sp.sill + (sp.id === 'van' ? 0.3 : 0.24);
      if (i === 1) doorMark(b, sp, def, sx);
      b.box(sx * x, (y0 + y1) / 2, (a + e) / 2, SKIN, y1 - y0, Math.abs(a - e) - 0.04, col);
      if (i === 1) b.end();
    });
    // An ambulance or patrol car carries a reflective stripe along the line between the colours.
    if (t.body === 'ambulance' || t.body === 'patrol') {
      const ys = t.tone === 'doors' ? sp.belt - 0.08 : sp.sill + 0.3;
      zones.forEach(([a, e], i) => {
        if (i === 1 && !doorOn) return;
        if (i === 1) doorMark(b, sp, def, sx);
        b.box(sx * (x + 0.002), ys, (a + e) / 2, SKIN, 0.06, Math.abs(a - e) - 0.04, S.paint(t.body === 'patrol' ? 0x1e3a8a : 0xc8321e, 0.4));
        if (i === 1) b.end();
      });
    }
  }
}

/**
 * Rust, more of it on a rusty scheme: blooms along the sills and round the arches. A bloom on the door is the door's.
 */
export function rustBlooms(c: TrimCtx) {
  const { b, sp, def, t } = c;
  const r = rnd(c.seed + 77);
  const z = flankZones(sp, def);
  const k = t.scheme === 'rusty' ? 2.2 : 1;
  const n = Math.round((c.wear * 5 + (c.seed % 3)) * k);
  const rust = S.rust(0x7a3f22);
  for (let i = 0; i < n; i++) {
    const sx: 1 | -1 = r() > 0.5 ? 1 : -1;
    const zz = (r() - 0.5) * (sp.L - 1.2);
    const onDoor = zz < Math.max(z.door[0], z.door[1]) - 0.08 && zz > Math.min(z.door[0], z.door[1]) + 0.08;
    // Keep off the arch openings: they are holes in the panel.
    if (Math.abs(zz - z.wf) < z.gap + 0.05 || Math.abs(zz - z.wr) < z.gap + 0.05) continue;
    if (onDoor) {
      const d = bodyPart(c.fit, sx > 0 ? 'doorL' : 'doorR');
      if (d && (d.off || !d.stock)) continue;
      doorMark(b, sp, def, sx);
    }
    b.rbox(sx * (z.hw + 0.004), sp.sill + 0.12 + r() * 0.2 * k, zz, 0.012, 0.1 + r() * 0.14 * k, 0.2 + r() * 0.4, 0.004, rust);
    if (onDoor) b.end();
  }
  if (t.scheme === 'rusty') {
    // Rust lace round the arch lips.
    for (const sx of [1, -1]) {
      for (const wz of [z.wf, z.wr]) {
        for (let i = 0; i < 4; i++) {
          const a = 0.35 + i * 0.75 + r() * 0.3;
          b.rbox(sx * (z.hw + 0.006), z.R + Math.sin(a) * (z.R + 0.12), wz + Math.cos(a) * (z.R + 0.12), 0.012, 0.08, 0.12, 0.004, rust, a, 0, 0);
        }
      }
    }
  }
}

const isPaintSurface = (r: number, mt: number) => (r > 0.45 && r < 0.51 && mt > 0.1 && mt < 0.14) || (r > 0.26 && r < 0.3 && mt > 0.08 && mt < 0.12);

/**
 * The panels the scheme recolours, after the user's own paint is in: a panel in primer or off another car, a roof and bonnet
 * bleached by the sun. Panels the user has sprayed keep their paint. Same matching as `paintPanels`: only vertices that are
 * the body's own colour, so cans, trim and plates on the panel keep theirs.
 */
export function schemePanels(c: TrimCtx, m: Mounts) {
  const { b, t } = c;
  if (c.hulk) return;
  const targets = new Map<PanelId, { col: THREE.Color; matte: boolean; mix: number }>();
  const user = c.panels ?? {};
  if ((t.scheme === 'primer' || t.scheme === 'patched') && user[t.patch] === undefined) targets.set(t.patch, { col: new THREE.Color(t.second), matte: t.scheme === 'primer', mix: 1 });
  if (t.scheme === 'bleached') {
    for (const p of ['roof', 'hood'] as PanelId[]) if (user[p] === undefined) targets.set(p, { col: new THREE.Color(c.paintHex).lerp(new THREE.Color(0xe6dccb), 0.5), matte: true, mix: 1 });
  }
  if (!targets.size) return;
  const base = new THREE.Color(c.paintHex);
  const n = b.pos.length / 3;
  const out = new THREE.Color();
  for (let i = 0; i < n; i++) {
    if (!isPaintSurface(b.srf[i * 4], b.srf[i * 4 + 1])) continue;
    const r = b.col[i * 3];
    const g = b.col[i * 3 + 1];
    const bl = b.col[i * 3 + 2];
    const dev = Math.max(Math.abs(r - base.r), Math.abs(g - base.g), Math.abs(bl - base.b));
    if (dev > 0.5 * Math.max(0.08, base.r + base.g + base.b) / 3 + 0.12) continue;
    const panel = panelAt(m, b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]);
    const tg = panel ? targets.get(panel) : undefined;
    if (!tg) continue;
    const k = (v: number, b1: number) => v / Math.max(0.03, b1);
    out.setRGB(tg.col.r * k(r, base.r), tg.col.g * k(g, base.g), tg.col.b * k(bl, base.b));
    b.col[i * 3] = Math.min(4, out.r);
    b.col[i * 3 + 1] = Math.min(4, out.g);
    b.col[i * 3 + 2] = Math.min(4, out.b);
    if (tg.matte) {
      // Primer and sun-baked paint are flat: rough, no clear coat. (No longer counts as paint for a later spray: the user's
      // panels are applied before this, so it never has to.)
      b.srf[i * 4] = 0.82;
      b.srf[i * 4 + 1] = 0.04;
    }
  }
  void PANELS;
}

// ---------------------------------------------------------------- bolt-ons of its own

/**
 * The odds and ends a car picks up: roof rails, an aerial or a CB whip, mud flaps behind the wheels, a spare of its own on
 * the tailgate, roof or bonnet, and jerry cans strapped on. Racks and spares only where no fitted part has the spot.
 */
export function extras(c: TrimCtx, m: Mounts) {
  const { b, sp, def, t, fit } = c;
  const z = flankZones(sp, def);
  const r = rnd(c.seed + 919);
  const rail = S.steel(0x2a2c2e, 0.6);
  const chrome = S.chrome(0xb8bcc0);
  const roofFree = !fit.roof;
  const ro = m.roof;
  // Roof rails along the gutters, outside the roof deck (cargo lies between them).
  if (t.rails && ro && !c.hulk) {
    const x = Math.min(z.hw - 0.14, ro.hw + 0.16);
    const y = ro.y + 0.02;
    for (const sx of [1, -1]) {
      b.rod(sx * x, y + 0.06, ro.z0, sx * x, y + 0.06, ro.z1, 0.016, t.mirrors === 'chrome' ? chrome : rail, 6);
      for (const zz of [ro.z0, (ro.z0 + ro.z1) / 2, ro.z1]) b.rbox(sx * x, y + 0.03, zz, 0.04, 0.06, 0.06, 0.01, rail);
    }
  }
  // An aerial: a thin whip on the front wing, or a CB on a spring base on the roof edge.
  if (t.antenna && !c.hulk) {
    if (t.antenna === 1) {
      const ax = -(z.hw - 0.1);
      const az = sp.wsBase + 0.12;
      b.cyl(ax, sp.belt + 0.01, az, 0.03, 0.02, 0.03, S.steel(0x1a1a1a), 0, 0, 0, 8);
      b.rod(ax, sp.belt + 0.02, az, ax - 0.02, sp.belt + 0.85, az - 0.1, 0.0035, chrome, 4);
    } else {
      const ax = z.hw - 0.12;
      const ay = (ro?.y ?? sp.roof) - 0.02;
      const az = ro ? ro.z0 + 0.1 : -0.5;
      b.cyl(ax, ay + 0.03, az, 0.05, 0.06, 0.05, S.steel(0x1a1a1a), 0, 0, 0, 8);
      b.cyl(ax, ay + 0.1, az, 0.03, 0.08, 0.03, chrome, 0, 0, 0, 6);
      b.rod(ax, ay + 0.14, az, ax + 0.02, ay + 1.35, az - 0.25, 0.005, S.plastic(0x1a1a1a), 4);
    }
  }
  // Mud flaps behind each wheel.
  if (t.flaps && !c.hulk) {
    const flap = S.rubber(0x1a1a1a);
    for (const sx of [1, -1]) {
      for (const wz of [z.wf, z.wr]) {
        const fz = wz - z.R - 0.08;
        const top = Math.max(sp.sill, z.R + 0.1);
        b.box(sx * (z.hw - 0.12), (top + 0.12) / 2, fz, 0.22, top - 0.12, 0.012, flap);
        if (wz === z.wr) b.box(sx * (z.hw - 0.12), 0.18, fz - 0.008, 0.16, 0.05, SKIN, S.chrome(0xa8acb0));
      }
    }
  }
  // A spare of its own.
  const R = def.physics.wheelRadius * 0.95;
  if (t.spare === 'tail' && !fit.rear && !c.hulk) {
    if (sp.id === 'hatch' || sp.id === 'van') {
      // On the tailgate or rear door, in a vinyl cover: it lifts with the door.
      b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: sp.id === 'hatch' ? [0, sp.roof + 0.02, sp.rwTop] : [0, sp.roof + 0.03, -z.nose + 0.06] }));
      const y = sp.id === 'van' ? sp.belt + 0.25 : (sp.sill + sp.belt) / 2 + 0.06;
      const zz = -z.nose - (sp.id === 'van' ? 0.04 : 0.02) - 0.11;
      spareTyre(b, 0, y, zz, R, 0.2, Math.PI / 2, 0);
      b.cyl(0, y, zz - 0.105, R * 2.05, 0.012, R * 2.05, S.cloth(t.second === 0x1c1c1c ? 0x2a2a2a : 0x1c1c1c, 0.5), Math.PI / 2, 0, 0, 20);
      b.end();
    }
  } else if (t.spare === 'roof' && roofFree && ro && !c.hulk) {
    spareTyre(b, 0, ro.y + 0.11, ro.z0 + R + 0.1, R, 0.2, 0, 0);
    strap(b, [[-R, ro.y + 0.02, ro.z0 + R + 0.1], [-R * 0.6, ro.y + 0.2, ro.z0 + R + 0.1], [R * 0.6, ro.y + 0.2, ro.z0 + R + 0.1], [R, ro.y + 0.02, ro.z0 + R + 0.1]]);
  } else if (t.spare === 'bonnet' && !c.hulk) {
    const hood = bodyPart(fit, 'hood');
    if (!hood || (hood.stock && !hood.off)) {
      hoodMark(b, sp);
      const zz = (z.nose + sp.wsBase) / 2 + 0.05;
      spareTyre(b, 0, sp.hood + 0.12, zz, R, 0.22, 0, 0);
      b.box(0, sp.hood + 0.02, zz, 0.3, 0.02, 0.3, rail);
      b.end();
    }
  }
  // Jerry cans: on a van's rear door or a pickup's tailgate corner, or in the rails on the roof.
  if (t.cans && !c.hulk) {
    const cols = [0x55603e, 0xb0301e, 0x3a3c3e, 0xc89a2a];
    for (let i = 0; i < t.cans; i++) {
      const colr = cols[Math.floor(r() * cols.length)];
      if (t.rails && ro && roofFree) jerryCan(b, (i ? -1 : 1) * (ro.hw * 0.6), ro.y + 0.02, ro.z1 - 0.3, colr, 0, true);
      else {
        const sx = i ? -1 : 1;
        const y = bumperY(sp) + 0.12;
        b.box(sx * (z.hw - 0.24), y - 0.01, -z.nose - 0.16, 0.24, 0.02, 0.2, rail);
        jerryCan(b, sx * (z.hw - 0.24), y, -z.nose - 0.17, colr, Math.PI / 2);
        strap(b, [[sx * (z.hw - 0.36), y + 0.25, -z.nose - 0.06], [sx * (z.hw - 0.36), y + 0.25, -z.nose - 0.3], [sx * (z.hw - 0.12), y + 0.25, -z.nose - 0.3]]);
      }
    }
  }
  void rivets;
}

/**
 * A car that ran with a gang: red war paint slashed down the flanks and across the bonnet, spikes welded along the front
 * bumper, a bar cage over the windscreen (outside the glass, thin, so the driver still sees the road) and a skull on the
 * bonnet.
 */
export function raiderKit(c: TrimCtx) {
  const { b, sp, def, t } = c;
  if (!t.raider || c.hulk) return;
  const z = flankZones(sp, def);
  const red = S.paint(0xb8321e, 0.55);
  const steel = S.steel(0x7a7e82, 0.55);
  const y = bumperY(sp);
  // Spikes along the front.
  for (let i = 0; i < 7; i++) b.add('cone12', -z.hw * 0.75 + i * (z.hw * 1.5) / 6, y + 0.02, z.nose + 0.28, 0.06, 0.26, 0.06, steel, Math.PI / 2, 0, 0);
  b.box(0, y + 0.02, z.nose + 0.15, z.hw * 1.6, 0.06, 0.04, S.steel(0x3a3c3e, 0.8));
  // War paint: three slashes down each flank, over the door; the door's own go with it.
  for (const sx of [1, -1] as const) {
    const d = bodyPart(c.fit, sx > 0 ? 'doorL' : 'doorR');
    const doorOn = !d || (d.stock && !d.off);
    for (let i = 0; i < 3; i++) {
      const zz = z.front[1] - 0.2 - i * 0.28;
      const inDoor = zz < Math.max(z.door[0], z.door[1]) && zz > Math.min(z.door[0], z.door[1]);
      if (inDoor && !doorOn) continue;
      if (inDoor) doorMark(b, sp, def, sx);
      b.box(sx * (z.hw + LIFT_TONE + 0.001), (sp.sill + sp.belt) / 2 + 0.04, zz, SKIN, sp.belt - sp.sill - 0.16, 0.07, red, sx * 0.45, 0, 0);
      if (inDoor) b.end();
    }
  }
  // The cage over the windscreen: a frame on the A-pillars and four bars down it, 5 cm out from the glass.
  const a: [number, number] = [sp.belt + 0.02, sp.wsBase];
  const e: [number, number] = [sp.roof - (sp.id === 'van' ? 0.1 : 0), sp.wsTop];
  const dy = e[0] - a[0];
  const dz = e[1] - a[1];
  const len = Math.hypot(dy, dz);
  const ny = -dz / len;
  const nz = dy / len;
  const off = 0.05;
  const hw = z.hw - 0.16;
  const bar = S.steel(0x2a2c2e, 0.7);
  const P = (x: number, f: number): [number, number, number] => [x, a[0] + dy * f + ny * off, a[1] + dz * f + nz * off];
  for (let i = 0; i < 5; i++) {
    const x = -hw + (i / 4) * hw * 2;
    const p0 = P(x, 0.02);
    const p1 = P(x * 0.96, 0.98);
    b.rod(...p0, ...p1, i === 0 || i === 4 ? 0.016 : 0.009, bar, 6);
  }
  for (const f of [0.02, 0.98]) b.rod(...P(-hw, f), ...P(hw, f), 0.014, bar, 6);
  // A skull on the bonnet.
  const hood = bodyPart(c.fit, 'hood');
  if (!hood || (hood.stock && !hood.off)) {
    hoodMark(b, sp);
    const zc = (z.nose + sp.wsBase) / 2 + 0.1;
    b.add('dome', 0, sp.hood + 0.02, zc, 0.3, 0.12, 0.34, S.paint(0xe2dccb, 0.6));
    for (const sx of [1, -1]) b.cyl(sx * 0.06, sp.hood + 0.075, zc + 0.06, 0.07, 0.02, 0.07, S.paint(0x101010, 0.5), 0, 0, 0, 10);
    for (const sx of [1, -1]) b.box(sx * 0.3, sp.hood + 0.016, zc - 0.1, 0.5, SKIN, 0.07, red, 0, sx * 0.5, 0);
    b.end();
  }
}

/** A taxi's checker band down both flanks, two rows of squares under the waist line; the door's squares go with the door. */
export function taxiChecker(c: TrimCtx) {
  const { b, sp, def, t } = c;
  if (t.body !== 'taxi' || c.hulk) return;
  const z = flankZones(sp, def);
  const dark = S.paint(0x161616, 0.5);
  const light = S.paint(0xe0be1a, 0.45);
  const s = 0.06;
  const y0 = sp.belt - 0.13;
  for (const sx of [1, -1] as const) {
    const d = bodyPart(c.fit, sx > 0 ? 'doorL' : 'doorR');
    const doorOn = !d || (d.stock && !d.off);
    [z.front, z.door, z.rear].forEach(([a, e], zi) => {
      if (zi === 1 && !doorOn) return;
      const lo = Math.min(a, e) + 0.03;
      const hi = Math.max(a, e) - 0.03;
      if (zi === 1) doorMark(b, sp, def, sx);
      // A yellow band, and the dark squares over it.
      b.box(sx * (z.hw + LIFT_TONE), y0 + s / 2, (lo + hi) / 2, SKIN, s * 2, hi - lo, light);
      for (let k = 0; Math.round(lo / s) + k <= Math.round(hi / s); k++) {
        const i = Math.round(lo / s) + k;
        const zz = i * s;
        if (zz - s / 2 < lo || zz + s / 2 > hi) continue;
        b.box(sx * (z.hw + LIFT_TONE + 0.002), y0 + (i % 2) * s, zz, SKIN, s, s, dark);
      }
      if (zi === 1) b.end();
    });
  }
}

/** A roof sign (taxi) or a dead light bar (patrol car), where no roof part is fitted. */
export function roofTop(c: TrimCtx, m: Mounts) {
  const { b, t, fit } = c;
  const ro = m.roof;
  if (!ro || fit.roof || c.hulk) return;
  const r = rnd(c.seed + 31);
  if (t.body === 'taxi') {
    const zc = ro.z1 - 0.28;
    for (const sx of [1, -1]) b.box(sx * 0.18, ro.y + 0.03, zc, 0.06, 0.05, 0.18, S.plastic(0x1a1a1a));
    b.rbox(0, ro.y + 0.13, zc, 0.6, 0.16, 0.24, 0.04, S.plastic(0xe0be1a, 0.4));
    for (const fz of [1, -1] as const) {
      sprayText(b, { o: new THREE.Vector3(0, ro.y + 0.13, zc + fz * 0.125), right: new THREE.Vector3(fz > 0 ? 1 : -1, 0, 0), up: new THREE.Vector3(0, 1, 0) }, 'TAXI', 0.08, S.paint(0x161616, 0.4), r, 0.002);
    }
  } else if (t.body === 'patrol' || t.body === 'ambulance') {
    const zc = ro.z1 - 0.25;
    b.rbox(0, ro.y + 0.06, zc, Math.min(1.2, ro.hw * 2.2), 0.1, 0.24, 0.03, S.plastic(0x1a1a1a));
    for (const sx of [1, -1]) {
      b.rbox(sx * 0.3, ro.y + 0.12, zc, 0.42, 0.08, 0.2, 0.03, S.plastic(t.body === 'patrol' ? (sx > 0 ? 0x2a4ab8 : 0xb82a2a) : 0xd84a1a, 0.25));
    }
  }
}
