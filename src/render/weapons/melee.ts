import * as THREE from 'three';
import { M, shape, type P2, type WB, type WS } from './kit';
import { C } from '../palette';

/**
 * Blades, clubs and tools, each held at the origin round the handle's line along +z (the head or the blade forward): a
 * hunting knife with a stacked-leather handle, a machete, a katana with its curve, temper line and wrapped handle, an ash
 * bat taped at the grip, a fire axe with its pick, a lead pipe ending in an elbow, a sledgehammer, a big adjustable wrench,
 * a crowbar, a NATO jerrycan and a road flare.
 */

/**
 * A ground blade lofted between its spine and its edge (points (z, y) from the heel to the tip, the same count): flat
 * sides from the spine down to the grind line (`grind` of the way from the edge to the spine, per point), then a bevel
 * running in to the edge. `t` is the spine's thickness, tapering to nothing at the tip.
 */
function blade(w: WB, key: string, spine: [number, number][], edge: [number, number][], grind: number[], t: number, flat: WS, ground: WS) {
  const make = (side: 'flat' | 'ground') => {
    const pos: number[] = [];
    const idx: number[] = [];
    const n = spine.length;
    const th = (i: number) => (t / 2) * (1 - Math.pow(i / (n - 1), 3) * 0.9) * (i === n - 1 ? 0 : 1);
    const G = (i: number): [number, number] => [edge[i][0] + (spine[i][0] - edge[i][0]) * grind[i], edge[i][1] + (spine[i][1] - edge[i][1]) * grind[i]];
    const v = (x: number, p: [number, number]) => {
      pos.push(x, p[1], p[0]);
      return pos.length / 3 - 1;
    };
    for (const s of [1, -1]) {
      for (let i = 0; i < n - 1; i++) {
        const a = side === 'flat' ? [v(s * th(i), spine[i]), v(s * th(i), G(i)), v(s * th(i + 1), G(i + 1)), v(s * th(i + 1), spine[i + 1])] : [v(s * th(i), G(i)), v(0, edge[i]), v(0, edge[i + 1]), v(s * th(i + 1), G(i + 1))];
        if (s > 0) idx.push(a[0], a[2], a[1], a[0], a[3], a[2]);
        else idx.push(a[0], a[1], a[2], a[0], a[2], a[3]);
      }
    }
    if (side === 'flat') {
      // The spine's top, and the heel's face.
      for (let i = 0; i < n - 1; i++) {
        const a = [v(th(i), spine[i]), v(-th(i), spine[i]), v(-th(i + 1), spine[i + 1]), v(th(i + 1), spine[i + 1])];
        idx.push(a[0], a[2], a[1], a[0], a[3], a[2]);
      }
      const h = [v(th(0), spine[0]), v(-th(0), spine[0]), v(-th(0), G(0)), v(th(0), G(0)), v(0, edge[0])];
      idx.push(h[0], h[1], h[2], h[0], h[2], h[3], h[3], h[2], h[4]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  };
  w.put(w.custom(`blade:${key}:flat`, () => make('flat'), 0.35), 0, 0, 0, flat);
  w.put(w.custom(`blade:${key}:ground`, () => make('ground'), 0.35), 0, 0, 0, ground);
}

/** A handle of oval section along z from `z0` to `z1`, `rx` by `ry`. */
function handle(w: WB, key: string, z0: number, z1: number, rx: number, ry: number, m: WS, x = 0, y = 0) {
  const n = 20;
  w.sec(`hdl:${key}`, () => shape(Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * rx, Math.sin((i / n) * Math.PI * 2) * ry] as P2)), z0, z1, Math.min(rx, ry) * 0.35, m, x, y);
}

// ---------------------------------------------------------------------------------------------------- blades

