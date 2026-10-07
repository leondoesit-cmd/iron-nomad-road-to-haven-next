import * as THREE from 'three';
import { MeshBuilder, S, valueNoise3, type Surf } from './builder';
import { kitMaterial } from './materials';
import { appendProp } from './props';
import { disposeTree } from './dispose';
import { crate } from './parts';
import { CELL, cellX, cellZ, floorAt, type DelveDecor, type DelveDoor, type DelveMap } from '../world/delve';
import type { DelveTheme } from '../world/delveSites';
import type { PropKind } from '../world/layout';

/**
 * Everything you see underground. Walls, floors and ceilings are built cell by cell from the delve grid; caves and
 * mines get rock whose vertices are shoved around by a position-only noise field (so neighbouring faces always
 * meet), the bunker and the metro get panelled concrete and tile with trims, pipes and lamps. All of it merges into
 * a handful of meshes using the shared "kit" material, so the shader wear and the lights treat it like any model.
 */

export interface DelveLook {
  wall: number;
  wall2: number;
  floor: number;
  ceil: number;
  /** Distance fog colour and range. */
  fog: number;
  fogNear: number;
  fogFar: number;
  /** Ambient (hemisphere) colours and strength. */
  sky: number;
  ground: number;
  ambient: number;
  /** Exposure the post chain uses, and bloom. */
  exposure: number;
  /** Colour of the way-out light. */
  daylight: number;
}

export const DELVE_LOOK: Record<DelveTheme, DelveLook> = {
  cave: { wall: 0x4e4036, wall2: 0x2e251e, floor: 0x5a4a3c, ceil: 0x3c3128, fog: 0x07090c, fogNear: 4, fogFar: 46, sky: 0x394a58, ground: 0x1a1612, ambient: 0.09, exposure: 1.25, daylight: 0xcfe4ff },
  mine: { wall: 0x5e4e3c, wall2: 0x3e3226, floor: 0x5e5040, ceil: 0x3a3026, fog: 0x0a0907, fogNear: 4, fogFar: 44, sky: 0x4a4a3e, ground: 0x1c1710, ambient: 0.1, exposure: 1.25, daylight: 0xffe2b0 },
  bunker: { wall: 0x8a8d86, wall2: 0x5f6a62, floor: 0x585a56, ceil: 0x6a6c68, fog: 0x080a0c, fogNear: 5, fogFar: 50, sky: 0x44525c, ground: 0x181a1c, ambient: 0.12, exposure: 1.25, daylight: 0xdaf0ff },
  metro: { wall: 0xb8b6a8, wall2: 0x2f5a52, floor: 0x7a7a74, ceil: 0x3c3e40, fog: 0x07090a, fogNear: 6, fogFar: 56, sky: 0x4a5a5a, ground: 0x16191a, ambient: 0.12, exposure: 1.25, daylight: 0xd8e8ff },
};

const SURF = (c: number, r = 0.9, m = 0, w = 0.6, e = 0): Surf => ({ c, r, m, w, e });

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Push a point by a position-only vector noise field: shared edges always move together, so rock never cracks. */
function rockify(p: [number, number, number], ax: number, ay: number, az: number, seed: number): [number, number, number] {
  const f = 0.55;
  const nx = valueNoise3(p[0] * f, p[1] * f, p[2] * f, seed) - 0.5;
  const ny = valueNoise3(p[0] * f + 17, p[1] * f, p[2] * f, seed + 1) - 0.5;
  const nz = valueNoise3(p[0] * f, p[1] * f + 31, p[2] * f, seed + 2) - 0.5;
  const g = 1.9;
  const mx = valueNoise3(p[0] * g, p[1] * g, p[2] * g, seed + 3) - 0.5;
  const my = valueNoise3(p[0] * g + 5, p[1] * g, p[2] * g, seed + 4) - 0.5;
  const mz = valueNoise3(p[0] * g, p[1] * g + 9, p[2] * g, seed + 5) - 0.5;
  return [p[0] + (nx * 2 + mx * 0.7) * ax, p[1] + (ny * 2 + my * 0.7) * ay, p[2] + (nz * 2 + mz * 0.7) * az];
}

type V3 = [number, number, number];

/** A flat-shaded subdivided face. `flip` reverses the winding. Vertices pass through `move`. */
function face(b: MeshBuilder, o: V3, u: V3, v: V3, nu: number, nv: number, move: (p: V3) => V3, color: (p: V3) => THREE.Color | number, surf: Surf, flip = false) {
  const col = new THREE.Color();
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const pt = (a: number, c: number): V3 => move([o[0] + (u[0] * a) / nu + (v[0] * c) / nv, o[1] + (u[1] * a) / nu + (v[1] * c) / nv, o[2] + (u[2] * a) / nu + (v[2] * c) / nv]);
      const p00 = pt(i, j);
      const p10 = pt(i + 1, j);
      const p11 = pt(i + 1, j + 1);
      const p01 = pt(i, j + 1);
      const c = color([(p00[0] + p11[0]) / 2, (p00[1] + p11[1]) / 2, (p00[2] + p11[2]) / 2]);
      if (typeof c === 'number') col.set(c);
      else col.copy(c);
      const s = { ...surf, c: col.clone() };
      if (flip) b.quad(p00, p01, p11, p10, s);
      else b.quad(p00, p10, p11, p01, s);
    }
  }
}

