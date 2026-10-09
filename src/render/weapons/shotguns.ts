import { M, shape, type P2, type WB, type WS } from './kit';
import { guard, post, swivel, trigger } from './parts';
import { FRAMES } from '../../sim/gunFrames';
import { SHELL_LEN } from '../../sim/gunActions';

/**
 * A 12-gauge shell lying along +z from its head at `at`: the brass head with its rim and primer, the plastic hull, its crimp
 * folded in at the front.
 */
function shell(w: WB, key: string, at: [number, number, number], hull: number) {
  const [x, y, z] = at;
  const L = SHELL_LEN;
  w.turnAlong(`${key}.head`, [[0, 0], [0.0108, 0], [0.0108, 0.012], [0.0101, 0.016], [0.0101, 0.2], [0, 0.2]], [x, y, z], [x, y, z + L], M.brass(0xb08a46, 0.3));
  w.turnAlong(`${key}.hull`, [[0, 0.19], [0.0099, 0.19], [0.0099, 0.95], [0.0088, 0.99], [0.004, 1], [0, 1]], [x, y, z], [x, y, z + L], M.paint(hull, 0.35));
  if (w.hi) w.turnAlong(`${key}.primer`, [[0, 0], [0.0028, 0], [0.0028, 1], [0, 1]], [x, y, z - 0.0003], [x, y, z + 0.0004], M.steel(0x9a9ea2, 0.3));
}

/**
 * The shotguns: the side-by-side doubles (a sawn-off with its stock cut to a stub grip, and the long-barrelled coach gun
 * with its outside hammers), the walnut pump gun, and the semi-automatic combat shotgun in black alloy and polymer. Each is
 * drawn to its frame in `sim/gunFrames.ts`.
 */

// ---------------------------------------------------------------------------------------------------- side-by-side doubles

interface DoubleCfg {
  key: 'sawn' | 'coach';
  /** Fore-end's front; outside hammers; the full stock or the stub grip. */
  fore: number;
  hammers: boolean;
  full: boolean;
}

