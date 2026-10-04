import { MeshBuilder, S } from './builder';
import { furnRect, furnSlots, GUN_RACK, type Furn } from '../world/interiors';

/**
 * Furniture models, built in the item's own frame (origin on the floor at the centre of its footprint, +Z the
 * front, +X to the right) and appended with the item's yaw. Everything is a handful of boxes: the view is from
 * above and behind, so tops and fronts carry the look.
 */

const WOOD = [0x6a4a30, 0x8a6a44, 0x4e3a2a, 0x9a7c52, 0x5a4030];
const CLOTH = [0x6a5a4a, 0x4a5a6a, 0x7a4a44, 0x5a6a50, 0x8a8068, 0x4a4a58];
const GOODS = [0xb84a3a, 0x3a6a9a, 0xc8a83a, 0x4a8a5a, 0xd8d0c0, 0x8a5a9a, 0xd87a3a];

/** Is a surface spot (board `board`, between local x `x0` and `x1`) taken by a loose item? Then the model keeps it clear. */
function held(f: Furn, board: number, x0: number, x1: number, z?: number): boolean {
  if (!f.used?.length) return false;
  const slots = furnSlots(f);
  return f.used.some((i) => {
    const s = slots[i];
    return !!s && s.board === board && x1 > s.x - s.w / 2 - 0.02 && x0 < s.x + s.w / 2 + 0.02 && (z === undefined || Math.sign(z) === Math.sign(s.z));
  });
}

