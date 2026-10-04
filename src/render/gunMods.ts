import { MeshBuilder, S } from './builder';
import type { AttachSlot, GunModel } from '../data/gear';

/**
 * Add-ons on the held gun, drawn as simple solids bolted onto the model at the spots each gun declares: a scope tube on the top
 * rail, a suppressor on the muzzle, a grip under the handguard, a longer magazine below the well. Everything is in the gun's
 * local space (+Z forward along the barrel, +Y up, the origin at the grip), the same space `humanoid.ts` builds the guns in.
 * `ANCHORS` is the only per-gun data: a gun with no entry for a slot simply has nowhere to show that add-on.
 */

export interface Anchors {
  /** The top of the receiver and the middle of its rail. */
  top: { y: number; z: number };
  /** The barrel's axis height and the z of its tip. */
  muzzle: { y: number; z: number };
  /** The underside of the handguard. */
  under: { y: number; z: number };
  /** The bottom of the magazine (or the end of a tube) and where it sits along the gun. */
  mag: { y: number; z: number };
  /** The back of the gun, where a stock begins. */
  stock: { y: number; z: number };
  /** A spot on the left side for a light. */
  side: { x: number; y: number; z: number };
  /** Barrel radius, so a muzzle device is sized to what it is on. */
  r: number;
  /** Two barrels side by side (a shotgun). */
  dbl?: boolean;
}