interface Run {
  /** 'x' runs along x (a north or south wall), 'z' along z (east or west). */
  axis: 'x' | 'z';
  /** Fixed coordinate in metres (the wall plane). */
  c: number;
  a: number;
  b: number;
  /** Which way the open side is: +1 or -1 along the perpendicular axis. */
  n: 1 | -1;
}

export class DelveView {
  group = new THREE.Group();
  doors = new Map<string, THREE.Group>();
  /** Shown once the boss is down. */
  lift = new THREE.Group();
  private geos: THREE.BufferGeometry[] = [];
  private extra: THREE.Material[] = [];

  constructor(public map: DelveMap) {
    const m = map;
    const L = DELVE_LOOK[m.theme];
    const kit = kitMaterial();
    const rocky = m.theme === 'cave' || m.theme === 'mine';
    const amp = m.theme === 'cave' ? 0.5 : 0.12;
    const shell = new MeshBuilder();
    shell.jitter = 0.05;
    const decor = new MeshBuilder();
    decor.jitter = 0.05;
    this.floors(shell, rocky, amp, L);
    this.ceilings(shell, rocky, amp, L);
    this.walls(shell, rocky, amp, L, decor);
    this.props(decor, L);
    this.lamps(decor);
    this.add(shell.build(), kit, false, true);
    this.add(decor.build(), kit, true, true);
    this.exitLight(L);
    this.buildLift();
    this.group.add(this.lift);
    this.lift.visible = false;
    for (const d of m.doors) this.buildDoor(d);
  }