export function knife(w: WB) {
  const steel = M.bright(0xb0b4b8, 0.25);
  const edge = M.bright(0xd0d4d8, 0.15);
  edge.r = 0.16;
  const spine: [number, number][] = [[0.068, 0.0115], [0.12, 0.0125], [0.19, 0.0128], [0.225, 0.009], [0.255, 0.0045], [0.276, 0.0005]];
  const edgeL: [number, number][] = [[0.068, -0.0155], [0.12, -0.0175], [0.19, -0.016], [0.225, -0.012], [0.255, -0.006], [0.276, 0.0005]];
  blade(w, 'knife', spine, edgeL, [0.42, 0.42, 0.45, 0.5, 0.55, 0.6], 0.0052, steel, edge);
  // A fuller down the flat near the spine (both sides).
  if (w.hi) for (const s of [1, -1]) w.box(s * 0.0024, 0.0065, 0.13, 0.0008, 0.0035, 0.09, M.steel(0x7a7e82, 0.3));
  // Brass guard, stacked leather handle with its spacers, a brass pommel.
  w.side('kn.guard', () => shape([[0.058, -0.026, 0.006], [0.067, -0.026, 0.004], [0.067, 0.02, 0.004], [0.058, 0.02, 0.006]]), 0, 0.012, 0.0018, M.brass(0xb08a46, 0.4));
  handle(w, 'kn', -0.058, 0.058, 0.0118, 0.0148, M.leather(0x4a2e18, 0.45));
  if (w.hi) for (let z = -0.05; z < 0.056; z += 0.0075) w.turn('kn.ring', [[0.0115, 0], [0.0122, 0.0006], [0.0122, 0.0012], [0.0115, 0.0018]], 0, 0, M.leather(0x2a1a10, 0.5), 16, 0.7, z);
  for (const z of [-0.06, 0.056]) handle(w, `kn.sp${z}`, z - 0.002, z + 0.002, 0.0125, 0.0155, M.poly(0x1a1210, 0.3));
  w.turn('kn.pommel', [[0, -0.078], [0.006, -0.077], [0.012, -0.072], [0.0135, -0.066], [0.0125, -0.061], [0, -0.061]], 0, 0, M.brass(0xb08a46, 0.4));
}

export function machete(w: WB) {
  const steel = M.steel(0x6a6e72, 0.55);
  const edge = M.bright(0xb8bcc0, 0.3);
  const spine: [number, number][] = [[0.095, 0.016], [0.25, 0.019], [0.45, 0.022], [0.56, 0.022], [0.605, 0.016], [0.628, 0.0]];
  const edgeL: [number, number][] = [[0.095, -0.02], [0.25, -0.026], [0.45, -0.034], [0.56, -0.036], [0.605, -0.028], [0.628, 0.0]];
  blade(w, 'machete', spine, edgeL, [0.28, 0.28, 0.3, 0.32, 0.35, 0.4], 0.0032, steel, edge);
  // Polymer handle with finger ridges, its rivets, the guard flange and the lanyard hole.
  w.side('mc.handle', () => shape([[-0.078, 0.011, 0.008], [0.09, 0.015, 0.004], [0.09, -0.019, 0.004], [0.02, -0.018, 0.01], [0.004, -0.022, 0.006], [-0.012, -0.018, 0.006], [-0.028, -0.022, 0.006], [-0.045, -0.018, 0.006], [-0.078, -0.016, 0.01]], [{ c: [-0.066, -0.002], r: 0.004 }]), 0, 0.026, w.hi ? 0.006 : 0.004, M.stipple(0x1b1c1e, 0.35));
  for (const z of [-0.035, 0.0, 0.04]) for (const s of [1, -1]) w.turnAlong('mc.rivet', [[0, 0], [0.0032, 0], [0.0032, 0.5], [0.002, 1], [0, 1]], [s * 0.012, -0.002, z], [s * 0.0145, -0.002, z], M.bright(0x9a9ea2), 10);
  w.side('mc.guard', () => shape([[0.088, -0.026, 0.004], [0.098, -0.026, 0.004], [0.098, 0.02, 0.004], [0.088, 0.02, 0.004]]), 0, 0.03, 0.0025, M.poly(0x1b1c1e, 0.35));
}

