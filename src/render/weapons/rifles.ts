import { M, replacesStock, shape, type Looks, type P2, type WB, type WS } from './kit';
import { barrel, boxMag, guard, mlok, peep, pistolGrip, post, rings, scope, swivel, trigger } from './parts';
import { FRAMES } from '../../sim/gunFrames';

/**
 * The rifles: the AR-pattern carbine and its big brother the marksman rifle, the FAL-pattern battle rifle, the hunting
 * sporter with its worn scope, the chassis sniper, the scrap carbine, the brass-framed lever gun, the belt-fed light
 * machine gun and the crossbow. Each is drawn to its frame in `sim/gunFrames.ts`.
 */

const rakeOf = (a: [number, number, number]) => a[2] / a[1];

// ---------------------------------------------------------------------------------------------------- AR pattern

interface ArCfg {
  key: 'ar' | 'dmr';
  /** Scale of the receivers and grip against an AR-15's (an AR-10 is bigger). */
  k: number;
  /** The upper receiver's back and front, the handguard's front, the barrel's visible end, the muzzle device's start. */
  zr: number;
  zf: number;
  hg: number;
  bz: number;
  /** Muzzle device: an A2 birdcage or a two-port brake. */
  device: 'a2' | 'brake';
  barrelR: number;
  /** Collapsible carbine stock or a fixed precision stock with a cheek riser. */
  stock: 'ctr' | 'prs';
  mag: { len: number; curve: number };
  anod: WS;
  poly: WS;
}

const AR: ArCfg = { key: 'ar', k: 1, zr: -0.048, zf: 0.128, hg: 0.45, bz: 0.468, device: 'a2', barrelR: 0.0095, stock: 'ctr', mag: { len: 0.143, curve: 0.03 }, anod: M.anod(0x26272a, 0.3), poly: M.poly(0x1e1f21, 0.3) };
const DMR: ArCfg = { key: 'dmr', k: 1.1, zr: -0.052, zf: 0.15, hg: 0.53, bz: 0.63, device: 'brake', barrelR: 0.0115, stock: 'prs', mag: { len: 0.11, curve: 0.012 }, anod: M.anod(0x2a2b2c, 0.3), poly: M.poly(0x232426, 0.3) };