const pickC = (arr: number[], seed: number) => arr[Math.floor(Math.abs(seed)) % arr.length];
const rnd = (seed: number) => {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

function bed(b: MeshBuilder, f: Furn) {
  const { w, d } = f;
  const wood = S.wood(pickC(WOOD, f.seed), 0.6);
  const sheet = S.cloth(pickC([0xc8c0b0, 0xa8b0b8, 0xb8a898, 0x9aa890], f.seed + 3), 0.6);
  const blanket = S.cloth(pickC(CLOTH, f.seed + 1), 0.5);
  b.box(0, 0.2, 0, w, 0.16, d, wood);
  b.rbox(0, 0.4, 0.04, w - 0.1, 0.24, d - 0.18, 0.05, sheet);
  b.rbox(0, 0.5, d * 0.14, w - 0.06, 0.1, d * 0.66, 0.05, blanket);
  for (const x of w > 1.2 ? [-w * 0.25, w * 0.25] : [0]) b.rbox(x, 0.55, -d / 2 + 0.3, Math.min(0.6, w * 0.4), 0.13, 0.36, 0.05, S.cloth(0xd8d4c8, 0.5));
  b.box(0, 0.62, -d / 2 + 0.03, w, 0.7, 0.06, wood);
  b.box(0, 0.32, d / 2 - 0.03, w, 0.36, 0.06, wood);
}

function bunk(b: MeshBuilder, f: Furn) {
  const { w, d } = f;
  const wood = S.wood(0x5a4030, 0.6);
  for (const x of [-w / 2 + 0.04, w / 2 - 0.04]) for (const z of [-d / 2 + 0.04, d / 2 - 0.04]) b.box(x, 0.8, z, 0.07, 1.6, 0.07, wood);
  for (const y of [0.35, 1.15]) {
    b.box(0, y, 0, w - 0.05, 0.08, d - 0.05, wood);
    b.rbox(0, y + 0.12, 0, w - 0.14, 0.14, d - 0.12, 0.04, S.cloth(pickC(CLOTH, f.seed + y * 5), 0.6));
  }
  b.rod(w / 2 + 0.02, 0.4, d / 2 - 0.3, w / 2 + 0.02, 1.2, d / 2 - 0.3, 0.015, S.steel(), 4);
}

function nightstand(b: MeshBuilder, f: Furn) {
  const wood = S.wood(pickC(WOOD, f.seed), 0.6);
  b.rbox(0, f.h / 2, 0, f.w, f.h, f.d, 0.02, wood);
  b.box(0, f.h * 0.7, f.d / 2 + 0.003, f.w - 0.06, 0.14, 0.01, S.wood(0x2a2018, 0.8));
  b.box(0, f.h * 0.3, f.d / 2 + 0.003, f.w - 0.06, 0.14, 0.01, S.wood(0x2a2018, 0.8));
  b.cyl(0.05, f.h + 0.1, 0, 0.1, 0.2, 0.1, S.paint(0xcfc8b0, 0.6), 0, 0, 0, 8);
  b.frustum(0.05, f.h + 0.3, 0, 0.1, 0.06, 0.18, S.cloth(0xd8c8a0, 0.6), 0, 0, 0, 10);
}

function wardrobe(b: MeshBuilder, f: Furn) {
  const wood = S.wood(pickC(WOOD, f.seed), 0.6);
  b.rbox(0, f.h / 2, 0, f.w, f.h, f.d, 0.02, wood);
  b.box(0, f.h / 2, f.d / 2 + 0.004, 0.012, f.h - 0.1, 0.01, S.wood(0x1e1610, 0.8));
  b.box(0, f.h - 0.02, 0, f.w + 0.04, 0.05, f.d + 0.04, wood);
  for (const x of [-0.07, 0.07]) b.box(x, f.h * 0.5, f.d / 2 + 0.02, 0.025, 0.2, 0.025, S.metal(0x9a9a98, 0.5));
}

function dresser(b: MeshBuilder, f: Furn) {
  const wood = S.wood(pickC(WOOD, f.seed), 0.6);
  b.rbox(0, f.h / 2, 0, f.w, f.h, f.d, 0.02, wood);
  b.box(0, f.h + 0.01, 0, f.w + 0.04, 0.04, f.d + 0.04, S.wood(pickC(WOOD, f.seed + 2), 0.55));
  for (let i = 0; i < 3; i++) {
    const y = f.h * (0.2 + i * 0.3);
    b.box(0, y + 0.15, f.d / 2 + 0.004, f.w - 0.1, 0.012, 0.01, S.wood(0x1e1610, 0.8));
    b.box(0, y, f.d / 2 + 0.02, 0.14, 0.02, 0.02, S.metal(0x9a9a98, 0.5));
  }
  b.rbox(-f.w * 0.25, f.h + 0.14, 0, 0.18, 0.22, 0.12, 0.02, S.paint(0x6a7a8a, 0.6));
}

function sofa(b: MeshBuilder, f: Furn) {
  const { w, d } = f;
  const c = S.cloth(pickC(CLOTH, f.seed), 0.6);
  const c2 = S.cloth(pickC(CLOTH, f.seed + 2), 0.6);
  b.rbox(0, 0.2, 0, w, 0.24, d, 0.04, S.wood(0x2a2018, 0.8));
  b.rbox(0, 0.4, 0.06, w - 0.3, 0.2, d - 0.22, 0.07, c);
  b.rbox(0, 0.68, -d / 2 + 0.12, w - 0.1, 0.58, 0.22, 0.08, c);
  for (const s of [-1, 1]) b.rbox(s * (w / 2 - 0.1), 0.45, 0.02, 0.2, 0.5, d - 0.04, 0.07, c2);
  const n = w > 1.8 ? 3 : 2;
  for (let i = 0; i < n; i++) b.rbox(((i + 0.5) / n - 0.5) * (w - 0.4), 0.56, 0.08, (w - 0.4) / n - 0.03, 0.12, d - 0.34, 0.05, c);
}

function armchair(b: MeshBuilder, f: Furn) {
  const c = S.cloth(pickC(CLOTH, f.seed + 4), 0.6);
  b.rbox(0, 0.2, 0, f.w, 0.24, f.d, 0.04, S.wood(0x2a2018, 0.8));
  b.rbox(0, 0.42, 0.05, f.w - 0.3, 0.2, f.d - 0.22, 0.07, c);
  b.rbox(0, 0.68, -f.d / 2 + 0.11, f.w - 0.08, 0.56, 0.2, 0.08, c);
  for (const s of [-1, 1]) b.rbox(s * (f.w / 2 - 0.09), 0.45, 0.02, 0.18, 0.46, f.d - 0.04, 0.07, c);
}

function table(b: MeshBuilder, f: Furn) {
  const wood = S.wood(pickC(WOOD, f.seed), 0.6);
  b.box(0, f.h - 0.025, 0, f.w, 0.05, f.d, wood);
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.box(x * (f.w / 2 - 0.06), (f.h - 0.05) / 2, z * (f.d / 2 - 0.06), 0.06, f.h - 0.05, 0.06, wood);
}

function coffeetable(b: MeshBuilder, f: Furn) {
  const wood = S.wood(pickC(WOOD, f.seed), 0.6);
  b.rbox(0, f.h - 0.03, 0, f.w, 0.05, f.d, 0.02, wood);
  b.box(0, 0.12, 0, f.w - 0.1, 0.03, f.d - 0.1, wood);
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.box(x * (f.w / 2 - 0.05), (f.h - 0.05) / 2, z * (f.d / 2 - 0.05), 0.05, f.h - 0.05, 0.05, wood);
  if (f.seed % 2) b.rbox(0.1, f.h, 0, 0.18, 0.04, 0.12, 0.01, S.paint(0x8a3a2a, 0.7));
}

function chair(b: MeshBuilder, f: Furn) {
  const wood = S.wood(pickC(WOOD, f.seed), 0.6);
  b.box(0, 0.45, 0, f.w, 0.05, f.d, wood);
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.box(x * (f.w / 2 - 0.03), 0.22, z * (f.d / 2 - 0.03), 0.04, 0.44, 0.04, wood);
  b.box(0, 0.7, -f.d / 2 + 0.02, f.w, 0.4, 0.04, wood);
}

function deskchair(b: MeshBuilder, f: Furn) {
  const dark = S.plastic(0x2a2a2c, 0.5);
  b.cyl(0, 0.25, 0, 0.06, 0.4, 0.06, S.steel(), 0, 0, 0, 6);
  for (let i = 0; i < 5; i++) b.rod(0, 0.07, 0, Math.cos(i * 1.256) * 0.26, 0.04, Math.sin(i * 1.256) * 0.26, 0.02, dark, 4);
  b.rbox(0, 0.48, 0, 0.46, 0.08, 0.46, 0.03, S.cloth(pickC(CLOTH, f.seed), 0.6));
  b.rbox(0, 0.78, -0.2, 0.44, 0.52, 0.07, 0.03, S.cloth(pickC(CLOTH, f.seed), 0.6));
}

function tvstand(b: MeshBuilder, f: Furn) {
  const wood = S.wood(pickC(WOOD, f.seed), 0.6);
  b.rbox(0, f.h / 2, 0, f.w, f.h, f.d, 0.02, wood);
  b.box(0, f.h * 0.5, f.d / 2 + 0.004, f.w - 0.1, f.h - 0.12, 0.01, S.wood(0x1e1610, 0.8));
  if (f.seed % 3) {
    b.rbox(0, f.h + 0.34, -0.02, 0.9, 0.52, 0.06, 0.02, S.plastic(0x141416, 0.4));
    b.box(0, f.h + 0.34, 0.012, 0.82, 0.44, 0.01, S.glass(0x0a1218));
    b.box(0, f.h + 0.05, -0.02, 0.2, 0.1, 0.12, S.plastic(0x1a1a1c, 0.4));
  } else {
    b.rbox(0.1, f.h + 0.34, 0, 0.9, 0.52, 0.06, 0.02, S.plastic(0x141416, 0.4), 0.2, 0.3, 0.8);
  }
}

function bookshelf(b: MeshBuilder, f: Furn) {
  const wood = S.wood(pickC(WOOD, f.seed), 0.6);
  const r = rnd(f.seed + 5);
  b.box(0, f.h / 2, -f.d / 2 + 0.01, f.w, f.h, 0.02, S.wood(0x2a2018, 0.8));
  for (const x of [-1, 1]) b.box(x * (f.w / 2 - 0.015), f.h / 2, 0, 0.03, f.h, f.d, wood);
  const shelves = Math.max(3, Math.round(f.h / 0.38));
  for (let i = 0; i <= shelves; i++) {
    const y = (i / shelves) * (f.h - 0.03) + 0.015;
    b.box(0, y, 0, f.w, 0.03, f.d, wood);
    if (i < shelves && r() > 0.2) {
      let x = -f.w / 2 + 0.07;
      const top = ((i + 1) / shelves) * (f.h - 0.03) - y;
      while (x < f.w / 2 - 0.2 && r() > 0.12) {
        const bw = 0.03 + r() * 0.04;
        const bh = Math.min(top - 0.06, 0.18 + r() * 0.12);
        b.box(x + bw / 2, y + 0.015 + bh / 2, 0, bw, bh, f.d - 0.12, S.paint(GOODS[Math.floor(r() * GOODS.length)], 0.8), 0, 0, (r() - 0.5) * 0.1);
        x += bw + 0.005;
      }
    }
  }
}

function rug(b: MeshBuilder, f: Furn) {
  const c = pickC([0x7a3a30, 0x3a5a6a, 0x6a5a3a, 0x4a4a5a], f.seed);
  b.box(0, 0.012, 0, f.w, 0.02, f.d, S.cloth(c, 0.7));
  b.box(0, 0.024, 0, f.w - 0.2, 0.01, f.d - 0.2, S.cloth(c + 0x181818, 0.7));
  b.box(0, 0.032, 0, f.w - 0.5, 0.01, f.d - 0.5, S.cloth(c, 0.7));
}

function counter(b: MeshBuilder, f: Furn) {
  const cab = S.paint(pickC([0xd8d0b8, 0xb8c0b0, 0xa8a898, 0xc8b898], f.seed >> 3), 0.6);
  b.box(0, 0.44, 0.01, f.w, 0.88, f.d - 0.02, cab);
  b.box(0, 0.9, 0.01, f.w + 0.02, 0.04, f.d + 0.02, S.concrete(0x4a463e, 0.5));
  b.box(0, 0.45, f.d / 2, f.w - 0.06, 0.6, 0.01, S.paint(0x8a8472, 0.7));
  b.box(0, 0.12, f.d / 2 - 0.02, f.w, 0.12, 0.02, S.paint(0x2a2822, 0.8));
  b.box(0.12, 0.7, f.d / 2 + 0.02, 0.12, 0.02, 0.02, S.metal(0x9a9a98, 0.5));
  // Upper cabinets against the wall.
  b.box(0, 1.65, -f.d / 2 + 0.17, f.w, 0.6, 0.34, cab);
  b.box(0, 1.65, -f.d / 2 + 0.345, f.w - 0.06, 0.52, 0.01, S.paint(0x8a8472, 0.7));
}

function sinkunit(b: MeshBuilder, f: Furn) {
  counter(b, f);
  b.box(0, 0.91, 0.02, f.w * 0.55, 0.045, f.d - 0.2, S.metal(0xb8bcc0, 0.4));
  b.box(0, 0.93, 0.02, f.w * 0.5, 0.03, f.d - 0.26, S.metal(0x6a6e72, 0.4));
  b.rod(0, 0.92, -f.d / 2 + 0.12, 0, 1.15, -f.d / 2 + 0.12, 0.018, S.chrome(), 6);
  b.rod(0, 1.15, -f.d / 2 + 0.12, 0, 1.12, -f.d / 2 + 0.28, 0.018, S.chrome(), 6);
}

function stove(b: MeshBuilder, f: Furn) {
  b.box(0, 0.45, 0, f.w, 0.9, f.d, S.paint(0xd4d0c4, 0.55));
  b.box(0, 0.905, 0, f.w + 0.01, 0.02, f.d + 0.01, S.plastic(0x1a1a1c, 0.4));
  for (const [x, z] of [[-0.14, -0.12], [0.14, -0.12], [-0.14, 0.14], [0.14, 0.14]]) b.cyl(x, 0.925, z, 0.17, 0.02, 0.17, S.steel(0x2a2a2c, 0.5), 0, 0, 0, 10);
  b.box(0, 0.42, f.d / 2 + 0.004, f.w - 0.12, 0.4, 0.01, S.glass(0x141418));
  b.box(0, 0.7, f.d / 2 + 0.01, f.w - 0.06, 0.03, 0.02, S.metal(0x8a8a88, 0.5));
  b.box(0, 1.1, -f.d / 2 + 0.03, f.w, 0.3, 0.06, S.paint(0xd4d0c4, 0.55));
}

function fridge(b: MeshBuilder, f: Furn) {
  const body = S.paint(pickC([0xd8d4c8, 0xc8cac4, 0xa8b0a8, 0xe0d8c0], f.seed), 0.55);
  b.rbox(0, f.h / 2, 0, f.w, f.h, f.d, 0.03, body);
  b.box(0, f.h * 0.64, f.d / 2 + 0.003, f.w - 0.04, 0.012, 0.01, S.paint(0x4a4a46, 0.8));
  b.box(-f.w / 2 + 0.07, f.h * 0.82, f.d / 2 + 0.03, 0.025, 0.4, 0.03, S.metal(0x9a9a98, 0.4));
  b.box(-f.w / 2 + 0.07, f.h * 0.4, f.d / 2 + 0.03, 0.025, 0.5, 0.03, S.metal(0x9a9a98, 0.4));
}

function toilet(b: MeshBuilder, f: Furn) {
  const porc = S.gloss(0xd8d8d0, 0.4);
  b.rbox(0, 0.22, 0.12, 0.38, 0.4, 0.46, 0.1, porc);
  b.cyl(0, 0.43, 0.14, 0.36, 0.04, 0.42, S.paint(0xcfcfc8, 0.5), 0, 0, 0, 12);
  b.rbox(0, 0.62, -0.24, 0.4, 0.4, 0.17, 0.04, porc);
}

function vanity(b: MeshBuilder, f: Furn) {
  b.box(0, 0.4, 0, f.w, 0.8, f.d, S.wood(pickC(WOOD, f.seed), 0.6));
  b.box(0, 0.82, 0, f.w + 0.02, 0.04, f.d + 0.02, S.concrete(0xc8c4b8, 0.4));
  b.cyl(0, 0.845, 0.02, 0.34, 0.03, 0.28, S.gloss(0xe0e0d8, 0.4), 0, 0, 0, 12);
  b.rod(0, 0.85, -f.d / 2 + 0.06, 0, 1.0, -f.d / 2 + 0.06, 0.015, S.chrome(), 6);
  // Mirror cabinet on the wall.
  b.box(0, 1.5, -f.d / 2 + 0.06, f.w - 0.1, 0.7, 0.1, S.paint(0xcfcfc8, 0.5));
  b.box(0, 1.5, -f.d / 2 + 0.115, f.w - 0.16, 0.6, 0.01, S.chrome());
}

function tub(b: MeshBuilder, f: Furn) {
  const porc = S.gloss(0xdcdcd4, 0.4);
  b.rbox(0, f.h / 2, 0, f.w, f.h, f.d, 0.06, porc);
  b.box(0, f.h + 0.003, 0.02, f.w - 0.16, 0.012, f.d - 0.16, S.paint(0x8a9a98, 0.4));
  b.rod(0, f.h, -f.d / 2 + 0.1, 0, f.h + 0.3, -f.d / 2 + 0.1, 0.018, S.chrome(), 6);
}

function desk(b: MeshBuilder, f: Furn) {
  const wood = S.wood(pickC(WOOD, f.seed), 0.6);
  b.box(0, f.h - 0.025, 0, f.w, 0.05, f.d, wood);
  b.box(f.w / 2 - 0.2, (f.h - 0.05) / 2, 0, 0.4, f.h - 0.05, f.d - 0.04, wood);
  b.box(-f.w / 2 + 0.03, (f.h - 0.05) / 2, 0, 0.04, f.h - 0.05, f.d - 0.04, wood);
  for (let i = 0; i < 3; i++) b.box(f.w / 2 - 0.2, 0.17 + i * 0.2, f.d / 2 - 0.015, 0.34, 0.012, 0.01, S.wood(0x1e1610, 0.8));
  b.rbox(-0.2, f.h + 0.05, 0, 0.3, 0.1, 0.22, 0.02, S.paint(0xcfc8b8, 0.6));
  b.box(-0.2, f.h + 0.21, -0.1, 0.34, 0.24, 0.02, S.plastic(0x1a1a1c, 0.4));
}

function filing(b: MeshBuilder, f: Furn) {
  b.rbox(0, f.h / 2, 0, f.w, f.h, f.d, 0.02, S.metal(0x7a8084, 0.6));
  for (let i = 0; i < 3; i++) {
    const y = f.h * (0.2 + i * 0.3);
    b.box(0, y + 0.13, f.d / 2 + 0.004, f.w - 0.06, 0.012, 0.01, S.paint(0x2a2c2e, 0.8));
    b.box(0, y, f.d / 2 + 0.02, 0.14, 0.03, 0.025, S.metal(0xb0b4b6, 0.4));
  }
}

function locker(b: MeshBuilder, f: Furn) {
  const c = pickC([0x5a6a7a, 0x6a7a5a, 0x7a7a7e, 0x8a5a4a], f.seed);
  b.rbox(0, f.h / 2, 0, f.w, f.h, f.d, 0.02, S.metal(c, 0.65));
  b.box(0, f.h / 2, f.d / 2 + 0.004, f.w - 0.06, f.h - 0.08, 0.01, S.metal(c + 0x0a0a0a, 0.6));
  for (let i = 0; i < 4; i++) b.box(0, f.h - 0.2 - i * 0.04, f.d / 2 + 0.012, f.w - 0.18, 0.012, 0.01, S.paint(0x1a1a1c, 0.8));
  b.box(f.w / 2 - 0.1, f.h * 0.5, f.d / 2 + 0.02, 0.03, 0.12, 0.03, S.metal(0xb0b4b6, 0.4));
}

function safe(b: MeshBuilder, f: Furn) {
  b.rbox(0, f.h / 2, 0, f.w, f.h, f.d, 0.03, S.steel(0x3a3e42, 0.7));
  b.cyl(0.05, f.h * 0.58, f.d / 2 + 0.02, 0.14, 0.04, 0.14, S.chrome(), Math.PI / 2, 0, 0, 12);
  b.box(-0.14, f.h * 0.58, f.d / 2 + 0.02, 0.04, 0.2, 0.03, S.metal(0xa0a4a8, 0.4));
}

function gondola(b: MeshBuilder, f: Furn) {
  const r = rnd(f.seed + 11);
  const frame = S.metal(0x8a8e8e, 0.65);
  b.box(0, 0.06, 0, f.w, 0.12, f.d, S.paint(0x4a4a48, 0.8));
  b.box(0, f.h / 2, 0, 0.03, f.h, f.d, frame, 0, 0, 0);
  for (const x of [-1, 1]) b.box(x * (f.w / 2 - 0.015), f.h / 2, 0, 0.03, f.h, f.d, frame);
  // Three boards, 0.4 m apart: the goods fill what the loose items leave free.
  for (let i = 0; i < 3; i++) {
    const y = 0.22 + i * 0.4;
    b.box(0, y, 0, f.w, 0.025, f.d, frame);
    for (const side of [-1, 1]) {
      let x = -f.w / 2 + 0.1;
      while (x < f.w / 2 - 0.15) {
        if (r() > 0.28) {
          const bw = 0.1 + r() * 0.16;
          const bh = 0.1 + r() * 0.18;
          if (!held(f, i, x - 0.02, x + bw + 0.02, side)) b.box(x + bw / 2, y + 0.012 + bh / 2, side * f.d * 0.2, bw, bh, f.d * 0.34, S.paint(GOODS[Math.floor(r() * GOODS.length)], 0.8));
          x += bw + 0.02;
        } else x += 0.25;
      }
    }
  }
}

function checkout(b: MeshBuilder, f: Furn) {
  b.box(0, 0.5, 0, f.w, 1.0, f.d, S.paint(0x7a6a58, 0.7));
  b.box(0, 1.02, 0, f.w + 0.04, 0.05, f.d + 0.04, S.concrete(0x3a3834, 0.5));
  b.rbox(-f.w * 0.2, 1.16, -0.05, 0.4, 0.22, 0.34, 0.03, S.paint(0x4a4a46, 0.6));
  b.box(-f.w * 0.2, 1.3, -0.17, 0.3, 0.14, 0.03, S.glass(0x10181c), -0.3, 0, 0);
  b.box(f.w * 0.15, 1.05, 0.02, 0.5, 0.02, f.d - 0.2, S.rubber(0x1a1a1c));
}

function cooler(b: MeshBuilder, f: Furn) {
  const r = rnd(f.seed + 13);
  b.box(0, f.h / 2, 0, f.w, f.h, f.d, S.paint(0xcfd2d0, 0.5));
  b.box(0, f.h / 2, f.d / 2 + 0.003, f.w - 0.1, f.h - 0.2, 0.01, S.glass(0x4a606c));
  for (let i = 0; i < 4; i++) {
    const y = 0.3 + i * ((f.h - 0.5) / 4);
    b.box(0, y, f.d / 2 - 0.12, f.w - 0.14, 0.02, 0.28, S.steel(0x6a6e70, 0.5));
    let x = -f.w / 2 + 0.12;
    while (x < f.w / 2 - 0.18) {
      b.cyl(x, y + 0.13, f.d / 2 - 0.12, 0.08, 0.24, 0.08, S.paint(GOODS[Math.floor(r() * GOODS.length)], 0.6), 0, 0, 0, 8);
      x += 0.13;
    }
  }
  b.box(0, f.h - 0.04, 0, f.w + 0.02, 0.08, f.d + 0.02, S.paint(0x9aa0a0, 0.55));
}

function rack(b: MeshBuilder, f: Furn) {
  const r = rnd(f.seed + 17);
  const upright = S.paint(0x2a5a9a, 0.6);
  const beam = S.paint(0xd87a2a, 0.6);
  const bays = Math.max(1, Math.round(f.w / 1.8));
  for (let i = 0; i <= bays; i++) {
    const x = -f.w / 2 + (i * f.w) / bays;
    for (const z of [-f.d / 2 + 0.04, f.d / 2 - 0.04]) b.box(x, f.h / 2, z, 0.08, f.h, 0.08, upright);
  }
  const levels = 3;
  for (let l = 0; l < levels; l++) {
    const y = 0.2 + l * ((f.h - 0.3) / levels);
    for (const z of [-f.d / 2 + 0.05, f.d / 2 - 0.05]) b.box(0, y, z, f.w, 0.1, 0.05, beam);
    b.box(0, y + 0.03, 0, f.w - 0.1, 0.03, f.d - 0.12, S.wood(0x8a6a44, 0.7));
    for (let i = 0; i < bays; i++) {
      const x = -f.w / 2 + ((i + 0.5) * f.w) / bays;
      // The two low levels keep their bay clear for a loose item; the crates are stacked in whatever is left.
      if (held(f, l, x - 0.1, x + 0.1) || r() < 0.3) continue;
      const n = 1 + Math.floor(r() * 2);
      for (let k = 0; k < n; k++) {
        const bh = 0.4 + r() * 0.5;
        b.box(x + (k - (n - 1) / 2) * 0.5, y + 0.05 + bh / 2, 0, 0.7, bh, f.d - 0.25, r() > 0.4 ? S.paint(0x9a7a52, 0.8) : S.paint(GOODS[Math.floor(r() * GOODS.length)], 0.8));
      }
    }
  }
}

function pallet(b: MeshBuilder, f: Furn) {
  const r = rnd(f.seed + 19);
  const wood = S.wood(0x8a6a44, 0.75);
  for (let i = 0; i < 3; i++) b.box(0, 0.06, -f.d / 2 + 0.08 + i * (f.d / 2 - 0.08), f.w, 0.1, 0.1, wood);
  for (let i = 0; i < 5; i++) b.box(-f.w / 2 + 0.05 + i * ((f.w - 0.1) / 4), 0.13, 0, 0.11, 0.03, f.d, wood);
  const n = held(f, 0, -9, 9) ? 0 : Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const bh = 0.3 + r() * 0.4;
    b.box((i - (n - 1) / 2) * 0.4, 0.15 + bh / 2, 0, 0.7, bh, f.d - 0.15, r() > 0.5 ? S.paint(0x9a7a52, 0.8) : S.paint(GOODS[Math.floor(r() * GOODS.length)], 0.8), 0, (r() - 0.5) * 0.3, 0);
  }
}