export function katana(w: WB) {
  const body = M.bright(0x9a9ea2, 0.15);
  body.r = 0.28;
  const ha = M.bright(0xc8ccd0, 0.12);
  ha.r = 0.14;
  // The curve rises toward the tip; the temper line waves along it.
  const n = 9;
  const spine: [number, number][] = [];
  const edgeL: [number, number][] = [];
  const grind: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const z = 0.15 + t * 0.64;
    const rise = 0.04 * t * t;
    const wdt = 0.032 - 0.006 * t;
    spine.push([z, 0.012 + rise]);
    edgeL.push([z, 0.012 + rise - wdt]);
    grind.push(0.42 + Math.sin(t * 23) * 0.06);
  }
  // The point (kissaki): the edge sweeps up to meet the spine.
  spine[n - 1] = [0.795, 0.052];
  edgeL[n - 1] = [0.795, 0.052];
  edgeL[n - 2] = [0.762, 0.026];
  blade(w, 'katana', spine, edgeL, grind, 0.0068, body, ha);
  // Habaki, tsuba with its openings, seppa, the wrapped tsuka with same showing, the kashira.
  w.side('kt.habaki', () => shape([[0.13, -0.022, 0.003], [0.155, -0.021, 0.003], [0.155, 0.014, 0.003], [0.13, 0.015, 0.003]]), 0, 0.011, 0.002, M.brass(0xb89040, 0.3));
  w.sec('kt.tsuba', () => shape(Array.from({ length: 24 }, (_, i) => [Math.cos((i / 24) * Math.PI * 2) * 0.036, Math.sin((i / 24) * Math.PI * 2) * 0.039 - 0.004] as P2), w.hi ? [[[0.016, 0.006], [0.026, 0.006], [0.026, 0.018], [0.016, 0.018]], [[-0.016, 0.006], [-0.026, 0.006], [-0.026, 0.018], [-0.016, 0.018]]] : []), 0.118, 0.126, 0.0012, M.blued(0x1c1c1e, 0.5));
  handle(w, 'kt.same', -0.12, 0.118, 0.0128, 0.0158, M.leather(0xe8e2d0, 0.3));
  // The ito: cord wrapped in crossing turns, leaving diamonds of same between them.
  const cord = M.cord(0x1a1a20, 0.4);
  const turns = w.hi ? 9 : 5;
  for (let i = 0; i < turns; i++) {
    const z = -0.106 + (i / (turns - 1)) * 0.21;
    for (const s of [1, -1]) {
      w.rbox(0.0125 * s, 0, z, 0.003, 0.034, 0.012, 0.0014, cord, 0.5 * s, 0, 0);
      w.rbox(0, 0.0155 * s, z + 0.012, 0.028, 0.003, 0.012, 0.0014, cord, 0, 0, 0.5 * s);
    }
  }
  w.rbox(0.0136, 0.0, 0.0, 0.003, 0.012, 0.026, 0.002, M.brass(0xa88438, 0.4));
  w.rbox(-0.0136, 0.0, -0.01, 0.003, 0.012, 0.026, 0.002, M.brass(0xa88438, 0.4));
  handle(w, 'kt.fuchi', 0.104, 0.118, 0.0142, 0.0172, M.blued(0x1c1c1e, 0.5));
  handle(w, 'kt.kashira', -0.134, -0.118, 0.0142, 0.0172, M.blued(0x1c1c1e, 0.5));
}

// ---------------------------------------------------------------------------------------------------- clubs