/** A side-by-side double: two barrels on their ribs, a boxlock action with its top lever, splinter fore-end, two triggers. */
function double(w: WB, c: DoubleCfg) {
  const f = FRAMES[c.key];
  const K = c.key;
  const B = f.bore;
  const blued = M.blued(c.key === 'sawn' ? 0x1d2026 : 0x1a1d24, c.key === 'sawn' ? 0.6 : 0.4);
  const action = M.blued(c.key === 'sawn' ? 0x2a2c30 : 0x4a4c50, 0.45);
  const wood = M.wood(c.key === 'sawn' ? 0x5e3820 : 0x5a3018, 0.45);
  const MZ = f.muzzle;
  const dx = f.dbl! / 2;
  // The barrels drop open on their hinge in the close-up model (`barrels`), the fore-end with them.
  w.piece('barrels', () => {
    // The barrels: tapering tubes with a dark bore, the sawn ends left rough; the ribs between them.
    for (const s of [1, -1]) {
      const rough = c.key === 'sawn';
      w.turn(`${K}.bbl`, [[0, 0.034], [0.0119, 0.034], [0.0119, 0.06], [0.0105, 0.2], [0.0104, MZ - (rough ? 0 : 0.001)], [rough ? 0.0104 : 0.0098, MZ], [0.0093, MZ], [0.0093, MZ - 0.04], [0, MZ - 0.04]], s * dx, B, blued);
      if (w.hi) w.turn(`${K}.bore`, [[0.0091, 0], [0.0091, 0.039], [0, 0.039]], s * dx, B, M.hole(), 12, 0.7, MZ - 0.04);
      // The chambers' mouths in the breech face, dark, for when they are empty; the lumps under the breech on the hinge.
      w.inner(() => w.turn(`${K}.chamber`, [[0, 0], [0.0102, 0], [0.0102, 0.0006], [0, 0.0006]], s * dx, B, M.hole(), 16, 0.7, 0.0336));
    }
    w.inner(() => w.side(`${K}.lump`, () => shape([[0.034, B - 0.012], [0.06, B - 0.012], [0.058, B - 0.024, 0.003], [0.036, B - 0.022, 0.003]]), 0, 0.016, 0.001, blued));
    w.side(`${K}.rib`, () => shape([[0.036, B + 0.007], [MZ - 0.002, B + 0.006], [MZ - 0.002, f.front[1] - 0.003, 0.001], [0.036, f.rear[1] - 0.003, 0.002]]), 0, 0.009, 0.0008, blued);
    w.side(`${K}.ribL`, () => shape([[0.036, B - 0.012], [MZ - 0.004, B - 0.011], [MZ - 0.004, B - 0.004], [0.036, B - 0.004]]), 0, 0.01, 0, blued);
    w.sphere(0, f.front[1] - 0.0016, f.front[2], 0.0017, M.brass(0xd8c070, 0.2));
    // Fore-end: a splinter of wood under the barrels with its iron at the back.
    w.side(`${K}.fore`, () => shape([[0.04, B - 0.006], [c.fore, B - 0.006], [c.fore + 0.004, B - 0.016, 0.006], [c.fore - 0.01, B - 0.03, 0.008], [0.05, B - 0.032, 0.01]]), 0, 0.04, w.hi ? 0.005 : 0.004, wood);
    w.side(`${K}.iron`, () => shape([[0.036, B - 0.012], [0.06, B - 0.012], [0.058, B - 0.031, 0.004], [0.038, B - 0.033, 0.004]]), 0, 0.034, 0.0015, action);
  });
  // The two shells in the chambers, their heads flush with the breech face.
  w.prop('shells', () => {
    for (const s of [1, -1]) shell(w, `${K}.sh`, [s * dx, B, 0.0336 - 0.0012], 0xa8281c);
  });
  // The action: the body with its rounded fences at the breech, the top tang, the top lever and safety.
  w.side(`${K}.action`, () => shape([[-0.048, B + 0.004, 0.006], [-0.03, B + 0.016, 0.006], [0.034, B + 0.016, 0.004], [0.036, B - 0.022, 0.006], [0.0, B - 0.036, 0.006], [-0.035, B - 0.036], [-0.05, B - 0.026, 0.008]]), 0, 0.043, 0.003, action);
  for (const s of [1, -1]) w.sphere(s * dx, B, 0.034, 0.0128, action, 1, 1, 0.45);
  w.side(`${K}.tang`, () => shape([[-0.03, B + 0.018], [-0.09, B + 0.006, 0.004], [-0.089, B + 0.001, 0.003], [-0.03, B + 0.012]]), 0, 0.014, 0.0008, action);
  w.rbox(-0.006, B + 0.0195, -0.042, 0.012, 0.004, 0.03, 0.0015, blued);
  w.rbox(-0.012, B + 0.02, -0.06, 0.012, 0.0045, 0.012, 0.0018, M.knurl(0x1f2226));
  w.rbox(0, B + 0.012, -0.072, 0.006, 0.0035, 0.009, 0.0012, blued);
  // The hammers, outside on the lock plates (the coach gun).
  if (c.hammers) {
    for (const s of [1, -1]) {
      w.side(`${K}.plate`, () => shape([[-0.075, B - 0.006, 0.01], [-0.032, B + 0.008, 0.006], [0.0, B + 0.006, 0.006], [0.0, B - 0.022, 0.006], [-0.06, B - 0.024, 0.01]]), s * 0.0222, 0.0024, 0.0006, action);
      w.side(`${K}.hammer`, () => shape([[-0.028, B - 0.008], [-0.018, B - 0.004, 0.004], [-0.024, B + 0.016, 0.004], [-0.044, B + 0.03, 0.004], [-0.05, B + 0.026, 0.003], [-0.034, B + 0.012, 0.004], [-0.038, B - 0.008, 0.004]]), s * 0.0255, 0.0055, 0.001, blued);
      if (w.hi) w.side(`${K}.spur`, () => shape([[-0.043, B + 0.031], [-0.051, B + 0.027], [-0.048, B + 0.023], [-0.041, B + 0.027]]), s * 0.0255, 0.006, 0, M.knurl(0x15181c));
    }
  }
  // Two triggers in the guard.
  const gy = B - 0.036;
  guard(w, K, -0.052, 0.006, gy, 0.032, blued, 0.008);
  trigger(w, `${K}.a`, -0.012, gy, 0.02, blued, 0.005);
  trigger(w, `${K}.b`, -0.032, gy, 0.017, blued, 0.005);
  // The stock: the wrist into a pistol grip, cut off short and taped (sawn-off), or carried on to a full butt (coach gun).
  const R = 0.67;
  const fz = (y: number) => -0.05 + R * (y - gy + 0.004);
  const bz = (y: number) => -0.093 + R * (y - gy + 0.004);
  const yb = gy - 0.058;
  if (!c.full) {
    const pts: P2[] = [[-0.048, B + 0.006, 0.004], [-0.09, B + 0.002, 0.012], [bz(gy - 0.004) - 0.004, gy, 0.02], [bz(yb) - 0.002, yb], [fz(yb) + 0.002, yb], [fz(gy - 0.02), gy - 0.02, 0.012], [-0.05, gy - 0.002, 0.004]];
    w.side(`${K}.stock`, () => shape(pts), 0, 0.036, w.hi ? 0.007 : 0.004, wood);
    // The sawn face: the end grain, darker, and two turns of tape above it.
    w.side(`${K}.cut`, () => shape([[bz(yb) - 0.002, yb - 0.0005], [fz(yb) + 0.002, yb - 0.0005], [fz(yb) + 0.001, yb - 0.0015], [bz(yb) - 0.001, yb - 0.0015]]), 0, 0.034, 0, M.wood(0x3a2414, 0.6));
    w.side(`${K}.tape`, () => shape([[bz(yb + 0.028) - 0.003, yb + 0.028], [fz(yb + 0.028) + 0.003, yb + 0.028], [fz(yb + 0.006) + 0.003, yb + 0.006], [bz(yb + 0.006) - 0.003, yb + 0.006]]), 0, 0.039, 0.004, M.tape(0x1e1e20, 0.6));
  } else {
    const sz = f.stock.z;
    const pts: P2[] = [[-0.048, B + 0.006, 0.004], [-0.1, B - 0.004, 0.02], [-0.14, B - 0.008, 0.03], [sz + 0.012, B - 0.026, 0.006], [sz + 0.01, -0.12, 0.006], [-0.17, -0.07, 0.12], [bz(yb + 0.01) - 0.004, yb + 0.012, 0.012], [bz(yb) + 0.006, yb, 0.004], [fz(yb) + 0.002, yb, 0.004], [fz(gy - 0.02), gy - 0.02, 0.012], [-0.05, gy - 0.002, 0.004]];
    w.side(`${K}.stock`, () => shape(pts), 0, 0.04, w.hi ? 0.009 : 0.004, wood);
    w.side(`${K}.buttplate`, () => shape([[sz, B - 0.025, 0.004], [sz + 0.012, B - 0.026], [sz + 0.011, -0.121], [sz - 0.001, -0.121, 0.004]]), 0, 0.04, 0.003, M.blued(0x1c1e22, 0.5));
    if (w.hi) for (const s of [1, -1]) w.side(`${K}.chq${s}`, () => shape([[fz(gy - 0.012) - 0.004, gy - 0.012, 0.004], [bz(gy - 0.004) - 0.002, gy - 0.004, 0.006], [bz(yb + 0.016) + 0.004, yb + 0.016, 0.006], [fz(yb + 0.014) - 0.002, yb + 0.014, 0.004]]), s * 0.0202, 0.0012, 0, M.checker(0x4c2a14, 0.45));
    swivel(w, 0, -0.105, sz + 0.07, blued, false);
  }
}