function crate(b: MeshBuilder, f: Furn) {
  const wood = S.wood(pickC(WOOD, f.seed), 0.75);
  b.box(0, f.h / 2, 0, f.w, f.h, f.d, S.wood(0x7a5a38, 0.8));
  for (const y of [0.05, f.h - 0.05]) {
    b.box(0, y, f.d / 2 + 0.005, f.w + 0.01, 0.08, 0.02, wood);
    b.box(0, y, -f.d / 2 - 0.005, f.w + 0.01, 0.08, 0.02, wood);
    b.box(f.w / 2 + 0.005, y, 0, 0.02, 0.08, f.d + 0.01, wood);
    b.box(-f.w / 2 - 0.005, y, 0, 0.02, 0.08, f.d + 0.01, wood);
  }
  for (const x of [-1, 1]) b.box(x * (f.w / 2 - 0.05), f.h / 2, f.d / 2 + 0.005, 0.07, f.h, 0.02, wood);
}

function barrel(b: MeshBuilder, f: Furn) {
  const c = pickC([0x6a3a2a, 0x2a4a6a, 0x4a5a3a, 0x8a8a84], f.seed);
  b.cyl(0, f.h / 2, 0, 0.56, f.h, 0.56, S.metal(c, 0.7), 0, 0, 0, 14);
  for (const y of [0.15, f.h / 2, f.h - 0.15]) b.torus(0, y, 0, 0.285, 0.015, S.steel(0x3a3c3e, 0.7), Math.PI / 2, 0, 0, 4, 16);
  b.cyl(0, f.h + 0.005, 0, 0.46, 0.015, 0.46, S.metal(c - 0x101010, 0.7), 0, 0, 0, 14);
}