function arPattern(w: WB, c: ArCfg, looks: Looks) {
  const f = FRAMES[c.key];
  const K = c.key;
  const B = f.bore;
  const k = c.k;
  const { anod, poly } = c;
  const steel = M.park(0x2f312e, 0.3);
  const railBase = f.top.y - 0.0095;
  const pl = B - 0.0165 * k;
  const { zr, zf } = c;
  // ---- upper receiver: the body under the rail, the port and its dust cover, the brass deflector, the forward assist.
  w.side(`${K}.upper`, () => shape([[zr, pl], [zf, pl], [zf, railBase - 0.004, 0.002], [zf - 0.003, railBase], [zr + 0.003, railBase], [zr, railBase - 0.004, 0.002]]), 0, 0.0254 * k, 0.0012, anod);
  w.rail(`${K}.up`, 0, railBase, zr + 0.002, zf - 0.001, anod);
  const p0 = f.port[2] - 0.03 * k;
  const p1 = f.port[2] + 0.03 * k;
  w.rbox(-0.0131 * k, B, (p0 + p1) / 2, 0.0012, 0.015 * k, p1 - p0, 0.0005, steel);
  if (w.hi) {
    w.box(-0.0138 * k, B + 0.002, (p0 + p1) / 2, 0.0008, 0.0015, p1 - p0 - 0.006, steel);
    w.tube(-0.0128 * k, B - 0.0082 * k, p0 - 0.002, p1 + 0.002, 0.0011, steel);
  }
  w.side(`${K}.deflect`, () => shape([[p0 - 0.016, pl + 0.006], [p0 - 0.002, pl + 0.006], [p0 - 0.002, railBase - 0.004, 0.002], [p0 - 0.012, railBase - 0.006, 0.006]]), -0.0127 * k - 0.0022, 0.0046, 0.0012, anod);
  if (w.hi) w.turnAlong(`${K}.fa`, [[0, 0], [0.0062, 0], [0.0062, 0.4], [0.0048, 0.45], [0.0048, 0.75], [0.0058, 0.8], [0.0058, 1], [0, 1]], [-0.009 * k, B + 0.002, p0 - 0.004], [-0.019 * k, B + 0.006, p0 - 0.032], anod);
  // ---- charging handle: a T in the channel at the back, under the rail.
  w.rbox(0, railBase - 0.0035, zr - 0.002, 0.016, 0.006, 0.014, 0.0015, anod);
  w.rbox(0, railBase - 0.0035, zr - 0.007, 0.036 * k, 0.0065, 0.008, 0.0025, anod);
  // ---- lower receiver: the body, the flared magazine well, the guard, trigger, grip and controls.
  const yl = B - 0.034 * k;
  const mw0 = f.well[2] - 0.037 * k;
  const mw1 = f.well[2] + 0.035 * k;
  w.side(`${K}.lower`, () => shape([[zr, pl], [mw1 - 0.004, pl], [mw1 - 0.004, yl], [zr + 0.026, yl, 0.004], [zr + 0.012, yl + 0.006, 0.006], [zr, pl - 0.01, 0.004]]), 0, 0.0226 * k, 0.0012, anod);
  w.side(`${K}.well`, () => shape([[mw0, pl], [mw1, pl], [mw1 + 0.003, pl - 0.008, 0.003], [mw1 + 0.001, f.well[1] + 0.002, 0.003], [mw1 + 0.004, f.well[1] - 0.001, 0.002], [mw0 - 0.004, f.well[1] - 0.001, 0.002], [mw0, f.well[1] + 0.004, 0.003], [mw0, yl]]), 0, 0.03 * k, 0.0014, anod);
  const gz1 = mw0 - 0.001;
  const gz0 = gz1 - 0.05 * k;
  guard(w, K, gz0, gz1, yl, 0.027 * k, anod, 0.0105);
  trigger(w, K, gz0 + 0.031 * k, yl, 0.018 * k, steel);
  // The grip: its top behind the guard, raked, finger groove, the hand laid on it at the frame's grip point.
  const R = rakeOf(f.grip.a);
  const gTop = yl + 0.001;
  pistolGrip(w, K, gz0 + 0.002, gz0 - 0.034 * k, gTop, R, 0.095 * k, 0.027 * k, M.stipple(c.poly.c as number, 0.3), { groove: true, swell: 0.004 });
  // Controls: the magazine button on the right with its fence, the bolt catch and the selector on the left, takedown pins.
  w.raw(steel, (b) => b.cyl(-0.0128 * k, yl + 0.012, mw0 + 0.006, 0.0085, 0.003, 0.0085, steel, 0, 0, Math.PI / 2, 14));
  w.side(`${K}.boltcatch`, () => shape([[mw0 - 0.002, pl - 0.002], [mw0 + 0.012, pl - 0.003, 0.002], [mw0 + 0.011, pl - 0.012, 0.002], [mw0 + 0.002, pl - 0.008, 0.002]]), 0.0113 * k + 0.0012, 0.0024, 0.0006, steel);
  w.side(`${K}.sel`, () => shape([[zr + 0.03, pl - 0.009, 0.002], [zr + 0.05, pl - 0.006, 0.002], [zr + 0.049, pl - 0.012, 0.002], [zr + 0.03, pl - 0.016, 0.003]]), 0.0113 * k + 0.0013, 0.0026, 0.0007, steel);
  w.pin(0.0113 * k, pl - 0.006, zf - 0.008, 0.0024, steel);
  w.pin(0.0113 * k, pl - 0.006, zr + 0.01, 0.0024, steel);
  w.pin(0.0113 * k, yl + 0.006, gz0 + 0.031 * k, 0.0016, steel);
  w.pin(0.0113 * k, yl + 0.01, gz0 + 0.014 * k, 0.0016, steel);
  // ---- magazine: a curved 30-rounder (or a straighter 20 for the .308), ribbed, a polymer floor plate.
  const mag = c.key === 'ar' ? M.poly(0x1d1d1f, 0.3) : M.anod(0x232426, 0.35);
  boxMag(w, K, mw0 + 0.002, mw1 - 0.002, f.well[1] + 0.006, c.mag.len + 0.006, c.mag.curve, 0.0225 * k, mag, { ribs: 2, plate: M.poly(0x1a1a1c), flare: 0.006 });
  // ---- buffer tube and stock.
  const tubeR = 0.0146 * k;
  w.turn(`${K}.buffer`, [[0, zr - 0.21], [tubeR, zr - 0.21], [tubeR, zr - 0.004], [tubeR + 0.002, zr - 0.004], [tubeR + 0.002, zr], [0, zr]], 0, B, anod);
  if (w.hi) w.turn(`${K}.castle`, [[tubeR, zr - 0.012], [tubeR + 0.0045, zr - 0.012], [tubeR + 0.0045, zr - 0.004], [tubeR, zr - 0.004]], 0, B, steel, w.hi ? 24 : 10);
  w.side(`${K}.endplate`, () => shape([[zr - 0.006, B + 0.012], [zr - 0.002, B + 0.012], [zr - 0.002, B - 0.024, 0.003], [zr - 0.006, B - 0.024, 0.003]]), 0, 0.03 * k, 0.0008, steel);
  const sz = f.stock.z;
  const own = !replacesStock(looks.stock);
  if (!own) {
    // A replacement stock goes on the tube (see `gunMods.ts`).
  } else if (c.stock === 'ctr') {
    // A collapsible carbine stock, half out: a cheek weld on top of the tube, the latch under it, a rubber pad.
    w.side(
      `${K}.ctr`,
      () => shape([[sz + 0.15, B + 0.017, 0.006], [sz + 0.012, B + 0.026, 0.006], [sz + 0.008, B + 0.028], [sz + 0.008, f.stock.y - 0.06, 0.004], [sz + 0.026, f.stock.y - 0.066, 0.008], [sz + 0.08, B - 0.032, 0.03], [sz + 0.13, B - 0.02, 0.006]]),
      0,
      0.032,
      0.004,
      poly,
    );
    w.side(`${K}.pad`, () => shape([[sz, B + 0.03, 0.004], [sz + 0.01, B + 0.03, 0.002], [sz + 0.01, f.stock.y - 0.068, 0.004], [sz, f.stock.y - 0.068, 0.004]]), 0, 0.03, 0.004, M.rubber(0x161617, 0.3));
    w.rbox(0, B - tubeR - 0.006, sz + 0.12, 0.008, 0.008, 0.03, 0.002, poly);
    if (w.hi) w.box(0.0175, B + 0.004, sz + 0.06, 0.0006, 0.012, 0.03, M.hole());
  } else {
    // A fixed precision stock: the cheek riser up on its post, the adjustable pad, the rear monopod.
    w.side(
      `${K}.prs`,
      () => shape([[zr - 0.004, B + 0.018, 0.006], [sz + 0.02, B + 0.02, 0.006], [sz + 0.012, B + 0.022], [sz + 0.012, f.stock.y - 0.072, 0.004], [sz + 0.03, f.stock.y - 0.078, 0.006], [sz + 0.09, B - 0.04, 0.03], [zr - 0.06, B - 0.024, 0.02], [zr - 0.004, B - 0.022, 0.006]]),
      0,
      0.036,
      0.004,
      poly,
    );
    if (w.hi) w.side(`${K}.prsHole`, () => shape([[sz + 0.04, f.stock.y - 0.05, 0.008], [sz + 0.1, B - 0.03, 0.01], [sz + 0.1, f.stock.y - 0.05, 0.008]]), 0, 0.046, 0.001, M.hole());
    w.side(`${K}.cheek`, () => shape([[sz + 0.03, B + 0.024], [zr - 0.03, B + 0.024], [zr - 0.034, B + 0.04, 0.006], [sz + 0.035, B + 0.044, 0.008]]), 0, 0.03, 0.004, poly);
    for (const z of [zr - 0.07, sz + 0.07]) w.tube(0, B + 0.022, z - 0.004, z + 0.004, 0.003, steel);
    w.side(`${K}.pad`, () => shape([[sz, B + 0.022, 0.004], [sz + 0.012, B + 0.022, 0.002], [sz + 0.012, f.stock.y - 0.074, 0.004], [sz, f.stock.y - 0.074, 0.004]]), 0, 0.036, 0.004, M.rubber(0x161617, 0.3));
  }
  if (own) swivel(w, 0, f.stock.y - 0.06, sz + 0.05, steel, false);
  // ---- handguard, barrel and muzzle device.
  const half = 0.021 * k;
  mlok(w, K, zf - 0.002, c.hg, B, half, anod);
  const br = c.barrelR;
  barrel(w, K, B, [[br + 0.003, zf - 0.03], [br, zf + 0.01], [br, c.bz]], 0.0028 * k, M.park(0x2b2d2a, 0.3));
  if (c.device === 'a2') {
    // The A2 birdcage: closed underneath so the muzzle does not kick up dust, slotted round the top.
    const z0 = c.bz - 0.001;
    const z1 = f.muzzle;
    w.turn(`${K}.a2`, [[0, z0], [0.0105, z0], [0.0112, z0 + 0.004], [0.0112, z1 - 0.002], [0.0104, z1], [0.0062, z1], [0.006, z1 - 0.03], [0, z1 - 0.03]], 0, B, steel);
    if (w.hi)
      for (const a of [Math.PI / 2, Math.PI / 2 + 1.05, Math.PI / 2 - 1.05, Math.PI / 2 + 2.1, Math.PI / 2 - 2.1]) {
        const r = 0.0109;
        w.box(Math.cos(a) * r, B + Math.sin(a) * r, (z0 + z1) / 2 + 0.008, 0.0028, 0.0028, 0.024, M.hole(), 0, 0, a);
      }
    if (w.hi) w.turn(`${K}.a2nut`, [[0.0096, z0 - 0.006], [0.0118, z0 - 0.006], [0.0118, z0], [0.0096, z0]], 0, B, steel, 6);
  } else {
    // A two-port muzzle brake.
    const z0 = c.bz - 0.002;
    const z1 = f.muzzle;
    w.turn(`${K}.brake`, [[0, z0], [0.0128, z0], [0.0132, z0 + 0.003], [0.0132, z1 - 0.002], [0.0124, z1], [0.0066, z1], [0.0064, z1 - 0.06], [0, z1 - 0.06]], 0, B, steel);
    if (w.hi) for (const zz of [z0 + 0.018, z0 + 0.036]) for (const s of [1, -1]) w.box(s * 0.0128, B + 0.002, zz, 0.003, 0.012, 0.009, M.hole());
  }
  // ---- flip-up sights on the rail ends, standing up.
  const crest = f.top.y;
  w.rbox(0, crest + 0.004, f.rear[2], 0.026, 0.009, 0.026, 0.0015, anod);
  for (const s of [1, -1]) w.side(`${K}.rwing`, () => shape([[f.rear[2] - 0.01, crest + 0.006], [f.rear[2] + 0.01, crest + 0.006], [f.rear[2] + 0.007, f.rear[1] + 0.002, 0.004], [f.rear[2] - 0.007, f.rear[1] + 0.002, 0.004]]), s * 0.0105, 0.0035, 0.001, anod);
  peep(w, f.rear[2], f.rear[1], crest + 0.008, anod, 0.0062, 0.0024);
  w.rbox(0, crest + 0.004, f.front[2], 0.026, 0.009, 0.022, 0.0015, anod);
  post(w, `${K}.f`, f.front[2], f.front[1], crest + 0.008, anod, true, 0.026);
  swivel(w, half + 0.002, B - 0.006, c.hg - 0.03, steel, false);
}

export const ar = (w: WB, looks: Looks = {}) => arPattern(w, AR, looks);
export const dmr = (w: WB, looks: Looks = {}) => arPattern(w, DMR, looks);



// ---------------------------------------------------------------------------------------------------- battle rifle

/**
 * A FAL-pattern battle rifle in its old wooden furniture: the tall upper with its peep sight, the alloy lower and its big
 * guard, a 20-round steel magazine, the gas tube over the barrel with the charging handle folding out on the LEFT, the
 * gas block with its eared front sight and regulator, a long slotted flash hider, and the long straight stock.
 */
