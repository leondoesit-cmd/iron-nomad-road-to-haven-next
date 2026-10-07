import * as THREE from 'three';
import { MeshBuilder, S, type ColorIn } from './builder';
import type { PropKind } from '../world/layout';
import { CH, CH_WALLS, MH, MH_WALLS, OM, OM_WALLS, fencePosts, stairSteps, terraceEdges, type ArchOpening, type WallRun } from '../world/heritage';
import { CULVERT_OUT } from '../world/millBend';

/**
 * The real buildings of `world/heritage.ts`, drawn from the same numbers. Local frame as for every prop: the pad at y = 0,
 * +Z out of the front, metres. Drawn by the far landscape for the whole map, and collided as drawn.
 */

export const HERITAGE_KINDS = new Set<PropKind>(['concreteHouse', 'mudHut', 'oldMill', 'culvert']);

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A wall run's outline with its openings: doorways are notches in the foot, windows holes, each with a round head or square. */
function wallShape(w: WallRun): THREE.Shape {
  const ops = [...w.ops].sort((p, q) => p.at - q.at);
  const H = w.y1 - w.y0;
  const s = new THREE.Shape();
  s.moveTo(w.a0, 0);
  for (const op of ops) {
    if (op.sill > 0) continue;
    const l = op.at - op.w / 2;
    const r = op.at + op.w / 2;
    s.lineTo(l, 0);
    s.lineTo(l, op.spring);
    if (op.square) s.lineTo(r, op.spring);
    else s.absarc(op.at, op.spring, op.w / 2, Math.PI, 0, true);
    s.lineTo(r, 0);
  }
  s.lineTo(w.a1, 0);
  s.lineTo(w.a1, H);
  s.lineTo(w.a0, H);
  s.closePath();
  for (const op of ops) {
    if (op.sill <= 0) continue;
    const l = op.at - op.w / 2;
    const r = op.at + op.w / 2;
    const hole = new THREE.Path();
    hole.moveTo(l, op.sill);
    hole.lineTo(r, op.sill);
    hole.lineTo(r, op.spring);
    if (op.square) hole.lineTo(l, op.spring);
    else hole.absarc(op.at, op.spring, op.w / 2, 0, Math.PI, false);
    hole.lineTo(l, op.sill);
    s.holes.push(hole);
  }
  return s;
}

/** Half a ring, `rad` to `rad + band`, over the top: an arch's moulded surround. */
function archBand(rad: number, band: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(rad + band, 0);
  s.absarc(0, 0, rad + band, 0, Math.PI, false);
  s.lineTo(-rad, 0);
  s.absarc(0, 0, rad, Math.PI, 0, true);
  s.closePath();
  return s;
}

/**
 * Place something along a wall run's outside face: `a` along the run, `y` up from the storey's foot, `proud` out of the face.
 * Boxes take their size along the run, up and out.
 */
function faceBox(b: MeshBuilder, w: WallRun, a: number, y: number, proud: number, along: number, tall: number, deep: number, c: ColorIn) {
  const n = w.c + w.out * (CH.t / 2 + proud - deep / 2);
  if (w.axis === 'x') b.box(a, w.y0 + y, n, along, tall, deep, c);
  else b.box(n, w.y0 + y, a, deep, tall, along, c);
}

/**
 * The Concrete House (Beit HaBeton), the 1912 pumping station on the Yarkon: a grey rendered block with an arcade of three
 * round arches on the front and two on the right side, pilasters with simple capitals between them, a deep cornice, and a
 * smaller upper storey set back behind a railed terrace, its two tall arches onto the terrace, narrow arched windows down its
 * sides and a crenellated parapet. An open stair climbs the left wall to the terrace. Inside the hall the old pump is still
 * there: the well head with its grate, the engine on its bed with a flywheel, the pipes. A welded mesh fence (one panel down)
 * runs along the front and the right side; felled eucalyptus logs and a fluted stone drum lie in the yard. It has no collider
 * of its own: `heritageAabbs` gives it boxes from the same numbers.
 */