function haybale(b: MeshBuilder, f: Furn) {
  const r = rnd(f.seed + 23);
  b.box(0, f.h / 2, 0, f.w, f.h, f.d, S.cloth(0xb09850 + Math.floor(r() * 5) * 0x0a0a00, 0.9));
  for (const x of [-0.22, 0.22]) b.box(x * f.w, f.h / 2, 0, 0.02, f.h + 0.02, f.d + 0.02, S.cloth(0x6a5a3a));
  for (let i = 0; i < 6; i++) b.rod((r() - 0.5) * f.w, f.h, (r() - 0.5) * f.d, (r() - 0.5) * f.w * 1.3, f.h + 0.1, (r() - 0.5) * f.d * 1.3, 0.008, S.cloth(0xc8b060), 3);
}

function workbench(b: MeshBuilder, f: Furn) {
  const wood = S.wood(0x6a4a30, 0.75);
  b.box(0, f.h - 0.04, 0, f.w, 0.08, f.d, wood);
  for (const x of [-1, 1]) {
    b.box(x * (f.w / 2 - 0.06), (f.h - 0.08) / 2, 0, 0.08, f.h - 0.08, f.d - 0.1, wood);
  }
  b.box(0, 0.3, 0, f.w - 0.2, 0.04, f.d - 0.1, wood);
  // Tool board on the wall with outlines, a vise and a few tools on top.
  b.box(0, f.h + 0.6, -f.d / 2 + 0.03, f.w - 0.1, 0.8, 0.04, S.wood(0x4a3a28, 0.8));
  const r = rnd(f.seed + 29);
  for (let i = 0; i < 5; i++) b.rod(-f.w / 2 + 0.25 + i * ((f.w - 0.5) / 4), f.h + 0.4 + r() * 0.2, -f.d / 2 + 0.06, -f.w / 2 + 0.25 + i * ((f.w - 0.5) / 4) + (r() - 0.5) * 0.1, f.h + 0.8, -f.d / 2 + 0.06, 0.012, S.steel(0x7a7e80, 0.5), 4);
  b.rbox(f.w / 2 - 0.22, f.h + 0.1, 0.05, 0.16, 0.16, 0.2, 0.02, S.paint(0x3a3c3e, 0.6));
  if (!f.used?.length) b.box(-0.2, f.h + 0.02, 0.05, 0.3, 0.04, 0.08, S.paint(0xb84a2a, 0.7), 0, 0.3, 0);
}