export function br(w: WB, looks: Looks = {}) {
  const f = FRAMES.br;
  const B = f.bore;
  const steel = M.park(0x2a2c2a, 0.35);
  const alloy = M.anod(0x29292a, 0.35);
  const wood = M.wood(0x6a3e22, 0.4);
  const pl = B - 0.014;
  // Upper: a hump at the back for the rear sight, the top cover, the shoulder at the front.
  w.side(`br.upper`, () => shape([[-0.055, pl], [0.2, pl], [0.2, B + 0.016, 0.003], [0.17, B + 0.021, 0.01], [0.0, B + 0.023], [-0.022, B + 0.029, 0.006], [-0.05, B + 0.028, 0.004], [-0.055, B + 0.02, 0.003]]), 0, 0.03, 0.0015, steel);
  // The ejection port in the right side, its bolt carrier showing.
  w.box(-0.0152, B + 0.004, f.port[2], 0.0008, 0.014, 0.05, M.hole());
  w.box(-0.0145, B + 0.002, f.port[2] - 0.004, 0.0008, 0.006, 0.03, M.steel(0x6a6e70, 0.3));
  // Lower: the magazine well and the trigger guard, the pistol grip under its back.
  const wz0 = f.well[2] - 0.033;
  const wz1 = f.well[2] + 0.034;
  const yl = 0.0;
  w.side(`br.lower`, () => shape([[-0.055, pl], [wz1 + 0.012, pl], [wz1 + 0.012, pl - 0.012, 0.003], [wz1 + 0.002, f.well[1] + 0.002, 0.003], [wz0 - 0.002, f.well[1] + 0.002, 0.003], [wz0, yl], [-0.03, yl + 0.002, 0.006], [-0.055, pl - 0.008, 0.004]]), 0, 0.028, 0.0012, alloy);
  guard(w, 'br', wz0 - 0.058, wz0 - 0.002, yl, 0.03, steel, 0.009);
  trigger(w, 'br', wz0 - 0.022, yl, 0.02, steel);
  pistolGrip(w, 'br', wz0 - 0.056, wz0 - 0.096, yl + 0.002, rakeOf(f.grip.a), 0.1, 0.03, M.stipple(0x1c1c1e, 0.3), { swell: 0.004 });
  // Selector on the left over the grip, the takedown lever at the back, the magazine catch behind the well.
  w.side(`br.sel`, () => shape([[-0.02, pl - 0.004, 0.002], [0.004, pl - 0.001, 0.002], [0.002, pl - 0.008, 0.002], [-0.02, pl - 0.012, 0.003]]), 0.0152, 0.0024, 0.0006, steel);
  w.rbox(0, f.well[1] + 0.006, wz0 - 0.004, 0.012, 0.008, 0.006, 0.0015, steel);
  w.pin(0.014, pl - 0.006, -0.045, 0.003, steel);
  // The 20-round magazine.
  boxMag(w, 'br', wz0 + 0.002, wz1 - 0.002, f.well[1] + 0.006, f.well[1] - f.mag.y - 0.01, 0.014, 0.025, M.park(0x2a2b2a, 0.4), { ribs: 1, flare: 0.004 });
  // Barrel, gas block with its front sight and regulator, gas tube with the folding charging handle on the left.
  barrel(w, 'br', B, [[0.0135, 0.19], [0.0125, 0.24], [0.0098, 0.5], [0.0095, 0.735]], 0.0035, M.park(0x2a2c2a, 0.35));
  const gz = 0.47;
  w.side(`br.gas`, () => shape([[gz - 0.012, B - 0.012], [gz + 0.03, B - 0.012], [gz + 0.03, B + 0.026, 0.004], [gz - 0.012, B + 0.026, 0.004]]), 0, 0.024, 0.0015, steel);
  post(w, 'br.f', f.front[2], f.front[1], B + 0.026, steel, true, 0.022);
  w.turnAlong('br.reg', [[0, 0], [0.006, 0], [0.006, 1], [0, 1]], [0.012, B + 0.016, gz + 0.01], [0.02, B + 0.016, gz + 0.01], M.knurl(0x2a2c2e));
  w.tube(0, B + 0.018, 0.2, gz - 0.01, 0.0068, steel);
  w.rbox(0.012, B + 0.018, f.spots!.handle[2], 0.014, 0.008, 0.012, 0.002, steel);
  w.rod([0.016, B + 0.018, f.spots!.handle[2]], [0.034, B + 0.016, f.spots!.handle[2] - 0.004], 0.0028, steel);
  w.sphere(0.036, B + 0.016, f.spots!.handle[2] - 0.004, 0.005, steel, 1, 0.8, 1);
  // The long slotted flash hider.
  w.turn('br.hider', [[0, 0.73], [0.0115, 0.73], [0.0118, 0.735], [0.0118, f.muzzle - 0.002], [0.011, f.muzzle], [0.0074, f.muzzle], [0.0072, f.muzzle - 0.06], [0, f.muzzle - 0.06]], 0, B, steel);
  if (w.hi) for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    w.box(Math.cos(a) * 0.0115, B + Math.sin(a) * 0.0115, f.muzzle - 0.025, 0.0024, 0.0024, 0.04, M.hole(), 0, 0, a);
  }
  // Wooden handguards, upper and lower, with their cooling holes.
  w.side(`br.hgLow`, () => shape([[0.205, B + 0.002], [0.44, B + 0.002], [0.445, B - 0.008, 0.006], [0.43, f.under.y, 0.008], [0.23, f.under.y - 0.004, 0.04], [0.205, B - 0.012, 0.006]]), 0, 0.044, w.hi ? 0.009 : 0.004, wood);
  w.side(`br.hgUp`, () => shape([[0.205, B + 0.006], [0.44, B + 0.006], [0.44, B + 0.022, 0.006], [0.205, B + 0.026, 0.006]]), 0, 0.03, 0.005, wood);
  if (w.hi) for (let i = 0; i < 5; i++) for (const s of [1, -1]) w.turnAlong('br.vent', [[0, 0], [0.0032, 0], [0.0032, 1], [0, 1]], [s * 0.0128, B + 0.018, 0.25 + i * 0.04], [s * 0.0158, B + 0.018, 0.25 + i * 0.04], M.hole());
  // The rear sight: an aperture on its slide, with wings, on the hump.
  for (const s of [1, -1]) w.side(`br.rwing`, () => shape([[f.rear[2] - 0.012, B + 0.026], [f.rear[2] + 0.012, B + 0.026], [f.rear[2] + 0.008, f.rear[1] + 0.003, 0.004], [f.rear[2] - 0.008, f.rear[1] + 0.003, 0.004]]), s * 0.009, 0.003, 0.0008, steel);
  peep(w, f.rear[2], f.rear[1], B + 0.027, steel, 0.0058, 0.0021);
  // The stock: long, straight, wooden, a steel butt plate.
  const sz = f.stock.z;
  if (!replacesStock(looks.stock)) {
    w.side(`br.stock`, () => shape([[-0.052, B + 0.022, 0.004], [sz + 0.012, B + 0.016, 0.01], [sz + 0.012, -0.088, 0.006], [sz + 0.03, -0.094, 0.01], [-0.14, -0.03, 0.06], [-0.065, -0.004, 0.012], [-0.052, pl - 0.006, 0.004]]), 0, 0.042, w.hi ? 0.009 : 0.004, wood);
    w.side(`br.butt`, () => shape([[sz, B + 0.016, 0.004], [sz + 0.012, B + 0.016], [sz + 0.012, -0.092], [sz, -0.092, 0.004]]), 0, 0.04, 0.004, steel);
    swivel(w, 0, -0.07, sz + 0.1, steel, false);
  }
  swivel(w, 0, B - 0.012, gz + 0.02, steel, false);
}

// ---------------------------------------------------------------------------------------------------- sniper

/**
 * A bolt-action precision rifle in an aluminium chassis: a round action on a one-piece rail, the big tactical bolt knob,
 * a heavy fluted barrel with a two-chamber brake, a free-float tube, a folding skeleton stock with a cheek riser and
 * a monopod, a detachable 5-round magazine and a tactical scope (taken off when another optic goes on the rail).
 */