export function concreteHouse(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.06;
  const r = rng(seed + 11);
  const render = S.concrete(0x9a958b, 0.65);
  const light = S.concrete(0xaaa59a, 0.55);
  const stain = S.concrete(0x726e66, 0.85);
  const plinthS = S.concrete(0x857f73, 0.75);
  // Floors under the slabs: dark and warm (the sky's light that a covered floor would not get still reaches them).
  const floor = S.concrete(0x4a4239, 0.9);
  const rubble = S.concrete(0x6f685e, 0.85);
  const roofS = S.concrete(0x5f5b55, 0.9);
  const dark = S.concrete(0x16140f, 0.3);
  const rail = S.steel(0x565b5d, 0.8);
  const rust = S.rust(0x77472b);
  const T = CH.t;
  const { hw, hd, plinth, g1, deck, uhw, uz0, uz1, u1, roof } = CH;

  // Plinth: down into the ground (the pad slopes away toward the river), a step round its foot.
  b.box(0, (plinth - 1.8) / 2, 0, hw * 2 + 0.2, plinth + 1.8, hd * 2 + 0.2, plinthS);
  b.box(0, 0.11, 0, hw * 2 + 0.9, 0.22, hd * 2 + 0.9, plinthS);
  b.box(0, plinth + 0.005, 0, (hw - T) * 2, 0.01, (hd - T) * 2, floor);

  // Walls, with their arches cut.
  CH_WALLS.forEach((w, i) => {
    const key = `concreteHouse:wall${i}`;
    if (w.axis === 'x') b.extrude(key, () => wallShape(w), T, 0, 0, w.y0, w.c, render);
    else b.extrude(key, () => wallShape(w), T, 0, w.c, w.y0, 0, render, 0, -Math.PI / 2, 0);
    // A moulded band round each arch, a keystone at its crown, a sill under each window, impost blocks where it springs.
    for (const op of w.ops) archTrim(b, w, op, light);
  });

  // Pilasters with a base and a capital, and quoins at the corners.
  const pil = (w: WallRun, a: number, wid: number, top: number) => {
    faceBox(b, w, a, (top + 0.3) / 2, 0.1, wid, top - 0.3, 0.1, light);
    faceBox(b, w, a, 0.18, 0.14, wid + 0.14, 0.36, 0.14, light);
    faceBox(b, w, a, top - 0.12, 0.16, wid + 0.2, 0.24, 0.16, light);
  };
  const [gFront, gBack, gRight, gLeft, uFront, uBack, uRight, uLeft] = CH_WALLS;
  const gTop = g1 - 0.3 - plinth;
  const uTop = u1 - 0.25 - deck;
  for (const a of [-2.1, 2.1]) pil(gFront, a, 0.62, gTop);
  for (const a of [-2.1, 2.1]) pil(gBack, a, 0.56, gTop);
  pil(gRight, -0.3, 0.62, gTop);
  pil(uFront, 0, 0.56, uTop);
  pil(uBack, 0, 0.5, uTop);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(sx * (hw - 0.3), (plinth + g1 - 0.3) / 2, sz * (hd - 0.3), 0.8, g1 - 0.3 - plinth, 0.8, light);
      b.box(sx * (uhw - 0.28), (deck + u1 - 0.25) / 2, sz > 0 ? uz1 - 0.28 : uz0 + 0.28, 0.76, u1 - 0.25 - deck, 0.76, light);
    }
  }

  // A band round the outside of a storey, `p` out from its wall faces (centre cx, cz; half extents hx, hz).
  const ring = (cx: number, cz: number, hx: number, hz: number, y0: number, y1: number, p: number, c: ColorIn) => {
    const yc = (y0 + y1) / 2;
    const ht = y1 - y0;
    b.box(cx, yc, cz + hz + p / 2 - 0.01, (hx + p) * 2, ht, p + 0.02, c);
    b.box(cx, yc, cz - hz - p / 2 + 0.01, (hx + p) * 2, ht, p + 0.02, c);
    b.box(cx + hx + p / 2 - 0.01, yc, cz, p + 0.02, ht, hz * 2, c);
    b.box(cx - hx - p / 2 + 0.01, yc, cz, p + 0.02, ht, hz * 2, c);
  };
  // The slab over the hall (the terrace and the upper floor), and its cornice: a deep band over a thin one.
  b.box(0, (g1 + deck) / 2, 0, (hw - T) * 2 + 0.02, deck - g1, (hd - T) * 2 + 0.02, render);
  ring(0, 0, hw, hd, g1 - 0.26, g1 - 0.14, 0.1, light);
  ring(0, 0, hw, hd, g1 - 0.08, deck + 0.06, 0.22, light);
  // Upper floor and ceiling inside, and the roof slab with its cornice.
  const ucz = (uz0 + uz1) / 2;
  const ud = uz1 - uz0;
  b.box(0, deck + 0.005, ucz, (uhw - T) * 2, 0.01, ud - T * 2, floor);
  b.box(0, (u1 + roof) / 2, ucz, (uhw - T) * 2 + 0.02, roof - u1, ud - T * 2 + 0.02, render);
  ring(0, ucz, uhw, ud / 2, u1 - 0.17, u1 - 0.07, 0.09, light);
  ring(0, ucz, uhw, ud / 2, u1 - 0.02, roof + 0.08, 0.21, light);
  b.box(0, roof + 0.01, ucz, (uhw - T) * 2, 0.02, ud - T * 2, roofS);

  // Parapet with merlons all round the roof.
  const pt = 0.32;
  const ph = CH.parapet - roof;
  const mh = CH.merlon - CH.parapet;
  const parapetRun = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    b.box((x0 + x1) / 2, roof + 0.08 + ph / 2, (z0 + z1) / 2, alongX ? len : pt, ph, alongX ? pt : len, render);
    const n = Math.max(2, Math.round(len / 0.8));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      b.box(x, roof + 0.08 + ph + mh / 2, z, alongX ? 0.42 : pt + 0.02, mh, alongX ? pt + 0.02 : 0.42, render);
    }
  };
  const px = uhw + 0.21 - pt / 2;
  const pz0 = uz0 - 0.21 + pt / 2;
  const pz1 = uz1 + 0.21 - pt / 2;
  parapetRun(-px, pz1, px, pz1);
  parapetRun(-px, pz0, px, pz0);
  parapetRun(px, pz0, px, pz1);
  parapetRun(-px, pz0, -px, pz1);

  // The terrace round the upper storey: a low coping and a steel railing on posts, open where the stair lands.
  const s = CH.stair;
  const coping = (x0: number, z0: number, x1: number, z1: number) => {
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    const len = Math.hypot(x1 - x0, z1 - z0);
    b.box((x0 + x1) / 2, deck + 0.06 + 0.13, (z0 + z1) / 2, alongX ? len : 0.3, 0.26, alongX ? 0.3 : len, light);
    const n = Math.max(1, Math.round(len / 1.5));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      b.box(x0 + (x1 - x0) * t, deck + 0.32 + 0.42, z0 + (z1 - z0) * t, 0.05, 0.84, 0.05, rail);
    }
    for (const y of [deck + 0.7, deck + 1.15]) b.box((x0 + x1) / 2, y, (z0 + z1) / 2, alongX ? len : 0.05, 0.05, alongX ? 0.05 : len, rail);
  };
  for (const [x0, z0, x1, z1] of terraceEdges()) coping(x0, z0, x1, z1);

  // Weather streaks down the render under the cornices and the sills.
  for (let i = 0; i < 16; i++) {
    const w = CH_WALLS[Math.floor(r() * CH_WALLS.length)];
    const a = w.a0 + 0.4 + r() * (w.a1 - w.a0 - 0.8);
    const len = 0.8 + r() * 1.8;
    const top = w.y1 - w.y0 - 0.35 - (w.y0 > 1 ? 0.2 : 0.25);
    const piece = w.ops.some((op) => Math.abs(a - op.at) < op.w / 2 + 0.15 && top - len < op.spring + op.w / 2);
    if (piece) continue;
    faceBox(b, w, a, top - len / 2, 0.006, 0.18 + r() * 0.25, len, 0.004, stain);
  }

  // The hall: columns under the upper front wall, the well head, the engine on its bed, pipes, rubble.
  for (const cx of CH.columns) b.box(cx, (plinth + g1) / 2, uz1 - T / 2, 0.5, g1 - plinth, 0.5, render);
  const wl = CH.well;
  b.cyl(wl.x, plinth + wl.h / 2, wl.z, wl.r * 2, wl.h, wl.r * 2, render, 0, 0, 0, 20);
  b.cyl(wl.x, plinth + wl.h + 0.005, wl.z, wl.r * 2 - 0.3, 0.01, wl.r * 2 - 0.3, dark, 0, 0, 0, 20);
  for (let k = -2; k <= 2; k++) b.box(wl.x + k * 0.26, plinth + wl.h + 0.03, wl.z, 0.05, 0.05, wl.r * 2 - 0.2, rust);
  b.box(wl.x, plinth + wl.h + 0.03, wl.z, wl.r * 2 - 0.2, 0.05, 0.05, rust);
  const en = CH.engine;
  const ey = plinth + en.h;
  b.box(en.x, plinth + en.h / 2, en.z, en.w, en.h, en.d, render);
  b.cyl(en.x - 0.3, ey + 0.42, en.z, 0.8, 1.9, 0.8, rust, 0, 0, Math.PI / 2, 14);
  b.cyl(en.x - 1.3, ey + 0.42, en.z, 0.95, 0.12, 0.95, rust, 0, 0, Math.PI / 2, 14);
  b.box(en.x + 0.75, ey + 0.35, en.z, 0.5, 0.7, 0.6, rust);
  // The flywheel, standing across the end of the bed on its axle.
  const fx = en.x + 1.15;
  const fy = ey + 0.95;
  b.cyl(en.x + 0.85, fy, en.z, 0.12, 0.9, 0.12, rust, 0, 0, Math.PI / 2, 8);
  b.torus(fx, fy, en.z, 0.9, 0.07, rust, 0, Math.PI / 2, 0, 6, 24);
  b.cyl(fx, fy, en.z, 0.26, 0.2, 0.26, rust, 0, 0, Math.PI / 2, 10);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    b.rod(fx, fy, en.z, fx, fy + Math.sin(a) * 0.86, en.z + Math.cos(a) * 0.86, 0.035, rust, 5);
  }
  // Pipes: the suction from the well to the engine, and the main out under the arcade toward the river.
  b.pipe([[wl.x + wl.r * 0.8, plinth + 0.45, wl.z], [en.x - 1.4, plinth + 0.45, en.z], [en.x - 1.25, ey + 0.42, en.z]], 0.11, rust, 8);
  b.pipe([[en.x + 0.75, plinth + 0.2, en.z + 0.3], [en.x + 0.75, plinth + 0.15, 1.2], [0.9, plinth + 0.15, 2.6], [0.9, plinth + 0.15, hd + 0.3], [0.9, -0.1, hd + 0.9]], 0.13, rust, 8);
  // The tool chest by the engine (searchable), and rubble fallen from the slab.
  const tc = CH.loot[0];
  b.box(tc.x, plinth + 0.27, tc.z, 0.95, 0.54, 0.55, S.paint(0x7c3226, 0.9));
  b.box(tc.x, plinth + 0.56, tc.z, 0.97, 0.05, 0.57, S.paint(0x6a2a20, 0.9));
  for (let i = 0; i < 9; i++) {
    const x = -5.5 + r() * 11;
    const z = -4.3 + r() * 8.6;
    if (Math.hypot(x - wl.x, z - wl.z) < 1.4 || (Math.abs(x - en.x) < 2.3 && Math.abs(z - en.z) < 1.3)) continue;
    b.box(x, plinth + 0.06, z, 0.25 + r() * 0.4, 0.12 + r() * 0.1, 0.2 + r() * 0.35, rubble, (r() - 0.5) * 0.4, r() * 6, (r() - 0.5) * 0.4);
  }
  // Upstairs: the cabinet against the back wall (searchable), loose planks, rubble.
  const cb = CH.loot[1];
  b.box(cb.x, deck + 0.9, cb.z - 0.15, 0.9, 1.8, 0.45, S.paint(0x56645a, 0.85));
  b.box(cb.x + 0.22, deck + 1.2, cb.z + 0.08, 0.02, 0.5, 0.02, S.steel(0x3c3f40, 0.6));
  for (let i = 0; i < 3; i++) b.box(1.2 + r() * 1.5, deck + 0.03 + i * 0.04, -2.6 + r() * 1.2, 2.2, 0.035, 0.22, S.wood(0x6a5440, 0.8), 0, 0.3 + r() * 0.8, 0);
  for (let i = 0; i < 5; i++) b.box(-3 + r() * 6, deck + 0.05, -4.2 + r() * 5, 0.25 + r() * 0.3, 0.1, 0.25 + r() * 0.3, rubble, (r() - 0.5) * 0.4, r() * 6, (r() - 0.5) * 0.4);

  // The open stair up the left wall: solid masonry steps, the landing on its pier, a rail on the open side.
  const { rise, tread } = stairSteps();
  const sw = s.x1 - s.x0;
  const sxc = (s.x0 + s.x1) / 2;
  for (let i = 0; i < s.steps - 1; i++) {
    const top = (i + 1) * rise;
    const zc = s.zFoot - (i + 0.5) * tread;
    b.box(sxc, top / 2, zc, sw, top, tread + 0.005, i % 2 ? render : light);
  }
  b.box(sxc, deck / 2, (s.zTop + s.zBack) / 2, sw, deck, s.zTop - s.zBack, render);
  const railX = s.x0 + 0.06;
  for (let k = 0; k <= 6; k++) {
    const z = s.zFoot - (k / 6) * (s.zFoot - s.zTop);
    const y = ((s.zFoot - z) / tread) * rise + rise;
    b.box(railX, y + 0.5, z, 0.05, 1.0, 0.05, rail);
  }
  b.rod(railX, rise + 1.0, s.zFoot, railX, deck + 1.0, s.zTop, 0.025, rail, 6);
  b.rod(railX, rise + 0.55, s.zFoot, railX, deck + 0.55, s.zTop, 0.02, rail, 6);
  b.box(railX, deck + 0.5, s.zBack + 0.03, 0.05, 1.0, 0.05, rail);
  b.box(railX, deck + 1.0, (s.zTop + s.zBack) / 2, 0.05, 0.05, s.zTop - s.zBack, rail);
  b.box(sxc, deck + 1.0, s.zBack + 0.03, sw, 0.05, 0.05, rail);

  // Welded mesh fence along the front and the right side, one panel lying flat where someone pushed through. A heritage
  // plate on it, Hebrew over English once, now too faded to read.
  const fenceZ = CH.fence.front;
  const { posts, down } = fencePosts();
  for (let i = 0; i < posts.length; i++) {
    const [x, z] = posts[i];
    b.cyl(x, CH.fence.h / 2, z, 0.06, CH.fence.h, 0.06, S.steel(0x8f9494, 0.45), 0, 0, 0, 6);
    if (i + 1 < posts.length) meshPanel(b, x, z, posts[i + 1][0], posts[i + 1][1], i === down);
  }
  b.box(-1.0, 1.35, fenceZ + 0.04, 1.3, 0.75, 0.03, S.paint(0x2e6a40, 0.7));
  for (let k = 0; k < 4; k++) b.box(-1.0 - (k % 2) * 0.1, 1.55 - k * 0.15, fenceZ + 0.06, k === 0 ? 0.9 : 1.05 - (k % 2) * 0.25, 0.05, 0.01, S.paint(0xd8dccf, 0.6));

  // The yard on the right: two felled eucalyptus logs and a fluted stone drum.
  const logW = S.wood(0x46352a, 0.5);
  const logPale = S.wood(0x8a7560, 0.4);
  const cut = S.wood(0xa07a50, 0.35);
  for (const l of CH.logs) {
    b.cyl(l.x, l.d / 2 - 0.02, l.z, l.d, l.len, l.d, l.pale ? logPale : logW, Math.PI / 2, l.yaw, 0, 12);
    for (const e of [-1, 1]) b.cyl(l.x + e * Math.sin(l.yaw) * (l.len / 2 + 0.01), l.d / 2 - 0.02, l.z + e * Math.cos(l.yaw) * (l.len / 2 + 0.01), l.d - 0.05, 0.02, l.d - 0.05, cut, Math.PI / 2, l.yaw, 0, 12);
  }
  const dr = CH.drum;
  b.extrude('concreteHouse:drum', () => {
    const sh = new THREE.Shape();
    const n = 216;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
      // Narrow channels cut down the drum, nine of them, the stone a little uneven between.
      const flute = Math.max(0, Math.cos(a * 9)) ** 40;
      const rr = dr.r - 0.07 * flute + 0.012 * Math.sin(a * 5 + 1);
      if (k === 0) sh.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else sh.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    return sh;
  }, dr.h, 0.02, dr.x, dr.h / 2, dr.z, S.rock(0xa39a88), -Math.PI / 2, 0.4, 0);

  b.groundShade(-0.2, 0.9, 0.3);
  return b;
}