function stall(b: MeshBuilder, f: Furn) {
  const wood = S.wood(0x6a4a30, 0.8);
  // A partition of boards with a post at each end; local x is its length.
  for (let i = 0; i < 6; i++) b.box(0, 0.2 + i * 0.25, 0, f.w, 0.2, f.d, wood, 0, 0, (i % 2 ? 1 : -1) * 0.004);
  for (const x of [-f.w / 2, f.w / 2]) b.box(x, f.h / 2, 0, 0.14, f.h + 0.1, 0.14, S.wood(0x4a3220, 0.8));
}

function woodstove(b: MeshBuilder, f: Furn) {
  b.rbox(0, 0.4, 0, f.w, 0.6, f.d, 0.05, S.steel(0x2a2a2c, 0.6));
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.box(x * (f.w / 2 - 0.05), 0.05, z * (f.d / 2 - 0.05), 0.06, 0.1, 0.06, S.steel(0x2a2a2c, 0.6));
  b.cyl(0, 1.3, -f.d / 2 + 0.1, 0.12, 1.4, 0.12, S.metal(0x2a2a2c, 0.6), 0, 0, 0, 8);
  b.box(0, 0.4, f.d / 2 + 0.004, 0.28, 0.24, 0.01, S.glow(0xff8a3a, 0.5));
}

