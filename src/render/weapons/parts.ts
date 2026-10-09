import { M, shape, type P2, type WB, type WS } from './kit';

/**
 * Parts many guns share, drawn to their own numbers: barrels with a crown and a dark bore, raked pistol grips, trigger
 * guards and triggers, box magazines (straight or curved, ribbed), aperture and post sights, sling swivels, and handguards
 * built as real panels with real slots cut through them (the barrel shows through).
 */

/**
 * A barrel along z at height `y` from `z0` to `z1`: the outline is (radius, z) pairs from the breech forward (the crown and
 * the bore are added at `z1`).
 */
export function barrel(w: WB, key: string, y: number, prof: [number, number][], bore: number, m: WS, x = 0) {
  const z1 = prof[prof.length - 1][1];
  const r1 = prof[prof.length - 1][0];
  const c = Math.min(0.0008, (r1 - bore) * 0.3);
  const pts: [number, number][] = [[0, prof[0][1]], ...prof.slice(0, -1), [r1, z1 - c], [r1 - c, z1], [bore + 0.0007, z1], [bore, z1 - 0.0007], [bore, z1 - 0.02], [0, z1 - 0.02]];
  w.turn(`bbl:${key}`, pts, x, y, m);
  if (w.hi) w.turn(`bore:${bore}`, [[bore * 0.97, 0], [bore * 0.97, 0.0195], [0, 0.0195]], x, y, M.hole(), 12, 0.7, z1 - 0.02);
}

/**
 * A pistol grip hanging from its top (the front at `zf`, the back at `zb`, both at height `y`), raked back by `rake`
 * (dz per metre of drop), `len` long down its front, `width` across, with a finger groove and a palm swell.
 */
export function pistolGrip(w: WB, key: string, zf: number, zb: number, y: number, rake: number, len: number, width: number, m: WS, opts: { groove?: boolean; swell?: number; bev?: number; heel?: number } = {}) {
  const bev = opts.bev ?? 0.004;
  const fz = (yy: number) => zf + rake * (yy - y);
  const bz = (yy: number) => zb + rake * (yy - y);
  const yb = y - len;
  const sw = opts.swell ?? 0.003;
  const pts: P2[] = [
    [zb + bev, y + 0.004],
    [zf - bev, y + 0.004],
    [fz(y - 0.008) - bev, y - 0.008, 0.004],
  ];
  if (opts.groove) {
    pts.push([fz(y - 0.026) - bev + 0.004, y - 0.026, 0.006]);
    pts.push([fz(y - 0.036) - bev + 0.001, y - 0.036, 0.004]);
  }
  pts.push([fz(y - len * 0.6) - bev + 0.002, y - len * 0.6, 0.02]);
  pts.push([fz(yb) - bev + 0.002, yb + bev, 0.006]);
  pts.push([bz(yb) + bev - (opts.heel ?? 0.004), yb + bev, 0.008]);
  pts.push([bz(y - len * 0.45) + bev - sw, y - len * 0.45, 0.03]);
  pts.push([bz(y - 0.006) + bev, y - 0.006, 0.006]);
  w.side(`grip:${key}`, () => shape(pts), 0, width, bev, m);
}

/** A trigger guard loop under a receiver, from `z0` (back) to `z1` (front), its top at `y`, its bottom `d` below. */
export function guard(w: WB, key: string, z0: number, z1: number, y: number, d: number, m: WS, width = 0.008, t = 0.0035) {
  const b = y - d;
  w.side(
    `guard:${key}`,
    () =>
      shape(
        [[z0, y + 0.001], [z1, y + 0.001], [z1 + 0.002, b + 0.006, 0.006], [z1 - 0.006, b, 0.008], [z0 + 0.004, b + 0.002, 0.008], [z0 - 0.002, y - d * 0.5, 0.006]],
        [[[z0 + t, y - 0.0005], [z1 - t, y - 0.0005], [z1 - t + 0.001, b + t + 0.004, 0.004], [z1 - t - 0.005, b + t, 0.006], [z0 + t + 0.003, b + t + 0.002, 0.006], [z0 + t, y - d * 0.5, 0.004]]],
      ),
    0,
    width,
    0.0012,
    m,
  );
}

/** A curved trigger blade hanging from (z, y), `len` long. */
export function trigger(w: WB, key: string, z: number, y: number, len: number, m: WS, width = 0.0055) {
  w.side(
    `trig:${key}`,
    () => shape([[z - 0.004, y + 0.002], [z + 0.003, y + 0.002], [z + 0.006, y - len * 0.5, 0.008], [z + 0.004, y - len, 0.003], [z + 0.0015, y - len, 0.001], [z + 0.0028, y - len * 0.5, 0.008], [z - 0.002, y - 0.003]]),
    0,
    width,
    0.001,
    m,
  );
}