export const ANCHORS: Record<GunModel, Anchors> = {
  pistol: { top: { y: 0.055, z: 0.12 }, muzzle: { y: 0.035, z: 0.245 }, under: { y: 0.008, z: 0.12 }, mag: { y: -0.09, z: 0.03 }, stock: { y: 0.03, z: 0.01 }, side: { x: -0.02, y: 0.0, z: 0.12 }, r: 0.01 },
  compact: { top: { y: 0.051, z: 0.1 }, muzzle: { y: 0.032, z: 0.205 }, under: { y: 0.005, z: 0.1 }, mag: { y: -0.082, z: 0.035 }, stock: { y: 0.028, z: 0.015 }, side: { x: -0.018, y: 0.0, z: 0.1 }, r: 0.009 },
  revolver: { top: { y: 0.078, z: 0.15 }, muzzle: { y: 0.04, z: 0.3 }, under: { y: 0.015, z: 0.22 }, mag: { y: 0.035, z: 0.085 }, stock: { y: 0.03, z: 0.0 }, side: { x: -0.022, y: 0.02, z: 0.2 }, r: 0.011 },
  cannon: { top: { y: 0.083, z: 0.15 }, muzzle: { y: 0.045, z: 0.39 }, under: { y: 0.015, z: 0.28 }, mag: { y: 0.035, z: 0.085 }, stock: { y: 0.03, z: 0.0 }, side: { x: -0.026, y: 0.02, z: 0.25 }, r: 0.016 },
  smg: { top: { y: 0.0575, z: 0.16 }, muzzle: { y: 0.03, z: 0.45 }, under: { y: -0.018, z: 0.3 }, mag: { y: -0.185, z: 0.14 }, stock: { y: 0.02, z: -0.2 }, side: { x: -0.026, y: 0.02, z: 0.3 }, r: 0.01 },
  mp: { top: { y: 0.066, z: 0.1 }, muzzle: { y: 0.035, z: 0.275 }, under: { y: -0.01, z: 0.16 }, mag: { y: -0.19, z: 0.08 }, stock: { y: 0.03, z: -0.03 }, side: { x: -0.022, y: 0.03, z: 0.15 }, r: 0.008 },
  smg2: { top: { y: 0.062, z: 0.14 }, muzzle: { y: 0.03, z: 0.44 }, under: { y: -0.02, z: 0.3 }, mag: { y: -0.185, z: 0.12 }, stock: { y: 0.02, z: -0.26 }, side: { x: -0.026, y: 0.02, z: 0.3 }, r: 0.012 },
  sawn: { top: { y: 0.07, z: 0.05 }, muzzle: { y: 0.035, z: 0.37 }, under: { y: 0.005, z: 0.14 }, mag: { y: 0.03, z: 0.02 }, stock: { y: -0.03, z: -0.12 }, side: { x: -0.04, y: 0.03, z: 0.2 }, r: 0.0135, dbl: true },
  pump: { top: { y: 0.07, z: 0.08 }, muzzle: { y: 0.042, z: 0.81 }, under: { y: -0.03, z: 0.55 }, mag: { y: 0.008, z: 0.63 }, stock: { y: -0.01, z: -0.35 }, side: { x: -0.03, y: 0.04, z: 0.45 }, r: 0.013 },
  rifle: { top: { y: 0.062, z: 0.25 }, muzzle: { y: 0.035, z: 0.78 }, under: { y: 0.014, z: 0.55 }, mag: { y: -0.125, z: 0.2 }, stock: { y: -0.01, z: -0.25 }, side: { x: -0.03, y: 0.03, z: 0.5 }, r: 0.012 },
  carbine: { top: { y: 0.066, z: 0.2 }, muzzle: { y: 0.032, z: 0.63 }, under: { y: -0.012, z: 0.5 }, mag: { y: -0.18, z: 0.17 }, stock: { y: 0.0, z: -0.25 }, side: { x: -0.03, y: 0.02, z: 0.5 }, r: 0.011 },
  ar: { top: { y: 0.07, z: 0.24 }, muzzle: { y: 0.034, z: 0.9 }, under: { y: -0.015, z: 0.62 }, mag: { y: -0.185, z: 0.2 }, stock: { y: 0.0, z: -0.31 }, side: { x: -0.032, y: 0.02, z: 0.62 }, r: 0.009 },
  br: { top: { y: 0.068, z: 0.26 }, muzzle: { y: 0.032, z: 0.93 }, under: { y: -0.02, z: 0.66 }, mag: { y: -0.195, z: 0.22 }, stock: { y: -0.005, z: -0.35 }, side: { x: -0.034, y: 0.015, z: 0.66 }, r: 0.01 },
  dmr: { top: { y: 0.065, z: 0.28 }, muzzle: { y: 0.034, z: 1.1 }, under: { y: -0.01, z: 0.82 }, mag: { y: -0.19, z: 0.24 }, stock: { y: 0.0, z: -0.36 }, side: { x: -0.034, y: 0.02, z: 0.78 }, r: 0.013 },
  sniper: { top: { y: 0.065, z: 0.3 }, muzzle: { y: 0.034, z: 1.21 }, under: { y: 0.012, z: 0.95 }, mag: { y: -0.105, z: 0.3 }, stock: { y: -0.01, z: -0.4 }, side: { x: -0.034, y: 0.02, z: 0.85 }, r: 0.015 },
  lever: { top: { y: 0.058, z: 0.25 }, muzzle: { y: 0.04, z: 0.85 }, under: { y: -0.012, z: 0.62 }, mag: { y: 0.008, z: 0.84 }, stock: { y: -0.01, z: -0.26 }, side: { x: -0.03, y: 0.03, z: 0.5 }, r: 0.012 },
  crossbow: { top: { y: 0.05, z: 0.22 }, muzzle: { y: 0.04, z: 0.58 }, under: { y: -0.035, z: 0.38 }, mag: { y: 0.03, z: 0.58 }, stock: { y: 0.0, z: -0.15 }, side: { x: -0.025, y: 0.02, z: 0.35 }, r: 0.01 },
  combat: { top: { y: 0.076, z: 0.1 }, muzzle: { y: 0.042, z: 0.82 }, under: { y: -0.02, z: 0.5 }, mag: { y: 0.01, z: 0.7 }, stock: { y: -0.01, z: -0.35 }, side: { x: -0.03, y: 0.04, z: 0.45 }, r: 0.013 },
  coach: { top: { y: 0.066, z: 0.06 }, muzzle: { y: 0.035, z: 0.72 }, under: { y: 0.0, z: 0.4 }, mag: { y: 0.03, z: 0.02 }, stock: { y: -0.03, z: -0.24 }, side: { x: -0.04, y: 0.03, z: 0.3 }, r: 0.0135, dbl: true },
  lmg: { top: { y: 0.078, z: 0.22 }, muzzle: { y: 0.04, z: 0.84 }, under: { y: -0.015, z: 0.6 }, mag: { y: -0.16, z: 0.18 }, stock: { y: 0.0, z: -0.38 }, side: { x: -0.036, y: 0.02, z: 0.6 }, r: 0.013 },
};