function footlocker(b: MeshBuilder, f: Furn) {
  b.box(0, f.h / 2, 0, f.w, f.h, f.d, S.wood(0x5a4030, 0.8));
  b.box(0, f.h + 0.03, 0, f.w + 0.02, 0.07, f.d + 0.02, S.wood(0x4a3424, 0.8));
  for (const x of [-0.3, 0.3]) b.box(x * f.w, f.h / 2 + 0.03, 0, 0.05, f.h + 0.1, f.d + 0.02, S.steel(0x4a4a48, 0.7));
  b.box(0, f.h, f.d / 2 + 0.01, 0.07, 0.07, 0.02, S.metal(0xa8a090, 0.5));
}

function shelf(b: MeshBuilder, f: Furn) {
  const r = rnd(f.seed + 31);
  const frame = S.metal(0x6a6e6e, 0.7);
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.box(x * (f.w / 2 - 0.02), f.h / 2, z * (f.d / 2 - 0.02), 0.04, f.h, 0.04, frame);
  const n = Math.max(3, Math.round(f.h / 0.45));
  for (let i = 0; i < n; i++) {
    const y = 0.12 + i * ((f.h - 0.2) / (n - 1));
    b.box(0, y, 0, f.w, 0.03, f.d, S.wood(0x7a5a38, 0.8));
    let x = -f.w / 2 + 0.1;
    while (x < f.w / 2 - 0.2) {
      if (r() > 0.35) {
        const bw = 0.12 + r() * 0.22;
        const bh = 0.1 + r() * 0.22;
        if (!held(f, i, x - 0.02, x + bw + 0.02)) b.box(x + bw / 2, y + 0.015 + bh / 2, 0, bw, bh, f.d * 0.8, r() > 0.5 ? S.paint(0x9a7a52, 0.8) : S.paint(GOODS[Math.floor(r() * GOODS.length)], 0.8));
        x += bw + 0.03;
      } else x += 0.2;
    }
  }
}

