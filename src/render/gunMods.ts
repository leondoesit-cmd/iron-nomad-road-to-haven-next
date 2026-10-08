import type { AttachSlot, GunModel } from '../data/gear';
import { FRAMES } from '../sim/gunFrames';
import type { V3 } from '../sim/weaponanim';
import { M, shape, type P2, type WB, type WS } from './weapons/kit';
import { rings, scope } from './weapons/parts';

/**
 * Add-ons on a gun, modelled at the spots its frame declares (`sim/gunFrames.ts`): an optic on the rail, a suppressor or
 * a brake on the muzzle, a grip or a bipod under the fore-end, a longer or a drum magazine, a stock or a pad, a light
 * or a laser on the left. Everything is in the gun's own frame (+z down the barrel, +y up, +x to its left, origin at the
 * grip), the frame `render/weapons` builds the guns in. `ANCHORS` is the per-gun data: a gun with no anchor for a slot has
 * nowhere to show that add-on.
 *
 * Optics are open: the eye looks through them behind the sights (`sightLine`), so a red dot is a ring with its lit dot on
 * the axis, a holographic sight a hood with its reticle in the window, a scope an open tube with a crosshair.
 */

export interface Anchors {
  /** The top of the rail (or receiver, or slide) and the middle of where an optic goes on it. */
  top: { y: number; z: number };
  /** The barrel's axis height and the z of its tip. */
  muzzle: { y: number; z: number };
  /** The underside of the fore-end. */
  under: { y: number; z: number };
  /** The bottom of the magazine (or the end of a tube) and where it sits along the gun. */
  mag: { y: number; z: number };
  /** The end of the stock, where a pad goes. */
  stock: { y: number; z: number };
  /** A spot on the left side for a light. */
  side: { x: number; y: number; z: number };
  /** Barrel radius, so a muzzle device is sized to what it is on. */
  r: number;
  /** Two barrels side by side (a shotgun). */
  dbl?: boolean;
}

export const ANCHORS = {} as Record<GunModel, Anchors>;
for (const m of Object.keys(FRAMES) as GunModel[]) {
  const f = FRAMES[m];
  ANCHORS[m] = { top: f.top, muzzle: { y: f.bore, z: f.muzzle }, under: f.under, mag: f.mag, stock: f.stock, side: { x: f.side[0], y: f.side[1], z: f.side[2] }, r: f.r, dbl: !!f.dbl };
}

const HALF = Math.PI / 2;

/** How much a barrel add-on lengthens the barrel, by its look. The muzzle device then sits at the new tip. */
const BARREL_EXT: Record<string, number> = { bar_h: 0.05, bar_c: 0.07, bar_r: 0.1, bar_g: 0.08, bar_m: 0.09, bar_f: 0.11 };
const MUZZLE_LEN: Record<string, number> = { supp_s: 0.17, can_s: 0.12, supp_l: 0.26, can_l: 0.2, comp: 0.05, comp2: 0.07, brake: 0.065, hider: 0.07, choke: 0.04 };

/** Where the muzzle ends up with the add-ons on, so the flash and the tracer start at the tip. */
export function muzzleAt(model: GunModel, looks: Partial<Record<AttachSlot, string>>): { y: number; z: number } {
  const A = ANCHORS[model];
  let z = A.muzzle.z + (BARREL_EXT[looks.barrel ?? ''] ?? 0);
  const m = MUZZLE_LEN[looks.muzzle ?? ''];
  if (m) z += m;
  return { y: A.muzzle.y, z };
}

/** An optic's look: how high its axis stands over the rail, how long it is, and what it is drawn as. */
interface Optic {
  h: number;
  len: number;
  kind: 'tube' | 'reflex' | 'holo' | 'micro' | 'scope';
  /** A scope's tube, eyepiece and objective radii. */
  r?: number;
  ocu?: number;
  obj?: number;
}
const OPTICS: Record<string, Optic> = {
  dot: { h: 0.033, len: 0.064, kind: 'tube' },
  reflex: { h: 0.026, len: 0.05, kind: 'reflex' },
  holo: { h: 0.031, len: 0.096, kind: 'holo' },
  pdot: { h: 0.016, len: 0.042, kind: 'micro' },
  scope: { h: 0, len: 0.2, kind: 'scope', r: 0.0127, ocu: 0.0185, obj: 0.0195 },
  scope4: { h: 0, len: 0.26, kind: 'scope', r: 0.015, ocu: 0.02, obj: 0.025 },
  scope8: { h: 0, len: 0.34, kind: 'scope', r: 0.017, ocu: 0.021, obj: 0.029 },
};
const opticH = (o: Optic) => (o.kind === 'scope' ? Math.max(o.obj!, o.r! + 0.006) + 0.006 : o.h);