/** An arch's trim on its wall's outside: the moulded band, the keystone, the impost blocks, a sill under a window. */
function archTrim(b: MeshBuilder, w: WallRun, op: ArchOpening, c: ColorIn) {
  const rad = op.w / 2;
  const band = Math.min(0.16, rad * 0.18);
  const n = w.c + w.out * (CH.t / 2 + 0.03);
  const y = w.y0 + op.spring;
  const key = `concreteHouse:arch${Math.round(rad * 100)}`;
  if (w.axis === 'x') b.extrude(key, () => archBand(rad, band), 0.06, 0, op.at, y, n, c);
  else b.extrude(key, () => archBand(rad, band), 0.06, 0, n, y, op.at, c, 0, -Math.PI / 2, 0);
  faceBox(b, w, op.at, op.spring + rad + band * 0.5, 0.07, 0.26, band + 0.22, 0.08, c);
  for (const s of [-1, 1]) faceBox(b, w, op.at + s * (rad + band * 0.5), op.spring - 0.06, 0.05, band + 0.16, 0.12, 0.06, c);
  if (op.sill > 0) faceBox(b, w, op.at, op.sill - 0.04, 0.1, op.w + 0.24, 0.08, 0.14, c);
}

/** A welded mesh fence panel between two posts: a frame and a grid of wire, or lying flat on the ground. */
function meshPanel(b: MeshBuilder, x0: number, z0: number, x1: number, z1: number, down: boolean) {
  const wire = S.steel(0x9ea3a2, 0.35);
  const len = Math.hypot(x1 - x0, z1 - z0);
  const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  const H = 1.9;
  const at = (t: number, y: number, off = 0): [number, number, number] => {
    if (!down) return [x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t];
    // Fallen outward: the panel's height lies along the ground, away from the house.
    const nx = alongX ? 0 : 1;
    const nz = alongX ? 1 : 0;
    return [x0 + (x1 - x0) * t + nx * y, 0.04 + off, z0 + (z1 - z0) * t + nz * y];
  };
  const bar = (t0: number, y0: number, t1: number, y1: number, r: number) => {
    const a = at(t0, y0);
    const c = at(t1, y1);
    b.box((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2, Math.max(r, Math.abs(c[0] - a[0])), Math.max(r, Math.abs(c[1] - a[1])), Math.max(r, Math.abs(c[2] - a[2])), wire);
  };
  bar(0.02, 0.06, 0.98, 0.06, 0.035);
  bar(0.02, H, 0.98, H, 0.035);
  const nv = Math.round(len / 0.2);
  for (let k = 1; k < nv; k++) bar(k / nv, 0.06, k / nv, H, 0.012);
  for (let y = 0.5; y < H; y += 0.5) bar(0.02, y, 0.98, y, 0.012);
}

/**
 * The mud hut out on the Yarkon's meadow: one room of mud brick, rendered and weathered tan, two small square windows toward
 * the river, the door on the right, under a flat roof of reed thatch on round beams whose ends stick out, the thatch deep and
 * ragged at the eaves. Inside: a clay oven (a tabun) in the corner, a mud-brick bench, a straw mat and clay jars, the big one
 * by the front wall worth searching. A few pots by the door. No collider of its own (`heritageAabbs`).
 */
export function mudHut(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.08;
  const r = rng(seed + 23);
  const mud = S.concrete(0xb48c62, 0.5);
  const mudDark = S.concrete(0x8e6c4a, 0.7);
  const wood = S.wood(0x4e3a28, 0.6);
  const pole = S.wood(0x6a5038, 0.5);
  const thatch = S.wood(0x8a7048, 0.7);
  const thatchDark = S.wood(0x5f4c33, 0.8);
  const clay = S.concrete(0xa8643a, 0.5);
  const straw = S.wood(0xb89a5c, 0.6);
  const { hw, hd, t, wall, thatch0, thatch1, eave } = MH;
  // A low footing of darker mud, then the walls with their openings cut.
  b.box(0, 0.06, 0, hw * 2 + 0.1, 0.24, hd * 2 + 0.1, mudDark);
  MH_WALLS.forEach((w, i) => {
    const key = `mudHut:wall${i}`;
    if (w.axis === 'x') b.extrude(key, () => wallShape(w), t, 0, 0, w.y0, w.c, mud);
    else b.extrude(key, () => wallShape(w), t, 0, w.c, w.y0, 0, mud, 0, -Math.PI / 2, 0);
    // A wooden lintel over each opening and a frame round each window.
    for (const op of w.ops) {
      faceBox(b, w, op.at, op.spring + 0.07, 0.03, op.w + 0.3, 0.14, t + 0.06, wood);
      if (op.sill > 0) faceBox(b, w, op.at, op.sill - 0.03, 0.04, op.w + 0.1, 0.06, t + 0.08, wood);
    }
  });
  // Weathering: rain has washed the mud paler at the top of the walls and splashed it darker at the foot.
  for (const w of MH_WALLS) {
    for (let k = 0; k < 5; k++) {
      const a = w.a0 + 0.3 + r() * (w.a1 - w.a0 - 0.6);
      if (w.ops.some((op) => Math.abs(a - op.at) < op.w / 2 + 0.2)) continue;
      faceBox(b, w, a, 0.35 + r() * 0.2, 0.004, 0.4 + r() * 0.5, 0.5 + r() * 0.4, 0.004, mudDark);
    }
  }
  // Round beams across the walls, their ends standing out under the eaves front and back.
  for (let k = 0; k < 6; k++) {
    const x = -hw + 0.35 + (k / 5) * (hw * 2 - 0.7);
    b.cyl(x, wall + 0.08, 0, 0.16, hd * 2 + eave * 1.4, 0.16, pole, Math.PI / 2, 0, 0, 7);
  }
  // The thatch: a thick mat of reeds over the beams, a little uneven on top, ragged ends hanging at the eaves.
  const tw = hw + eave;
  const td = hd + eave;
  b.box(0, (thatch0 + thatch1) / 2, 0, tw * 2, thatch1 - thatch0, td * 2, thatch);
  for (let k = 0; k < 7; k++) b.box((r() - 0.5) * hw * 1.4, thatch1 + 0.02, (r() - 0.5) * hd * 1.4, 1.2 + r() * 1.4, 0.08, 1.0 + r() * 1.2, k % 2 ? thatch : thatchDark, 0, r() * 3, 0);
  const fringe = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.round(len / 0.11);
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      const hang = 0.12 + r() * 0.22;
      const x = x0 + (x1 - x0) * u;
      const z = z0 + (z1 - z0) * u;
      b.box(x, thatch0 - hang / 2 + 0.05, z, 0.05, hang, 0.05, r() < 0.5 ? thatch : thatchDark, (r() - 0.5) * 0.3, 0, (r() - 0.5) * 0.3);
    }
  };
  fringe(-tw, td, tw, td);
  fringe(-tw, -td, tw, -td);
  fringe(tw, -td, tw, td);
  fringe(-tw, -td, -tw, td);
  // Inside: the floor of beaten earth, the oven, the bench, a mat and the jars.
  b.box(0, 0.005, 0, (hw - t) * 2, 0.01, (hd - t) * 2, S.concrete(0x5e4a36, 0.9));
  const ov = MH.oven;
  b.add('dome', ov.x, 0, ov.z, ov.r * 2, 1.4, ov.r * 2, clay);
  b.cyl(ov.x - ov.r * 0.7, 0.28, ov.z + ov.r * 0.4, 0.3, 0.32, 0.3, S.concrete(0x1a1410, 0.3), 0, 0, Math.PI / 2, 8);
  const be = MH.bench;
  b.box(be.x, be.h / 2, be.z, be.w, be.h, be.d, mud);
  b.box(-0.2, 0.012, 0.2, 1.6, 0.02, 1.0, straw, 0, 0.2, 0);
  const jar = (x: number, z: number, h: number, c: typeof clay) => {
    b.add('sphere16', x, h * 0.45, z, h * 0.75, h * 0.8, h * 0.75, c);
    b.cyl(x, h * 0.86, z, h * 0.32, h * 0.22, h * 0.32, c, 0, 0, 0, 10);
    b.torus(x, h * 0.97, z, h * 0.17, 0.025, c, Math.PI / 2, 0, 0, 5, 12);
  };
  const lj = MH.loot[0];
  jar(lj.x, lj.z, 0.8, clay);
  jar(ov.x - 0.2, ov.z + 0.9, 0.36, S.concrete(0x8c5434, 0.5));
  jar(be.x + 0.7, be.z, 0.32, S.concrete(0x9a6a44, 0.5));
  // A plank door swung back against the inside of the wall, and pots by the doorway outside.
  b.box(hw - t - 0.05, 1.0, 0.45 + 0.95 / 2 + 0.47, 0.05, 1.95, 0.92, wood, 0, 0, 0.02);
  jar(hw + 0.55, 1.4, 0.42, S.concrete(0x93603c, 0.55));
  jar(hw + 0.4, 1.95, 0.3, clay);
  b.groundShade(-0.1, 0.5, 0.35);
  return b;
}