export function bat(w: WB) {
  const ash = M.wood(0xc8a066, 0.45);
  ash.r = 0.42;
  // Knob, handle, the long taper, the barrel and its cupped end.
  w.turn('bat', [[0, -0.068], [0.014, -0.067], [0.021, -0.06], [0.0215, -0.054], [0.0135, -0.046], [0.0128, 0.06], [0.0135, 0.2], [0.018, 0.34], [0.027, 0.47], [0.0325, 0.6], [0.0335, 0.8], [0.032, 0.825], [0.024, 0.835], [0.008, 0.832], [0, 0.828]], 0, 0, ash, w.hi ? 24 : 10);
  // Tape wound up the handle, its edges standing proud a hair.
  w.turn('bat.tape', [[0.0136, -0.044], [0.0142, -0.043], [0.0144, 0.16], [0.0138, 0.17]], 0, 0, M.tape(0x161618, 0.5), w.hi ? 20 : 8);
  if (w.hi) for (let i = 0; i < 8; i++) w.turn('bat.seam', [[0.0144, 0], [0.0147, 0.001], [0.0144, 0.002]], 0, 0, M.tape(0x0c0c0e, 0.5), 20, 0.7, -0.03 + i * 0.024);
  // The maker's oval burnt into the barrel.
  if (w.hi) w.side('bat.brand', () => shape([[0.56, -0.004, 0.006], [0.64, -0.004, 0.006], [0.64, 0.01, 0.006], [0.56, 0.01, 0.006]]), 0.0333, 0.0006, 0, M.wood(0x3a2414, 0.4));
}

export function pipe(w: WB) {
  const lead = M.steel(0x5e6266, 0.75);
  lead.r = 0.62;
  w.tube(0, 0, -0.02, 0.66, 0.0168, lead, 0.0012);
  // Threads at the far end, a coupling and an elbow screwed onto it.
  if (w.hi) for (let i = 0; i < 6; i++) w.turn('pipe.thr', [[0.0168, 0], [0.0174, 0.0012], [0.0168, 0.0024]], 0, 0, lead, 16, 0.7, 0.62 + i * 0.0026);
  w.turn('pipe.coupling', [[0, 0.636], [0.021, 0.636], [0.0225, 0.64], [0.0225, 0.672], [0.021, 0.676], [0, 0.676]], 0, 0, M.steel(0x6a6c6a, 0.8));
  w.rbox(0, 0.0, 0.69, 0.042, 0.042, 0.03, 0.01, M.steel(0x6a6c6a, 0.8));
  w.turnAlong('pipe.elbow', [[0, 0], [0.021, 0], [0.0225, 0.1], [0.0225, 0.9], [0.021, 1], [0, 1]], [0, 0.012, 0.69], [0, 0.05, 0.69], M.steel(0x6a6c6a, 0.8));
  // Tape round the grip end.
  w.turn('pipe.tape', [[0.0168, -0.022], [0.0185, -0.02], [0.0188, 0.14], [0.0172, 0.145]], 0, 0, M.tape(0x2a2a2c, 0.6));
}

export function sledge(w: WB) {
  const hickory = M.wood(0xb88a52, 0.5);
  handle(w, 'sl.haft', -0.02, 0.8, 0.0135, 0.019, hickory);
  w.turn('sl.grip', [[0.0, -0.03], [0.018, -0.03], [0.022, -0.02], [0.021, 0.16], [0.017, 0.17], [0, 0.17]], 0, 0, M.rubber(0x161616, 0.4));
  if (w.hi) for (let i = 0; i < 9; i++) w.turn('sl.ridge', [[0.0212, 0], [0.0225, 0.004], [0.0212, 0.008]], 0, 0, M.rubber(0x101010, 0.4), 16, 0.7, -0.012 + i * 0.018);
  // The head: a chamfered steel block across the haft, painted, its striking faces bare.
  const head = () => shape([[-0.03, -0.03, 0.006], [0.03, -0.03, 0.006], [0.03, 0.03, 0.006], [-0.03, 0.03, 0.006]]);
  const zc = 0.82;
  w.put(w.extruded('sl.head', head, 0.17, 0.006), 0, 0, zc, M.paint(0x1c1c1e, 0.5), 0, Math.PI / 2, 0);
  for (const s of [1, -1]) w.put(w.extruded('sl.face', head, 0.018, 0.005), s * 0.093, 0, zc, M.steel(0x8a8e92, 0.5), 0, Math.PI / 2, 0);
  w.rbox(0, 0, zc - 0.037, 0.034, 0.034, 0.012, 0.004, M.steel(0x3a3c3e, 0.5));
}