export function sniper(w: WB, optic = true) {
  const f = FRAMES.sniper;
  const B = f.bore;
  const chassis = M.anod(0x5b4d39, 0.3);
  const black = M.anod(0x222325, 0.3);
  const steel = M.park(0x2b2d2b, 0.3);
  // The action, its bolt shroud and the bolt handle with its big knob.
  w.turn('sn.action', [[0, -0.02], [0.0175, -0.02], [0.0185, -0.016], [0.0185, 0.205], [0.0175, 0.21], [0, 0.21]], 0, B, steel);
  w.turn('sn.shroud', [[0, -0.062], [0.006, -0.062], [0.0105, -0.05], [0.0125, -0.03], [0.0125, -0.019], [0, -0.019]], 0, B, black);
  w.box(-0.0182, B + 0.007, f.port[2], 0.0012, 0.013, 0.06, M.hole());
  const k = f.spots!.knob;
  w.turnAlong('sn.handle', [[0, 0], [0.0042, 0], [0.0036, 0.6], [0.0032, 1], [0, 1]], [-0.012, B + 0.003, k[2] + 0.012], [k[0] + 0.006, k[1] + 0.008, k[2] + 0.002], steel);
  w.turnAlong('sn.knob', [[0, 0], [0.006, 0.02], [0.0105, 0.15], [0.0115, 0.45], [0.0108, 0.8], [0.006, 0.97], [0, 1]], [k[0] + 0.006, k[1] + 0.008, k[2] + 0.002], [k[0] - 0.012, k[1] - 0.006, k[2] - 0.001], M.knurl(0x232426, 0.3));
  w.rail('sn', 0, f.top.y - 0.0095, -0.03, 0.215, black);
  // Chassis centre: under the action, the magazine well, the guard.
  const yb = B - 0.018;
  w.side('sn.chassis', () => shape([[-0.075, B + 0.004], [0.23, B + 0.004], [0.23, yb - 0.022, 0.006], [0.155, yb - 0.026, 0.004], [0.155, f.well[1], 0.003], [0.068, f.well[1], 0.003], [0.068, yb - 0.026], [0.012, yb - 0.026], [-0.03, yb - 0.022, 0.01], [-0.075, yb, 0.006]]), 0, 0.044, w.hi ? 0.003 : 0, chassis);
  guard(w, 'sn', 0.014, 0.068, yb - 0.026, 0.024, chassis, 0.012);
  trigger(w, 'sn', 0.048, yb - 0.026, 0.016, steel);
  pistolGrip(w, 'sn', 0.016, -0.022, yb - 0.024, rakeOf(f.grip.a), 0.098, 0.03, M.stipple(0x1d1e20, 0.3), { swell: 0.005 });
  boxMag(w, 'sn', 0.074, 0.15, f.well[1] + 0.005, 0.012, 0, 0.026, black, { plate: black });
  w.rbox(0, f.well[1] - 0.004, 0.064, 0.016, 0.006, 0.01, 0.002, steel);
  // Fore-end tube, the heavy fluted barrel and its brake.
  mlok(w, 'sn', 0.225, 0.55, B, 0.025, chassis, false);
  barrel(w, 'sn', B, [[0.016, 0.205], [0.0155, 0.25], [0.0135, 0.45], [0.012, 0.84]], 0.0035, steel);
  if (w.hi) for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    w.box(Math.cos(a) * 0.0121, B + Math.sin(a) * 0.0121, 0.69, 0.0026, 0.0026, 0.27, M.park(0x1e201e, 0.3), 0, 0, a);
  }
  w.turn('sn.brake', [[0, 0.838], [0.0158, 0.838], [0.0165, 0.842], [0.0165, f.muzzle - 0.002], [0.0156, f.muzzle], [0.0075, f.muzzle], [0.0073, f.muzzle - 0.08], [0, f.muzzle - 0.08]], 0, B, black);
  if (w.hi) for (const z of [0.856, 0.884]) for (const s of [1, -1]) w.box(s * 0.0158, B + 0.002, z, 0.004, 0.019, 0.016, M.hole());
  // Folding skeleton stock: hinge, upper beam with the cheek riser on posts, lower beam, the pad, the monopod.
  const sz = f.stock.z;
  w.rbox(0, B - 0.006, -0.083, 0.032, 0.05, 0.018, 0.004, black);
  w.side('sn.beamU', () => shape([[-0.09, B - 0.002], [sz + 0.03, B - 0.002], [sz + 0.03, B + 0.014, 0.004], [-0.09, B + 0.014, 0.004]]), 0, 0.024, 0.002, chassis);
  w.side('sn.beamL', () => shape([[-0.09, B - 0.032], [-0.1, B - 0.02, 0.004], [sz + 0.03, -0.055, 0.006], [sz + 0.03, -0.074, 0.006], [-0.1, B - 0.04, 0.006]]), 0, 0.022, 0.002, chassis);
  w.side('sn.cheek', () => shape([[-0.115, B + 0.03], [sz + 0.06, B + 0.03], [sz + 0.055, f.rear[1] - 0.036, 0.008], [-0.11, f.rear[1] - 0.038, 0.012]]), 0, 0.034, 0.004, black);
  for (const z of [-0.14, sz + 0.09]) w.tube(0, B + 0.022, z - 0.005, z + 0.005, 0.0035, steel);
  w.side('sn.pad', () => shape([[sz, B + 0.028, 0.006], [sz + 0.032, B + 0.028, 0.004], [sz + 0.032, -0.088, 0.006], [sz, -0.088, 0.006]]), 0, 0.04, 0.004, chassis);
  w.side('sn.rubber', () => shape([[sz - 0.012, B + 0.026, 0.004], [sz + 0.001, B + 0.026], [sz + 0.001, -0.086], [sz - 0.012, -0.086, 0.004]]), 0, 0.042, 0.004, M.rubber(0x151516));
  w.rod([0, -0.06, sz + 0.07], [0, -0.115, sz + 0.07], 0.0042, steel);
  w.turnAlong('sn.mfoot', [[0, 0], [0.009, 0], [0.009, 1], [0, 1]], [0, -0.118, sz + 0.07], [0, -0.126, sz + 0.07], M.rubber(0x151516));
  swivel(w, 0.026, B - 0.01, 0.5, steel, false);
  // The tactical scope: 34 mm tube, target turrets, a 56 mm objective.
  if (optic) {
    rings(w, 'sn', f.top.y, f.rear[1], 0.017, [0.065, 0.2], black);
    scope(w, 'sn', f.rear[1], f.rear[2], f.front[2] + 0.006, 0.017, 0.021, 0.03, M.anod(0x1c1d1f, 0.25), { turrets: 'target' });
  }
}

// ---------------------------------------------------------------------------------------------------- hunting rifle

/**
 * A walnut-stocked bolt-action sporter: a round blued action and its bolt with a round knob, a tapered sporter barrel, a
 * Monte Carlo stock with chequered wrist and fore-end, an ebony fore-end tip, a hinged floor plate and a worn 3-9x scope on
 * two rings (taken off when a better optic goes on).
 */
export function rifle(w: WB, optic = true) {
  const f = FRAMES.rifle;
  const B = f.bore;
  const blued = M.blued(0x1c1f26, 0.5);
  const wood = M.wood(0x5e3a20, 0.4);
  const chq = M.checker(0x523018, 0.4);
  w.turn('hr.action', [[0, -0.005], [0.016, -0.005], [0.0173, -0.001], [0.0173, 0.21], [0.0165, 0.215], [0, 0.215]], 0, B, blued);
  w.turn('hr.shroud', [[0, -0.042], [0.005, -0.042], [0.0095, -0.032], [0.0112, -0.015], [0.0112, -0.004], [0, -0.004]], 0, B, blued);
  w.box(-0.0168, B + 0.006, f.port[2], 0.0012, 0.012, 0.058, M.hole());
  const k = f.spots!.knob;
  w.turnAlong('hr.handle', [[0, 0], [0.0042, 0], [0.0034, 0.6], [0.003, 1], [0, 1]], [-0.012, B + 0.002, k[2] + 0.014], [k[0] + 0.006, k[1] + 0.004, k[2] + 0.002], blued);
  w.sphere(k[0], k[1], k[2], 0.0085, blued);
  // The safety on the right of the tang, the bolt release in front of the guard.
  w.rbox(-0.0125, B - 0.01, -0.002, 0.004, 0.006, 0.012, 0.0012, blued);
  // Barrel.
  barrel(w, 'hr', B, [[0.0148, 0.205], [0.0142, 0.235], [0.0125, 0.3], [0.0085, f.muzzle]], 0.0034, blued);
  // The stock: one piece of walnut, the action let into it, a pistol grip, the Monte Carlo comb and cheek.
  const pts: P2[] = [
    [0.47, B - 0.002, 0.004],
    [0.21, B - 0.002],
    [0.205, B + 0.0],
    [-0.025, B + 0.0],
    [-0.04, B - 0.006, 0.008],
    [-0.06, B - 0.01, 0.02],
    [-0.09, B + 0.001, 0.02],
    [-0.12, B + 0.005, 0.03],
    [-0.22, B + 0.004, 0.02],
    [f.stock.z + 0.012, B - 0.012, 0.006],
    [f.stock.z + 0.01, -0.103, 0.006],
    [-0.15, -0.068, 0.12],
    [-0.05, -0.052, 0.012],
    [-0.04, -0.082, 0.004],
    [-0.008, -0.08, 0.006],
    [0.006, -0.05, 0.02],
    [0.022, -0.026, 0.008],
    [0.17, -0.024, 0.01],
    [0.25, -0.014, 0.08],
    [0.45, -0.006, 0.02],
  ];
  w.side('hr.stock', () => shape(pts), 0, 0.04, w.hi ? 0.009 : 0.004, wood);
  // The ebony fore-end tip, the white-lined recoil pad, the grip cap.
  w.side('hr.tip', () => shape([[0.45, B - 0.003], [0.475, B - 0.003], [0.476, -0.004, 0.004], [0.45, -0.005]]), 0, 0.034, 0.004, M.wood(0x16110e, 0.2));
  w.side('hr.pad', () => shape([[f.stock.z - 0.005, B - 0.011, 0.004], [f.stock.z + 0.012, B - 0.012], [f.stock.z + 0.011, -0.104], [f.stock.z - 0.006, -0.104, 0.004]]), 0, 0.04, 0.004, M.rubber(0x1e1a18, 0.3));
  if (w.hi) w.side('hr.line', () => shape([[f.stock.z + 0.011, B - 0.012], [f.stock.z + 0.0135, B - 0.012], [f.stock.z + 0.0125, -0.104], [f.stock.z + 0.01, -0.104]]), 0, 0.041, 0, M.dot(0xe0dccf));
  w.side('hr.cap', () => shape([[-0.041, -0.079], [-0.009, -0.077], [-0.008, -0.083, 0.002], [-0.041, -0.085, 0.002]]), 0, 0.03, 0.002, M.wood(0x16110e, 0.2));
  // Chequering on both sides of the wrist and the fore-end.
  for (const s of [1, -1]) {
    w.side(`hr.chqW${s}`, () => shape([[0.012, -0.03, 0.004], [-0.018, -0.022, 0.006], [-0.034, -0.05, 0.006], [-0.006, -0.068, 0.006]]), s * 0.0202, 0.0012, 0, chq);
    w.side(`hr.chqF${s}`, () => shape([[0.27, -0.008, 0.006], [0.41, -0.002, 0.006], [0.41, B - 0.016, 0.004], [0.27, B - 0.018, 0.004]]), s * 0.0202, 0.0012, 0, chq);
  }
  // A cheek piece on the left, the floor plate and the guard bow.
  w.side('hr.cheek', () => shape([[-0.11, B - 0.003, 0.01], [-0.23, B - 0.003, 0.01], [-0.23, -0.04, 0.02], [-0.1, -0.03, 0.03]]), 0.0205, 0.004, 0.002, wood);
  w.rbox(0, -0.0255, 0.125, 0.02, 0.004, 0.09, 0.0015, blued);
  guard(w, 'hr', 0.022, 0.085, -0.024, 0.024, blued, 0.0095);
  trigger(w, 'hr', 0.052, -0.024, 0.017, blued);
  w.screw(0, -0.0275, 0.17, '-y', 0.0025, blued);
  w.screw(0, -0.0275, 0.085, '-y', 0.0025, blued);
  swivel(w, 0, -0.008, 0.4, blued, false);
  swivel(w, 0, -0.088, -0.22, blued, false);
  // The worn scope on its bases and rings.
  if (optic) {
    w.rbox(0, B + 0.0185, 0.035, 0.012, 0.004, 0.022, 0.0012, blued);
    w.rbox(0, B + 0.0185, 0.165, 0.012, 0.004, 0.022, 0.0012, blued);
    rings(w, 'hr', B + 0.02, f.rear[1], 0.0127, [0.035, 0.165], blued);
    scope(w, 'hr', f.rear[1], f.rear[2], f.front[2], 0.0127, 0.019, 0.0235, M.blued(0x181a1e, 0.55), { turrets: 'capped' });
  }
}