/** Heavy steel shelving: three tiers on blue uprights, a bin or two on each tier where nothing lies. */
function partsshelf(b: MeshBuilder, f: Furn) {
  const r = rnd(f.seed + 41);
  const upright = S.paint(0x2a5a9a, 0.6);
  const tiers = [0.1, 0.85, 1.5];
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.box(x * (f.w / 2 - 0.03), f.h / 2, z * (f.d / 2 - 0.03), 0.06, f.h, 0.06, upright);
  for (const y of [...tiers, f.h - 0.03]) b.box(0, y, 0, f.w, 0.04, f.d, y === f.h - 0.03 ? upright : S.metal(0x7a7e82, 0.6));
  b.box(0, f.h / 2, -f.d / 2 + 0.01, f.w - 0.1, f.h - 0.1, 0.012, S.metal(0x5a5e62, 0.7));
  tiers.forEach((y, i) => {
    if (r() < 0.35) return;
    for (const x of [-f.w * 0.24, f.w * 0.24]) {
      if (held(f, i, x - 0.2, x + 0.2) || r() < 0.3) continue;
      const bh = 0.12 + r() * 0.22;
      b.box(x, y + 0.02 + bh / 2, 0, 0.3 + r() * 0.2, bh, f.d - 0.15, r() > 0.5 ? S.plastic(0x9a2a1e, 0.6) : S.plastic(0xc8a82a, 0.6));
    }
  });
}

/** An engine stand: a rolling steel frame with a padded cradle. The engine sits on its deck. */
function enginestand(b: MeshBuilder, f: Furn) {
  const steel = S.steel(0x3a3d40, 0.7);
  const paint = S.paint(0xc43a1e, 0.55);
  for (const x of [-1, 1]) b.box(x * (f.w / 2 - 0.06), 0.1, 0, 0.08, 0.08, f.d, steel);
  for (const z of [-1, 1]) b.box(0, 0.16, z * (f.d / 2 - 0.06), f.w, 0.05, 0.07, steel);
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.cyl(x * (f.w / 2 - 0.08), 0.05, z * (f.d / 2 - 0.05), 0.1, 0.1, 0.1, S.rubber(0x1c1c1e), Math.PI / 2, 0, 0, 8);
  for (const x of [-1, 1]) {
    b.box(x * (f.w / 2 - 0.08), 0.3, -f.d / 2 + 0.07, 0.07, 0.34, 0.07, paint);
    b.box(x * (f.w / 2 - 0.08), 0.3, f.d / 2 - 0.07, 0.07, 0.34, 0.07, paint);
    b.box(x * (f.w / 2 - 0.08), f.h - 0.025, 0, 0.1, 0.05, f.d - 0.04, paint);
  }
}

/** A wall rack of tyres: two tiers of planking on uprights, tyres standing in the cells that hold no loose one. */
function tyrerack(b: MeshBuilder, f: Furn) {
  const upright = S.paint(0x2a5a9a, 0.6);
  const rubber = S.rubber(0x161618);
  const tiers = [0.12, 0.84];
  for (let i = 0; i <= 3; i++) for (const z of [-f.d / 2 + 0.04, f.d / 2 - 0.04]) b.box(-f.w / 2 + (i * f.w) / 3, f.h / 2, z, 0.07, f.h, 0.07, upright);
  for (const y of [...tiers, f.h - 0.04]) b.box(0, y, 0, f.w, 0.04, f.d, S.wood(0x8a6a44, 0.7));
  tiers.forEach((y, k) => {
    for (let c = 0; c < 3; c++) {
      const x = -f.w / 2 + ((c + 0.5) * f.w) / 3;
      if (held(f, k, x - 0.05, x + 0.05) || (f.seed + c + k * 3) % 4 === 0) continue;
      b.torus(x, y + 0.02 + 0.3, 0, 0.23, 0.095, rubber, 0, 0, 0, 10, 24);
      b.cyl(x, y + 0.02 + 0.3, 0, 0.3, 0.13, 0.3, S.metal(0x8a8e92, 0.5), Math.PI / 2, 0, 0, 14);
    }
  });
}

/** A stack of tyres on the floor, lying flat. */
function tyrestack(b: MeshBuilder, f: Furn) {
  const rubber = S.rubber(0x161618);
  const n = 4 + (f.seed % 2);
  for (let i = 0; i < n; i++) b.torus(((i % 2) - 0.5) * 0.03, 0.1 + i * 0.19, ((i % 3) - 1) * 0.02, 0.26, 0.09, rubber, Math.PI / 2, 0, 0, 10, 24);
}