/**
 * The line the eye looks along with the add-ons on: the fitted optic's axis (its eyepiece end and its dot or objective),
 * or the gun's own sights. In the gun's frame.
 */
export function sightLine(model: GunModel, looks: Partial<Record<AttachSlot, string>>): { rear: V3; front: V3 } {
  const o = OPTICS[looks.optic ?? ''];
  const f = FRAMES[model];
  if (!o) return { rear: f.rear, front: f.front };
  const A = ANCHORS[model];
  const y = A.top.y + opticH(o);
  return { rear: [0, y, A.top.z - o.len / 2], front: [0, y, A.top.z + o.len / 2] };
}

export { replacesStock } from './weapons/kit';

const metal = M.anod(0x1c1d1f, 0.35);
const steel = M.park(0x2a2c2a, 0.35);
const polymer = M.poly(0x222324, 0.3);
const rubber = M.rubber(0x161616);
const lensRim = M.glass(0x0e1a22);
const red = M.glow(0xff2a1a, 3.2);
const white = M.glow(0xfff2c8, 3.6);

/** A rail clamp under an optic or a light, its cross bolt on the left. */
function clamp(w: WB, y: number, z: number, len: number, wide = 0.024) {
  w.rbox(0, y + 0.005, z, wide, 0.01, len, 0.0015, metal);
  if (w.hi) w.turnAlong('mod.bolt', [[0, 0], [0.003, 0], [0.003, 1], [0, 1]], [wide / 2, y + 0.004, z], [wide / 2 + 0.003, y + 0.004, z], steel, 8);
}

/** Add every fitted add-on's solids to a gun being built. */
export function drawMods(w: WB, model: GunModel, looks: Partial<Record<AttachSlot, string>>) {
  const was = w.prefix;
  w.prefix = `${model}:`;
  drawModsAt(w, model, looks);
  w.prefix = was;
}