// ---------------------------------------------------------------------------------------------------- scrap carbine

/**
 * A hunting action rebuilt round a banana magazine: a cut-down beech stock wrapped in tape, a magazine well welded under
 * the action for a steel 30-round magazine, the bolt handle cut and welded straight out to the right, a short barrel in
 * a length of tape- and wire-wrapped water pipe, a drilled-pipe muzzle brake, and sights welded on where they would fit.
 */
export function carbine(w: WB, looks: Looks = {}) {
  const f = FRAMES.carbine;
  const B = f.bore;
  const blued = M.blued(0x22252a, 0.85);
  const raw = M.steel(0x5a5650, 0.9);
  const wood = M.wood(0x7a4a2a, 0.7);
  const tape = M.tape(0x2a2b2d, 0.6);
  const weld = (x: number, y: number, z: number, len: number, axis: 'y' | 'z' | 'x') => {
    if (!w.hi) return;
    const n = Math.max(3, Math.round(len / 0.0035));
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1) - 0.5;
      w.sphere(x + (axis === 'x' ? t * len : 0), y + (axis === 'y' ? t * len : 0), z + (axis === 'z' ? t * len : 0), 0.0019, raw);
    }
  };
  w.turn('cb.action', [[0, -0.005], [0.016, -0.005], [0.0172, -0.001], [0.0172, 0.205], [0.0165, 0.21], [0, 0.21]], 0, B, blued);
  w.turn('cb.shroud', [[0, -0.04], [0.006, -0.04], [0.0105, -0.03], [0.0112, -0.004], [0, -0.004]], 0, B, blued);
  w.box(-0.0168, B + 0.006, f.port[2], 0.0012, 0.012, 0.05, M.hole());
  // The charging handle: a bar welded straight out of the bolt to the right, a nut for a knob.
  const h = f.spots!.handle;
  w.box(-0.0172, B, (h[2] + f.spots!.handleBack[2]) / 2, 0.0012, 0.004, h[2] - f.spots!.handleBack[2] + 0.01, M.hole());
  w.rod([-0.012, B, h[2]], [h[0] + 0.006, h[1], h[2]], 0.0032, raw);
  w.turnAlong('cb.nut', [[0, 0], [0.0062, 0], [0.0062, 1], [0, 1]], [h[0] + 0.006, h[1], h[2]], [h[0] - 0.006, h[1], h[2]], raw, 6);
  weld(-0.0145, B, h[2], 0.008, 'y');
  // The magazine well: a box of plate welded under the action, and the steel 30-round magazine in it.
  const wz0 = f.well[2] - 0.024;
  const wz1 = f.well[2] + 0.024;
  w.side('cb.well', () => shape([[wz0 - 0.004, B - 0.012], [wz1 + 0.004, B - 0.012], [wz1 + 0.004, f.well[1]], [wz0 - 0.004, f.well[1]]]), 0, 0.03, 0, raw);
  weld(0.0152, B - 0.013, f.well[2], 0.05, 'z');
  weld(-0.0152, B - 0.013, f.well[2], 0.05, 'z');
  boxMag(w, 'cb', wz0 + 0.001, wz1 - 0.001, f.well[1] + 0.004, f.well[1] - f.mag.y - 0.008, 0.07, 0.027, M.park(0x2c2a26, 0.8), { ribs: 1, flare: 0.006 });
  // The cut-down stock: the wrist and butt of a sporter, its fore-end sawn off under the action; tape round the wrist.
  const wrist: P2[] = [
    [0.08, B - 0.002],
    [-0.025, B - 0.002],
    [-0.04, B - 0.008, 0.008],
    [-0.07, B - 0.012],
    [-0.07, -0.05],
    [-0.05, -0.052, 0.012],
    [-0.04, -0.082, 0.004],
    [-0.008, -0.08, 0.006],
    [0.006, -0.05, 0.02],
    [0.022, -0.026, 0.008],
    [0.07, -0.024],
    [0.08, -0.012],
  ];
  w.side('cb.wrist', () => shape(wrist), 0, 0.038, w.hi ? 0.008 : 0.004, wood);
  w.side('cb.tapeW', () => shape([[-0.03, B + 0.001], [-0.006, B + 0.001], [-0.006, -0.07], [-0.03, -0.072]]), 0, 0.041, 0.004, tape);
  if (!replacesStock(looks.stock)) {
    const butt: P2[] = [[-0.066, B - 0.012], [-0.11, B - 0.002, 0.03], [-0.21, B - 0.002, 0.02], [f.stock.z + 0.012, B - 0.014, 0.006], [f.stock.z + 0.01, -0.1, 0.006], [-0.15, -0.066, 0.12], [-0.066, -0.05]];
    w.side('cb.butt', () => shape(butt), 0, 0.038, w.hi ? 0.008 : 0.004, wood);
    w.side('cb.tapeB', () => shape([[-0.22, B + 0.001], [-0.2, B + 0.001], [-0.2, -0.07], [-0.22, -0.072]]), 0, 0.041, 0.004, tape);
    w.side('cb.pad', () => shape([[f.stock.z - 0.006, B - 0.012, 0.004], [f.stock.z + 0.012, B - 0.014], [f.stock.z + 0.011, -0.1], [f.stock.z - 0.007, -0.1, 0.004]]), 0, 0.04, 0.004, M.rubber(0x1a1817, 0.6));
  }
  guard(w, 'cb', 0.02, 0.075, -0.024, 0.022, raw, 0.008);
  trigger(w, 'cb', 0.05, -0.024, 0.016, blued);
  // Barrel in its pipe: two wraps of tape, wire twisted round, a hose clamp; the drilled pipe brake.
  barrel(w, 'cb', B, [[0.0145, 0.205], [0.0125, 0.24], [0.0095, 0.6]], 0.0034, blued);
  w.turn('cb.pipe', [[0.017, 0.215], [0.0205, 0.215], [0.021, 0.218], [0.021, 0.437], [0.0205, 0.44], [0.017, 0.44]], 0, B, M.steel(0x7a7670, 0.85));
  for (const z of [0.25, 0.39]) w.turn(`cb.wrap`, [[0.0212, 0], [0.0222, 0.002], [0.0222, 0.034], [0.0212, 0.036]], 0, B, tape, undefined, 0.7, z);
  if (w.hi) for (let i = 0; i < 7; i++) w.torus(0, B, 0.315 + i * 0.006, 0.0215, 0.0009, M.steel(0x8a6a4a, 0.9));
  w.turn('cb.clamp', [[0.0214, 0], [0.023, 0.001], [0.023, 0.008], [0.0214, 0.009]], 0, B, M.bright(0x9a9c9e), undefined, 0.7, 0.225);
  if (w.hi) w.rbox(-0.022, B + 0.008, 0.229, 0.006, 0.008, 0.008, 0.001, M.bright(0x9a9c9e));
  w.turn('cb.brake', [[0, 0.598], [0.0135, 0.598], [0.0135, f.muzzle], [0.0085, f.muzzle], [0.0085, f.muzzle - 0.04], [0, f.muzzle - 0.04]], 0, B, raw);
  if (w.hi) for (let i = 0; i < 3; i++) for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) w.turnAlong('cb.hole', [[0, 0], [0.0028, 0], [0.0028, 1], [0, 1]], [Math.cos(a) * 0.012, B + Math.sin(a) * 0.012, 0.61 + i * 0.011], [Math.cos(a) * 0.0138, B + Math.sin(a) * 0.0138, 0.61 + i * 0.011], M.hole(), 8);
  // Sights: a notched bar welded at the back of the action, a post on a collar at the front.
  w.rbox(0, (B + 0.017 + f.rear[1] + 0.004) / 2, f.rear[2], 0.006, f.rear[1] - B - 0.013, 0.004, 0.0008, raw);
  w.sec('cb.rear', () => shape([[-0.009, f.rear[1] - 0.005], [0.009, f.rear[1] - 0.005], [0.009, f.rear[1] + 0.004], [0.0018, f.rear[1] + 0.004], [0.0018, f.rear[1]], [-0.0018, f.rear[1]], [-0.0018, f.rear[1] + 0.004], [-0.009, f.rear[1] + 0.004]]), f.rear[2] - 0.002, f.rear[2] + 0.002, 0, raw);
  weld(0, B + 0.017, f.rear[2], 0.01, 'x');
  w.turn('cb.collar', [[0.0098, 0], [0.013, 0], [0.013, 0.012], [0.0098, 0.012]], 0, B, raw, undefined, 0.7, f.front[2] - 0.006);
  w.rbox(0, (B + 0.012 + f.front[1]) / 2, f.front[2], 0.003, f.front[1] - B - 0.012, 0.004, 0.0006, raw);
  w.rbox(0, B + 0.017, f.front[2], 0.01, 0.012, 0.01, 0.002, raw);
  if (!replacesStock(looks.stock)) swivel(w, 0, -0.085, -0.2, raw, false);
}