const BLK = 0x1c1d1f;
const metal = S.metal(BLK, 0.4);
const dark = S.metal(0x0a0a0a);
const rubber = S.rubber(0x161616);
const polymer = S.plastic(0x222324, 0.3);
const rust = S.rust(0x6a4a2e);
const lens = S.glow(0x5aa8ff, 1.1);
const red = S.glow(0xff2a1a, 3.2);
const white = S.glow(0xfff2c8, 3.6);
const HALF = Math.PI / 2;

/** A cylinder along Z from `z0` to `z1` at height `y`, `x` off the centre line. */
function bar(b: MeshBuilder, x: number, y: number, z0: number, z1: number, d: number, c: Parameters<MeshBuilder['cyl']>[6] = metal, seg = 10) {
  b.cyl(x, y, (z0 + z1) / 2, d, Math.abs(z1 - z0), d, c, HALF, 0, 0, seg);
}

/** How much a barrel add-on lengthens the barrel, by its look. The muzzle device then sits at the new tip. */
const BARREL_EXT: Record<string, number> = { bar_h: 0.05, bar_c: 0.07, bar_r: 0.1, bar_g: 0.08, bar_m: 0.09, bar_f: 0.11 };

/** Where the muzzle ends up with the add-ons on, so the flash and the tracer start at the tip. */
export function muzzleAt(model: GunModel, looks: Partial<Record<AttachSlot, string>>): { y: number; z: number } {
  const A = ANCHORS[model];
  let z = A.muzzle.z + (BARREL_EXT[looks.barrel ?? ''] ?? 0);
  const m = MUZZLE_LEN[looks.muzzle ?? ''];
  if (m) z += m;
  return { y: A.muzzle.y, z };
}

const MUZZLE_LEN: Record<string, number> = { supp_s: 0.17, can_s: 0.12, supp_l: 0.26, can_l: 0.2, comp: 0.05, comp2: 0.07, brake: 0.065, hider: 0.07, choke: 0.04 };