/**
 * A box magazine below a well: its back and front at `zb`, `zf` where it leaves the well at `y`, `len` long, its bottom
 * swung forward by `curve` (a banana magazine), `width` across, with stiffening ribs down its sides and a floor plate.
 */
export function boxMag(w: WB, key: string, zb: number, zf: number, y: number, len: number, curve: number, width: number, m: WS, opts: { ribs?: number; plate?: WS; flare?: number; top?: number; round?: [number, number, number] } = {}) {
  // Up in the well, only seen once it is out: the top of its body, `top` tall, the lips and the top round lying in them.
  if (opts.top) {
    const t = opts.top;
    w.inner(() => {
      w.rbox(0, y + t / 2 - 0.001, (zb + zf) / 2, width - 0.003, t + 0.002, zf - zb - 0.002, 0.0012, m);
      const r = opts.round;
      if (r) cartridge(w, `mag:${key}:top`, [0, y + t + r[0] * 0.7, zb + 0.004], r[0], r[1], r[2]);
    });
  }
  const n = 6;
  const back: [number, number][] = [];
  const front: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const yy = y - len * t;
    const dz = curve * t * t;
    const grow = (opts.flare ?? 0.006) * t;
    back.push([zb + dz - grow * 0.3, yy]);
    front.push([zf + dz + grow * 0.7, yy]);
  }
  const pts: P2[] = [...front.map((p) => [p[0], p[1], 0.002] as P2), ...[...back].reverse().map((p) => [p[0], p[1], 0.002] as P2)];
  pts[n] = [pts[n][0], pts[n][1], 0.003];
  pts[n + 1] = [pts[n + 1][0], pts[n + 1][1], 0.003];
  w.side(`mag:${key}`, () => shape(pts), 0, width - 0.002, 0.001, m);
  // Ribs pressed into the sides, following the curve a run at a time.
  const ribs = opts.ribs ?? 0;
  if (ribs > 0 && w.hi) {
    for (let r = 0; r < ribs; r++) {
      const k = (r + 1) / (ribs + 1);
      const line = back.map((b, i) => [b[0] + (front[i][0] - b[0]) * k, b[1]] as [number, number]);
      for (let i = 1; i < n - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        const ang = Math.atan2(b[0] - a[0], a[1] - b[1]);
        for (const s of [1, -1]) w.box(s * (width / 2 - 0.0002), (a[1] + b[1]) / 2, (a[0] + b[0]) / 2, 0.0014, Math.hypot(b[0] - a[0], b[1] - a[1]) + 0.0006, 0.0032, m, -ang, 0, 0);
      }
    }
  }
  // The floor plate, a little proud all round, square to the magazine's last run.
  const fb = back[n];
  const ff = front[n];
  const run = Math.atan2(ff[0] - front[n - 1][0], front[n - 1][1] - ff[1]);
  w.rbox(0, y - len - 0.0025, (fb[0] + ff[0]) / 2, width + 0.002, 0.005, ff[0] - fb[0] + 0.005, 0.0018, opts.plate ?? m, run, 0, 0);
}

/**
 * A cartridge lying along +z from its head at `at`: a brass case `r` across and `len` long, the bullet `bl` long in front of
 * it (copper, or lead-grey for a revolver round), a primer in the head.
 */
export function cartridge(w: WB, key: string, at: [number, number, number], r: number, len: number, bl: number, lead = false) {
  const [x, y, z] = at;
  w.turnAlong(`${key}.case`, [[0, 0], [r * 1.02, 0], [r * 1.02, 0.04], [r * 0.9, 0.07], [r, 0.12], [r, 0.9], [r * 0.96, 1], [0, 1]], [x, y, z], [x, y, z + len], M.brass(0xb08a46, 0.3));
  w.turnAlong(`${key}.ball`, [[0, 0], [r * 0.93, 0], [r * 0.93, 0.3], [r * 0.75, 0.7], [r * 0.4, 0.93], [0, 1]], [x, y, z + len - 0.001], [x, y, z + len + bl], lead ? M.steel(0x7a7672, 0.6) : M.brass(0xb8703a, 0.25));
  if (w.hi) w.turnAlong(`${key}.primer`, [[0, 0], [r * 0.4, 0], [r * 0.4, 1], [0, 1]], [x, y, z - 0.0003], [x, y, z + 0.0004], M.steel(0x9a9ea2, 0.3));
}

/** An aperture (peep) rear sight: a ring at height `y` on a post standing on `base` (at z). */
export function peep(w: WB, z: number, y: number, base: number, m: WS, ring = 0.0055, hole = 0.0022) {
  w.torus(0, y, z, (ring + hole) / 2, (ring - hole) / 2, m);
  w.rbox(0, (base + y - ring) / 2, z, 0.006, Math.max(0.002, y - ring - base + 0.002), 0.004, 0.0008, m);
}