// ---------------------------------------------------------------------------------------------------- lever action

/**
 * A brass-framed lever gun gone dark with age: the flat-sided receiver with its loading gate on the right, the exposed
 * hammer, the lever's loop behind the trigger, an octagonal barrel over the magazine tube with a brass nose cap, a
 * straight-wristed walnut stock with a crescent brass butt plate, a buckhorn rear sight and a brass-beaded blade.
 */
export function lever(w: WB) {
  const f = FRAMES.lever;
  const B = f.bore;
  const brass = M.brass(0x8a6a34, 0.55);
  const blued = M.blued(0x1c1e22, 0.55);
  const wood = M.wood(0x62381c, 0.45);
  const yb = -0.017;
  // The receiver, its upper tang running back over the wrist, the loading gate.
  w.side('lv.recv', () => shape([[-0.03, B + 0.006, 0.006], [-0.012, B + 0.015, 0.006], [0.15, B + 0.015, 0.004], [0.156, B + 0.008], [0.156, yb + 0.004, 0.003], [0.145, yb, 0.003], [0.03, yb], [-0.022, yb + 0.006, 0.01], [-0.032, B - 0.012, 0.008]]), 0, 0.029, 0.0018, brass);
  w.side('lv.tang', () => shape([[-0.03, B + 0.01], [-0.085, B + 0.002, 0.004], [-0.083, B - 0.003, 0.003], [-0.03, B + 0.002]]), 0, 0.012, 0.0008, brass);
  w.side('lv.gate', () => shape([[0.065, yb + 0.006, 0.003], [0.115, yb + 0.006, 0.003], [0.115, B - 0.012, 0.003], [0.065, B - 0.012, 0.003]]), -0.0148, 0.0014, 0, M.blued(0x22242a, 0.4));
  w.screw(-0.0156, B - 0.001, 0.12, '-x', 0.002, blued);
  w.screw(-0.0156, yb + 0.012, 0.012, '-x', 0.002, blued);
  w.screw(0.0156, yb + 0.012, 0.012, 'x', 0.002, blued);
  // Hammer, its spur knurled.
  w.side('lv.hammer', () => shape([[-0.016, B - 0.012], [-0.008, B - 0.008], [-0.012, B + 0.014, 0.004], [-0.022, B + 0.028, 0.004], [-0.032, B + 0.03, 0.003], [-0.033, B + 0.024, 0.003], [-0.024, B + 0.01, 0.005], [-0.024, B - 0.01]]), 0, 0.007, 0.0012, blued);
  if (w.hi) w.side('lv.spur', () => shape([[-0.022, B + 0.0285], [-0.032, B + 0.0305], [-0.033, B + 0.027], [-0.024, B + 0.025]]), 0, 0.0074, 0, M.knurl(0x16181c));
  // The lever: along the receiver's bottom, the trigger's opening, then the loop the fingers go through.
  const L = f.spots!.loop;
  w.side(
    'lv.lever',
    () =>
      shape(
        [[0.13, yb + 0.002], [0.13, yb - 0.005, 0.004], [0.05, yb - 0.007], [0.046, yb - 0.024, 0.008], [0.03, L[1] - 0.02, 0.012], [-0.012, L[1] - 0.024, 0.014], [L[2] - 0.05, L[1] - 0.006, 0.014], [L[2] - 0.05, L[1] + 0.012, 0.01], [-0.026, yb - 0.008, 0.008], [-0.005, yb + 0.001]],
        [
          [[0.04, yb - 0.006], [0.044, yb - 0.022, 0.006], [0.028, yb - 0.026, 0.004], [0.018, yb - 0.008]],
          [[0.024, L[1] - 0.008, 0.006], [L[2] - 0.042, L[1] - 0.002, 0.012], [L[2] - 0.042, L[1] + 0.008, 0.006], [-0.016, yb - 0.012, 0.004], [0.012, yb - 0.012, 0.004], [0.026, L[1] + 0.01, 0.006]],
        ],
      ),
    0,
    0.0078,
    0.0014,
    blued,
  );
  trigger(w, 'lv', 0.03, yb, 0.016, blued, 0.006);
  // The barrel's octagon, the crown cut in its face, the magazine tube under it with its cap, the brass nose cap.
  const oc = (): ReturnType<typeof shape> => {
    const r = 0.0118;
    const pts: P2[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      pts.push([Math.cos(a) * r, Math.sin(a) * r, 0.0006]);
    }
    return shape(pts);
  };
  w.sec('lv.barrel', oc, 0.154, f.muzzle, 0.0008, blued, 0, B);
  w.turn('lv.crown', [[0, 0], [0.0056, 0], [0.0052, -0.0008], [0.0052, -0.016], [0, -0.016]], 0, B, M.hole(), w.hi ? 12 : 6, 0.7, f.muzzle + 0.0002);
  w.tube(0, f.mag.y, 0.154, f.mag.z, 0.0088, blued);
  w.turn('lv.tcap', [[0, f.mag.z - 0.002], [0.0094, f.mag.z - 0.002], [0.0094, f.mag.z + 0.008], [0.006, f.mag.z + 0.01], [0, f.mag.z + 0.01]], 0, f.mag.y, blued);
  w.side('lv.nose', () => shape([[0.415, f.mag.y - 0.01, 0.003], [0.428, f.mag.y - 0.01, 0.003], [0.428, B + 0.006, 0.005], [0.415, B + 0.008, 0.005]]), 0, 0.03, 0.0016, brass);
  // Fore-end and stock in walnut; the crescent butt plate in brass.
  w.side('lv.fore', () => shape([[0.156, f.mag.y - 0.012], [0.415, f.mag.y - 0.01, 0.004], [0.415, B + 0.004], [0.156, B + 0.006]]), 0, 0.032, w.hi ? 0.006 : 0.004, wood);
  const sz = f.stock.z;
  w.side('lv.stock', () => shape([[-0.031, B + 0.004, 0.004], [-0.09, B - 0.002, 0.03], [sz + 0.012, B - 0.014, 0.006], [sz + 0.008, -0.1, 0.006], [-0.17, -0.05, 0.12], [-0.065, -0.012, 0.02], [-0.03, yb + 0.002, 0.006]]), 0, 0.036, w.hi ? 0.008 : 0.004, wood);
  w.side('lv.butt', () => shape([[sz + 0.012, B - 0.012, 0.003], [sz - 0.004, B - 0.016, 0.006], [sz + 0.008, -0.04, 0.02], [sz - 0.006, -0.098, 0.006], [sz + 0.01, -0.102, 0.003], [sz + 0.02, -0.04, 0.02], [sz + 0.016, B - 0.01, 0.004]]), 0, 0.038, 0.002, brass);
  // Sights: a buckhorn on the barrel, a blade with a brass bead at the muzzle.
  const ry = f.rear[1];
  w.sec('lv.buck', () => shape([[-0.012, B + 0.011], [0.012, B + 0.011], [0.012, ry + 0.007, 0.004], [0.009, ry + 0.008, 0.002], [0.003, ry + 0.003, 0.002], [0.0009, ry, 0.0006], [-0.0009, ry, 0.0006], [-0.003, ry + 0.003, 0.002], [-0.009, ry + 0.008, 0.002], [-0.012, ry + 0.007, 0.004]]), f.rear[2] - 0.002, f.rear[2] + 0.002, 0, blued);
  w.side('lv.blade', () => shape([[f.front[2] - 0.016, B + 0.011], [f.front[2] + 0.004, B + 0.011], [f.front[2] + 0.004, f.front[1] - 0.001, 0.0008], [f.front[2] - 0.006, f.front[1] - 0.001, 0.002]]), 0, 0.0028, 0, blued);
  w.sphere(0, f.front[1] - 0.0007, f.front[2], 0.0011, M.brass(0xc8a050, 0.2));
  swivel(w, 0, -0.08, sz + 0.06, blued, false);
}