/**
 * Abu Rabah mill on the Half Island, as the Yarkon's Ottoman mills still stand: a long block of honey-coloured kurkar laid
 * in courses, darker and greener at the waterline, patched here and there with plaster, standing right across the stream.
 * Three round-arched races go through its base, a wooden sluice gate wound up over the middle one; above them the mill floor,
 * lit by narrow arched windows, a small square barred one and a wide arched one with a grille, under a low gable roof of
 * red clay tiles with white fascias, and over its +z end the restorers' lantern: a tall box of grey panels and glass in a
 * frame of steel, its own low roof on top. It stands lengthwise in the water; the door in the middle of its +x side opens onto
 * stone steps down to the crossing beside it. Inside: two pairs of
 * millstones in their wooden tuns with the hoppers over them, sacks of grain, the bin and the miller's chest, the tie beams of
 * the roof. Collided as `heritageAabbs` (no collider of its own).
 */
export function oldMill(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.04;
  const r = rng(seed + 31);
  const lime = S.concrete(0xb59c74, 0.6);
  const blocks = [0xc29a5c, 0xb88c50, 0xcaa468, 0xad8550, 0xc6a26a, 0xb4915e, 0xbf9a62].map((c) => S.rock(c));
  const wetS = S.rock(0x5f5338);
  const wetS2 = S.rock(0x6e5f40);
  const plaster = S.concrete(0xcdb488, 0.45);
  const plaster2 = S.concrete(0xbfa77c, 0.55);
  const dressed = S.rock(0xd0ae72);
  const inner = S.rock(0x6a5a44);
  const dark = S.concrete(0x15110c, 0.3);
  const wood = S.wood(0x56412c, 0.7);
  const woodPale = S.wood(0x8a6c4a, 0.6);
  const plank = S.wood(0x6e5338, 0.75);
  const iron = S.rust(0x463427);
  const roofS = S.concrete(0x9c5a3c, 0.85);
  const roofR = S.concrete(0xae6a46, 0.8);
  const fascia = S.paint(0xd4d2c8, 0.55);
  const sack = S.cloth(0xb8a47c, 0.6);
  const stoneMill = S.rock(0x9a948a);
  const { hw, hd, t, base, deck, slab, eave, ridge } = OM;

  // Where a point on a wall's outside face lies, and a quad or a box on it (`proud` out of the face).
  const face = (w: WallRun, a: number, y: number, proud: number): [number, number, number] => {
    const n = w.c + w.out * (t / 2 + proud);
    return w.axis === 'x' ? [a, y, n] : [n, y, a];
  };
  const fquad = (w: WallRun, a0: number, a1: number, y0: number, y1: number, proud: number, c: Parameters<MeshBuilder['quad']>[4]) => {
    const fwd = w.axis === 'x' ? w.out > 0 : w.out < 0;
    const s0 = fwd ? a0 : a1;
    const s1 = fwd ? a1 : a0;
    b.quad(face(w, s0, y0, proud), face(w, s1, y0, proud), face(w, s1, y1, proud), face(w, s0, y1, proud), c);
  };
  const fbox = (w: WallRun, a: number, y: number, proud: number, along: number, tall: number, deep: number, c: ColorIn) => {
    const n = w.c + w.out * (t / 2 + proud - deep / 2);
    if (w.axis === 'x') b.box(a, y, n, along, tall, deep, c);
    else b.box(n, y, a, deep, tall, along, c);
  };
  const crown = (w: WallRun, op: ArchOpening) => w.y0 + op.spring + (op.square ? 0 : op.w / 2);
  const hits = (w: WallRun, a0: number, a1: number, y0: number, y1: number, m: number) =>
    w.ops.some((op) => a1 > op.at - op.w / 2 - m && a0 < op.at + op.w / 2 + m && y1 > w.y0 + op.sill - m && y0 < crown(w, op) + m);

  // The walls, their openings cut, limewashed inside (the mortar between the stones outside).
  OM_WALLS.forEach((w, i) => {
    const key = `oldMill:wall${i}`;
    if (w.axis === 'x') b.extrude(key, () => wallShape(w), t, 0, 0, w.y0, w.c, lime);
    else b.extrude(key, () => wallShape(w), t, 0, w.c, w.y0, 0, lime, 0, -Math.PI / 2, 0);
  });
  // Coursed stone over every outside face: blocks of a few tones, the joints left between them, dark and green at the water.
  OM_WALLS.forEach((w, wi) => {
    const course = 0.31;
    let row = 0;
    for (let y = Math.max(w.y0, wi < 2 ? -0.3 : 0.55); y < w.y1 - 0.04; y += course, row++) {
      const y1 = Math.min(w.y1, y + course);
      let a = w.a0;
      let first = true;
      while (a < w.a1 - 0.04) {
        const len = first && row % 2 ? 0.22 + r() * 0.2 : 0.42 + r() * 0.46;
        first = false;
        const a1 = Math.min(w.a1, a + len);
        if (!hits(w, a, a1, y, y1, 0.03)) {
          const c = y < 0.25 ? (r() < 0.5 ? wetS : wetS2) : y < 0.55 && r() < 0.6 ? wetS2 : blocks[Math.floor(r() * blocks.length)];
          fquad(w, a + 0.02, a1 - 0.02, y + 0.022, y1 - 0.022, 0.012 + r() * 0.014, c);
        }
        a = a1;
      }
    }
    // Plaster patched over the stone where the old render held on.
    for (let k = 0; k < (wi < 2 ? 4 : 1); k++) {
      const pw = 0.9 + r() * 1.8;
      const ph = 1.0 + r() * 2.6;
      const a0 = w.a0 + 0.3 + r() * (w.a1 - w.a0 - pw - 0.6);
      const y0 = (wi < 2 ? deck : 1.4) + r() * (eave - deck - ph - 0.2);
      if (hits(w, a0, a0 + pw, y0, y0 + ph, 0.1)) continue;
      fquad(w, a0, a0 + pw, y0, y0 + ph, 0.032, k % 2 ? plaster2 : plaster);
      // Ragged edges: a few smaller pieces round it.
      for (let q = 0; q < 3; q++) {
        const ea = a0 + (r() - 0.2) * pw;
        const ey = y0 + (r() < 0.5 ? -0.25 : ph - 0.05) + r() * 0.2;
        const ew = 0.3 + r() * 0.5;
        if (!hits(w, ea, ea + ew, ey, ey + 0.3, 0.05)) fquad(w, ea, ea + ew, ey, ey + 0.28, 0.03, plaster2);
      }
    }
    // Dressed stone round each opening: voussoirs over the arches (heavy over the races), a lintel and jambs round the
    // square windows, a sill under every window.
    for (const op of w.ops) {
      const rad = op.w / 2;
      const isRace = op.sill <= 0 && wi < 2;
      if (!op.square) {
        const band = isRace ? 0.42 : 0.2;
        const n = w.c + w.out * (t / 2 + 0.02);
        const y = w.y0 + op.spring;
        const key = `oldMill:arch${Math.round(rad * 100)}:${Math.round(band * 100)}`;
        if (w.axis === 'x') b.extrude(key, () => archBand(rad, band), 0.05, 0, op.at, y, n, dressed);
        else b.extrude(key, () => archBand(rad, band), 0.05, 0, n, y, op.at, dressed, 0, -Math.PI / 2, 0);
        fbox(w, op.at, y + rad + band * 0.5, 0.05, 0.3, band + 0.12, 0.08, dressed);
        for (const s of [-1, 1]) {
          const jy0 = w.y0 + Math.max(op.sill, isRace ? 0.25 - w.y0 : 0);
          fbox(w, op.at + s * (rad + 0.09), (jy0 + y) / 2, 0.025, 0.18, y - jy0, 0.05, dressed);
        }
      } else {
        const top = w.y0 + op.spring;
        fbox(w, op.at, top + 0.13, 0.04, op.w + 0.44, 0.26, 0.07, dressed);
        for (const s of [-1, 1]) fbox(w, op.at + s * (rad + 0.09), w.y0 + (op.sill + op.spring) / 2, 0.025, 0.18, op.spring - op.sill, 0.05, dressed);
      }
      if (op.sill > 0 && !(wi >= 2 && op.at === 0)) fbox(w, op.at, w.y0 + op.sill - 0.05, 0.08, op.w + 0.3, 0.1, 0.14, dressed);
      // Bars: iron in the square windows, a grille in the wide arched one, nothing in the narrow ones.
      if (op.sill > 0 && (op.square || op.w > 1)) {
        const nb = Math.max(2, Math.round(op.w / 0.16));
        const yb = w.y0 + op.sill;
        const yt = w.y0 + op.spring + (op.square ? 0 : rad * 0.9);
        for (let k = 1; k < nb; k++) {
          const a = op.at - rad + (op.w * k) / nb;
          const hTop = op.square ? yt : w.y0 + op.spring + Math.sqrt(Math.max(0, rad * rad - (a - op.at) ** 2)) - 0.04;
          fbox(w, a, (yb + hTop) / 2, -t / 2 + 0.06, 0.024, hTop - yb, 0.024, iron);
        }
        for (const yy of [yb + 0.4, yb + (w.y0 + op.spring - yb) * 0.75]) fbox(w, op.at, yy, -t / 2 + 0.07, op.w, 0.03, 0.02, iron);
      }
    }
  });
  // Quoins: long and short dressed blocks up each corner.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      let row = 0;
      for (let y = sz ? 0.6 : 0; y < eave - 0.2; y += 0.31, row++) {
        const long = row % 2 === 0;
        const lx = long ? 0.62 : 0.34;
        const lz = long ? 0.34 : 0.62;
        b.box(sx * (hw - lx / 2 + 0.03), y + 0.155, sz * (hd - lz / 2 + 0.03), lx, 0.27, lz, dressed);
      }
    }
  }
  // Under the floor: the races' dark walls and the solid base at each end; the floor of planks over them.
  const under = deck - slab;
  const rw = OM.race.w / 2;
  const ix = hw - t;
  for (let k = 0; k + 1 < OM.races.length; k++) {
    const z0 = OM.races[k] + rw;
    const z1 = OM.races[k + 1] - rw;
    b.box(0, (base + under) / 2, (z0 + z1) / 2, ix * 2, under - base, z1 - z0, inner);
  }
  const zEnd = OM.races[OM.races.length - 1] + rw;
  for (const sg of [1, -1]) b.box(0, (base + under) / 2, sg * (zEnd + (hd - t - zEnd) / 2), ix * 2, under - base, hd - t - zEnd, inner);
  b.box(0, under + slab / 2 - 0.02, 0, ix * 2, slab - 0.04, (hd - t) * 2, S.concrete(0x3a3128, 0.8));
  for (let z = -hd + t + 0.15; z < hd - t; z += 0.3) b.box(0, deck - 0.02, z, ix * 2 - 0.02, 0.04, 0.28, r() < 0.5 ? plank : wood);
  // The sluice gate wound up over the middle race on the -x side (the door is over it on the other), in its frame of two
  // posts and a beam.
  const gx = -hw - 0.14;
  for (const s of [-1, 1]) b.box(gx, 1.3, s * (rw + 0.12), 0.18, 3.2, 0.16, wood);
  b.box(gx, 2.95, 0, 0.22, 0.2, OM.race.w + 0.55, wood);
  b.box(gx - 0.02, 2.2, 0, 0.1, 0.9, OM.race.w, woodPale);
  b.rod(gx - 0.1, 2.65, 0, gx - 0.1, 3.4, 0, 0.04, iron, 6);
  b.torus(gx - 0.1, 3.45, 0, 0.18, 0.025, iron, 0, 0, Math.PI / 2, 4, 14);

  // The roof: a low gable along the building, clay tiles in courses down each slope, white fascias, the gable ends in stone.
  const ox = hw + 0.45;
  const rise = ridge - eave;
  const slopeLen = Math.hypot(ox, rise);
  const ang = Math.atan2(rise, ox);
  const rz0 = -hd - 0.4;
  const rz1 = hd + 0.4;
  for (const sx of [-1, 1]) {
    const cx = (sx * ox) / 2;
    const cy = eave + 0.06 + rise / 2;
    b.box(cx, cy, 0, slopeLen, 0.07, rz1 - rz0, roofS, 0, 0, sx * -ang);
    // The tiles' courses: a lip every third of a metre down the slope, and the rounded backs of the tiles in each.
    const nc = Math.round(slopeLen / 0.34);
    for (let k = 0; k < nc; k++) {
      const u = (k + 0.5) / nc - 0.5;
      const px = cx + sx * Math.cos(ang) * u * slopeLen;
      const py = cy + Math.sin(ang) * -u * slopeLen + 0.05;
      b.box(px, py, 0, 0.08, 0.05, rz1 - rz0, k % 2 ? roofR : roofS, 0, 0, sx * -ang);
    }
    for (let z = rz0 + 0.12; z < rz1 - 0.1; z += 0.24) b.box(cx, cy + 0.06, z, slopeLen, 0.03, 0.05, roofR, 0, 0, sx * -ang);
    b.box(sx * (ox + 0.02), eave + 0.0, 0, 0.05, 0.26, rz1 - rz0 + 0.06, fascia);
    b.box(sx * (ox - 0.05), eave - 0.12, 0, 0.14, 0.12, rz1 - rz0, S.steel(0x7c7e7a, 0.6));
  }
  b.box(0, ridge + 0.08, 0, 0.32, 0.1, rz1 - rz0 + 0.04, roofR);
  for (const sz of [-1, 1]) {
    b.extrude(`oldMill:gable`, () => {
      const s = new THREE.Shape();
      s.moveTo(-hw, 0);
      s.lineTo(hw, 0);
      s.lineTo(0, rise);
      s.closePath();
      return s;
    }, t, 0, 0, eave, sz * (hd - t / 2), lime);
    for (let k = 0; k < 4; k++) {
      const y = eave + 0.05 + k * 0.31;
      const half = hw * (1 - (k * 0.31 + 0.31) / rise) - 0.05;
      if (half > 0.3) b.box(0, y + 0.155, sz * (hd + 0.012), half * 2, 0.27, 0.03, blocks[k % blocks.length]);
    }
    for (const sx of [-1, 1]) b.box((sx * ox) / 2, eave + 0.1 + rise / 2, sz * (rz1 + 0.02), slopeLen, 0.22, 0.05, fascia, 0, 0, sx * -ang);
  }
  // Inside under the roof: tie beams and a ridge beam.
  for (let z = -hd + 1.6; z < hd - 1; z += 2.6) b.box(0, eave - 0.2, z, ix * 2, 0.24, 0.22, wood);
  b.box(0, ridge - 0.25, 0, 0.2, 0.22, (hd - t) * 2, wood);

  // The door in the +x side: a gate of iron bars, swung back inside against the wall.
  const dz = OM.door.z;
  const xi = hw - t - 0.05;
  const gw = OM.door.w - 0.06;
  const gz = dz + OM.door.w / 2 + 0.06;
  for (const y of [deck + 0.05, deck + 1.0, deck + 1.95]) b.box(xi - gw / 2, y, gz, gw, 0.05, 0.04, iron);
  for (const x of [xi - 0.02, xi - gw + 0.02]) b.box(x, deck + 1.0, gz, 0.05, 1.95, 0.05, iron);
  for (let k = 1; k < 9; k++) b.box(xi - (gw * k) / 9, deck + 1.0, gz, 0.022, 1.9, 0.022, iron);
  // Steps down from it to the crossing: stone treads on a solid block standing in the water.
  const st = OM.steps;
  const nSteps = 6;
  const rise1 = (deck - st.foot) / nSteps;
  const tread = st.run / nSteps;
  for (let k = 0; k < nSteps; k++) {
    const top = deck - k * rise1;
    const xc = hw + (k + 0.5) * tread;
    b.box(xc, (top - 1.0) / 2, dz, tread + 0.01, top + 1.0, st.w, k % 2 ? dressed : blocks[1]);
  }
  b.box(hw + 0.05, deck - 0.02, dz, 0.12, 0.06, st.w + 0.2, dressed);

  // Inside: two pairs of millstones in their tuns with hoppers over them, sacks, the bin and the chest.
  for (const sm of OM.stones) {
    const y = deck;
    b.cyl(sm.x, y + sm.h / 2, sm.z, sm.r * 2, sm.h, sm.r * 2, wood, 0, Math.PI / 8, 0, 8);
    b.cyl(sm.x, y + sm.h + 0.01, sm.z, sm.r * 2 - 0.1, 0.03, sm.r * 2 - 0.1, plank, 0, Math.PI / 8, 0, 8);
    b.cyl(sm.x - 0.75, y + 0.12, sm.z, 0.85, 0.2, 0.85, stoneMill, 0, 0, Math.PI / 2, 14);
    // The hopper: an upturned pyramid of boards on four legs, a shoe under it.
    for (const [px, pz] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]]) b.box(sm.x + px, y + sm.h + 0.65, sm.z + pz, 0.08, 1.3, 0.08, wood);
    for (let q = 0; q < 4; q++) {
      const a = (q / 4) * Math.PI * 2;
      const cx = Math.cos(a) * 0.36;
      const cz = Math.sin(a) * 0.36;
      b.box(sm.x + cx, y + sm.h + 1.45, sm.z + cz, Math.abs(cz) > 0.1 ? 1.0 : 0.04, 0.55, Math.abs(cx) > 0.1 ? 1.0 : 0.04, woodPale, cz ? Math.sign(cz) * 0.5 : 0, 0, cx ? -Math.sign(cx) * 0.5 : 0);
    }
    b.box(sm.x - 0.35, y + sm.h + 0.95, sm.z, 0.5, 0.06, 0.2, woodPale, 0, 0, 0.35);
  }
  const sk = OM.sacks;
  for (let k = 0; k < 9; k++) {
    const row = Math.floor(k / 4);
    const sx = sk.x + (r() - 0.5) * 0.4;
    const sz = sk.z - sk.d / 2 + 0.4 + (k % 4) * 0.8;
    b.rbox(sx, deck + 0.24 + row * 0.38, sz, 0.62, 0.42, 0.75, 0.14, sack, (r() - 0.5) * 0.2, r() * 0.5, (r() - 0.5) * 0.2, 2);
  }
  const [bin, chest] = OM.loot;
  b.box(bin.x, deck + 0.45, bin.z, 1.05, 0.9, 0.95, plank);
  b.box(bin.x, deck + 0.95, bin.z + 0.1, 1.1, 0.06, 0.8, wood, -0.25, 0, 0);
  b.box(chest.x, deck + 0.28, chest.z, 0.95, 0.56, 0.55, S.paint(0x3d5a6a, 0.85));
  b.box(chest.x, deck + 0.58, chest.z, 0.97, 0.06, 0.57, S.paint(0x30495a, 0.85));
  for (const s of [-0.3, 0.3]) b.box(chest.x + s, deck + 0.3, chest.z, 0.05, 0.6, 0.58, iron);
  // Spilled grain and dust on the boards.
  for (let k = 0; k < 6; k++) b.box(-2 + r() * 4, deck + 0.012, -7 + r() * 14, 0.4 + r() * 0.6, 0.012, 0.3 + r() * 0.5, S.concrete(0xc4ae7c, 0.8), 0, r() * 3, 0);

  // The lantern over the +z end: a tall box of grey panels in a steel frame, a band of glass round its top, white fascias
  // and its own low roof.
  const L = OM.lantern;
  const pan = [S.paint(0xb4b8b8, 0.6), S.paint(0xa6abac, 0.6), S.paint(0xbfc2c0, 0.55)];
  const frame = S.steel(0x5c6264, 0.6);
  const glass = S.metal(0x3c4a52, 0.25);
  const ly0 = ridge - 0.95;
  const ly1 = ridge + L.h;
  const lzc = L.z;
  b.box(0, (ly0 + ly1) / 2, lzc, L.w - 0.08, ly1 - ly0, L.d - 0.08, S.concrete(0x2a2826, 0.9));
  for (const [axis, half, len] of [['x', L.d / 2, L.w], ['z', L.w / 2, L.d]] as const) {
    for (const s of [-1, 1]) {
      const cols = Math.max(2, Math.round(len / 1.0));
      for (let c = 0; c < cols; c++) {
        const a = -len / 2 + (len * (c + 0.5)) / cols;
        for (let row = 0; row < 3; row++) {
          const y0 = ly0 + 0.2 + row * ((ly1 - ly0 - 0.4) / 3);
          const hh = (ly1 - ly0 - 0.4) / 3 - 0.06;
          const c3 = row === 2 ? glass : pan[(c + row * 2 + (s > 0 ? 1 : 0)) % pan.length];
          if (axis === 'x') b.box(a, y0 + hh / 2, lzc + s * half, len / cols - 0.07, hh, 0.05, c3);
          else b.box(s * half, y0 + hh / 2, lzc + a, 0.05, hh, len / cols - 0.07, c3);
        }
      }
      // The frame: posts between the panels and rails between the rows.
      for (let c = 0; c <= cols; c++) {
        const a = -len / 2 + (len * c) / cols;
        if (axis === 'x') b.box(a, (ly0 + ly1) / 2, lzc + s * (half + 0.03), 0.07, ly1 - ly0, 0.07, frame);
        else b.box(s * (half + 0.03), (ly0 + ly1) / 2, lzc + a, 0.07, ly1 - ly0, 0.07, frame);
      }
      for (let row = 0; row <= 3; row++) {
        const y = ly0 + 0.17 + row * ((ly1 - ly0 - 0.4) / 3);
        if (axis === 'x') b.box(0, y, lzc + s * (half + 0.03), len, 0.06, 0.07, frame);
        else b.box(s * (half + 0.03), y, lzc, 0.07, 0.06, len, frame);
      }
    }
  }
  const lRise = 0.55;
  const lOx = L.w / 2 + 0.3;
  const lAng = Math.atan2(lRise, lOx);
  const lLen = Math.hypot(lOx, lRise);
  for (const sx of [-1, 1]) {
    b.box((sx * lOx) / 2, ly1 + 0.05 + lRise / 2, lzc, lLen, 0.06, L.d + 0.5, roofS, 0, 0, sx * -lAng);
    b.box(sx * (lOx + 0.02), ly1 - 0.02, lzc, 0.05, 0.22, L.d + 0.56, fascia);
  }
  for (const sz of [-1, 1]) b.box(0, ly1 + 0.08, lzc + sz * (L.d / 2 + 0.28), L.w + 0.6, 0.18, 0.05, fascia);
  b.groundShade(-0.3, 1.2, 0.25);
  return b;
}