  private add(g: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, receive: boolean) {
    this.geos.push(g);
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  // ------------------------------------------------------------------------------------------- floors

  private floors(b: MeshBuilder, rocky: boolean, amp: number, L: DelveLook) {
    const m = this.map;
    const r = rng(m.seed + 3);
    const base = new THREE.Color(L.floor);
    const tmp = new THREE.Color();
    for (let j = 0; j < m.h; j++) {
      for (let i = 0; i < m.w; i++) {
        if (!m.grid[j * m.w + i]) continue;
        const x = cellX(m, i);
        const z = cellZ(m, j);
        // Cells beside rock are darker: crude ambient occlusion in the corners.
        let solid = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (!floorAt(m, x + 1 + di * CELL, z + 1 + dj * CELL)) solid++;
        const ao = 1 - Math.min(0.5, solid * 0.09);
        if (rocky) {
          face(
            b,
            [x, 0, z],
            [CELL, 0, 0],
            [0, 0, CELL],
            2,
            2,
            (p) => rockify(p, amp * 0.5, 0.07, amp * 0.5, m.seed),
            (p) => tmp.copy(base).multiplyScalar(ao * (0.8 + valueNoise3(p[0] * 0.7, 0, p[2] * 0.7, m.seed + 9) * 0.5)),
            SURF(0, 0.95, 0, 0.8),
            true,
          );
        } else {
          // Slabs a metre square with hairline joints and the odd stained one.
          for (let k = 0; k < 4; k++) {
            const sx = x + (k % 2);
            const sz = z + Math.floor(k / 2);
            const tone = 0.86 + r() * 0.22;
            const stain = r() < 0.07 ? 0.65 : 1;
            const tile = m.theme === 'metro';
            const c = tmp.copy(base).multiplyScalar(ao * tone * stain * (tile && (i + j + k) % 2 === 0 ? 1.08 : 1));
            b.quad([sx + 0.02, 0, sz + 0.98], [sx + 0.98, 0, sz + 0.98], [sx + 0.98, 0, sz + 0.02], [sx + 0.02, 0, sz + 0.02], { ...SURF(0, tile ? 0.5 : 0.9, 0, 0.55), c: c.clone() });
          }
        }
      }
    }
    // A dark under-floor behind the joints, so gaps read as gaps and not as holes.
    const lo = new MeshBuilder();
    lo.quad([cellX(m, 0), -0.04, cellZ(m, m.h)], [cellX(m, m.w), -0.04, cellZ(m, m.h)], [cellX(m, m.w), -0.04, cellZ(m, 0)], [cellX(m, 0), -0.04, cellZ(m, 0)], SURF(0x0a0a0a, 1, 0, 0.2));
    b.append(lo);
  }

  // ------------------------------------------------------------------------------------------- ceilings

  private ceilings(b: MeshBuilder, rocky: boolean, amp: number, L: DelveLook) {
    const m = this.map;
    const H = m.ceil;
    const base = new THREE.Color(L.ceil);
    const tmp = new THREE.Color();
    const r = rng(m.seed + 5);
    for (let j = 0; j < m.h; j++) {
      for (let i = 0; i < m.w; i++) {
        if (!m.grid[j * m.w + i]) continue;
        const x = cellX(m, i);
        const z = cellZ(m, j);
        if (rocky) {
          face(
            b,
            [x, H, z],
            [CELL, 0, 0],
            [0, 0, CELL],
            2,
            2,
            (p) => rockify(p, amp * 0.5, m.theme === 'cave' ? 0.7 : 0.15, amp * 0.5, m.seed + 40),
            (p) => tmp.copy(base).multiplyScalar(0.75 + valueNoise3(p[0] * 0.6, p[1], p[2] * 0.6, m.seed + 11) * 0.5),
            SURF(0, 0.95, 0, 0.8),
          );
          // Stalactites on the cave ceiling.
          if (m.theme === 'cave' && r() < 0.28) {
            const px = x + 0.4 + r() * 1.2;
            const pz = z + 0.4 + r() * 1.2;
            const len = 0.6 + r() * 1.8;
            b.add('cone6', px, H - len / 2 + 0.3, pz, 0.35 + r() * 0.35, len, 0.35 + r() * 0.35, S.rock(0x5a4a3c), Math.PI, r() * 6, 0);
          }
        } else {
          const c = tmp.copy(base).multiplyScalar(0.85 + r() * 0.2);
          b.quad([x, H, z], [x + CELL, H, z], [x + CELL, H, z + CELL], [x, H, z + CELL], { ...SURF(0, 0.9, 0, 0.7), c: c.clone() });
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------- walls

  /** Maximal straight stretches of wall: a floor cell on one side and rock on the other. */
  private runs(): Run[] {
    const m = this.map;
    const out: Run[] = [];
    const solid = (i: number, j: number) => i < 0 || j < 0 || i >= m.w || j >= m.h || !m.grid[j * m.w + i];
    const fl = (i: number, j: number) => !solid(i, j);
    // North and south walls run along x.
    for (const n of [1, -1] as const) {
      for (let j = 0; j < m.h; j++) {
        let a = -1;
        for (let i = 0; i <= m.w; i++) {
          const wall = i < m.w && fl(i, j) && solid(i, j + (n === 1 ? -1 : 1));
          if (wall && a < 0) a = i;
          else if (!wall && a >= 0) {
            // The wall plane is the cell edge on the rock side; the open side is toward the floor.
            out.push({ axis: 'x', c: cellZ(m, n === 1 ? j : j + 1), a: cellX(m, a), b: cellX(m, i), n });
            a = -1;
          }
        }
      }
    }
    for (const n of [1, -1] as const) {
      for (let i = 0; i < m.w; i++) {
        let a = -1;
        for (let j = 0; j <= m.h; j++) {
          const wall = j < m.h && fl(i, j) && solid(i + (n === 1 ? -1 : 1), j);
          if (wall && a < 0) a = j;
          else if (!wall && a >= 0) {
            out.push({ axis: 'z', c: cellX(m, n === 1 ? i : i + 1), a: cellZ(m, a), b: cellZ(m, j), n });
            a = -1;
          }
        }
      }
    }
    return out;
  }

  private walls(b: MeshBuilder, rocky: boolean, amp: number, L: DelveLook, decor: MeshBuilder) {
    const m = this.map;
    const H = m.ceil;
    const r = rng(m.seed + 7);
    const tmp = new THREE.Color();
    const c1 = new THREE.Color(L.wall);
    const c2 = new THREE.Color(L.wall2);
    const pt = (run: Run, t: number, y: number): V3 => (run.axis === 'x' ? [t, y, run.c] : [run.c, y, t]);
    for (const run of this.runs()) {
      const len = run.b - run.a;
      if (rocky) {
        // Rock wall, rockified, with darker strata toward the floor.
        const u: V3 = run.axis === 'x' ? [len, 0, 0] : [0, 0, len];
        const o = pt(run, run.a, 0);
        const flip = run.axis === 'x' ? run.n === -1 : run.n === 1;
        face(
          b,
          o,
          u,
          [0, H, 0],
          Math.max(1, Math.round(len / 1.2)),
          4,
          (p) => rockify(p, amp * 0.55, amp * 0.5, amp * 0.55, m.seed + 20),
          (p) => tmp.copy(c1).lerp(c2, Math.min(1, Math.max(0, valueNoise3(p[0] * 0.5, p[1] * 0.9, p[2] * 0.5, m.seed + 12) * 1.3 - 0.2))).multiplyScalar((0.5 + valueNoise3(p[0] * 1.7, p[1] * 2.3, p[2] * 1.7, m.seed + 31) * 0.9) * (0.7 + Math.min(1, p[1] / H) * 0.3)),
          SURF(0, 0.92, 0, 0.8),
          flip,
        );
        this.crags(b, run, L, r);
      } else {
        this.panelWall(b, decor, run, L, r);
      }
    }
    void c2;
  }

  /** Rock chunks heaped along a wall: they break its straight line and give caves and mines a ragged outline. */
  private crags(b: MeshBuilder, run: Run, L: DelveLook, r: () => number) {
    const m = this.map;
    const H = m.ceil;
    const cave = m.theme === 'cave';
    const c1 = new THREE.Color(L.wall);
    const c2 = new THREE.Color(L.wall2);
    const tmp = new THREE.Color();
    const step = cave ? 3.2 : 5;
    for (let t = run.a + 0.8; t < run.b; t += step) {
      const n = cave ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const y = k === 0 ? 0.3 + r() * 0.6 : 1.6 + r() * Math.max(0.5, H - 3);
        const size = (cave ? 1.3 : 0.9) + r() * (cave ? 1.5 : 0.8);
        const off = -0.05 - r() * 0.3;
        const tt = t + (r() - 0.5) * 1.6;
        const px = run.axis === 'x' ? tt : run.c + run.n * off;
        const pz = run.axis === 'x' ? run.c + run.n * off : tt;
        const from = b.vertexCount;
        b.add('ico1', px, y, pz, size * (0.8 + r() * 0.5), size * (0.55 + r() * 0.45), size * (0.8 + r() * 0.5), S.rock(tmp.copy(c1).lerp(c2, r() * 0.8).multiplyScalar(0.9).getHex()), (r() - 0.5) * 0.6, r() * 6.28, (r() - 0.5) * 0.6);
        b.displace(size * 0.2, 0.9, Math.floor(px * 3 + pz * 5 + y), from);
        b.flatNormals(from);
      }
    }
  }

  /** A flat wall for the bunker and the metro: dado and upper wall, seams, a cornice, pipes, now and then a vent or a sign. */
  private panelWall(b: MeshBuilder, decor: MeshBuilder, run: Run, L: DelveLook, r: () => number) {
    const m = this.map;
    const H = m.ceil;
    const len = run.b - run.a;
    const metro = m.theme === 'metro';
    const along = (t: number, y: number, off = 0): V3 => (run.axis === 'x' ? [t, y, run.c + run.n * off] : [run.c + run.n * off, y, t]);
    const sx = run.axis === 'x' ? len : 0.001;
    const sz = run.axis === 'x' ? 0.001 : len;
    void sx;
    void sz;
    const mid = (run.a + run.b) / 2;
    const dado = metro ? 2.5 : 1.15;
    const upper = new THREE.Color(L.wall);
    const lower = new THREE.Color(L.wall2);
    // Wall faces are quads wound so their normal points to the open side.
    const quad = (y0: number, y1: number, c: THREE.Color, off: number, surf: Surf) => {
      const a = along(run.a, y0, off);
      const bb = along(run.b, y0, off);
      const cc = along(run.b, y1, off);
      const d = along(run.a, y1, off);
      const flip = run.axis === 'x' ? run.n === -1 : run.n === 1;
      const s = { ...surf, c: c.clone() };
      if (flip) b.quad(a, d, cc, bb, s);
      else b.quad(a, bb, cc, d, s);
    };
    quad(0, dado, lower, 0, SURF(0, metro ? 0.35 : 0.8, 0, 0.5));
    quad(dado, H, upper, 0, SURF(0, 0.92, 0, 0.7));
    // Vertical seams every two metres, a baseboard, a band and a cornice.
    const dark = S.concrete(0x2a2c2a, 0.8);
    for (let t = run.a + 2; t < run.b - 0.1; t += 2) {
      const p = along(t, H / 2, run.n * 0.015);
      decor.box(p[0], p[1], p[2], run.axis === 'x' ? 0.04 : 0.03, H, run.axis === 'x' ? 0.03 : 0.04, dark);
    }
    const strip = (y: number, h: number, depth: number, s: Surf) => {
      const p = along(mid, y, run.n * depth / 2);
      decor.box(p[0], p[1], p[2], run.axis === 'x' ? len : depth, h, run.axis === 'x' ? depth : len, s);
    };
    strip(0.07, 0.14, 0.06, S.concrete(0x2e302e, 0.8));
    strip(dado, 0.08, 0.05, SURF(metro ? 0xd8d4c4 : 0x3a3f3a, 0.6));
    strip(H - 0.12, 0.24, 0.12, S.concrete(0x4e504e, 0.8));
    if (metro) {
      // A coloured line tile band and the odd poster panel.
      strip(1.55, 0.2, 0.02, SURF(0x2f6a58, 0.4));
      for (let t = run.a + 3; t < run.b - 2; t += 8 + Math.floor(r() * 6)) {
        const p = along(t, 1.7, run.n * 0.03);
        const colors = [0xb23a2a, 0x2a5ab2, 0xc8a02a, 0x6a2a8a, 0x2aa08a];
        decor.box(p[0], p[1], p[2], run.axis === 'x' ? 1.3 : 0.03, 1.9, run.axis === 'x' ? 0.03 : 1.3, SURF(colors[Math.floor(r() * colors.length)], 0.5, 0, 0.5));
      }
    } else if (len > 4) {
      // Pipes and cable trays near the ceiling.
      const y = H - 0.55 - (r() < 0.5 ? 0 : 0.28);
      const a = along(run.a + 0.2, y, run.n * 0.18);
      const c = along(run.b - 0.2, y, run.n * 0.18);
      decor.rod(a[0], a[1], a[2], c[0], c[1], c[2], 0.06, S.metal(r() < 0.5 ? 0x7a7d78 : 0x8a6a4a, 0.7), 8);
      if (r() < 0.55) {
        const y2 = H - 0.95;
        const a2 = along(run.a + 0.2, y2, run.n * 0.12);
        const c2 = along(run.b - 0.2, y2, run.n * 0.12);
        decor.rod(a2[0], a2[1], a2[2], c2[0], c2[1], c2[2], 0.03, S.rubber(0x1c1c1c), 5);
      }
      // A wall vent or a stencilled number.
      if (r() < 0.4 && len > 5) {
        const t = run.a + 1 + r() * (len - 2);
        const p = along(t, 1.9 + r() * 0.5, run.n * 0.03);
        decor.box(p[0], p[1], p[2], run.axis === 'x' ? 0.7 : 0.05, 0.5, run.axis === 'x' ? 0.05 : 0.7, S.metal(0x585c58, 0.8));
      }
    }
  }

  // ------------------------------------------------------------------------------------------- decor

  private props(b: MeshBuilder, L: DelveLook) {
    const m = this.map;
    for (const p of m.props) {
      const y = 0;
      switch (p.kind as DelveDecor) {
        case 'stalagmite': {
          const r = rng(p.seed + 3);
          const n = 1 + Math.floor(r() * 3);
          for (let i = 0; i < n; i++) {
            const h = (0.8 + r() * 1.7) * p.scale * (i === 0 ? 1.3 : 0.7);
            const w = (0.5 + r() * 0.5) * p.scale;
            b.add('cone6', p.x + (r() - 0.5) * 0.9, y + h / 2, p.z + (r() - 0.5) * 0.9, w, h, w, S.rock(i % 2 ? 0x5a4a3c : 0x6a5848), 0, r() * 6, 0);
          }
          break;
        }
        case 'fungus': {
          const r = rng(p.seed + 7);
          for (let i = 0; i < 5; i++) {
            const h = 0.12 + r() * 0.3;
            const px = p.x + (r() - 0.5) * 0.8;
            const pz = p.z + (r() - 0.5) * 0.8;
            b.rod(px, y, pz, px, y + h, pz, 0.025, S.cloth(0x4a4a3a, 0.8), 5);
            b.add('dome', px, y + h, pz, 0.18 + r() * 0.12, 0.1, 0.18 + r() * 0.12, S.glow(i % 2 ? 0x5affc0 : 0x7a9aff, 2.2));
          }
          break;
        }
        case 'timber': {
          const w = S.wood(0x6a4c30, 0.85);
          for (const s of [-1, 1]) b.box(p.x + s * 1.9, 1.5, p.z, 0.28, 3.0, 0.28, w);
          b.box(p.x, 3.05, p.z, 4.4, 0.3, 0.32, S.wood(0x5a4026, 0.85));
          b.rod(p.x - 1.9, 2.2, p.z, p.x - 1.0, 3.0, p.z, 0.06, w, 5);
          b.rod(p.x + 1.9, 2.2, p.z, p.x + 1.0, 3.0, p.z, 0.06, w, 5);
          break;
        }
        case 'rails': {
          for (const s of [-0.5, 0.5]) b.rod(p.x + s, 0.1, p.z - 3.5, p.x + s, 0.1, p.z + 3.5, 0.03, S.steel(0x5a5650, 0.7), 5);
          for (let t = -3.4; t <= 3.4; t += 0.7) b.box(p.x, 0.06, p.z + t, 1.5, 0.07, 0.15, S.wood(0x4a3828, 0.95));
          break;
        }
        case 'pillar':
          b.cyl(p.x, 2.2, p.z, 0.9, m.ceil, 0.9, S.concrete(0x8e8c82, 0.6), 0, 0, 0, 14);
          b.cyl(p.x, 0.15, p.z, 1.15, 0.3, 1.15, S.concrete(0x6e6c64, 0.7), 0, 0, 0, 14);
          b.cyl(p.x, m.ceil - 0.2, p.z, 1.15, 0.4, 1.15, S.concrete(0x6e6c64, 0.7), 0, 0, 0, 14);
          break;
        case 'carriage':
          this.carriage(b, p.x, p.z);
          break;
        case 'bunk': {
          const r = rng(p.seed);
          b.box(p.x, 0.5, p.z, 2.0, 0.08, 0.9, S.steel(0x4a4e4a, 0.7));
          b.box(p.x, 1.4, p.z, 2.0, 0.08, 0.9, S.steel(0x4a4e4a, 0.7));
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.rod(p.x + sx * 0.98, 0, p.z + sz * 0.42, p.x + sx * 0.98, 1.9, p.z + sz * 0.42, 0.03, S.steel(0x3a3e3a, 0.7), 4);
          b.box(p.x - 0.2, 0.58, p.z, 1.6, 0.1, 0.8, S.cloth(r() < 0.5 ? 0x6a6a52 : 0x52625a, 0.9));
          b.box(p.x + 0.1, 1.48, p.z, 1.6, 0.1, 0.8, S.cloth(0x5a4a3a, 0.9));
          break;
        }
        case 'cot':
          b.box(p.x, 0.35, p.z, 1.9, 0.06, 0.8, S.cloth(0x6a6a52, 0.9));
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.rod(p.x + sx * 0.9, 0, p.z + sz * 0.36, p.x + sx * 0.9, 0.34, p.z + sz * 0.36, 0.02, S.steel(0x3a3e3a, 0.7), 4);
          break;
        case 'table':
          b.box(p.x, 0.85, p.z, 1.7, 0.07, 0.9, S.wood(0x6a5238, 0.85));
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.rod(p.x + sx * 0.75, 0, p.z + sz * 0.38, p.x + sx * 0.75, 0.85, p.z + sz * 0.38, 0.03, S.steel(0x3a3e3a, 0.7), 4);
          crate(b, p.x + 0.3, 1.05, p.z, 0.3, 0.3, 0.3, p.seed);
          break;
        case 'generator': {
          b.rbox(p.x, 0.55, p.z, 1.5, 1.1, 0.9, 0.06, S.paint(0x4a5a3a, 0.7));
          b.cyl(p.x + 0.5, 1.2, p.z, 0.2, 0.3, 0.2, S.steel(0x2a2c2e, 0.7), 0, 0, 0, 8);
          b.box(p.x - 0.4, 1.0, p.z + 0.46, 0.5, 0.3, 0.03, S.glow(0x6aff8a, 1.5));
          break;
        }
        case 'altar':
          b.rbox(p.x, 0.5, p.z, 2.2, 1.0, 1.2, 0.1, S.rock(0x4a3c30));
          break;
        default:
          // The ordinary props: crates, barrels, shelves, lockers, bones and rubble.
          appendProp(b, { kind: p.kind as PropKind, x: p.x, y, z: p.z, yaw: p.yaw, scale: p.scale, seed: p.seed });
      }
    }
    void L;
  }

  /** A stalled train carriage: a long steel box with windows, doors and a smashed end. */
  private carriage(b: MeshBuilder, x: number, z: number) {
    const body = S.paint(0x4a6a78, 0.8);
    const dark = S.steel(0x2a2e30, 0.7);
    b.box(x, 1.7, z, 12, 2.6, 2.8, body);
    b.box(x, 3.1, z, 12.1, 0.2, 2.9, S.metal(0x5a6064, 0.7));
    b.box(x, 0.5, z, 12, 0.4, 2.6, dark);
    for (let i = 0; i < 6; i++) {
      const wx = x - 5 + i * 2;
      for (const s of [-1, 1]) b.box(wx, 2.1, z + s * 1.41, 1.2, 0.9, 0.04, S.glass(0x0b1216));
    }
    for (const dx of [-2, 2]) for (const s of [-1, 1]) b.box(x + dx, 1.4, z + s * 1.42, 1.1, 1.9, 0.05, S.steel(0x3a4448, 0.7));
    // Wheels and bogies.
    for (const dx of [-4, 4]) for (const s of [-1, 1]) b.cyl(x + dx, 0.35, z + s * 0.9, 0.7, 0.2, 0.7, S.steel(0x1a1c1e, 0.6), Math.PI / 2, Math.PI / 2, 0, 12);
    // Rust streaks and a smashed end.
    b.box(x - 6.02, 1.7, z, 0.06, 2.4, 2.4, S.rust(0x5a3a22));
  }

  // ------------------------------------------------------------------------------------------- lamps

  private lamps(b: MeshBuilder) {
    const m = this.map;
    for (const l of m.lights) {
      const lit = !l.dead;
      switch (m.theme) {
        case 'cave': {
          if (l.y > 1.1) {
            // A brazier: an iron bowl on three legs, with a flame.
            for (let i = 0; i < 3; i++) {
              const a = (i / 3) * Math.PI * 2;
              b.rod(l.x + Math.cos(a) * 0.4, 0, l.z + Math.sin(a) * 0.4, l.x + Math.cos(a) * 0.15, 0.7, l.z + Math.sin(a) * 0.15, 0.03, S.steel(0x2a2a2a, 0.7), 4);
            }
            b.cyl(l.x, 0.78, l.z, 0.7, 0.2, 0.7, S.steel(0x2a2a2a, 0.7), 0, 0, 0, 10);
            // A bed of coals in the bowl; the flames over it are the fire engine's (`game/fires.ts`).
            if (lit) b.cyl(l.x, 0.885, l.z, 0.58, 0.03, 0.58, S.glow(0xff5a14, 2.6), 0, 0, 0, 10);
          } else {
            // Glowing crystals growing out of the floor.
            const rr = rng(Math.floor(l.x * 7 + l.z * 13));
            for (let i = 0; i < 6; i++) {
              const a = rr() * Math.PI * 2;
              const d = 0.1 + rr() * 0.55;
              const h = 0.35 + rr() * 0.75;
              b.add('cone6', l.x + Math.cos(a) * d, h / 2, l.z + Math.sin(a) * d, 0.16 + rr() * 0.12, h, 0.16 + rr() * 0.12, S.glow(l.color, 3.2), (rr() - 0.5) * 0.4, 0, (rr() - 0.5) * 0.4);
            }
          }
          break;
        }
        case 'mine': {
          b.rod(l.x, l.y, l.z, l.x, m.ceil, l.z, 0.015, S.steel(0x2a2a2a, 0.7), 4);
          b.add('sphere', l.x, l.y - 0.12, l.z, 0.2, 0.2, 0.2, lit ? S.glow(l.color, 5) : S.glass(0x1c1c18));
          b.torus(l.x, l.y - 0.1, l.z, 0.14, 0.012, S.steel(0x2a2a2a, 0.7), Math.PI / 2, 0, 0, 4, 10);
          break;
        }
        default: {
          b.box(l.x, l.y + 0.05, l.z, 1.3, 0.07, 0.22, S.steel(0x3a3c3c, 0.7));
          b.box(l.x, l.y - 0.01, l.z, 1.2, 0.04, 0.16, lit ? S.glow(l.color, 5) : S.glass(0x1a1c1c));
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------- way out

  /** Where the stairs up are: a shaft of daylight from a hole in the ceiling, and a ladder to it. */
  private exitLight(L: DelveLook) {
    const m = this.map;
    const { x, z } = m.exit;
    const col = new THREE.Color(L.daylight);
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 1.15, m.ceil, 28, 1, true),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending, fog: false }),
    );
    shaft.position.set(x, m.ceil / 2, z);
    this.extra.push(shaft.material as THREE.Material);
    this.geos.push(shaft.geometry);
    this.group.add(shaft);
    const patch = new THREE.Mesh(
      new THREE.CircleGeometry(1.2, 20),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
    );
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(x, 0.03, z);
    this.extra.push(patch.material as THREE.Material);
    this.geos.push(patch.geometry);
    this.group.add(patch);
    const hole = new THREE.Mesh(new THREE.CircleGeometry(1.0, 20), new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(2.5), fog: false }));
    hole.rotation.x = Math.PI / 2;
    hole.position.set(x, m.ceil - 0.02, z);
    this.extra.push(hole.material as THREE.Material);
    this.geos.push(hole.geometry);
    this.group.add(hole);
    // Ladder beside the shaft.
    const lb = new MeshBuilder();
    for (const s of [-0.28, 0.28]) lb.rod(x + 1.3 + s, 0, z + 0.2, x + 1.3 + s, m.ceil, z + 0.2, 0.035, S.steel(0x5a5c5a, 0.7), 5);
    for (let y = 0.3; y < m.ceil; y += 0.34) lb.rod(x + 1.02, y, z + 0.2, x + 1.58, y, z + 0.2, 0.02, S.steel(0x5a5c5a, 0.7), 4);
    this.add(lb.build(), kitMaterial(), false, false);
  }

  /** The service lift: a steel cage on a pad, with a green lamp. Hidden until the boss falls. */
  private buildLift() {
    const m = this.map;
    const b = new MeshBuilder();
    const { x, z } = m.lift;
    const steel = S.steel(0x4a5054, 0.7);
    b.box(x, 0.1, z, 2.6, 0.2, 2.6, S.metal(0x3a3e40, 0.7));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.rod(x + sx * 1.2, 0.2, z + sz * 1.2, x + sx * 1.2, 2.6, z + sz * 1.2, 0.05, steel, 5);
    for (const y of [0.9, 1.7, 2.6]) {
      b.box(x, y, z - 1.2, 2.4, 0.05, 0.05, steel);
      b.box(x, y, z + 1.2, 2.4, 0.05, 0.05, steel);
      b.box(x - 1.2, y, z, 0.05, 0.05, 2.4, steel);
      b.box(x + 1.2, y, z, 0.05, 0.05, 2.4, steel);
    }
    b.box(x, 2.7, z, 2.7, 0.12, 2.7, S.metal(0x3a3e40, 0.7));
    b.box(x + 1.25, 1.2, z + 1.25, 0.18, 0.3, 0.06, S.glow(0x6aff8a, 4));
    const mesh = new THREE.Mesh(b.build(), kitMaterial());
    mesh.castShadow = true;
    this.geos.push(mesh.geometry);
    this.lift.add(mesh);
  }

  // ------------------------------------------------------------------------------------------- doors

  private buildDoor(d: DelveDoor) {
    const m = this.map;
    const g = new THREE.Group();
    const b = new MeshBuilder();
    const alongX = d.w > d.d;
    const len = Math.max(d.w, d.d);
    const H = m.ceil;
    const rot = alongX ? 0 : Math.PI / 2;
    // Built along local x, then turned.
    const frame = S.steel(0x3a3e3e, 0.7);
    if (m.theme === 'mine') {
      // A barred gate of timber and iron.
      const wood = S.wood(0x5a4026, 0.9);
      for (let x = -len / 2 + 0.25; x < len / 2; x += 0.5) b.rod(x, 0, 0, x, H - 0.4, 0, 0.05, S.steel(0x4a4a46, 0.7), 5);
      for (const y of [0.4, 1.4, 2.4]) b.box(0, y, 0, len, 0.12, 0.14, wood);
      b.box(0, H - 0.2, 0, len, 0.3, 0.3, wood);
    } else if (m.theme === 'metro') {
      // A roller shutter, ribbed.
      for (let y = 0.1; y < H; y += 0.14) b.box(0, y, 0, len, 0.08, 0.1, S.metal(0x7a7e7a, 0.6));
      b.box(0, H - 0.1, 0, len + 0.2, 0.25, 0.3, frame);
    } else {
      // A blast door with hazard bands and a keypad.
      b.box(0, H / 2 - 0.1, 0, len, H - 0.2, 0.3, S.steel(0x55605a, 0.75));
      for (let i = 0; i < 8; i++) b.box(-len / 2 + (i + 0.5) * (len / 8), 0.4, 0.17, len / 9, 0.3, 0.02, S.paint(i % 2 ? 0x1a1a1a : 0xd0b020, 0.7), 0, 0, 0.6);
      b.box(len / 2 + 0.25, 1.2, 0, 0.3, 0.5, 0.2, S.metal(0x2a2c2c, 0.7));
      b.box(len / 2 + 0.25, 1.3, 0.11, 0.18, 0.1, 0.02, S.glow(0xff3a2a, 3));
    }
    b.box(-len / 2 - 0.1, H / 2, 0, 0.22, H, 0.4, frame);
    b.box(len / 2 + 0.1, H / 2, 0, 0.22, H, 0.4, frame);
    b.box(0, H - 0.05, 0, len + 0.4, 0.2, 0.4, frame);
    const mesh = new THREE.Mesh(b.build(), kitMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.geos.push(mesh.geometry);
    g.add(mesh);
    g.position.set(d.x, 0, d.z);
    g.rotation.y = rot;
    this.group.add(g);
    this.doors.set(d.id, g);
  }

  openDoor(id: string) {
    const g = this.doors.get(id);
    if (g) g.visible = false;
  }

  dispose() {
    disposeTree(this.group);
    for (const g of this.geos) g.dispose();
    for (const m of this.extra) m.dispose();
    this.group.removeFromParent();
  }
}

// ------------------------------------------------------------------------------------------- loot models

/** A strongbox: planked body, iron bands, a brass lock. `open` tips the lid back; `rich` is the boss's hoard. */
export function chestGeometry(open: boolean, rich: boolean, theme: DelveTheme): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.05;
  const k = rich ? 1.35 : 1;
  const wood = theme === 'bunker' || theme === 'metro' ? S.paint(theme === 'bunker' ? 0x4a5a3a : 0x5a6a72, 0.7) : S.wood(0x6a4a2c, 0.8);
  const iron = S.steel(0x3a3c3c, 0.7);
  b.rbox(0, 0.28 * k, 0, 0.95 * k, 0.5 * k, 0.6 * k, 0.03, wood);
  for (const x of [-0.32, 0.32]) b.box(x * k, 0.28 * k, 0, 0.07 * k, 0.52 * k, 0.64 * k, iron);
  if (open) {
    // Lid thrown back on its hinge.
    b.rbox(0, 0.62 * k, -0.36 * k, 0.95 * k, 0.07 * k, 0.5 * k, 0.02, wood, -1.15, 0, 0);
    for (const x of [-0.32, 0.32]) b.box(x * k, 0.62 * k, -0.37 * k, 0.07 * k, 0.08 * k, 0.5 * k, iron, -1.15, 0, 0);
    // The spill of coins and gear inside.
    b.box(0, 0.52 * k, 0, 0.8 * k, 0.04, 0.46 * k, S.glow(rich ? 0xffc14a : 0x9a7a3a, rich ? 1.2 : 0.2));
  } else {
    b.rbox(0, 0.58 * k, 0, 0.98 * k, 0.16 * k, 0.64 * k, 0.05, wood);
    for (const x of [-0.32, 0.32]) b.box(x * k, 0.58 * k, 0, 0.07 * k, 0.18 * k, 0.66 * k, iron);
    b.box(0, 0.52 * k, 0.33 * k, 0.12 * k, 0.14 * k, 0.03, S.metal(0xc8a030, 0.4));
  }
  b.groundShade(0, 0.2, 0.3);
  return b.build();
}

/** A key (or keycard): glowing so it can be found in the dark. */
export function keyGeometry(theme: DelveTheme): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const glow = S.glow(theme === 'bunker' || theme === 'metro' ? 0x7dffb0 : 0xffd24a, 3);
  if (theme === 'bunker') {
    b.rbox(0, 0, 0, 0.34, 0.2, 0.025, 0.01, S.plastic(0xe8e8e0, 0.3));
    b.box(0, 0.03, 0.015, 0.28, 0.05, 0.01, glow);
    b.box(-0.09, -0.04, 0.015, 0.08, 0.06, 0.01, S.metal(0xc8a030, 0.4));
  } else {
    b.torus(0, 0.12, 0, 0.07, 0.022, glow, 0, Math.PI / 2, 0, 5, 12);
    b.rod(0, 0.05, 0, 0, -0.18, 0, 0.018, S.metal(0xc8a030, 0.4), 6);
    b.box(0.04, -0.15, 0, 0.08, 0.03, 0.02, S.metal(0xc8a030, 0.4));
    b.box(0.03, -0.1, 0, 0.06, 0.03, 0.02, S.metal(0xc8a030, 0.4));
  }
  return b.build();
}