// ---------------------------------------------------------------------------------------------------- light machine gun

/**
 * A belt-fed light machine gun of the M249 pattern: the stamped receiver with its feed cover and rail, the belt coming up
 * out of a hard ammunition box under the left side into the feed tray, the charging handle on the right, a ribbed
 * handguard over the gas tube, a heat shield and carrying handle on the barrel, the folded bipod, a tall front sight and
 * a birdcage, and a fixed polymer stock.
 */
export function lmg(w: WB, looks: Looks = {}) {
  const f = FRAMES.lmg;
  const B = f.bore;
  const steel = M.park(0x2d2f2c, 0.45);
  const poly = M.poly(0x1d1e20, 0.35);
  const od = M.poly(0x47503a, 0.45);
  const top = 0.058;
  // Receiver: a long box; rivet heads down its sides.
  w.side('lm.recv', () => shape([[-0.105, -0.004], [0.225, -0.004], [0.225, top, 0.004], [-0.105, top, 0.004]]), 0, 0.05, 0.0015, steel);
  if (w.hi) for (const z of [-0.08, -0.04, 0.0, 0.18, 0.205]) for (const y of [0.006, 0.046]) for (const s of [1, -1]) w.sphere(s * 0.0252, y, z, 0.0018, steel, 0.5, 1, 1);
  // The feed cover, its latch at the back, the rail on it.
  w.side('lm.cover', () => shape([[-0.035, top - 0.001], [0.17, top - 0.001], [0.175, top + 0.006, 0.004], [0.16, f.top.y - 0.0095], [-0.03, f.top.y - 0.0095], [-0.035, top + 0.008, 0.003]]), 0, 0.052, 0.0012, steel);
  w.rbox(0, top + 0.004, -0.038, 0.03, 0.01, 0.008, 0.002, steel);
  w.rail('lm', 0, f.top.y - 0.0095, -0.025, 0.155, steel);
  // Feed tray opening on the left, the belt running up into it out of the box.
  w.box(0.0253, 0.04, 0.115, 0.0008, 0.014, 0.05, M.hole());
  const box = { x0: 0.004, x1: 0.064, y0: -0.13, y1: -0.008, z0: 0.065, z1: 0.165 };
  w.rbox((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2, box.x1 - box.x0, box.y1 - box.y0, box.z1 - box.z0, 0.006, od);
  if (w.hi) {
    for (let i = 0; i < 3; i++) w.box(box.x1 + 0.0004, (box.y0 + box.y1) / 2, box.z0 + 0.025 + i * 0.025, 0.0016, box.y1 - box.y0 - 0.02, 0.006, od);
    w.rbox(box.x1 + 0.002, box.y1 - 0.012, (box.z0 + box.z1) / 2, 0.004, 0.012, 0.03, 0.0015, M.poly(0x2a2c26));
  }
  const brass = M.brass(0xb08a46, 0.3);
  const belt: [number, number][] = [[0.05, -0.006], [0.046, 0.006], [0.04, 0.017], [0.034, 0.027], [0.029, 0.036]];
  for (const [x, y] of w.hi ? belt : belt.slice(0, 3)) {
    w.turn('lm.round', [[0, -0.03], [0.0048, -0.03], [0.0048, 0.006], [0.0038, 0.012], [0.0029, 0.014], [0.0029, 0.026], [0, 0.034]], x, y, brass, w.hi ? 10 : 6, 0.7, f.well[2]);
    if (w.hi) w.box(x, y + 0.0045, f.well[2] - 0.012, 0.007, 0.0012, 0.022, M.steel(0x3a3c3e, 0.5));
  }
  // Ejection port underneath on the right; the charging handle folding out of the right side.
  w.box(-0.018, -0.0045, f.port[2], 0.012, 0.0008, 0.05, M.hole());
  const hz = f.spots!.handle[2];
  w.box(-0.0255, 0.022, (hz + f.spots!.handleBack[2]) / 2, 0.0008, 0.006, hz - f.spots!.handleBack[2] + 0.012, M.hole());
  w.rbox(-0.036, 0.022, hz, 0.022, 0.009, 0.012, 0.002, steel);
  // Trigger group: a polymer lower with guard and grip.
  w.side('lm.lower', () => shape([[-0.1, -0.004], [0.07, -0.004], [0.068, -0.014, 0.004], [-0.04, -0.016, 0.006], [-0.1, -0.012, 0.004]]), 0, 0.04, 0.002, poly);
  guard(w, 'lm', 0.012, 0.066, -0.014, 0.03, poly, 0.012);
  trigger(w, 'lm', 0.046, -0.014, 0.018, steel);
  pistolGrip(w, 'lm', 0.012, -0.026, -0.012, rakeOf(f.grip.a), 0.1, 0.03, M.stipple(0x1c1d1f, 0.3), { swell: 0.004, groove: true });
  // The fixed stock: a hollow-cored polymer butt in line with the bore.
  const sz = f.stock.z;
  const own = !replacesStock(looks.stock);
  if (own) w.side('lm.stock', () => shape([[-0.105, top - 0.002, 0.004], [sz + 0.01, top - 0.008, 0.008], [sz + 0.012, -0.088, 0.008], [-0.24, -0.06, 0.03], [-0.105, -0.01, 0.006]], w.hi ? [[[-0.14, top - 0.022, 0.01], [sz + 0.05, top - 0.026, 0.01], [sz + 0.05, -0.06, 0.012], [-0.24, -0.04, 0.02], [-0.14, -0.006, 0.01]]] : []), 0, 0.042, 0.003, poly);
  if (own) w.side('lm.pad', () => shape([[sz, top - 0.006, 0.004], [sz + 0.012, top - 0.006], [sz + 0.012, -0.09], [sz, -0.09, 0.004]]), 0, 0.044, 0.003, M.rubber(0x151516));
  // Handguard under the front of the receiver, ribbed, over the gas tube.
  w.side('lm.hg', () => shape([[0.17, -0.004], [0.33, 0.0, 0.006], [0.33, -0.03, 0.01], [0.17, -0.034, 0.006]]), 0, 0.05, 0.004, poly);
  if (w.hi) for (let i = 0; i < 6; i++) w.box(0, -0.0345 + i * 0.0002, 0.19 + i * 0.024, 0.044, 0.002, 0.008, poly);
  // Barrel, heat shield, carrying handle, gas block with the tall front sight, the folded bipod, the birdcage.
  barrel(w, 'lm', B, [[0.0135, 0.22], [0.0118, 0.25], [0.0112, 0.68]], 0.0028, steel);
  w.tube(0, B - 0.023, 0.225, 0.5, 0.0055, steel);
  w.turn('lm.shield', [[0.0142, 0.23], [0.0162, 0.232], [0.0162, 0.44], [0.0142, 0.442]], 0, B, M.park(0x343632, 0.5), w.hi ? 20 : 8);
  w.rbox(0, B + 0.016, 0.33, 0.016, 0.012, 0.03, 0.003, steel);
  w.wire([[0.006, B + 0.022, 0.29], [0.006, B + 0.04, 0.3], [0.006, B + 0.042, 0.37], [0.006, B + 0.022, 0.38]], 0.0032, poly);
  w.side('lm.gas', () => shape([[0.49, B - 0.032], [0.545, B - 0.032], [0.545, B + 0.014, 0.004], [0.49, B + 0.014, 0.004]]), 0, 0.03, 0.002, steel);
  post(w, 'lm.f', f.front[2], f.front[1], B + 0.014, steel, true, 0.024);
  w.side('lm.fpost', () => shape([[f.front[2] - 0.006, B + 0.012], [f.front[2] + 0.006, B + 0.012], [f.front[2] + 0.004, f.front[1] - 0.012], [f.front[2] - 0.004, f.front[1] - 0.012]]), 0, 0.008, 0.001, steel);
  for (const s of [1, -1]) {
    w.rod([s * 0.008, B - 0.034, 0.5], [s * 0.014, B - 0.04, 0.35], 0.0042, steel);
    w.rod([s * 0.014, B - 0.04, 0.35], [s * 0.016, B - 0.042, 0.33], 0.0055, M.rubber(0x1a1a1a));
  }
  w.rbox(0, B - 0.034, 0.505, 0.03, 0.012, 0.016, 0.003, steel);
  w.turn('lm.cage', [[0, 0.678], [0.0118, 0.678], [0.0122, 0.682], [0.0122, f.muzzle - 0.002], [0.0114, f.muzzle], [0.0068, f.muzzle], [0.0066, f.muzzle - 0.04], [0, f.muzzle - 0.04]], 0, B, steel);
  if (w.hi) for (let i = 0; i < 5; i++) {
    const a = Math.PI / 2 + (i - 2) * 1.0;
    w.box(Math.cos(a) * 0.012, B + Math.sin(a) * 0.012, f.muzzle - 0.022, 0.0026, 0.0026, 0.026, M.hole(), 0, 0, a);
  }
  // Rear sight: a peep with wings on the cover's back.
  for (const s of [1, -1]) w.side('lm.rw', () => shape([[f.rear[2] - 0.012, f.top.y], [f.rear[2] + 0.012, f.top.y], [f.rear[2] + 0.008, f.rear[1] + 0.003, 0.004], [f.rear[2] - 0.008, f.rear[1] + 0.003, 0.004]]), s * 0.011, 0.003, 0.0008, steel);
  peep(w, f.rear[2], f.rear[1], f.top.y, steel, 0.006, 0.0022);
  if (own) swivel(w, 0, -0.06, sz + 0.06, steel, false);
}

// ---------------------------------------------------------------------------------------------------- crossbow

/**
 * A recurve crossbow: an alloy barrel with its flight groove, the trigger housing with the latch the string is cocked
 * into and a short rail, recurve limbs off the riser, the string back to the latch, a bolt with vanes and a broadhead in
 * the groove, a finger-guarded fore-grip, a pistol grip and a skeleton stock, the foot stirrup, and a peep and post.
 */
export function crossbow(w: WB) {
  const f = FRAMES.crossbow;
  const B = f.bore;
  const alloy = M.anod(0x2a2b2d, 0.35);
  const poly = M.poly(0x252628, 0.35);
  const limb = M.poly(0x1a1b1c, 0.3);
  const latch = f.spots!.latch;
  // Barrel: a channel with a groove down its top, from the housing to the riser.
  w.sec('xb.barrel', () => shape([[-0.015, B - 0.024], [0.015, B - 0.024], [0.015, B - 0.004, 0.002], [0.004, B - 0.004], [0.0015, B - 0.0075, 0.0008], [-0.0015, B - 0.0075, 0.0008], [-0.004, B - 0.004], [-0.015, B - 0.004, 0.002]]), 0.12, 0.5, 0.0012, alloy);
  // Trigger housing with the latch, and a rail on top.
  w.side('xb.house', () => shape([[-0.035, B - 0.03, 0.006], [0.15, B - 0.03], [0.15, B - 0.004], [0.13, f.top.y - 0.0095, 0.004], [0.0, f.top.y - 0.0095, 0.004], [-0.03, B + 0.004, 0.01]]), 0, 0.04, 0.003, poly);
  w.rail('xb', 0, f.top.y - 0.0095, 0.005, 0.12, alloy);
  w.rbox(0, latch[1] - 0.002, latch[2] - 0.02, 0.012, 0.008, 0.012, 0.002, M.steel(0x5a5e62, 0.3));
  // Riser and limbs: the pockets either side, each limb sweeping out and back and flicking forward at the tip.
  const rz = 0.5;
  w.rbox(0, B - 0.012, rz, 0.11, 0.03, 0.04, 0.006, alloy);
  const L: [number, number][] = [[0.05, 0.505], [0.12, 0.49], [0.2, 0.465], [0.27, 0.44], [0.315, 0.425], [0.34, 0.43], [0.352, 0.44]];
  const tips: [number, number, number][] = [];
  for (const s of [1, -1]) {
    for (let i = 0; i < L.length - 1; i++) {
      const [x0, z0] = L[i];
      const [x1, z1] = L[i + 1];
      const t = i / (L.length - 2);
      const len = Math.hypot(x1 - x0, z1 - z0);
      const ang = Math.atan2(z1 - z0, x1 - x0);
      w.rbox((s * (x0 + x1)) / 2, B - 0.012, (z0 + z1) / 2, len + 0.004, 0.044 - 0.018 * t, 0.009, 0.003, limb, 0, s > 0 ? -ang : ang - Math.PI, 0);
    }
    tips.push([s * L[L.length - 2][0], B - 0.012, L[L.length - 2][1]]);
  }
  // The string, cocked into the latch; the serving at its middle.
  for (const t of tips) w.rod(t, [0, latch[1] - 0.004, latch[2] - 0.02], 0.0012, M.cord(0x2a2622, 0.4));
  // The bolt: carbon shaft, three vanes, a three-bladed broadhead.
  const nz = latch[2] - 0.02;
  w.tube(0, B, nz, f.muzzle - 0.03, 0.0044, M.poly(0x161718, 0.3), 0.0004, w.hi ? 12 : 6);
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i / 3) * Math.PI * 2;
    w.box(Math.cos(a) * 0.009, B + Math.sin(a) * 0.009, nz + 0.04, 0.0008, 0.01, 0.06, i === 0 ? M.poly(0xc8402a, 0.3) : M.poly(0xd8d4c8, 0.3), 0, 0, a - Math.PI / 2);
  }
  w.turn('xb.ferrule', [[0, f.muzzle - 0.034], [0.0048, f.muzzle - 0.034], [0.0048, f.muzzle - 0.022], [0, f.muzzle - 0.018]], 0, B, M.bright(0x9aa0a4));
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i / 3) * Math.PI * 2;
    w.raw(M.bright(0xb4b8bc, 0.2), (b) => {
      const bx = Math.cos(a) * 0.006;
      const by = Math.sin(a) * 0.006;
      b.box(bx, B + by, f.muzzle - 0.013, Math.abs(Math.cos(a)) * 0.011 + 0.0006, Math.abs(Math.sin(a)) * 0.011 + 0.0006, 0.026, M.bright(0xb4b8bc, 0.2));
    });
  }
  // Fore-grip with finger guards, the pistol grip and guard, a skeleton stock with a cheek piece.
  w.side('xb.fore', () => shape([[0.19, B - 0.024], [0.4, B - 0.024], [0.395, B - 0.044, 0.008], [0.2, B - 0.05, 0.012]]), 0, 0.036, 0.004, poly);
  for (const z of [0.185, 0.405]) w.rbox(0, B - 0.03, z, 0.06, 0.014, 0.006, 0.002, poly);
  guard(w, 'xb', 0.012, 0.072, B - 0.03, 0.026, poly, 0.011);
  trigger(w, 'xb', 0.048, B - 0.03, 0.017, M.steel(0x4a4e52, 0.3));
  pistolGrip(w, 'xb', 0.012, -0.026, B - 0.028, rakeOf(f.grip.a), 0.1, 0.029, M.stipple(0x1d1e20, 0.3), { swell: 0.004 });
  const sz = f.stock.z;
  w.side('xb.stock', () => shape([[-0.035, B + 0.004, 0.006], [sz + 0.012, B + 0.006, 0.008], [sz + 0.012, -0.085, 0.006], [-0.23, -0.06, 0.03], [-0.05, B - 0.03, 0.01]], w.hi ? [[[-0.08, B - 0.012, 0.008], [sz + 0.05, B - 0.01, 0.008], [sz + 0.05, -0.06, 0.008], [-0.21, -0.045, 0.02]]] : []), 0, 0.034, 0.003, poly);
  w.side('xb.cheek', () => shape([[-0.1, B + 0.004], [-0.27, B + 0.006], [-0.27, B + 0.022, 0.008], [-0.11, B + 0.02, 0.01]]), 0, 0.03, 0.004, poly);
  w.side('xb.pad', () => shape([[sz, B + 0.006, 0.004], [sz + 0.012, B + 0.006], [sz + 0.012, -0.087], [sz, -0.087, 0.004]]), 0, 0.036, 0.003, M.rubber(0x151516));
  // Foot stirrup.
  w.wire([[0.03, B - 0.02, rz + 0.012], [0.042, B - 0.03, 0.57], [0.03, B - 0.034, 0.6], [-0.03, B - 0.034, 0.6], [-0.042, B - 0.03, 0.57], [-0.03, B - 0.02, rz + 0.012]], 0.004, alloy);
  // Sights: a peep at the back of the rail, a post on a bridge over the groove at the riser.
  peep(w, f.rear[2], f.rear[1], f.top.y, alloy, 0.0062, 0.0024);
  for (const s of [1, -1]) w.rbox(s * 0.012, (B + f.front[1]) / 2 - 0.006, f.front[2], 0.004, f.front[1] - B + 0.006, 0.008, 0.0012, alloy);
  w.rbox(0, f.front[1] - 0.012, f.front[2], 0.028, 0.004, 0.008, 0.0012, alloy);
  w.rbox(0, f.front[1] - 0.006, f.front[2], 0.0026, 0.012, 0.0035, 0.0006, alloy);
  w.sphere(0, f.front[1] - 0.0012, f.front[2] - 0.002, 0.0012, M.glow(0x5aff40, 1.4));
}