export const sawn = (w: WB) => double(w, { key: 'sawn', fore: 0.15, hammers: false, full: false });
export const coach = (w: WB) => double(w, { key: 'coach', fore: 0.25, hammers: true, full: true });

// ---------------------------------------------------------------------------------------------------- pump

/**
 * A walnut pump gun: a blued receiver with its port on the right and the loading port underneath, the magazine tube under
 * the barrel with its knurled cap and the barrel's ring, a ribbed slide on its action bars, a brass bead, an alloy trigger
 * plate with the cross-bolt safety, and a pistol-gripped stock with a recoil pad.
 */
export function pump(w: WB) {
  const f = FRAMES.pump;
  const B = f.bore;
  const blued = M.blued(0x1c1f25, 0.45);
  const alloy = M.anod(0x1f2022, 0.4);
  const wood = M.wood(0x5c351c, 0.4);
  const MZ = f.muzzle;
  const yb = B - 0.05;
  w.side('pu.recv', () => shape([[-0.046, B - 0.016], [-0.042, B + 0.012, 0.006], [-0.022, f.rear[1], 0.01], [0.15, f.rear[1], 0.004], [0.156, B + 0.01], [0.156, yb, 0.002], [-0.03, yb], [-0.046, yb + 0.012, 0.006]]), 0, 0.032, 0.003, blued);
  // Port with the bolt in it, the carrier in the loading port.
  w.box(-0.0162, B + 0.002, f.port[2], 0.0008, 0.022, 0.052, M.hole());
  w.box(-0.0156, B + 0.002, f.port[2] - 0.016, 0.0008, 0.014, 0.018, M.steel(0x7a7e82, 0.3));
  w.box(0, yb - 0.0004, 0.08, 0.018, 0.0008, 0.09, M.hole());
  w.box(0, yb + 0.0002, 0.06, 0.012, 0.0008, 0.05, M.steel(0x6a6e72, 0.4));
  // Trigger plate, guard, trigger, the safety behind it, the action release in front on the left.
  guard(w, 'pu', -0.04, 0.024, yb, 0.03, alloy, 0.011);
  trigger(w, 'pu', -0.004, yb, 0.019, alloy);
  w.turnAlong('pu.safe', [[0, 0], [0.0035, 0], [0.0035, 1], [0, 1]], [-0.012, yb - 0.006, -0.012], [0.012, yb - 0.006, -0.012], M.steel(0x7a7e82, 0.3));
  w.rbox(0.008, yb - 0.006, 0.032, 0.004, 0.01, 0.006, 0.0012, alloy);
  // Barrel, bead, magazine tube and cap, the barrel's ring round both.
  w.turn('pu.bbl', [[0, 0.15], [0.0122, 0.15], [0.0122, 0.18], [0.0108, 0.24], [0.0105, MZ - 0.001], [0.01, MZ], [0.0093, MZ], [0.0093, MZ - 0.04], [0, MZ - 0.04]], 0, B, blued);
  if (w.hi) w.turn('pu.bore', [[0.0091, 0], [0.0091, 0.039], [0, 0.039]], 0, B, M.hole(), 12, 0.7, MZ - 0.04);
  w.sphere(0, f.front[1] - 0.0017, f.front[2], 0.0018, M.brass(0xd8c070, 0.2));
  w.tube(0, f.mag.y, 0.15, f.mag.z, 0.0115, blued);
  w.turn('pu.cap', [[0, f.mag.z - 0.004], [0.0125, f.mag.z - 0.004], [0.0125, f.mag.z + 0.014], [0.009, f.mag.z + 0.018], [0, f.mag.z + 0.018]], 0, f.mag.y, M.knurl(0x1f2227, 0.4));
  w.side('pu.ring', () => shape([[f.mag.z - 0.024, f.mag.y - 0.012, 0.004], [f.mag.z - 0.006, f.mag.y - 0.012, 0.004], [f.mag.z - 0.006, B + 0.011, 0.006], [f.mag.z - 0.024, B + 0.011, 0.006]]), 0, 0.026, 0.0015, blued);
  // The slide: ribbed walnut round the tube, on its two bars.
  const s0 = 0.215;
  const s1 = 0.405;
  // The slide and its bars run back on their own in the close-up model (`pump`).
  w.piece('pump', () => {
    w.side('pu.slide', () => shape([[s0, B - 0.012], [s1, B - 0.012], [s1 + 0.004, f.mag.y - 0.008, 0.008], [s1 - 0.004, f.under.y + 0.004, 0.006], [s0 + 0.004, f.under.y + 0.004, 0.006], [s0 - 0.004, f.mag.y - 0.008, 0.008]]), 0, 0.046, w.hi ? 0.008 : 0.004, wood);
    if (w.hi) for (let i = 0; i < 9; i++) {
      const z = s0 + 0.02 + i * 0.019;
      for (const s of [1, -1]) w.box(s * 0.0232, f.mag.y - 0.004, z, 0.0012, 0.026, 0.004, M.wood(0x3e2412, 0.4));
      w.box(0, f.under.y + 0.0, z, 0.03, 0.0012, 0.004, M.wood(0x3e2412, 0.4));
    }
    for (const s of [1, -1]) w.box(s * 0.0128, f.mag.y + 0.004, 0.185, 0.002, 0.005, 0.07, M.steel(0x7a7e82, 0.35));
  });
  w.prop('shell', () => shell(w, 'pu.shell', [0, f.mag.y, 0.13], 0xa8281c));
  // Stock: the wrist and pistol grip with its cap, the comb, the butt and its pad.
  const sz = f.stock.z;
  const pts: P2[] = [
    [-0.044, B + 0.008, 0.004],
    [-0.09, B - 0.002, 0.02],
    [-0.15, B - 0.006, 0.04],
    [sz + 0.016, B - 0.02, 0.006],
    [sz + 0.014, -0.118, 0.006],
    [-0.18, -0.076, 0.12],
    [-0.112, -0.072, 0.012],
    [-0.1, -0.096, 0.004],
    [-0.066, -0.092, 0.006],
    [-0.05, -0.055, 0.02],
    [-0.036, yb - 0.002, 0.004],
  ];
  w.side('pu.stock', () => shape(pts), 0, 0.041, w.hi ? 0.009 : 0.004, wood);
  w.side('pu.cap', () => shape([[-0.1, -0.094], [-0.067, -0.09], [-0.066, -0.096, 0.002], [-0.1, -0.1, 0.002]]), 0, 0.03, 0.002, M.poly(0x161616, 0.3));
  w.side('pu.pad', () => shape([[sz - 0.002, B - 0.019, 0.006], [sz + 0.016, B - 0.02], [sz + 0.015, -0.12], [sz - 0.003, -0.12, 0.006]]), 0, 0.041, 0.004, M.rubber(0x1c1b1a, 0.4));
  if (w.hi) for (const s of [1, -1]) w.side(`pu.chq${s}`, () => shape([[-0.047, -0.03, 0.004], [-0.075, -0.02, 0.006], [-0.094, -0.074, 0.006], [-0.06, -0.082, 0.004]]), s * 0.0207, 0.0012, 0, M.checker(0x4a2a14, 0.4));
  swivel(w, 0, -0.1, sz + 0.07, blued, false);
  swivel(w, 0, f.mag.y - 0.012, f.mag.z - 0.015, blued, false);
}

