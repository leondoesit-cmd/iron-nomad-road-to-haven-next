import { M, replacesStock, shape, type Looks, type WB } from './kit';
import { barrel, boxMag, guard, peep, pistolGrip, swivel, trigger } from './parts';
import { FRAMES } from '../../sim/gunFrames';

/**
 * The submachine guns: a scrap tube gun welded together out of three others, and the factory-made roller-delayed police
 * gun with its retractable stock, cocking tube and claw-mounted rail. Each is drawn to its frame in `sim/gunFrames.ts`.
 */

const rakeOf = (a: [number, number, number]) => a[2] / a[1];

/**
 * The scrap SMG: a steel tube receiver with a cocking slot on the left and the port on the right, a welded magazine well
 * under it for a straight 9 mm stick, a polymer pistol grip on a welded bracket, a bent-strap trigger guard, a perforated
 * barrel shroud, a welded wire stock with a taped cheek rod, a peep made from angle iron, and weld beads at every joint.
 */
export function scrapSmg(w: WB, looks: Looks = {}) {
  const f = FRAMES.smg;
  const B = f.bore;
  const tube = M.park(0x3a3a36, 0.85);
  const raw = M.steel(0x585652, 0.9);
  const black = M.blued(0x1e2024, 0.6);
  const weld = (pts: [number, number, number][]) => {
    if (!w.hi) return;
    for (const p of pts) w.sphere(p[0], p[1], p[2], 0.002, raw);
  };
  const ring = (x: number, y: number, z: number, r: number, n = 10) => {
    if (!w.hi) return;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      w.sphere(x + Math.cos(a) * r, y + Math.sin(a) * r, z, 0.0019, raw);
    }
  };
  // Receiver tube, its end cap and the barrel nut.
  w.turn('sm.tube', [[0, -0.1], [0.0188, -0.1], [0.019, -0.098], [0.019, 0.17], [0, 0.17]], 0, B, tube);
  w.turn('sm.cap', [[0, -0.112], [0.012, -0.114], [0.0198, -0.108], [0.0198, -0.098], [0, -0.098]], 0, B, M.knurl(0x34342f, 0.8));
  w.turn('sm.nut', [[0, 0.168], [0.0212, 0.168], [0.0212, 0.186], [0.016, 0.188], [0, 0.188]], 0, B, M.knurl(0x34342f, 0.8));
  ring(0, B, 0.169, 0.0195);
  // The cocking slot on the left with the handle forward in it; the port on the right.
  const h = f.spots!.handle;
  w.box(0.0186, B, (h[2] + f.spots!.handleBack[2]) / 2, 0.0012, 0.0055, h[2] - f.spots!.handleBack[2] + 0.012, M.hole());
  w.piece('handle', () => {
    w.rod([0.012, B, h[2]], [h[0], h[1], h[2]], 0.003, raw);
    w.turnAlong('sm.knob', [[0, 0], [0.006, 0.05], [0.0065, 0.4], [0.006, 0.9], [0, 1]], [h[0] - 0.002, h[1], h[2]], [h[0] + 0.01, h[1], h[2]], black);
  });
  w.box(-0.0186, B + 0.008, f.port[2], 0.0012, 0.011, 0.04, M.hole());
  // The well, welded on; the magazine in it.
  const wz0 = f.well[2] - 0.02;
  const wz1 = f.well[2] + 0.02;
  w.side('sm.well', () => shape([[wz0, B - 0.012], [wz1, B - 0.012], [wz1, f.well[1]], [wz0, f.well[1]]]), 0, 0.03, 0, raw);
  weld([[0.015, B - 0.014, wz0 + 0.004], [0.015, B - 0.014, wz0 + 0.014], [0.015, B - 0.014, wz0 + 0.024], [0.015, B - 0.014, wz0 + 0.034]]);
  weld([[-0.015, B - 0.014, wz0 + 0.004], [-0.015, B - 0.014, wz0 + 0.014], [-0.015, B - 0.014, wz0 + 0.024], [-0.015, B - 0.014, wz0 + 0.034]]);
  w.piece('mag', () => boxMag(w, 'sm', wz0 + 0.003, wz1 - 0.003, f.well[1] + 0.004, f.well[1] - f.mag.y - 0.006, 0, 0.0235, black, { ribs: 1, flare: 0.002, top: 0.026, round: [0.0049, 0.019, 0.0105] }));
  // The bracket and grip, the bent strap guard and the trigger.
  w.side('sm.bracket', () => shape([[-0.05, B - 0.016], [0.06, B - 0.016], [0.06, 0.0], [-0.05, 0.0]]), 0, 0.022, 0, raw);
  weld([[0.0112, B - 0.017, -0.04], [0.0112, B - 0.017, -0.02], [0.0112, B - 0.017, 0.0], [0.0112, B - 0.017, 0.02], [0.0112, B - 0.017, 0.04]]);
  guard(w, 'sm', 0.012, 0.074, 0.0, 0.026, raw, 0.006, 0.003);
  trigger(w, 'sm', 0.046, 0.0, 0.017, raw);
  pistolGrip(w, 'sm', 0.012, -0.026, 0.0, rakeOf(f.grip.a), 0.095, 0.028, M.stipple(0x1f2022, 0.5), { groove: true, swell: 0.004 });
  // Tape round the grip's middle where it cracked.
  w.side('sm.tape', () => shape([[-0.004, -0.03], [-0.028, -0.03], [-0.04, -0.06], [-0.016, -0.06]]), 0, 0.031, 0.003, M.tape(0x6a5a3a, 0.6));
  // Shroud: a perforated tube round the barrel; the barrel and its thread protector out of the end.
  w.turn('sm.shroud', [[0.012, 0.186], [0.0148, 0.186], [0.0148, 0.3], [0.012, 0.3]], 0, B, tube);
  if (w.hi)
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 6; j++) {
        const a = (j / 6) * Math.PI * 2 + (i % 2) * 0.52;
        w.turnAlong('sm.hole', [[0, 0], [0.0032, 0], [0.0032, 1], [0, 1]], [Math.cos(a) * 0.0138, B + Math.sin(a) * 0.0138, 0.2 + i * 0.022], [Math.cos(a) * 0.0151, B + Math.sin(a) * 0.0151, 0.2 + i * 0.022], M.hole(), 8);
      }
  barrel(w, 'sm', B, [[0.0085, 0.29], [0.0085, f.muzzle - 0.012]], 0.0045, black);
  w.turn('sm.thread', [[0, f.muzzle - 0.013], [0.0095, f.muzzle - 0.013], [0.0095, f.muzzle], [0.006, f.muzzle], [0.006, f.muzzle - 0.01], [0, f.muzzle - 0.01]], 0, B, M.knurl(0x2a2a28, 0.7));
  // Sights: the front blade on the shroud, the rear an angle-iron peep welded on the tube.
  w.side('sm.blade', () => shape([[f.front[2] - 0.006, B + 0.012], [f.front[2] + 0.006, B + 0.012], [f.front[2] + 0.003, f.front[1], 0.001], [f.front[2] - 0.004, f.front[1], 0.001]]), 0, 0.0032, 0, raw);
  weld([[0.003, B + 0.015, f.front[2] - 0.006], [-0.003, B + 0.015, f.front[2] + 0.006]]);
  w.side('sm.rearL', () => shape([[f.rear[2] - 0.012, B + 0.017], [f.rear[2] + 0.012, B + 0.017], [f.rear[2] + 0.012, B + 0.021], [f.rear[2] - 0.012, B + 0.021]]), 0, 0.016, 0, raw);
  peep(w, f.rear[2], f.rear[1], B + 0.021, raw, 0.0062, 0.0026);
  // The wire stock: two rods welded to the end cap, a flat butt plate with a strip of tyre on it, tape on the cheek rod.
  const sz = f.stock.z;
  if (!replacesStock(looks.stock)) {
    w.rod([0, B + 0.013, -0.106], [0, B + 0.022, sz + 0.006], 0.0042, raw);
    w.rod([0, B - 0.013, -0.106], [0, -0.042, sz + 0.006], 0.0042, raw);
    ring(0, B, -0.104, 0.014, 8);
    w.side('sm.butt', () => shape([[sz, B + 0.03, 0.004], [sz + 0.006, B + 0.03, 0.002], [sz + 0.006, -0.065, 0.002], [sz, -0.065, 0.004]]), 0, 0.03, 0, raw);
    w.side('sm.tyre', () => shape([[sz - 0.008, B + 0.028, 0.004], [sz + 0.001, B + 0.028], [sz + 0.001, -0.063], [sz - 0.008, -0.063, 0.004]]), 0, 0.034, 0.002, M.rubber(0x161616, 0.6));
    w.turnAlong('sm.cheekT', [[0, 0], [0.0068, 0.02], [0.0068, 0.98], [0, 1]], [0, B + 0.016, -0.17], [0, B + 0.02, -0.27], M.tape(0x26282a, 0.6));
  }
  swivel(w, 0, B - 0.019, -0.09, raw, false);
}