/** A wall rack for guns: a backboard on two steel uprights, three padded tiers with a lip, and a locking bar. The guns themselves lie on it as separate objects. */
function gunrack(b: MeshBuilder, f: Furn) {
  // Light boards behind dark guns, so each one reads as a silhouette.
  const steel = S.steel(0x6a6e72, 0.5);
  const wood = S.wood(0xb89868, 0.5);
  b.box(0, f.h / 2, -f.d / 2 + 0.02, f.w, f.h, 0.04, S.wood(0xd0b890, 0.5));
  for (const x of [-1, 1]) b.box(x * (f.w / 2 - 0.03), f.h / 2, 0, 0.06, f.h, f.d, steel);
  for (const y of GUN_RACK) {
    b.box(0, y, 0, f.w - 0.1, 0.04, f.d - 0.02, wood);
    b.box(0, y + 0.03, f.d / 2 - 0.02, f.w - 0.1, 0.03, 0.02, S.paint(0x8a2a1e, 0.5));
    for (const x of [-0.45, 0.45]) b.box(x * (f.w / 1.5), y + 0.06, -f.d / 2 + 0.06, 0.03, 0.1, 0.03, steel);
  }
  b.box(0, f.h - 0.08, f.d / 2 - 0.02, f.w - 0.05, 0.05, 0.03, steel);
  b.box(0, f.h + 0.01, 0, f.w, 0.03, f.d, steel);
}

/** A roller tool chest: a red cabinet with drawers and a worktop. */
function toolchest(b: MeshBuilder, f: Furn) {
  const red = S.paint(0xb02a1e, 0.45);
  b.rbox(0, 0.1 + (f.h - 0.1) / 2, 0, f.w, f.h - 0.1, f.d, 0.02, red);
  b.box(0, f.h + 0.015, 0, f.w + 0.02, 0.03, f.d + 0.02, S.steel(0x4a4d50, 0.6));
  for (let i = 0; i < 5; i++) {
    b.box(0, 0.2 + i * 0.18, f.d / 2 + 0.004, f.w - 0.1, 0.01, 0.01, S.paint(0x2a1210, 0.8));
    b.box(0, 0.28 + i * 0.18, f.d / 2 + 0.02, f.w * 0.5, 0.025, 0.025, S.chrome(0xb0b4b6));
  }
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.cyl(x * (f.w / 2 - 0.08), 0.05, z * (f.d / 2 - 0.06), 0.1, 0.1, 0.1, S.rubber(0x1c1c1e), Math.PI / 2, 0, 0, 8);
}

function rubble(b: MeshBuilder, f: Furn) {
  const r = rnd(f.seed + 37);
  const cols = [0x8a867e, 0x6a6862, 0xb0a898, 0x8a4c3a];
  // Broken slabs and chunks, heaped low, with a few boards and bent rebar.
  for (let i = 0; i < 9; i++) {
    const a = r() * 6.28;
    const rad = Math.sqrt(r()) * f.w * 0.5;
    const sz = 0.18 + r() * 0.4;
    b.box(Math.cos(a) * rad, 0.05 + (1 - rad / (f.w * 0.5 + 0.01)) * 0.18 + r() * 0.05, Math.sin(a) * rad, sz * (1 + r()), 0.06 + r() * 0.12, sz * (0.6 + r()), S.concrete(cols[Math.floor(r() * cols.length)], 0.8), r() * 0.5, r() * 6, r() * 0.5);
  }
  for (let i = 0; i < 4; i++) b.add('ico', (r() - 0.5) * f.w * 0.7, 0.1 + r() * 0.08, (r() - 0.5) * f.d * 0.7, 0.2 + r() * 0.3, 0.14 + r() * 0.18, 0.2 + r() * 0.3, S.concrete(cols[Math.floor(r() * cols.length)], 0.8), r(), r() * 6, r());
  for (let i = 0; i < 3; i++) b.box((r() - 0.5) * f.w * 0.8, 0.2, (r() - 0.5) * f.d * 0.8, 0.07, 0.04, 0.8 + r() * 0.8, S.wood(0x5a4630, 0.8), r() * 0.3, r() * 6, r() * 0.3);
  for (let i = 0; i < 2; i++) {
    const x = (r() - 0.5) * f.w * 0.5;
    const z = (r() - 0.5) * f.d * 0.5;
    b.pipe([[x, 0.15, z], [x + (r() - 0.5) * 0.3, 0.5 + r() * 0.4, z + (r() - 0.5) * 0.3], [x + (r() - 0.5) * 0.6, 0.7 + r() * 0.4, z + (r() - 0.5) * 0.4]], 0.012, S.rust(0x6a3a22), 4);
  }
}

const MODELS: Partial<Record<Furn['kind'], (b: MeshBuilder, f: Furn) => void>> = {
  bed, bunk, nightstand, wardrobe, dresser, sofa, armchair, table, coffeetable, chair, deskchair, tvstand, bookshelf, rug,
  counter, sinkunit, stove, fridge, toilet, vanity, tub, desk, filing, locker, safe, gondola, checkout, cooler, rack, pallet, crate, barrel,
  haybale, workbench, stall, woodstove, footlocker, shelf, rubble, partsshelf, enginestand, tyrerack, tyrestack, toolchest, gunrack,
};

/** Append the model for one piece of furniture. `y` is the floor height under it. */
export function appendFurn(target: MeshBuilder, f: Furn, y: number) {
  const model = MODELS[f.kind];
  if (!model) return;
  const b = new MeshBuilder();
  b.jitter = 0.03;
  b.seed(f.seed + 1);
  model(b, f);
  target.append(b, f.x, y, f.z, f.yaw, 1);
}

export { furnRect };