// ---------------------------------------------------------------------------------------------------- combat shotgun

/**
 * A semi-automatic combat shotgun: an alloy receiver with a full rail, a ghost-ring rear sight and a winged front post,
 * the big charging handle out of the right, a polymer fore-end over the long magazine tube, a pistol grip and a
 * collapsible stock on its tube.
 */
export function combat(w: WB) {
  const f = FRAMES.combat;
  const B = f.bore;
  const anod = M.anod(0x232426, 0.35);
  const poly = M.poly(0x1d1e20, 0.35);
  const steel = M.park(0x2b2d2b, 0.35);
  const MZ = f.muzzle;
  const yb = B - 0.048;
  const railBase = f.top.y - 0.0095;
  w.side('cs.recv', () => shape([[-0.052, yb + 0.006], [-0.052, railBase - 0.004, 0.004], [-0.048, railBase], [0.168, railBase], [0.172, railBase - 0.006, 0.004], [0.172, yb, 0.003], [-0.03, yb]]), 0, 0.034, 0.002, anod);
  w.rail('cs', 0, railBase, -0.048, 0.165, anod);
  w.box(-0.0172, B + 0.004, f.port[2], 0.0008, 0.022, 0.058, M.hole());
  const h = f.spots!.handle;
  w.piece('handle', () => w.turnAlong('cs.handle', [[0, 0], [0.0045, 0], [0.0045, 0.7], [0.0062, 0.75], [0.0062, 1], [0, 1]], [-0.016, h[1], h[2]], [h[0] - 0.004, h[1], h[2]], steel));
  w.prop('shell', () => shell(w, 'cs.shell', [0, f.mag.y, 0.13], 0x2a3a6a));
  w.rbox(-0.0172, B - 0.024, 0.13, 0.002, 0.008, 0.012, 0.0015, steel);
  w.rbox(0.0172, B - 0.03, 0.035, 0.002, 0.006, 0.02, 0.0015, steel);
  // Trigger group in polymer, guard, trigger; the pistol grip.
  w.side('cs.lower', () => shape([[-0.075, yb + 0.004], [0.05, yb + 0.004], [0.05, yb - 0.006, 0.004], [-0.075, yb - 0.006, 0.004]]), 0, 0.03, 0.002, poly);
  guard(w, 'cs', -0.026, 0.034, yb - 0.006, 0.028, poly, 0.012);
  trigger(w, 'cs', 0.006, yb - 0.006, 0.018, steel);
  const R = f.grip.a[2] / f.grip.a[1];
  const gt = yb - 0.004;
  const zf = f.grip.p[2] + 0.018 - R * (f.grip.p[1] - gt);
  // A raked grip with its finger groove (see `parts.ts` pistolGrip), built inline at this gun's numbers.
  const gp: P2[] = [];
  const fzz = (y: number) => zf + R * (y - gt);
  const bzz = (y: number) => zf - 0.036 + R * (y - gt);
  gp.push([bzz(gt) + 0.004, gt + 0.004], [fzz(gt) - 0.004, gt + 0.004], [fzz(gt - 0.026) + 0.0, gt - 0.026, 0.006], [fzz(gt - 0.036) - 0.003, gt - 0.036, 0.004], [fzz(gt - 0.098) - 0.002, gt - 0.094, 0.006], [bzz(gt - 0.098) + 0.0, gt - 0.094, 0.008], [bzz(gt - 0.045) - 0.004, gt - 0.045, 0.03], [bzz(gt - 0.006) + 0.004, gt - 0.006, 0.006]);
  w.side('cs.grip', () => shape(gp), 0, 0.03, 0.004, M.stipple(0x1c1d1f, 0.3));
  // Barrel, the front post on its clamp, the tube and cap, the polymer fore-end.
  w.turn('cs.bbl', [[0, 0.165], [0.0122, 0.165], [0.0122, 0.19], [0.0108, 0.24], [0.0105, MZ - 0.001], [0.0099, MZ], [0.0093, MZ], [0.0093, MZ - 0.04], [0, MZ - 0.04]], 0, B, steel);
  if (w.hi) w.turn('cs.bore', [[0.0091, 0], [0.0091, 0.039], [0, 0.039]], 0, B, M.hole(), 12, 0.7, MZ - 0.04);
  w.side('cs.fclamp', () => shape([[f.front[2] - 0.012, B - 0.012, 0.003], [f.front[2] + 0.01, B - 0.012, 0.003], [f.front[2] + 0.01, B + 0.014, 0.004], [f.front[2] - 0.012, B + 0.014, 0.004]]), 0, 0.026, 0.0015, anod);
  post(w, 'cs.f', f.front[2], f.front[1], B + 0.014, anod, true, 0.026);
  w.tube(0, f.mag.y, 0.165, f.mag.z, 0.0118, anod);
  w.turn('cs.cap', [[0, f.mag.z - 0.003], [0.0128, f.mag.z - 0.003], [0.0128, f.mag.z + 0.014], [0.0092, f.mag.z + 0.018], [0, f.mag.z + 0.018]], 0, f.mag.y, M.knurl(0x202124, 0.35));
  w.side('cs.ring', () => shape([[f.mag.z - 0.02, f.mag.y - 0.013, 0.004], [f.mag.z - 0.004, f.mag.y - 0.013, 0.004], [f.mag.z - 0.004, B + 0.011, 0.006], [f.mag.z - 0.02, B + 0.011, 0.006]]), 0, 0.027, 0.0015, anod);
  w.side('cs.fore', () => shape([[0.175, B - 0.012], [0.43, B - 0.012], [0.434, f.mag.y - 0.006, 0.008], [0.426, f.under.y + 0.004, 0.006], [0.18, f.under.y + 0.004, 0.006], [0.172, f.mag.y - 0.006, 0.008]]), 0, 0.046, w.hi ? 0.006 : 0.004, poly);
  if (w.hi) for (let i = 0; i < 5; i++) for (const s of [1, -1]) w.box(s * 0.0232, f.mag.y, 0.21 + i * 0.045, 0.0008, 0.008, 0.028, M.hole());
  // Ghost ring rear sight with its wings.
  for (const s of [1, -1]) w.side('cs.rw', () => shape([[f.rear[2] - 0.012, f.top.y], [f.rear[2] + 0.012, f.top.y], [f.rear[2] + 0.008, f.rear[1] + 0.006, 0.004], [f.rear[2] - 0.008, f.rear[1] + 0.006, 0.004]]), s * 0.0115, 0.0034, 0.0008, anod);
  w.rbox(0, f.top.y + 0.003, f.rear[2], 0.026, 0.006, 0.026, 0.0015, anod);
  w.torus(0, f.rear[1], f.rear[2], 0.0054, 0.0017, steel);
  w.rbox(0, (f.top.y + 0.006 + f.rear[1] - 0.007) / 2, f.rear[2], 0.006, f.rear[1] - 0.007 - f.top.y - 0.006 + 0.002, 0.004, 0.0008, steel);
  // Stock: the tube, the collapsible stock on it with a cheek piece and pad.
  const sz = f.stock.z;
  w.turn('cs.tube', [[0, -0.23], [0.0128, -0.23], [0.0128, -0.052], [0, -0.052]], 0, B - 0.006, anod);
  w.side('cs.stock', () => shape([[sz + 0.15, B + 0.012, 0.006], [sz + 0.012, B + 0.022, 0.006], [sz + 0.008, B + 0.024], [sz + 0.008, f.stock.y - 0.07, 0.004], [sz + 0.026, f.stock.y - 0.076, 0.008], [sz + 0.08, B - 0.04, 0.03], [sz + 0.13, B - 0.026, 0.006]]), 0, 0.034, 0.004, poly);
  w.side('cs.pad', () => shape([[sz, B + 0.026, 0.004], [sz + 0.01, B + 0.026, 0.002], [sz + 0.01, f.stock.y - 0.078, 0.004], [sz, f.stock.y - 0.078, 0.004]]), 0, 0.032, 0.004, M.rubber(0x161617, 0.3));
  swivel(w, 0, f.stock.y - 0.068, sz + 0.05, steel, false);
  swivel(w, 0.012, f.mag.y - 0.012, f.mag.z - 0.012, steel, false);
}

export type { WS };