/**
 * One face of the old foundations under the crossing beside Abu Rabah mill, `len` metres long: a wall of coursed kurkar
 * standing straight up out of the water to the crossing's top, dark and slimed at the waterline, weeds and creepers hanging
 * over its edge, low arched openings at the water where the river runs through under the earth; its top reaches back over the
 * crossing's edge, earth trodden over it and big cut stones lying along it. Local frame: the water at y = 0, the face toward
 * +z, its length along x.
 */
export function culvertFace(len: number, seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.02;
  const r = rng(seed + 23);
  const core = S.rock(0x6d5f47);
  const stones = [0xb39467, 0xa88c62, 0x9c8058, 0xbfa070, 0xad9064].map((c) => S.rock(c));
  const wetS = [S.rock(0x5c5038), S.rock(0x4c4430)];
  const dark = S.concrete(0x0e0c0a, 0.4);
  const green = [S.concrete(0x4f6a2e, 0.9), S.concrete(0x5e7a34, 0.9), S.concrete(0x3f5a26, 0.9)];
  const top = 1.05;
  const foot = -1.9;
  const back = CULVERT_OUT + 0.4;
  b.box(0, (foot + top) / 2, -0.3, len, top - foot, 0.6, core);
  b.box(0, top - 0.17, -back / 2, len, 0.34, back, core);
  // The openings at the water.
  const n = Math.max(2, Math.round(len / 3.6));
  const w = 1.15;
  const holes: number[] = [];
  for (let k = 0; k < n; k++) {
    const x = -len / 2 + (len * (k + 0.5)) / n;
    holes.push(x);
    b.box(x, -0.05, 0.02, w, 0.7, 0.02, dark);
    b.cyl(x, 0.3, 0.02, w, 0.02, w, dark, Math.PI / 2, 0, 0, 14);
  }
  // Coursed stone over the face, the arches' stones set round each opening.
  const course = 0.3;
  for (let y = -0.35, row = 0; y < top - 0.05; y += course, row++) {
    const y1 = Math.min(top, y + course);
    let x = -len / 2;
    let first = true;
    while (x < len / 2 - 0.05) {
      const l = first && row % 2 ? 0.2 + r() * 0.2 : 0.38 + r() * 0.45;
      first = false;
      const x1 = Math.min(len / 2, x + l);
      const inHole = holes.some((h) => x1 > h - w / 2 - 0.05 && x < h + w / 2 + 0.05 && y < 0.3 + w / 2 + 0.02);
      if (!inHole) {
        const c = y < 0.15 ? wetS[Math.floor(r() * 2)] : stones[Math.floor(r() * stones.length)];
        b.box((x + x1) / 2, (y + y1) / 2, 0.02 + r() * 0.03, x1 - x - 0.04, y1 - y - 0.04, 0.05, c);
      }
      x = x1;
    }
  }
  for (const h of holes) {
    for (let k = 0; k <= 6; k++) {
      const a = (k / 6) * Math.PI;
      b.box(h + Math.cos(a) * (w / 2 + 0.12), 0.3 + Math.sin(a) * (w / 2 + 0.12), 0.04, 0.22, 0.26, 0.06, stones[k % stones.length], 0, 0, a - Math.PI / 2);
    }
  }
  // Weeds and creepers hanging over the edge, and big cut stones lying along the top; earth over the rest.
  for (let x = -len / 2 + 0.4; x < len / 2 - 0.4; x += 0.9 + r() * 1.6) {
    // A clump of creeper: strands of different lengths down from the edge, a few leaves along them.
    const strands = 3 + Math.floor(r() * 4);
    for (let k = 0; k < strands; k++) {
      const sx = x + (r() - 0.5) * 0.7;
      const hang = 0.2 + r() * 1.0;
      const c = green[Math.floor(r() * green.length)];
      b.box(sx, top - hang / 2 + 0.04, 0.07, 0.035, hang, 0.035, c, 0, 0, (r() - 0.5) * 0.25);
      for (let q = 0; q < 3; q++) b.box(sx + (r() - 0.5) * 0.14, top - r() * hang, 0.09, 0.09 + r() * 0.06, 0.07, 0.02, c, 0, 0, r() * 3);
    }
  }
  for (let x = -len / 2 + 0.6 + r(); x < len / 2 - 0.8; x += 2.2 + r() * 2.5) b.box(x, top + 0.2, -0.45 - r() * 0.3, 0.7 + r() * 0.5, 0.42, 0.55 + r() * 0.2, stones[Math.floor(r() * stones.length)], 0, (r() - 0.5) * 0.4, 0);
  for (let x = -len / 2 + 0.4; x < len / 2 - 0.6; x += 0.8 + r() * 1.2) {
    const pw = 0.7 + r() * 1.4;
    b.box(Math.min(len / 2 - pw / 2 - 0.1, x + pw / 2), top + 0.01, -0.9 - r() * (back - 1.8), pw, 0.02, 0.8 + r() * 0.6, S.concrete(r() < 0.5 ? 0x5e4b38 : 0x6c5842, 0.95));
  }
  return b;
}

export function buildHeritageLandmark(kind: PropKind, seed: number, tag = 0): MeshBuilder | null {
  switch (kind) {
    case 'culvert':
      return culvertFace(Math.max(2, tag / 4), seed);
    case 'concreteHouse':
      return concreteHouse(seed);
    case 'mudHut':
      return mudHut(seed);
    case 'oldMill':
      return oldMill(seed);
    default:
      return null;
  }
}