export function axe(w: WB) {
  const hickory = M.wood(0xb07e44, 0.5);
  handle(w, 'ax.haft', -0.06, 0.8, 0.0135, 0.0185, hickory);
  w.turn('ax.knob', [[0, -0.075], [0.012, -0.074], [0.019, -0.065], [0.019, -0.05], [0, -0.05]], 0, 0, hickory);
  // The head: the eye round the haft, a red-painted blade up to its bare edge, a pick down to its point.
  const zc = 0.74;
  const red = M.paint(0xa8241a, 0.55);
  w.side('ax.eye', () => shape([[zc - 0.035, -0.04, 0.008], [zc + 0.035, -0.04, 0.008], [zc + 0.035, 0.04, 0.008], [zc - 0.035, 0.04, 0.008]]), 0, 0.034, 0.004, red);
  // The blade: lofted from the eye out to the curved edge, the flats painted, the bevel ground bright.
  const n = 7;
  const spine: [number, number][] = [];
  const edgeL: [number, number][] = [];
  const grind: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = (t - 0.5) * 1.4;
    edgeL.push([zc + Math.sin(a) * 0.105, 0.04 + Math.cos(a) * 0.12]);
    spine.push([zc + (t - 0.5) * 0.06, 0.04]);
    grind.push(0.2);
  }
  // Loft it sideways: spine along the eye's top, edge out along the arc.
  axeBlade(w, spine, edgeL, red, M.bright(0xc0c4c8, 0.35));
  // The pick: a tapering spike down from the eye.
  w.side('ax.pick', () => shape([[zc - 0.03, -0.038], [zc + 0.03, -0.038], [zc + 0.006, -0.17, 0.002], [zc - 0.004, -0.17, 0.002]]), 0, 0.024, 0.003, red);
  w.side('ax.tip', () => shape([[zc + 0.0075, -0.15], [zc + 0.006, -0.172, 0.002], [zc - 0.004, -0.172, 0.002], [zc - 0.006, -0.15]]), 0, 0.024, 0.003, M.bright(0xa8acb0, 0.4));
}