/** Add every fitted add-on's solids to a gun being built. */
export function drawMods(b: MeshBuilder, model: GunModel, looks: Partial<Record<AttachSlot, string>>) {
  const A = ANCHORS[model];
  const d0 = A.r * 2;
  let tip = A.muzzle.z;

  // ---- barrel: a longer or heavier barrel is a fatter collar out to the new tip
  const bl = looks.barrel;
  if (bl && BARREL_EXT[bl]) {
    const e = BARREL_EXT[bl];
    if (A.dbl) for (const sx of [1, -1]) bar(b, sx * 0.016, A.muzzle.y, tip - 0.01, tip + e, d0 * 1.1, metal);
    else if (bl === 'bar_f') {
      // Heavy and fluted: a thick collar with grooves cut along it.
      bar(b, 0, A.muzzle.y, tip - 0.03, tip + e, d0 * 1.9, S.metal(0x2a2c2e, 0.3));
      for (let i = 0; i < 3; i++) b.box(0, A.muzzle.y + d0 * 0.95, tip + 0.01 + i * 0.03, d0 * 0.5, 0.004, 0.012, dark);
    } else if (bl === 'bar_m') {
      // Match grade: a slim, bright barrel with a target crown.
      bar(b, 0, A.muzzle.y, tip - 0.02, tip + e, d0 * 1.3, S.metal(0x4a4e52, 0.25));
      b.torus(0, A.muzzle.y, tip + e, d0 * 0.75, 0.004, S.chrome(0xb8bcc0), 0, 0, 0, 4, 10);
    } else bar(b, 0, A.muzzle.y, tip - 0.02, tip + e, d0 * 1.5, S.metal(0x2a2c2e, 0.35));
    tip += e;
  } else if (bl === 'limbs') {
    // Heavier limbs on a crossbow: a second, longer pair of arms and a pair of cams.
    for (const sx of [1, -1]) {
      b.rbox(sx * 0.2, A.muzzle.y - 0.005, A.muzzle.z - 0.07, 0.4, 0.014, 0.026, 0.005, S.metal(0x2a2c2e, 0.4), 0, -sx * 0.4, 0);
      b.cyl(sx * 0.36, A.muzzle.y - 0.005, A.muzzle.z - 0.17, 0.035, 0.022, 0.035, dark, 0, 0, 0, 8);
    }
  }

  // ---- muzzle device
  const mk = looks.muzzle;
  if (mk) {
    const len = MUZZLE_LEN[mk] ?? 0.06;
    const y = A.muzzle.y;
    const z0 = tip - 0.005;
    const z1 = tip + len;
    switch (mk) {
      case 'supp_s':
        bar(b, 0, y, z0, z1, Math.max(0.042, d0 * 1.9), S.metal(0x16171a, 0.3));
        b.cyl(0, y, z0 + 0.01, 0.05, 0.012, 0.05, metal, HALF, 0, 0, 10);
        break;
      case 'supp_l':
        bar(b, 0, y, z0, z1, Math.max(0.054, d0 * 1.9), S.metal(0x16171a, 0.3));
        b.cyl(0, y, z0 + 0.012, 0.062, 0.014, 0.062, metal, HALF, 0, 0, 10);
        break;
      case 'can_s':
      case 'can_l': {
        // Oil filter or pipe: rough, rusty, with a band or two.
        bar(b, 0, y, z0, z1, mk === 'can_s' ? 0.05 : 0.058, rust);
        for (const t of [0.3, 0.7]) b.torus(0, y, z0 + (z1 - z0) * t, mk === 'can_s' ? 0.026 : 0.03, 0.004, S.steel(0x5c6266), 0, 0, 0, 5, 12);
        break;
      }
      case 'comp':
      case 'comp2':
        bar(b, 0, y, z0, z1, d0 * 1.6, metal);
        for (let i = 0; i < (mk === 'comp' ? 2 : 3); i++) b.box(0, y + d0 * 0.8, z0 + 0.012 + i * 0.016, d0 * 1.0, 0.004, 0.006, dark);
        break;
      case 'brake':
        b.rbox(0, y, (z0 + z1) / 2, 0.052, 0.034, len, 0.006, metal);
        b.box(0.027, y, (z0 + z1) / 2, 0.003, 0.02, len * 0.6, dark);
        b.box(-0.027, y, (z0 + z1) / 2, 0.003, 0.02, len * 0.6, dark);
        break;
      case 'hider':
        bar(b, 0, y, z0, z1 - 0.02, d0 * 1.4, metal);
        for (let i = 0; i < 4; i++) {
          const a = (i * HALF) + Math.PI / 4;
          b.box(Math.cos(a) * d0 * 0.8, y + Math.sin(a) * d0 * 0.8, z1 - 0.02, 0.005, 0.005, 0.04, metal);
        }
        break;
      case 'choke':
        if (A.dbl) b.rbox(0, y, (z0 + z1) / 2, 0.07, 0.044, len, 0.008, metal);
        else bar(b, 0, y, z0, z1, d0 * 1.5, metal);
        break;
    }
  }

  // ---- optic, on the top rail
  const ok = looks.optic;
  if (ok) {
    const y = A.top.y;
    const z = A.top.z;
    const tube = (r: number, len: number, obj: number, ocu: number) => {
      const yy = y + 0.032 + r;
      b.box(0, y + 0.012, z - len * 0.25, 0.022, 0.024, 0.03, metal);
      b.box(0, y + 0.012, z + len * 0.25, 0.022, 0.024, 0.03, metal);
      bar(b, 0, yy, z - len / 2, z + len / 2, r * 2, S.metal(0x17181a, 0.3));
      b.cyl(0, yy, z + len / 2 + 0.01, obj * 2, 0.04, obj * 2, S.metal(0x17181a, 0.3), HALF, 0, 0, 12);
      b.cyl(0, yy, z + len / 2 + 0.032, obj * 1.7, 0.004, obj * 1.7, lens, HALF, 0, 0, 12);
      b.cyl(0, yy, z - len / 2 - 0.008, ocu * 2, 0.03, ocu * 2, S.metal(0x17181a, 0.3), HALF, 0, 0, 10);
      b.box(0, yy + r + 0.004, z, 0.012, 0.012, 0.03, metal);
    };
    switch (ok) {
      case 'dot':
        b.box(0, y + 0.01, z, 0.022, 0.018, 0.06, metal);
        b.rbox(0, y + 0.036, z, 0.03, 0.032, 0.052, 0.006, polymer);
        b.box(0, y + 0.036, z + 0.027, 0.022, 0.022, 0.004, lens);
        b.sphereAt(0, y + 0.036, z + 0.029, 0.003, red);
        break;
      case 'reflex':
        b.box(0, y + 0.008, z, 0.026, 0.016, 0.066, metal);
        b.box(0.016, y + 0.03, z, 0.004, 0.036, 0.06, polymer);
        b.box(-0.016, y + 0.03, z, 0.004, 0.036, 0.06, polymer);
        b.box(0, y + 0.032, z + 0.03, 0.03, 0.03, 0.004, lens);
        b.box(0, y + 0.05, z + 0.0, 0.036, 0.006, 0.06, polymer);
        break;
      case 'holo':
        b.box(0, y + 0.01, z, 0.028, 0.018, 0.08, metal);
        b.rbox(0, y + 0.04, z, 0.038, 0.046, 0.078, 0.008, polymer);
        b.box(0, y + 0.04, z + 0.04, 0.03, 0.034, 0.004, lens);
        b.box(0, y + 0.04, z - 0.04, 0.03, 0.034, 0.004, lens);
        break;
      case 'pdot':
        b.box(0, y + 0.006, z, 0.02, 0.012, 0.04, metal);
        b.rbox(0, y + 0.02, z, 0.022, 0.02, 0.036, 0.004, polymer);
        b.box(0, y + 0.02, z + 0.019, 0.016, 0.014, 0.003, lens);
        break;
      case 'scope':
        tube(0.017, 0.15, 0.026, 0.021);
        break;
      case 'scope4':
        tube(0.02, 0.21, 0.03, 0.024);
        break;
      case 'scope8':
        tube(0.024, 0.32, 0.038, 0.027);
        b.cyl(0.026, y + 0.032 + 0.024, z, 0.016, 0.02, 0.016, metal, 0, 0, HALF, 8);
        break;
    }
  }

  // ---- underbarrel
  const uk = looks.under;
  if (uk) {
    const y = A.under.y;
    const z = A.under.z;
    switch (uk) {
      case 'grip':
        b.box(0, y - 0.006, z, 0.026, 0.014, 0.05, metal);
        b.rbox(0, y - 0.05, z, 0.026, 0.088, 0.032, 0.01, rubber);
        break;
      case 'grip_a':
        b.box(0, y - 0.006, z, 0.026, 0.014, 0.05, metal);
        b.rbox(0, y - 0.035, z + 0.025, 0.026, 0.07, 0.036, 0.01, rubber, -0.9, 0, 0);
        break;
      case 'bipod':
        b.box(0, y - 0.008, z, 0.04, 0.018, 0.05, metal);
        for (const sx of [1, -1]) b.rod(sx * 0.016, y - 0.016, z, sx * 0.022, y - 0.02, z + 0.17, 0.004, metal, 5);
        break;
    }
  }

  // ---- magazine, below the well (or out the end of a tube)
  const mgk = looks.mag;
  if (mgk) {
    const y = A.mag.y;
    const z = A.mag.z;
    switch (mgk) {
      case 'mag_ext':
        b.rbox(0, y - 0.045, z, 0.03, 0.1, 0.05, 0.006, S.metal(0x1a1b1d, 0.35));
        break;
      case 'mag_q':
        b.rbox(0, y - 0.015, z, 0.04, 0.036, 0.062, 0.008, polymer);
        b.box(0, y - 0.036, z, 0.034, 0.006, 0.056, rubber);
        break;
      case 'drum':
        b.cyl(0, y - 0.045, z, 0.13, 0.055, 0.13, S.metal(0x1a1b1d, 0.35), 0, 0, HALF, 14);
        b.cyl(0, y - 0.045, z, 0.04, 0.062, 0.04, metal, 0, 0, HALF, 8);
        break;
      case 'loader':
        b.torus(0, y, z + 0.046, 0.05, 0.007, S.metal(0x8a8e92), 0, 0, 0, 5, 14);
        break;
      case 'tube':
        bar(b, 0, y, z - 0.01, z + 0.12, 0.022, metal);
        b.cyl(0, y, z + 0.125, 0.026, 0.01, 0.026, S.steel(0x5c6266), HALF, 0, 0, 8);
        break;
      case 'saddle':
        b.rbox(-0.034, A.top.y - 0.03, A.top.z + 0.05, 0.01, 0.045, 0.1, 0.003, S.leather(0x2a2018));
        for (let i = 0; i < 4; i++) b.cyl(-0.04, A.top.y - 0.028, A.top.z + 0.01 + i * 0.026, 0.017, 0.04, 0.017, S.paint(0xa8281c, 0.5), 0, 0, 0, 8);
        break;
      case 'crank':
        b.cyl(0.03, A.stock.y, A.stock.z + 0.1, 0.05, 0.012, 0.05, metal, 0, 0, HALF, 8);
        b.rod(0.036, A.stock.y, A.stock.z + 0.1, 0.05, A.stock.y + 0.04, A.stock.z + 0.1, 0.004, metal, 5);
        break;
      case 'mag_b':
        b.rbox(0, y - 0.03, z, 0.03, 0.06, 0.05, 0.006, S.metal(0x1a1b1d, 0.35));
        break;
    }
  }

  // ---- stock
  const sk = looks.stock;
  if (sk) {
    const y = A.stock.y;
    const z = A.stock.z;
    switch (sk) {
      case 'butt':
        b.rbox(0, y, z - 0.012, 0.044, 0.115, 0.026, 0.008, rubber);
        break;
      case 'butt2':
        b.rbox(0, y, z - 0.014, 0.046, 0.12, 0.032, 0.01, S.rubber(0x24241f));
        b.rbox(0, y + 0.062, z + 0.12, 0.034, 0.03, 0.16, 0.008, S.plastic(0x2a2c2e, 0.3));
        break;
      case 'stock_p':
        for (const sx of [1, -1]) b.rod(sx * 0.014, y, z + 0.02, sx * 0.014, y - 0.025, z - 0.22, 0.005, metal, 5);
        b.rbox(0, y - 0.03, z - 0.225, 0.038, 0.09, 0.02, 0.006, rubber);
        break;
      case 'stock_s':
        for (const sy of [1, -1]) b.rod(0, y + sy * 0.034, z + 0.02, 0, y + sy * 0.04, z - 0.24, 0.005, metal, 5);
        b.rbox(0, y, z - 0.245, 0.034, 0.095, 0.02, 0.006, rubber);
        break;
      case 'stock_h':
        b.rbox(0, y - 0.006, z - 0.13, 0.05, 0.12, 0.28, 0.016, polymer);
        b.rbox(0, y - 0.006, z - 0.275, 0.05, 0.125, 0.026, 0.008, rubber);
        break;
      case 'stock_t':
        b.rbox(0, y - 0.004, z - 0.11, 0.042, 0.1, 0.24, 0.014, polymer);
        b.rbox(0, y + 0.058, z - 0.09, 0.036, 0.026, 0.14, 0.008, S.plastic(0x2a2c2e, 0.3));
        b.rbox(0, y - 0.004, z - 0.235, 0.044, 0.108, 0.024, 0.008, rubber);
        break;
    }
  }

  // ---- rail: laser, torch or both, on the left of the handguard
  const rk = looks.rail;
  if (rk) {
    const { x, y, z } = A.side;
    switch (rk) {
      case 'laser':
        b.rbox(x, y, z, 0.022, 0.024, 0.06, 0.005, polymer);
        b.sphereAt(x, y, z + 0.032, 0.005, red);
        break;
      case 'torch':
        b.rbox(x, y, z, 0.03, 0.03, 0.07, 0.008, S.metal(0x2a2c2e, 0.3));
        b.cyl(x, y, z + 0.04, 0.034, 0.012, 0.034, white, HALF, 0, 0, 10);
        break;
      case 'combo':
        b.rbox(x, y, z, 0.03, 0.04, 0.08, 0.008, S.metal(0x2a2c2e, 0.3));
        b.cyl(x, y + 0.008, z + 0.044, 0.026, 0.01, 0.026, white, HALF, 0, 0, 10);
        b.sphereAt(x, y - 0.012, z + 0.043, 0.005, red);
        break;
    }
  }
}