/** A front post with protective ears, its tip at height `y` over a base at `base`. */
export function post(w: WB, key: string, z: number, y: number, base: number, m: WS, ears = true, wide = 0.016) {
  w.rbox(0, (y + base) / 2 - 0.001, z, 0.0026, y - base, 0.0035, 0.0006, m);
  if (ears) {
    w.side(`ears:${key}`, () => shape([[z - 0.006, base], [z + 0.006, base], [z + 0.005, y + 0.003, 0.002], [z - 0.005, y + 0.003, 0.002]]), wide / 2 - 0.0015, 0.003, 0.0008, m);
    w.side(`ears:${key}`, () => shape([[z - 0.006, base], [z + 0.006, base], [z + 0.005, y + 0.003, 0.002], [z - 0.005, y + 0.003, 0.002]]), -wide / 2 + 0.0015, 0.003, 0.0008, m);
  }
}

/** A sling loop: a bent wire on a little stud, the loop's plane across the gun (`across`) or along it. */
export function swivel(w: WB, x: number, y: number, z: number, m: WS, across = true, r = 0.008) {
  if (!w.hi) return;
  w.torus(x, y - r, z, r, 0.0013, m, 0, across ? 0 : Math.PI / 2, 0);
}

/**
 * A free-float handguard of real panels from `z0` to `z1` round a bore at `y`: two side walls and a floor with M-LOK slots
 * cut through them (the barrel shows through), chamfered corners, a Picatinny rail on top, a slim ring at the front.
 */
export function mlok(w: WB, key: string, z0: number, z1: number, y: number, half: number, m: WS, rail = true) {
  const t = 0.0024;
  const L = z1 - z0;
  const n = Math.max(1, Math.floor((L - 0.03) / 0.04));
  const off = z0 + (L - n * 0.04) / 2;
  const slot = (cu: number, cv: number, lu: number, lv: number): P2[] => {
    const r = Math.min(lu, lv) / 2 - 1e-4;
    return [[cu - lu / 2, cv - lv / 2, r], [cu + lu / 2, cv - lv / 2, r], [cu + lu / 2, cv + lv / 2, r], [cu - lu / 2, cv + lv / 2, r]];
  };
  const fw = half * 1.24;
  const wallH = half * 1.24;
  const sideHoles = w.hi ? Array.from({ length: n }, (_, i) => slot(off + i * 0.04 + 0.02, y, 0.032, 0.0072)) : [];
  for (const s of [1, -1]) w.side(`ml.side:${key}`, () => shape([[z0, y - wallH / 2], [z1, y - wallH / 2], [z1, y + wallH / 2], [z0, y + wallH / 2]], sideHoles), s * (half - t / 2), t, 0.0005, m);
  const floorHoles = w.hi ? Array.from({ length: n }, (_, i) => slot(0, off + i * 0.04 + 0.02, 0.0072, 0.032)) : [];
  w.top(`ml.floor:${key}`, () => shape([[-fw / 2, z0], [fw / 2, z0], [fw / 2, z1], [-fw / 2, z1]], floorHoles), y - half + t / 2, t, 0.0005, m);
  w.sec(`ml.top:${key}`, () => shape([[-fw / 2, -t], [fw / 2, -t], [fw / 2, 0], [-fw / 2, 0]]), z0, z1, 0.0005, m, 0, y + half);
  // The chamfers at the four corners, joining the walls to the floor and the top.
  for (const sy of [1, -1])
    for (const sx of [1, -1])
      w.sec(
        `ml.ch:${key}:${sx}:${sy}`,
        () => shape([[(sx * fw) / 2, sy * half], [sx * half, (sy * wallH) / 2], [sx * (half - t), (sy * wallH) / 2], [(sx * fw) / 2 - sx * 0.0004, sy * (half - t)]]),
        z0,
        z1,
        0.0004,
        m,
        0,
        y,
      );
  if (rail) w.rail(`ml:${key}`, 0, y + half, z0 + 0.002, z1 - 0.002, m);
  // The front ring, slimmer than the body.
  if (w.hi) w.turn(`ml.ring:${key}`, [[half * 0.55, z1 - 0.004], [half * 0.95, z1 - 0.004], [half * 0.97, z1], [half * 0.6, z1 + 0.0006], [half * 0.55, z1 + 0.0006]], 0, y, m);
}

/**
 * A riflescope on the axis at height `y`, its eyepiece at `z0` and its objective at `z1`: an open tube (the eye looks
 * through it behind the sights, so there is no solid lens), the ocular and objective bells, the power ring, the turrets,
 * and a fine crosshair with a lit centre in the objective's plane. `obj` and `ocu` are the bells' radii, `r` the tube's.
 */