/** The axe's blade: a wedge from the eye (thick) to the edge (sharp), in the gun-frame's (z, y) plane. */
function axeBlade(w: WB, spine: [number, number][], edge: [number, number][], paint: WS, bare: WS) {
  const thick = 0.034;
  const bandOf = (k: number): [number, number][] => spine.map((s, i) => [s[0] + (edge[i][0] - s[0]) * k, s[1] + (edge[i][1] - s[1]) * k]);
  const g = bandOf(0.82);
  const make = (from: [number, number][], to: [number, number][], t0: number, t1: number) => () => {
    const pos: number[] = [];
    const idx: number[] = [];
    const v = (x: number, p: [number, number]) => {
      pos.push(x, p[1], p[0]);
      return pos.length / 3 - 1;
    };
    for (const s of [1, -1])
      for (let i = 0; i < from.length - 1; i++) {
        const a = [v(s * t0, from[i]), v(s * t1, to[i]), v(s * t1, to[i + 1]), v(s * t0, from[i + 1])];
        if (s > 0) idx.push(a[0], a[1], a[2], a[0], a[2], a[3]);
        else idx.push(a[0], a[2], a[1], a[0], a[3], a[2]);
      }
    // The ends of the band.
    for (const i of [0, from.length - 1]) {
      const a = [v(t0, from[i]), v(-t0, from[i]), v(-t1, to[i]), v(t1, to[i])];
      if (i === 0) idx.push(a[0], a[2], a[1], a[0], a[3], a[2]);
      else idx.push(a[0], a[1], a[2], a[0], a[2], a[3]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return geo;
  };
  w.put(w.custom('ax.cheek', make(spine, g, thick / 2, 0.0028), 0.5), 0, 0, 0, paint);
  w.put(w.custom('ax.edge', make(g, edge, 0.0028, 0.0002), 0.5), 0, 0, 0, bare);
}

// ---------------------------------------------------------------------------------------------------- tools

export function wrench(w: WB) {
  const chrome = M.bright(0xb4b8bc, 0.3);
  // The forged handle, thinner in its middle, a hanging hole at the end.
  w.side('wr.handle', () => shape([[-0.035, -0.012, 0.012], [0.33, -0.014, 0.02], [0.37, -0.02, 0.02], [0.37, 0.018, 0.01], [0.33, 0.012, 0.02], [-0.035, 0.011, 0.012]], [{ c: [-0.018, 0], r: 0.0055 }]), 0, 0.012, 0.003, chrome);
  if (w.hi) for (const s of [1, -1]) w.side('wr.web', () => shape([[0.0, -0.006, 0.004], [0.3, -0.008, 0.006], [0.3, 0.006, 0.006], [0.0, 0.005, 0.004]]), s * 0.0058, 0.0012, 0, M.bright(0x9a9ea2, 0.35));
  // The head: the fixed jaw, the moving jaw on its rack, the knurled worm between them.
  w.side('wr.head', () => shape([[0.36, -0.022, 0.006], [0.445, -0.016, 0.01], [0.47, 0.004, 0.006], [0.468, 0.03, 0.004], [0.452, 0.03, 0.002], [0.45, 0.012, 0.004], [0.4, 0.008, 0.004], [0.395, 0.03, 0.004], [0.37, 0.03, 0.006], [0.355, 0.018, 0.006]]), 0, 0.018, 0.003, chrome);
  w.side('wr.jaw', () => shape([[0.4, 0.002, 0.003], [0.442, 0.002, 0.003], [0.442, 0.038, 0.004], [0.424, 0.04, 0.004], [0.423, 0.012, 0.002], [0.4, 0.012, 0.003]]), 0, 0.016, 0.0025, M.bright(0xa4a8ac, 0.3));
  w.turnAlong('wr.worm', [[0, 0], [0.0062, 0], [0.0062, 1], [0, 1]], [0, -0.004, 0.412], [0, -0.004, 0.436], M.knurl(0x8a8e92, 0.35));
}

export function crowbar(w: WB) {
  const paint = M.paint(0x8a1c14, 0.6);
  const hex = () => shape(Array.from({ length: 6 }, (_, i) => [Math.cos((i / 6) * Math.PI * 2) * 0.0115, Math.sin((i / 6) * Math.PI * 2) * 0.0115, 0.0012] as P2));
  w.sec('cb.bar', hex, -0.03, 0.47, 0, paint);
  // The chisel end: flattened and bare.
  w.side('cb.chisel', () => shape([[-0.075, -0.003], [-0.03, -0.01], [-0.03, 0.01], [-0.075, 0.003]]), 0, 0.02, 0.002, M.steel(0x6a6e72, 0.7));
  // The gooseneck: short runs of the bar bent up, then the forked claw.
  const pts: [number, number][] = [[0.47, 0], [0.51, 0.006], [0.545, 0.022], [0.57, 0.048], [0.585, 0.078]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    w.put(w.extruded('cb.neck', hex, len + 0.006, 0), 0, (a[1] + b[1]) / 2, (a[0] + b[0]) / 2, paint, -ang, 0, 0);
  }
  w.side('cb.claw', () => shape([[0.578, 0.07], [0.598, 0.072], [0.612, 0.104, 0.002], [0.6, 0.112, 0.002], [0.585, 0.09]]), 0.0055, 0.008, 0.0015, M.steel(0x6a6e72, 0.6));
  w.side('cb.claw', () => shape([[0.578, 0.07], [0.598, 0.072], [0.612, 0.104, 0.002], [0.6, 0.112, 0.002], [0.585, 0.09]]), -0.0055, 0.008, 0.0015, M.steel(0x6a6e72, 0.6));
}

export function jerrycan(w: WB) {
  const paint = M.paint(C.fuel, 0.6);
  // Body: the can hangs below the handle in the hand, its long side along z.
  const cx = 0.05;
  const cy = -0.18;
  const cz = 0.07;
  const H = 0.4;
  const L = 0.3;
  const T = 0.15;
  w.rbox(cx, cy, cz, T, H, L, 0.018, paint);
  // The welded seam round the middle, and the stamped X on each face inside a raised border.
  w.rbox(cx, cy, cz, 0.006, H + 0.006, L + 0.006, 0.004, paint);
  for (const s of [1, -1]) {
    const x = cx + s * (T / 2);
    w.side('jc.border', () => shape([[cz - L / 2 + 0.025, cy - H / 2 + 0.025], [cz + L / 2 - 0.025, cy - H / 2 + 0.025], [cz + L / 2 - 0.025, cy + H / 2 - 0.035], [cz - L / 2 + 0.025, cy + H / 2 - 0.035]], [[[cz - L / 2 + 0.034, cy - H / 2 + 0.034], [cz + L / 2 - 0.034, cy - H / 2 + 0.034], [cz + L / 2 - 0.034, cy + H / 2 - 0.044], [cz - L / 2 + 0.034, cy + H / 2 - 0.044]]]), x, 0.006, 0.0015, paint);
    const d = Math.atan2(H - 0.08, L - 0.07);
    for (const a of [d, -d]) w.rbox(x, cy - 0.005, cz, 0.006, 0.012, Math.hypot(H - 0.08, L - 0.07), 0.003, paint, a, 0, 0);
  }
  // Three handles on top (the middle one held), the spout with its clamped cap at the front corner.
  for (const z of [cz - 0.075, 0.06, cz + 0.075]) {
    w.rod([cx, cy + H / 2, z - 0.025], [cx, 0.06, z - 0.02], 0.006, paint);
    w.rod([cx, cy + H / 2, z + 0.025], [cx, 0.06, z + 0.02], 0.006, paint);
    w.rod([cx, 0.06, z - 0.02], [cx, 0.06, z + 0.02], 0.0075, paint);
  }
  w.turnAlong('jc.spout', [[0, 0], [0.024, 0], [0.024, 0.6], [0.026, 0.65], [0.026, 1], [0, 1]], [cx, cy + H / 2 - 0.004, cz + L / 2 - 0.045], [cx, cy + H / 2 + 0.03, cz + L / 2 - 0.035], paint);
  w.rbox(cx, cy + H / 2 + 0.03, cz + L / 2 - 0.06, 0.012, 0.01, 0.04, 0.003, M.steel(0x5a5e62, 0.6));
}

export function flare(w: WB) {
  const red = M.paint(0xc8302a, 0.45);
  red.f = M.tape().f;
  w.turn('fl.body', [[0, -0.005], [0.0165, -0.004], [0.017, 0.0], [0.017, 0.255], [0.0, 0.255]], 0, 0, red);
  if (w.hi) w.turn('fl.band', [[0.0171, 0.1], [0.0174, 0.101], [0.0174, 0.15], [0.0171, 0.151]], 0, 0, M.paint(0xe8e2d0, 0.3));
  w.turn('fl.cap', [[0, -0.022], [0.0176, -0.02], [0.0182, -0.012], [0.0182, 0.018], [0.0176, 0.02], [0, 0.02]], 0, 0, M.poly(0x2a2a2c, 0.3));
  // The lit end, burning back into the tube.
  w.turn('fl.burn', [[0, 0.255], [0.016, 0.255], [0.014, 0.262], [0.008, 0.268], [0, 0.27]], 0, 0, M.glow(0xffc070, 3));
}