/**
 * The police SMG, roller-delayed: a stamped receiver with its pressed ribs, the cocking tube over the barrel with the
 * handle out on the left at the front, a ringed front post and a drum-style aperture at the back, a wide tropical
 * handguard, a polymer trigger group with a raked grip and the selector on the left, a curved 30-round magazine, the
 * retractable stock on its two struts, and a claw-mounted rail.
 */
export function policeSmg(w: WB, looks: Looks = {}) {
  const f = FRAMES.smg2;
  const B = f.bore;
  const steel = M.park(0x262826, 0.3);
  const poly = M.poly(0x1d1e20, 0.3);
  // Receiver, its ribs, the end cap.
  w.side('mp5.recv', () => shape([[-0.095, 0.008], [0.172, 0.008], [0.172, 0.05, 0.004], [0.166, 0.058, 0.004], [-0.088, 0.058, 0.006], [-0.095, 0.05, 0.004]]), 0, 0.038, w.hi ? 0.005 : 0.004, steel);
  if (w.hi) for (const y of [0.02, 0.047]) for (const s of [1, -1]) w.box(s * 0.019, y, 0.04, 0.0016, 0.0035, 0.2, steel);
  w.rbox(0, 0.033, -0.098, 0.036, 0.05, 0.008, 0.004, steel);
  // The port on the right, the bolt showing in it.
  w.box(-0.0192, 0.035, f.port[2], 0.0008, 0.016, 0.044, M.hole());
  w.box(-0.0186, 0.033, f.port[2] - 0.006, 0.0008, 0.008, 0.024, M.steel(0x6a6e70, 0.3));
  // Cocking tube, its slot, the handle on the left.
  const ct = f.spots!.tube;
  w.tube(0, ct[1], 0.15, 0.322, 0.0115, steel);
  w.box(0.0112, ct[1], 0.215, 0.0012, 0.004, 0.09, M.hole());
  w.piece('handle', () => {
    w.rod([0.008, ct[1], ct[2]], [ct[0], ct[1] + 0.002, ct[2] - 0.004], 0.0028, steel);
    w.turnAlong('mp5.knob', [[0, 0], [0.005, 0.05], [0.0055, 0.5], [0.005, 0.95], [0, 1]], [ct[0] - 0.004, ct[1] + 0.002, ct[2] - 0.004], [ct[0] + 0.012, ct[1] + 0.003, ct[2] - 0.005], poly);
  });
  // The front sight: a ring hood round a post, on a block at the front of the tube.
  w.rbox(0, ct[1] + 0.012, f.front[2], 0.012, 0.024, 0.012, 0.002, steel);
  w.torus(0, f.front[1] - 0.001, f.front[2], 0.0095, 0.0016, steel);
  w.rbox(0, (ct[1] + 0.02 + f.front[1]) / 2, f.front[2], 0.0026, f.front[1] - ct[1] - 0.02, 0.003, 0.0005, steel);
  // The rear sight: an aperture drum on its bracket.
  const ry = f.rear[1];
  w.rbox(0, 0.064, f.rear[2], 0.03, 0.012, 0.016, 0.003, steel);
  for (const s of [1, -1]) w.turnAlong('mp5.drum', [[0, 0], [0.0105, 0], [0.011, 0.15], [0.011, 0.85], [0.0105, 1], [0, 1]], [s * 0.004, ry, f.rear[2]], [s * 0.012, ry, f.rear[2]], steel);
  w.turn('mp5.apt', [[0.0022, -0.006], [0.0075, -0.006], [0.0075, 0.006], [0.0022, 0.006]], 0, ry, steel, undefined, 0.7, f.rear[2]);
  // Claw mount rail.
  w.rail('mp5', 0, f.top.y - 0.0095, -0.02, 0.1, steel);
  for (const z of [-0.012, 0.092]) for (const s of [1, -1]) w.rbox(s * 0.015, 0.06, z, 0.006, 0.012, 0.012, 0.002, steel);
  // Barrel: the handguard round it, the three lugs and the muzzle out of the front.
  barrel(w, 'mp5', B, [[0.0085, 0.16], [0.0075, 0.3], [0.0075, f.muzzle]], 0.0045, steel);
  w.turn('mp5.lugs', [[0.0075, 0.312], [0.0105, 0.314], [0.0105, 0.33], [0.0075, 0.332]], 0, B, steel);
  w.side('mp5.hg', () => shape([[0.172, B + 0.018], [0.298, B + 0.016, 0.004], [0.3, B - 0.028, 0.008], [0.172, B - 0.034, 0.006]]), 0, 0.05, w.hi ? 0.008 : 0.004, poly);
  if (w.hi) for (let i = 0; i < 4; i++) for (const s of [1, -1]) w.box(s * 0.0252, B - 0.008, 0.19 + i * 0.026, 0.0008, 0.016, 0.012, M.hole());
  // Trigger group: the housing, guard, trigger, grip and selector.
  w.side('mp5.lower', () => shape([[-0.085, 0.01], [0.075, 0.01], [0.075, -0.004, 0.004], [-0.04, -0.004], [-0.085, 0.002, 0.004]]), 0, 0.034, 0.002, poly);
  guard(w, 'mp5', 0.006, 0.062, -0.002, 0.026, poly, 0.012);
  trigger(w, 'mp5', 0.04, -0.002, 0.017, steel);
  pistolGrip(w, 'mp5', 0.006, -0.03, -0.002, rakeOf(f.grip.a), 0.098, 0.03, M.stipple(0x1c1d1f, 0.3), { groove: true, swell: 0.004 });
  w.side('mp5.sel', () => shape([[-0.045, 0.002, 0.002], [-0.02, 0.006, 0.002], [-0.022, -0.002, 0.002], [-0.045, -0.006, 0.003]]), 0.0185, 0.0026, 0.0006, steel);
  w.pin(0.017, 0.0, -0.07, 0.0025, steel);
  w.pin(0.017, 0.0, 0.068, 0.0025, steel);
  // The magazine well, the paddle release behind it, the curved 30-rounder.
  w.side('mp5.well', () => shape([[0.08, 0.01], [0.128, 0.01], [0.128, -0.002, 0.002], [0.08, -0.002, 0.002]]), 0, 0.03, 0.001, steel);
  w.side('mp5.paddle', () => shape([[0.074, -0.002], [0.08, -0.002], [0.08, -0.016, 0.002], [0.072, -0.014, 0.002]]), 0, 0.012, 0.001, steel);
  w.piece('mag', () => boxMag(w, 'mp5', 0.084, 0.124, 0.002, f.well[1] - f.mag.y - 0.002, 0.032, 0.022, M.park(0x232526, 0.35), { ribs: 2, flare: 0.004, top: 0.02, round: [0.0049, 0.019, 0.0105] }));
  // The retractable stock: two struts and the butt plate, the latch on the end cap.
  const sz = f.stock.z;
  const own = !replacesStock(looks.stock);
  if (own) for (const [y, s] of [[0.05, 1], [0.05, -1], [0.016, 1], [0.016, -1]] as [number, number][]) w.box(s * 0.0155, y, (sz - 0.098) / 2 + 0.004, 0.004, 0.009, -0.098 - sz, steel);
  if (own) w.side('mp5.butt', () => shape([[sz, 0.072, 0.008], [sz + 0.014, 0.068, 0.004], [sz + 0.016, -0.036, 0.006], [sz + 0.002, -0.044, 0.01]]), 0, 0.044, 0.004, M.rubber(0x171718, 0.3));
  w.rbox(0, 0.06, -0.103, 0.014, 0.012, 0.008, 0.002, steel);
  swivel(w, 0, 0.0, -0.08, steel, false);
  swivel(w, 0.02, ct[1], 0.3, steel);
}