export function scope(w: WB, key: string, y: number, z0: number, z1: number, r: number, ocu: number, obj: number, m: WS, opts: { turrets?: 'capped' | 'target'; ring?: boolean } = {}) {
  const L = z1 - z0;
  const t = 0.0014;
  const zo = z0 + L * 0.22;
  const zt = z0 + L * 0.48;
  const zb = z1 - L * 0.3;
  // Outside from the eyepiece forward, then back along the inside: one shell, open at both ends.
  const prof: [number, number][] = [
    [ocu - t, z0],
    [ocu, z0 + 0.001],
    [ocu, z0 + L * 0.12],
    [r + 0.003, zo],
    [r, zo + 0.004],
    [r, zb],
    [obj, zb + L * 0.12],
    [obj, z1 - 0.001],
    [obj - t, z1],
    [obj - t * 1.5, z1 - 0.004],
    [r - t, zb + 0.004],
    [r - t, zo + 0.004],
    [ocu - t * 1.5, z0 + 0.004],
    [ocu - t, z0],
  ];
  w.turn(`scope:${key}`, prof, 0, y, m, undefined, 0.5);
  if (w.hi) {
    // The power ring's ribs behind the turrets, and a dark ring of glass round the objective's rim.
    for (let i = 0; i < 6; i++) w.turn(`scope.rib:${key}`, [[r + 0.0028, 0], [r + 0.0036, 0.0012], [r + 0.0028, 0.0024]], 0, y, M.knurl(0x1c1d20, 0.3), undefined, 0.7, zo - 0.012 + i * 0.0026);
    w.turn(`scope.lens:${key}`, [[obj - t * 1.6, 0], [obj - t * 1.6 - 0.0025, 0.0008], [obj - t * 1.6 - 0.0025, 0.0016], [obj - t * 1.6, 0.0024]], 0, y, M.glass(0x0a1820), undefined, 0.7, z1 - 0.012);
  }
  // Turrets: elevation on top, windage on the right, parallax on the left.
  const tall = opts.turrets === 'target' ? 0.022 : 0.012;
  const tr = opts.turrets === 'target' ? 0.0125 : 0.0085;
  // The turret saddle: a fatter band round the tube (never across it: the eye looks down the middle).
  w.turn(`scope.saddle:${key}`, [[r - 0.0005, zt - 0.016], [r + 0.0034, zt - 0.014], [r + 0.0042, zt - 0.008], [r + 0.0042, zt + 0.008], [r + 0.0034, zt + 0.014], [r - 0.0005, zt + 0.016]], 0, y, m);
  w.turnAlong(`scope.tu:${key}`, [[0, 0], [tr * 0.85, 0], [tr * 0.85, 0.4], [tr, 0.45], [tr, 1], [0, 1]], [0, y + r, zt], [0, y + r + tall, zt], opts.turrets === 'target' ? M.knurl(0x202124, 0.3) : m);
  w.turnAlong(`scope.tu:${key}`, [[0, 0], [tr * 0.85, 0], [tr * 0.85, 0.4], [tr, 0.45], [tr, 1], [0, 1]], [-r, y, zt], [-r - tall, y, zt], opts.turrets === 'target' ? M.knurl(0x202124, 0.3) : m);
  if (opts.turrets === 'target') w.turnAlong(`scope.px:${key}`, [[0, 0], [tr * 0.7, 0], [tr * 0.7, 1], [0, 1]], [r, y, zt], [r + tall * 0.6, y, zt], M.knurl(0x202124, 0.3));
  // The reticle: two hairs across the objective's inside, a lit dot where they cross.
  const ri = obj - t * 1.6;
  w.box(0, y, z1 - 0.006, ri * 2, 0.00035, 0.0003, M.hole());
  w.box(0, y, z1 - 0.006, 0.00035, ri * 2, 0.0003, M.hole());
  w.box(0, y, z1 - 0.0062, 0.0011, 0.0011, 0.0003, M.glow(0xff3a1c, 2.2));
}

/** Scope rings on a rail or base at `base`, round a tube of radius `r` at height `y`, at each z in `zs`. */
export function rings(w: WB, key: string, base: number, y: number, r: number, zs: number[], m: WS) {
  for (const z of zs) {
    w.turn(`ring:${key}`, [[r, -0.006], [r + 0.0038, -0.006], [r + 0.0042, -0.005], [r + 0.0042, 0.005], [r + 0.0038, 0.006], [r, 0.006]], 0, y, m, undefined, 0.7, z);
    w.rbox(0, (base + y - r) / 2, z, 0.014, Math.max(0.003, y - r - base + 0.002), 0.012, 0.0015, m);
    if (w.hi) for (const s of [1, -1]) w.screw(s * (r + 0.0045), y + r * 0.7, z, s > 0 ? 'x' : '-x', 0.0018, m);
  }
}