function drawModsAt(w: WB, model: GunModel, looks: Partial<Record<AttachSlot, string>>) {
  const A = ANCHORS[model];
  const f = FRAMES[model];
  const dbl = (f.dbl ?? 0) / 2;

  let tip = A.muzzle.z;
  const my = A.muzzle.y;

  // ---- barrel: a longer or heavier barrel stands out past the old crown
  const bl = looks.barrel;
  if (bl && BARREL_EXT[bl]) {
    const e = BARREL_EXT[bl];
    if (A.dbl) for (const sx of [1, -1]) w.turn(`mod.bdbl:${e}`, [[0, -0.01], [A.r, -0.01], [A.r * 0.98, e], [A.r * 0.85, e], [A.r * 0.85, e - 0.02], [0, e - 0.02]], sx * dbl, my, M.blued(0x1c1f25, 0.45), undefined, 0.7, tip);
    else if (bl === 'bar_f') {
      // Heavy and fluted: a fat run of barrel with flutes down it.
      const r = Math.max(A.r * 1.35, 0.009);
      w.turn(`mod.bf:${model}`, [[0, -0.03], [r, -0.03], [r, e - 0.002], [r - 0.001, e], [A.r * 0.5, e], [A.r * 0.5, e - 0.02], [0, e - 0.02]], 0, my, M.park(0x2a2c2e, 0.3), undefined, 0.7, tip);
      if (w.hi) for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        w.box(Math.cos(a) * r, my + Math.sin(a) * r, tip + e * 0.45, 0.0022, 0.0022, e * 0.7, M.park(0x1a1c1a, 0.3), 0, 0, a);
      }
    } else if (bl === 'bar_m') {
      // Match grade: slim and bright, a target crown.
      const r = Math.max(A.r * 1.05, 0.007);
      w.turn(`mod.bm:${model}`, [[0, -0.02], [r, -0.02], [r, e - 0.002], [r - 0.0012, e], [A.r * 0.5, e - 0.001], [A.r * 0.5, e - 0.02], [0, e - 0.02]], 0, my, M.bright(0x8a8e92, 0.25), undefined, 0.7, tip);
    } else {
      const r = Math.max(A.r * 1.1, 0.007);
      w.turn(`mod.bx:${model}`, [[0, -0.02], [r, -0.02], [r, e - 0.001], [r - 0.0008, e], [A.r * 0.5, e], [A.r * 0.5, e - 0.02], [0, e - 0.02]], 0, my, M.blued(0x22252a, 0.35), undefined, 0.7, tip);
    }
    tip += e;
  } else if (bl === 'limbs') {
    // Heavier limbs on a crossbow: a second, longer pair of arms ahead of the first, with cams at their tips.
    for (const sx of [1, -1]) {
      w.rbox(sx * 0.2, A.muzzle.y - 0.014, A.muzzle.z - 0.06, 0.4, 0.03, 0.012, 0.004, M.poly(0x2a2c2e, 0.3), 0, -sx * 0.32, 0);
      w.turnAlong('mod.cam', [[0, 0], [0.018, 0], [0.018, 1], [0, 1]], [sx * 0.37, A.muzzle.y - 0.026, A.muzzle.z - 0.18], [sx * 0.37, A.muzzle.y - 0.002, A.muzzle.z - 0.18], M.anod(0x2a2b2c));
    }
  }

  // ---- muzzle device
  const mk = looks.muzzle;
  if (mk) {
    const len = MUZZLE_LEN[mk] ?? 0.06;
    const z0 = tip - 0.004;
    const z1 = tip + len;
    const bore = Math.max(0.003, A.r * 0.5);
    const can = (key: string, r: number, m: WS, cap: WS) => {
      w.turn(`mod.can:${key}`, [[0, z0], [r * 0.7, z0], [r, z0 + 0.008], [r, z1 - 0.008], [r * 0.85, z1], [bore + 0.001, z1], [bore, z1 - 0.003], [bore, z1 - 0.03], [0, z1 - 0.03]], 0, my, m);
      if (w.hi) {
        w.turn(`mod.capR:${key}`, [[r * 0.98, z0 + 0.006], [r * 1.04, z0 + 0.008], [r * 1.04, z0 + 0.02], [r * 0.98, z0 + 0.022]], 0, my, cap);
        w.turn(`mod.bore:${key}`, [[bore * 0.97, 0], [bore * 0.97, 0.028], [0, 0.028]], 0, my, M.hole(), 12, 0.7, z1 - 0.029);
      }
    };
    switch (mk) {
      case 'supp_s':
        can('s', Math.max(0.017, A.r * 1.9), M.anod(0x18191b, 0.3), M.knurl(0x202124));
        break;
      case 'supp_l':
        can('l', Math.max(0.022, A.r * 1.9), M.anod(0x18191b, 0.3), M.knurl(0x202124));
        break;
      case 'can_s':
      case 'can_l': {
        // An oil filter (or a length of pipe) on an adaptor: painted, ribbed, rusted, clamped on.
        const r = mk === 'can_s' ? 0.025 : 0.029;
        w.turn(`mod.adapt:${mk}`, [[0, z0], [A.r * 1.4, z0], [A.r * 1.4, z0 + 0.025], [0, z0 + 0.025]], 0, my, M.steel(0x5a5e62, 0.8));
        w.turn(`mod.filter:${mk}`, [[0, z0 + 0.02], [r * 0.8, z0 + 0.02], [r, z0 + 0.03], [r, z1 - 0.006], [r * 0.9, z1], [bore + 0.002, z1], [bore, z1 - 0.004], [0, z1 - 0.004]], 0, my, M.paint(mk === 'can_s' ? 0x1e4a8a : 0xc85a1a, 0.95));
        if (w.hi) for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          w.box(Math.cos(a) * r, my + Math.sin(a) * r, z0 + 0.03 + (z1 - z0 - 0.04) * 0.12, 0.0035, 0.0035, 0.012, M.paint(mk === 'can_s' ? 0x1a3e74 : 0xa84a14, 0.95), 0, 0, a);
        }
        for (const t of [0.35, 0.75]) w.turn(`mod.clamp:${mk}`, [[r, -0.004], [r + 0.0015, -0.003], [r + 0.0015, 0.003], [r, 0.004]], 0, my, M.bright(0x9a9c9e, 0.5), undefined, 0.7, z0 + (z1 - z0) * t);
        break;
      }
      case 'comp':
      case 'comp2': {
        const r = Math.max(A.r * 1.6, 0.009);
        w.turn(`mod.comp:${mk}`, [[0, z0], [r, z0], [r, z1 - 0.002], [r - 0.001, z1], [bore, z1], [bore, z1 - 0.02], [0, z1 - 0.02]], 0, my, metal);
        if (w.hi) for (let i = 0; i < (mk === 'comp' ? 2 : 3); i++) for (const a of [HALF - 0.5, HALF + 0.5]) w.box(Math.cos(a) * r, my + Math.sin(a) * r, z0 + 0.014 + i * 0.016, 0.004, 0.004, 0.007, M.hole(), 0, 0, a);
        break;
      }
      case 'brake': {
        const r = Math.max(A.r * 1.6, 0.012);
        w.turn(`mod.brake:${model}`, [[0, z0], [r, z0], [r, z1 - 0.002], [r - 0.001, z1], [bore, z1], [bore, z1 - 0.03], [0, z1 - 0.03]], 0, my, metal);
        if (w.hi) for (let i = 0; i < 3; i++) for (const s of [1, -1]) w.box(s * r, my + 0.001, z0 + 0.014 + i * 0.016, 0.004, r * 1.2, 0.008, M.hole());
        break;
      }
      case 'hider': {
        // A three-prong flash hider.
        const r = Math.max(A.r * 1.3, 0.009);
        w.turn(`mod.hider:${model}`, [[0, z0], [r, z0], [r, z0 + 0.025], [0, z0 + 0.025]], 0, my, metal);
        for (let i = 0; i < 3; i++) {
          const a = HALF + (i / 3) * Math.PI * 2;
          w.rbox(Math.cos(a) * r * 0.78, my + Math.sin(a) * r * 0.78, (z0 + 0.025 + z1) / 2, r * 0.55, r * 0.55, z1 - z0 - 0.025, 0.001, metal, 0, 0, a);
        }
        break;
      }
      case 'choke':
        if (A.dbl) for (const sx of [1, -1]) w.turn('mod.choke2', [[0, z0], [A.r * 1.08, z0], [A.r * 1.08, z1], [A.r * 0.8, z1], [A.r * 0.8, z1 - 0.02], [0, z1 - 0.02]], sx * dbl, my, M.knurl(0x2a2c2e));
        else w.turn(`mod.choke:${model}`, [[0, z0], [A.r * 1.3, z0], [A.r * 1.3, z1], [A.r * 0.85, z1], [A.r * 0.85, z1 - 0.02], [0, z1 - 0.02]], 0, my, M.knurl(0x2a2c2e));
        break;
    }
  }

  // ---- optic, on the top rail
  const o = OPTICS[looks.optic ?? ''];
  if (o) {
    const y = A.top.y;
    const z = A.top.z;
    const sl = sightLine(model, looks);
    const ay = sl.rear[1];
    switch (o.kind) {
      case 'tube': {
        // A tube red dot: an open tube on its mount, rubber-armoured turrets, the dot lit on the axis at the front lens.
        clamp(w, y, z, 0.03);
        w.rbox(0, (y + 0.01 + ay - 0.012) / 2, z, 0.016, ay - 0.012 - y - 0.01 + 0.004, 0.024, 0.002, metal);
        w.turn('mod.dot', [[0.0122, z - o.len / 2], [0.0155, z - o.len / 2 + 0.001], [0.0155, z + o.len / 2 - 0.001], [0.0122, z + o.len / 2], [0.0118, z + o.len / 2 - 0.004], [0.0118, z - o.len / 2 + 0.004]], 0, ay, metal);
        w.turnAlong('mod.dotT', [[0, 0], [0.0068, 0], [0.0068, 1], [0, 1]], [0, ay + 0.014, z + 0.005], [0, ay + 0.022, z + 0.005], M.rubber(0x1d1d1d));
        w.turnAlong('mod.dotT', [[0, 0], [0.0068, 0], [0.0068, 1], [0, 1]], [-0.014, ay, z + 0.005], [-0.022, ay, z + 0.005], M.rubber(0x1d1d1d));
        w.turn('mod.dotLens', [[0.0118, 0], [0.0104, 0.0008], [0.0104, 0.0016], [0.0118, 0.0024]], 0, ay, lensRim, undefined, 0.7, z + o.len / 2 - 0.006);
        w.sphere(0, ay, z + o.len / 2 - 0.005, 0.0007, red);
        break;
      }
      case 'reflex': {
        // An open reflex sight: a low base and a hooded window, the dot on the axis in the window.
        clamp(w, y, z, 0.026);
        w.rbox(0, y + 0.014, z - 0.006, 0.026, 0.01, 0.04, 0.003, metal);
        const wy = ay;
        w.sec('mod.reflex', () => shape([[-0.014, -0.012], [0.014, -0.012], [0.014, 0.008, 0.004], [0.006, 0.014, 0.004], [-0.006, 0.014, 0.004], [-0.014, 0.008, 0.004]], [[[-0.011, -0.009, 0.002], [0.011, -0.009, 0.002], [0.011, 0.006, 0.003], [0.004, 0.0115, 0.003], [-0.004, 0.0115, 0.003], [-0.011, 0.006, 0.003]]]), z + 0.012, z + 0.022, 0.001, metal, 0, wy);
        w.sphere(0, wy, z + 0.017, 0.0007, red);
        break;
      }
      case 'holo': {
        // A holographic sight: a hooded box open front and back, its ring-and-dot reticle in the window, the battery out front.
        clamp(w, y, z, 0.06, 0.026);
        w.rbox(0, y + 0.014, z + 0.01, 0.03, 0.01, 0.07, 0.003, polymer);
        w.sec('mod.holo', () => shape([[-0.018, -0.016], [0.018, -0.016], [0.018, 0.012, 0.005], [0.012, 0.018, 0.004], [-0.012, 0.018, 0.004], [-0.018, 0.012, 0.005]], [[[-0.0145, -0.012, 0.002], [0.0145, -0.012, 0.002], [0.0145, 0.01, 0.003], [0.009, 0.014, 0.003], [-0.009, 0.014, 0.003], [-0.0145, 0.01, 0.003]]]), z - o.len / 2, z + 0.008, 0.0015, polymer, 0, ay);
        w.rbox(0, y + 0.016, z + 0.03, 0.03, 0.022, 0.04, 0.004, polymer);
        if (w.hi) for (const s of [1, -1]) w.rbox(s * 0.016, y + 0.016, z + 0.03, 0.003, 0.012, 0.018, 0.001, M.rubber(0x1a1a1a));
        w.torus(0, ay, z + 0.006, 0.0052, 0.0003, red);
        w.sphere(0, ay, z + 0.006, 0.0006, red);
        break;
      }
      case 'micro': {
        // A pistol micro dot on the slide: a plate, a little open window, the dot.
        w.rbox(0, y + 0.002, z, 0.022, 0.004, o.len, 0.0012, metal);
        w.sec('mod.micro', () => shape([[-0.0115, -0.01], [0.0115, -0.01], [0.0115, 0.004, 0.003], [0.005, 0.009, 0.003], [-0.005, 0.009, 0.003], [-0.0115, 0.004, 0.003]], [[[-0.0092, -0.006, 0.0015], [0.0092, -0.006, 0.0015], [0.0092, 0.003, 0.002], [0.004, 0.0068, 0.002], [-0.004, 0.0068, 0.002], [-0.0092, 0.003, 0.002]]]), z + 0.006, z + o.len / 2, 0.0008, metal, 0, ay);
        w.rbox(0, y + 0.006, z - 0.008, 0.022, 0.009, 0.02, 0.002, metal);
        w.sphere(0, ay, z + 0.012, 0.0006, red);
        break;
      }
      case 'scope': {
        rings(w, `mod.${looks.optic}`, y, ay, o.r!, [z - o.len * 0.18, z + o.len * 0.2], metal);
        scope(w, `mod.${looks.optic}`, ay, z - o.len / 2, z + o.len / 2, o.r!, o.ocu!, o.obj!, M.anod(0x17181a, 0.3), { turrets: looks.optic === 'scope8' ? 'target' : 'capped' });
        break;
      }
    }
  }

  // ---- underbarrel
  const uk = looks.under;
  if (uk) {
    const y = A.under.y;
    const z = A.under.z;
    switch (uk) {
      case 'grip':
        clamp(w, y - 0.012, z, 0.04, 0.022);
        w.side('mod.vgrip', () => shape([[z - 0.016, y - 0.008], [z + 0.016, y - 0.008], [z + 0.014, y - 0.088, 0.008], [z - 0.014, y - 0.09, 0.008]]), 0, 0.026, 0.004, M.stipple(0x1e1f21, 0.3));
        if (w.hi) for (let i = 0; i < 4; i++) w.rbox(0, y - 0.026 - i * 0.016, z + 0.0155, 0.022, 0.006, 0.004, 0.0015, polymer);
        break;
      case 'grip_a':
        clamp(w, y - 0.012, z, 0.05, 0.022);
        w.side('mod.agrip', () => shape([[z - 0.03, y - 0.008], [z + 0.026, y - 0.008, 0.004], [z + 0.03, y - 0.022, 0.008], [z - 0.022, y - 0.03, 0.01]]), 0, 0.026, 0.004, polymer);
        break;
      case 'bipod': {
        // Folded under the fore-end: the yoke on its clamp, two legs swung back, their rubber feet.
        clamp(w, y - 0.012, z, 0.034, 0.026);
        w.rbox(0, y - 0.016, z, 0.04, 0.012, 0.03, 0.003, metal);
        for (const sx of [1, -1]) {
          w.rod([sx * 0.014, y - 0.018, z], [sx * 0.018, y - 0.024, z - 0.17], 0.0045, metal);
          w.rod([sx * 0.018, y - 0.024, z - 0.12], [sx * 0.018, y - 0.024, z - 0.18], 0.0034, steel);
          w.sphere(sx * 0.018, y - 0.025, z - 0.184, 0.006, rubber);
        }
        break;
      }
    }
  }

  // ---- magazine, below the well (or out the end of a tube)
  const mgk = looks.mag;
  if (mgk) {
    const y = A.mag.y;
    const z = A.mag.z;
    switch (mgk) {
      case 'mag_ext':
        // An extension on the magazine's floor: a longer body and a fatter base plate.
        w.rbox(0, y - 0.024, z, 0.024, 0.05, 0.036, 0.002, M.park(0x1a1b1d, 0.35));
        w.rbox(0, y - 0.05, z, 0.028, 0.008, 0.042, 0.0025, polymer);
        break;
      case 'mag_q':
        w.rbox(0, y - 0.006, z, 0.028, 0.01, 0.046, 0.003, polymer);
        w.torus(0, y - 0.02, z, 0.01, 0.0026, M.cord(0x1e1f21), HALF, 0, 0);
        break;
      case 'drum':
        // A drum hanging off the well: two drums side by side and the feed tower up into the gun.
        w.rbox(0, y + 0.02, z, 0.024, 0.06, 0.04, 0.003, M.park(0x1a1b1d, 0.35));
        for (const sx of [1, -1]) {
          w.turnAlong('mod.drum', [[0, 0], [0.045, 0], [0.052, 0.12], [0.052, 0.88], [0.045, 1], [0, 1]], [sx * 0.004, y - 0.03, z], [sx * 0.036, y - 0.03, z], M.anod(0x1c1d1f, 0.4));
          if (w.hi) w.turnAlong('mod.drumW', [[0, 0], [0.008, 0], [0.008, 1], [0, 1]], [sx * 0.036, y - 0.03, z], [sx * 0.04, y - 0.03, z], M.knurl(0x2a2c2e));
        }
        break;
      case 'loader': {
        // A speedloader's rounds ready in their ring, carried beside the cylinder.
        const r = 0.012;
        w.torus(0.03, y, z, r, 0.004, polymer, 0, HALF, 0);
        if (w.hi) for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          w.turnAlong('mod.round', [[0, 0], [0.0045, 0], [0.0045, 0.6], [0.003, 0.9], [0, 1]], [0.026, y + Math.cos(a) * r, z + Math.sin(a) * r], [0.046, y + Math.cos(a) * r, z + Math.sin(a) * r], M.brass(0xb08a46, 0.3));
        }
        break;
      }
      case 'tube':
        w.tube(0, y, z - 0.01, z + 0.12, 0.0118, steel);
        w.turn('mod.tubecap', [[0, z + 0.118], [0.0125, z + 0.118], [0.0125, z + 0.134], [0.009, z + 0.138], [0, z + 0.138]], 0, y, M.knurl(0x2a2c2e));
        break;
      case 'saddle': {
        // A side saddle on the receiver's left with four shells in it.
        const sy = A.top.y - 0.03;
        const sz = A.top.z + 0.01;
        w.rbox(0.021, sy, sz, 0.004, 0.032, 0.1, 0.002, M.leather(0x2a2018));
        for (let i = 0; i < 4; i++) {
          w.turnAlong('mod.shell', [[0, 0], [0.0105, 0], [0.0105, 0.22], [0.0098, 0.24], [0.0098, 1], [0, 1]], [0.03, sy - 0.03, sz - 0.036 + i * 0.024], [0.03, sy + 0.035, sz - 0.036 + i * 0.024], M.paint(0xa8281c, 0.4));
          w.turnAlong('mod.head', [[0, 0], [0.0108, 0], [0.0108, 1], [0, 1]], [0.03, sy - 0.032, sz - 0.036 + i * 0.024], [0.03, sy - 0.024, sz - 0.036 + i * 0.024], M.brass(0xb08a46, 0.3));
        }
        break;
      }
      case 'crank': {
        // A cocking crank on the stock's side: its drum and the folded handle.
        const s = A.stock;
        w.turnAlong('mod.crank', [[0, 0], [0.024, 0], [0.024, 1], [0, 1]], [0.017, s.y + 0.02, s.z + 0.12], [0.03, s.y + 0.02, s.z + 0.12], metal);
        w.rod([0.032, s.y + 0.02, s.z + 0.12], [0.032, s.y + 0.06, s.z + 0.1], 0.0035, steel);
        w.turnAlong('mod.crankK', [[0, 0], [0.006, 0], [0.006, 1], [0, 1]], [0.032, s.y + 0.06, s.z + 0.1], [0.048, s.y + 0.06, s.z + 0.1], polymer);
        break;
      }
      case 'mag_b':
        w.rbox(0, y - 0.02, z, 0.028, 0.04, 0.07, 0.003, M.park(0x1a1b1d, 0.35));
        break;
    }
  }

  // ---- stock: a pad on the end of the gun's own, or a whole stock in place of it
  const sk = looks.stock;
  if (sk) {
    const s = A.stock;
    const t = f.tail ?? { y: f.bore, z: s.z + 0.2 };
    const len = t.z - s.z;
    switch (sk) {
      case 'butt':
        w.side('mod.pad', () => shape([[s.z - 0.014, s.y + 0.062, 0.006], [s.z, s.y + 0.062], [s.z, s.y - 0.06], [s.z - 0.014, s.y - 0.06, 0.006]]), 0, 0.044, 0.005, rubber);
        break;
      case 'butt2':
        w.side('mod.gel', () => shape([[s.z - 0.018, s.y + 0.064, 0.008], [s.z, s.y + 0.064], [s.z, s.y - 0.062], [s.z - 0.018, s.y - 0.062, 0.008]]), 0, 0.046, 0.006, M.rubber(0x24241f));
        w.side('mod.cheekrest', () => shape([[s.z + 0.04, s.y + 0.064], [s.z + 0.18, s.y + 0.066], [s.z + 0.18, s.y + 0.086, 0.008], [s.z + 0.04, s.y + 0.084, 0.008]]), 0, 0.036, 0.004, M.poly(0x2a2c2e, 0.3));
        break;
      case 'stock_p': {
        // A wire shoulder stock clipped to the pistol's grip.
        const g = f.grip.p;
        const base: V3 = [0, g[1] - 0.05, g[2] - 0.035];
        for (const sx of [1, -1]) w.rod([sx * 0.012, base[1], base[2]], [sx * 0.014, g[1] + 0.02, g[2] - 0.25], 0.0042, steel);
        w.rod([0, base[1] - 0.004, base[2]], [0, g[1] - 0.06, g[2] - 0.25], 0.0042, steel);
        w.side('mod.wirepad', () => shape([[g[2] - 0.262, g[1] - 0.075, 0.006], [g[2] - 0.246, g[1] - 0.075], [g[2] - 0.246, g[1] + 0.035], [g[2] - 0.262, g[1] + 0.035, 0.006]]), 0, 0.038, 0.004, rubber);
        break;
      }
      case 'stock_s': {
        // A skeleton stock: two struts and a slim plate.
        for (const dy of [0.032, -0.03]) w.rod([0, t.y + dy * 0.5, t.z], [0, t.y + dy, s.z + 0.012], 0.0046, metal);
        w.side('mod.skel', () => shape([[s.z, t.y + 0.04, 0.006], [s.z + 0.012, t.y + 0.04], [s.z + 0.012, t.y - 0.08], [s.z, t.y - 0.08, 0.006]]), 0, 0.034, 0.004, rubber);
        break;
      }
      case 'stock_h':
        // A heavy fixed stock, solid to the pad.
        w.side('mod.heavy', () => shape([[t.z, t.y + 0.018, 0.006], [s.z + 0.012, t.y + 0.026, 0.008], [s.z + 0.012, t.y - 0.088, 0.006], [s.z + len * 0.4, t.y - 0.07, 0.04], [t.z, t.y - 0.03, 0.006]]), 0, 0.044, 0.006, polymer);
        w.side('mod.heavyPad', () => shape([[s.z, t.y + 0.026, 0.006], [s.z + 0.013, t.y + 0.026], [s.z + 0.013, t.y - 0.09], [s.z, t.y - 0.09, 0.006]]), 0, 0.044, 0.004, rubber);
        break;
      case 'stock_t':
        // A tactical stock with an adjustable cheek riser and a QD cup.
        w.side('mod.tact', () => shape([[t.z, t.y + 0.014, 0.006], [s.z + 0.012, t.y + 0.02, 0.006], [s.z + 0.012, t.y - 0.08, 0.006], [s.z + len * 0.45, t.y - 0.05, 0.03], [t.z, t.y - 0.022, 0.006]], w.hi ? [[[s.z + len * 0.3, t.y - 0.01, 0.006], [s.z + len * 0.62, t.y - 0.008, 0.006], [s.z + len * 0.4, t.y - 0.05, 0.01]]] : []), 0, 0.036, 0.004, polymer);
        w.side('mod.riser', () => shape([[s.z + 0.04, t.y + 0.022], [t.z - 0.03, t.y + 0.018], [t.z - 0.034, t.y + 0.034, 0.006], [s.z + 0.044, t.y + 0.04, 0.008]]), 0, 0.03, 0.004, M.poly(0x2a2c2e, 0.3));
        w.side('mod.tactPad', () => shape([[s.z, t.y + 0.022, 0.006], [s.z + 0.012, t.y + 0.022], [s.z + 0.012, t.y - 0.084], [s.z, t.y - 0.084, 0.006]]), 0, 0.036, 0.004, rubber);
        break;
    }
  }

  // ---- rail: laser, light or both, on the left of the fore-end
  const rk = looks.rail;
  if (rk) {
    const { x, y, z } = A.side;
    const lx = x + 0.014;
    switch (rk) {
      case 'laser':
        w.rbox(lx, y, z, 0.022, 0.024, 0.06, 0.005, polymer);
        w.turnAlong('mod.lz', [[0, 0], [0.0042, 0], [0.0042, 1], [0, 1]], [lx, y, z + 0.03], [lx, y, z + 0.033], lensRim, 10);
        w.sphere(lx, y, z + 0.0335, 0.0018, red);
        break;
      case 'torch':
        w.turnAlong('mod.torch', [[0, 0], [0.012, 0], [0.012, 0.6], [0.016, 0.75], [0.016, 1], [0, 1]], [lx + 0.004, y, z - 0.04], [lx + 0.004, y, z + 0.035], M.anod(0x1c1d1f, 0.3));
        w.turnAlong('mod.torchL', [[0, 0], [0.014, 0], [0.014, 1], [0, 1]], [lx + 0.004, y, z + 0.035], [lx + 0.004, y, z + 0.0365], white);
        w.rbox(x + 0.004, y, z, 0.008, 0.014, 0.03, 0.002, metal);
        if (w.hi) for (let i = 0; i < 4; i++) w.turn('mod.torchR', [[0.0122, 0], [0.0128, 0.0015], [0.0122, 0.003]], lx + 0.004, y, M.anod(0x1c1d1f, 0.3), 16, 0.7, z - 0.03 + i * 0.012);
        break;
      case 'combo':
        w.rbox(lx, y, z, 0.03, 0.04, 0.08, 0.006, M.anod(0x2a2c2e, 0.3));
        w.turnAlong('mod.cl', [[0, 0], [0.011, 0], [0.011, 1], [0, 1]], [lx, y + 0.008, z + 0.04], [lx, y + 0.008, z + 0.0415], white);
        w.sphere(lx, y - 0.012, z + 0.041, 0.0022, red);
        if (w.hi) for (const s of [1, -1]) w.rbox(lx + 0.0155, y + s * 0.01, z - 0.02, 0.003, 0.006, 0.012, 0.001, M.rubber(0x1a1a1a));
        break;
    }
  }
}

/** The points a fitted optic's mount and lens leave for tests: whether `looks` puts anything on the top rail. */
export const hasOptic = (looks: Partial<Record<AttachSlot, string>>) => !!OPTICS[looks.optic ?? ''];

export type { P2 };
