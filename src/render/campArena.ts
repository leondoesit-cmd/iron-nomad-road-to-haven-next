import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import { kitMaterial } from './materials';
import { makeTerrainMaterial } from './terrainMaterial';
import { FacadeBuilder, facadeMaterial } from './facade';
import { boulderGeo, scatterFromSpots, type Spot } from './scatter';
import { crate, drum, jerryCan, plate, spareTyre } from './parts';
import { hash2, noise2 } from '../core/rng';
import { smoothstep } from '../core/math';
import { buildTreesSteps } from './trees';
import { TREE_SPECIES, woodSpecies, type TreeSpecies, type TreeSpot } from '../world/flora';
import type { Woods } from '../world/hydro';

/**
 * The land where the convoy stopped, when it stopped on the green: how lush the ground is, how wooded the country round it,
 * and what grows there (`lushAt`, `forestAt` and `woodsAt` of `world/hydro.ts`). The camp is drawn to match: a meadow for a
 * floor and the wood standing round the basin.
 */
export interface CampLand {
  lush: number;
  wood: number;
  woods: Woods;
}

/** A raised block of visual ground (canyon walls at the canyon-mouth camp), matching a collider box. */
export interface Rise {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

/** Ground stays flat out to here: raids spawn just inside it. */
const FLAT_R = 114;

/**
 * Visuals for the camp arena: a textured ground that rises into a canyon basin (or a city skyline ring),
 * ground cover, and detailed models for each camp site. Colliders stay in CampScene.
 */
export class CampArena {
  group = new THREE.Group();
  fb = new FacadeBuilder();
  det = new MeshBuilder();
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private instanced: THREE.InstancedMesh[] = [];
  private rises: Rise[] = [];

  constructor(
    public biome: 'wasteland' | 'city',
    private seed: number,
    private land?: CampLand,
  ) {
    this.det.jitter = 0.05;
    if (biome === 'city') this.land = undefined;
  }

  /** Visual ground height: zero on the play area, rising walls beyond it and on any rises. */
  heightAt(x: number, z: number): number {
    const r = Math.hypot(x, z);
    let h = 0;
    if (this.biome === 'wasteland') {
      const ridge = 1 - Math.abs(noise2(x / 60, z / 60, this.seed + 3) * 2 - 1);
      const ridge2 = 1 - Math.abs(noise2(x / 23, z / 23, this.seed + 4) * 2 - 1);
      h = smoothstep(FLAT_R, FLAT_R + 30, r) * (14 + ridge2 * 6) + smoothstep(FLAT_R + 20, 330, r) * (55 + ridge * ridge * 90);
    } else {
      h = smoothstep(FLAT_R + 60, 340, r) * 25;
    }
    for (const q of this.rises) {
      const dx = Math.max(0, Math.abs(x - q.x) - q.w / 2);
      const dz = Math.max(0, Math.abs(z - q.z) - q.d / 2);
      const e = Math.hypot(dx, dz);
      const k = 1 - smoothstep(0, 3.5, e);
      if (k > 0) {
        const n = noise2(x / 6, z / 6, this.seed + 9) * 2.5 + noise2(x / 17, z / 17, this.seed + 10) * 3;
        h = Math.max(h, k * (q.h + n));
      }
    }
    return h;
  }

  addRise(q: Rise) {
    this.rises.push(q);
  }

  /** Build the ground (call after any rises are added). */
  buildGround() {
    const city = this.biome === 'city';
    const R = 420;
    const cell = (a: number) => (a < 70 ? 3 : a < 140 ? 6 : 14);
    const ticks: number[] = [];
    for (let v = -R; v <= R; ) {
      ticks.push(v);
      v += cell(Math.abs(v));
    }
    const n = ticks.length;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const spl = new Float32Array(n * n * 4);
    const tda = new Float32Array(n * n * 4);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = ticks[c];
        const z = ticks[r];
        const i = r * n + c;
        const h = this.heightAt(x, z);
        pos[i * 3] = x;
        pos[i * 3 + 1] = h;
        pos[i * 3 + 2] = z;
        const k = 0.93 + hash2(c, r, this.seed) * 0.14;
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
        const slope = h > 0.5 ? 1 : 0;
        const sand = smoothstep(0.5, 0.78, noise2(x / 30, z / 30, this.seed + 5)) * (1 - slope);
        const gravel = smoothstep(0.6, 0.8, noise2(x / 14, z / 14, this.seed + 6)) * (1 - slope);
        spl[i * 4] = city ? sand * 0.5 : sand;
        spl[i * 4 + 1] = (1 - sand) * (1 - slope) * (city ? 1 : 0.8);
        spl[i * 4 + 2] = slope;
        spl[i * 4 + 3] = gravel + (city ? 0.2 : 0.1) * (1 - slope);
        tda[i * 4] = 1;
        const land = this.land;
        if (land) {
          // A meadow for the floor, frayed by noise, and the wood's litter under the trees round the basin.
          const rr = Math.hypot(x, z);
          tda[i * 4 + 2] = land.lush * (0.78 + 0.32 * noise2(x / 40, z / 40, this.seed + 21));
          tda[i * 4 + 3] = land.wood * smoothstep(FLAT_R - 10, FLAT_R + 30, rr);
        }
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = r * n + c;
        idx.push(a, a + n, a + n + 1, a, a + n + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
    g.setAttribute('tdata', new THREE.BufferAttribute(tda, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    // Slopes come from the actual normals: re-weight rock where the ground tilts.
    const nor = g.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < n * n; i++) {
      const steep = smoothstep(0.82, 0.62, nor.getY(i));
      const keep = 1 - steep;
      spl[i * 4] *= keep;
      spl[i * 4 + 1] = spl[i * 4 + 1] * keep + (pos[i * 3 + 1] > 0.3 && steep < 0.5 ? 0.3 : 0);
      spl[i * 4 + 2] = Math.max(spl[i * 4 + 2] * 0.3, steep);
      spl[i * 4 + 3] *= keep;
    }
    const mat = makeTerrainMaterial(this.biome);
    this.mats.push(mat);
    this.geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    this.group.add(m);
    if (city) this.cityRing();
  }

  /** Ruined towers around a city camp, lit at night like the leg skyline. */
  private cityRing() {
    const tints = [0xa8a8a2, 0x9a5a44, 0xc8b8a0, 0x5a6670, 0xb8b6ae];
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2 + hash2(i, 1, this.seed) * 0.1;
      const k = hash2(i, 2, this.seed);
      const r = 128 + k * 90;
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const w = 16 + k * 18;
      const d = 14 + hash2(i, 3, this.seed) * 14;
      const hgt = 18 + k * k * 70;
      const x0 = cx - w / 2;
      const x1 = cx + w / 2;
      const z0 = cz - d / 2;
      const z1 = cz + d / 2;
      const corners: [number, number][] = [[x0, z1], [x1, z1], [x1, z0], [x0, z0], [x0, z1]];
      const style = k > 0.8 ? 3 : i % 3;
      for (let f = 0; f < 4; f++) {
        const [ax, az] = corners[f];
        const [bx, bz] = corners[f + 1];
        const len = Math.hypot(bx - ax, bz - az);
        this.fb.wall(ax, az, bx, bz, this.heightAt(cx, cz) - 1, hgt, 0, new THREE.Color(tints[i % tints.length]), style, k * 91 + f, 3.3, len / Math.max(1, Math.round(len / 3)));
      }
      this.det.box(cx, hgt + 0.3, cz, w, 0.6, d, S.concrete(C.concreteDark, 0.8));
    }
  }

  // ---------------------------------------------------------------------------------- site pieces

  /** A low defensive barrier: scrap fence in the wasteland, jersey barriers and sandbags in the city. */
  barrier(x: number, z: number, w: number, d: number, h: number) {
    const b = this.det;
    const along = w >= d;
    const len = along ? w : d;
    const n = Math.max(1, Math.round(len / (this.biome === 'city' ? 3 : 2)));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n - 0.5;
      const px = along ? x + t * w : x;
      const pz = along ? z : z + t * d;
      const k = hash2(Math.round(px * 3), Math.round(pz * 3), this.seed);
      if (this.biome === 'city') {
        b.extrude('campJersey', () => {
          const s = new THREE.Shape();
          s.moveTo(-0.55, 0);
          s.lineTo(0.55, 0);
          s.lineTo(0.38, 0.25);
          s.lineTo(0.17, h);
          s.lineTo(-0.17, h);
          s.lineTo(-0.38, 0.25);
          s.closePath();
          return s;
        }, len / n - 0.05, 0.02, px, 0, pz, S.concrete(0xa6a299, 0.75), 0, along ? Math.PI / 2 : 0, 0);
        if (k > 0.5) for (let s = 0; s < 3; s++) b.rbox(px + (along ? (s - 1) * 0.55 : 0.55), 0.15 + (s % 2) * 0.28, pz + (along ? 0.55 : (s - 1) * 0.55), 0.55, 0.28, 0.32, 0.1, S.cloth(0x8a7a5a, 0.7), 0, along ? 0 : Math.PI / 2, 0);
      } else {
        // Corrugated sheet nailed to posts.
        const sw = len / n;
        const tilt = (k - 0.5) * 0.12;
        for (let c = 0; c < 6; c++) {
          const o = (c / 5 - 0.5) * (sw - 0.1);
          b.cyl(px + (along ? o : 0), h / 2, pz + (along ? 0 : o), 0.09, h, 0.09, S.metal(k > 0.5 ? 0x7a6a5a : 0x5a6064, 0.95), tilt, along ? 0 : Math.PI / 2, 0, 6);
        }
        b.box(px, h / 2, pz, along ? sw : 0.06, h * 0.96, along ? 0.06 : sw, S.rust(k > 0.5 ? C.rust : C.rust2), tilt * 0.5, 0, 0);
        b.rod(px + (along ? -sw / 2 : 0.1), 0, pz + (along ? 0.1 : -sw / 2), px + (along ? -sw / 2 : 0.1), h + 0.15, pz + (along ? 0.1 : -sw / 2), 0.05, S.wood(0x5a4632), 6);
      }
    }
  }

  /** Abandoned gas station: a shop with a forecourt canopy and two pumps. */
  gasStation() {
    const b = this.det;
    // Shop (14 x 8, 4.4 tall at (-20, 14)): facade walls with a shopfront band, roof and sign.
    const x0 = -27;
    const x1 = -13;
    const z0 = 10;
    const z1 = 18;
    const corners: [number, number][] = [[x0, z1], [x1, z1], [x1, z0], [x0, z0], [x0, z1]];
    for (let f = 0; f < 4; f++) {
      const [ax, az] = corners[f];
      const [bx, bz] = corners[f + 1];
      const len = Math.hypot(bx - ax, bz - az);
      this.fb.wall(ax, az, bx, bz, 0, 4.4, 0, new THREE.Color(0xd8cdb4), 2, 3.3 + f, 3.4, len / Math.max(1, Math.round(len / 3.2)));
    }
    b.box(-20, 4.5, 14, 14.6, 0.25, 8.6, S.concrete(C.concreteDark, 0.8));
    b.box(-20, 4.9, 9.7, 14.6, 0.7, 0.18, S.paint(0xc83a28, 0.7));
    b.box(-20, 4.9, 9.6, 5, 0.4, 0.04, S.paint(0xf0e8d8, 0.6));
    // Canopy over the forecourt on four columns, with a red fascia and dead strip lights.
    for (const [px, pz] of [[-6, 6], [6, 6], [-6, -4], [6, -4]]) {
      b.rbox(px, 2.2, pz, 0.5, 4.4, 0.5, 0.06, S.paint(0xd8d4cc, 0.7));
      b.box(px, 0.4, pz, 0.65, 0.8, 0.65, S.paint(0xc83a28, 0.75));
    }
    b.rbox(0, 4.6, 1, 18, 0.5, 14, 0.05, S.paint(0xe2ded6, 0.8));
    b.box(0, 4.6, 8.02, 18.1, 0.55, 0.06, S.paint(0xc83a28, 0.75));
    b.box(0, 4.6, -6.02, 18.1, 0.55, 0.06, S.paint(0xc83a28, 0.75));
    for (const sx of [-9.02, 9.02]) b.box(sx, 4.6, 1, 0.06, 0.55, 14.1, S.paint(0xc83a28, 0.75));
    for (let i = 0; i < 3; i++) b.box(-4 + i * 4, 4.33, 1, 0.3, 0.06, 10, S.glow(0xfff0d0, 0.6));
    // Pumps on islands.
    for (const px of [-4, 4]) {
      b.rbox(px, 0.1, 1, 1.6, 0.2, 3.2, 0.05, S.concrete(0xa8a49a, 0.7));
      b.rbox(px, 0.85, 1, 0.9, 1.3, 0.6, 0.06, S.paint(0xc83a28, 0.7));
      b.rbox(px, 1.6, 1, 0.8, 0.25, 0.55, 0.05, S.paint(0xf0ece4, 0.6));
      for (const sz of [0.31, -0.31]) b.box(px, 1.1, 1 + sz, 0.35, 0.22, 0.02, S.glass(0x1a2228));
      b.pipe([[px + 0.42, 1.0, 1.2], [px + 0.7, 0.6, 1.4], [px + 0.62, 0.15, 1.6], [px + 0.5, 0.3, 1.9]], 0.022, S.rubber(), 6);
    }
    // Price sign on a pole.
    b.rod(16, 0, 10, 16, 6.5, 10, 0.12, S.metal(0x6a6e70, 0.7), 10);
    b.rbox(16, 7.2, 10, 3, 1.8, 0.3, 0.05, S.paint(0xf0ece4, 0.8));
    b.box(16, 7.6, 10.16, 2.6, 0.5, 0.02, S.paint(0xc83a28, 0.6));
    for (let i = 0; i < 3; i++) b.box(15.2 + i * 0.8, 6.9, 10.16, 0.5, 0.4, 0.02, S.paint(0x1a1a1a, 0.5));
    drum(b, -11, 0, 9, C.fuel);
    drum(b, -11.7, 0, 9.4, 0x3a5f8a);
    jerryCan(b, -10.5, 0, 10.2, C.fuel, 0.4);
  }

  /** Multi-storey car park deck: columns, a roof deck with beams and painted bays. */
  carPark() {
    const b = this.det;
    for (let ix = -2; ix <= 2; ix++) {
      for (let iz = -2; iz <= 2; iz++) {
        if (ix === 0 && iz === 0) continue;
        const x = ix * 11;
        const z = iz * 11;
        b.rbox(x, 2.5, z, 2, 5, 2, 0.05, S.concrete(0x9a9890, 0.85));
        b.box(x, 0.6, z, 2.04, 1.2, 2.04, S.paint(C.signYellow, 0.9));
        for (let s = 0; s < 4; s++) b.box(x, 0.3 + s * 0.3, z, 2.06, 0.12, 2.06, S.paint(0x1a1a1a, 0.9));
      }
    }
    b.box(0, 5.2, 0, 70, 0.6, 70, S.concrete(0x8a8a84, 0.85));
    for (let i = -2; i <= 2; i++) {
      b.box(i * 11, 4.75, 0, 1.2, 0.5, 70, S.concrete(0x7e7e78, 0.85));
      b.box(0, 4.75, i * 11, 70, 0.5, 1.2, S.concrete(0x7e7e78, 0.85));
    }
    // Bay lines on the floor.
    for (let ix = -3; ix <= 3; ix++) for (const z of [-18, 18]) b.box(ix * 5.5, 0.02, z, 0.12, 0.01, 5, S.paint(0xd8d4c8, 0.9));
  }

  /** Plaza: paving, broken benches, planters and lamp posts. */
  plaza() {
    const b = this.det;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3;
      const x = Math.sin(a) * 22;
      const z = Math.cos(a) * 22;
      b.rbox(x, 0.35, z, 2.4, 0.7, 2.4, 0.08, S.concrete(0xb0aca2, 0.75), 0, a, 0);
      b.add('ico1', x, 0.75, z, 1.8, 0.6, 1.8, S.wood(0x4a3c2e, 0.6));
      b.rod(x + 1.6, 0, z, x + 1.6, 4.2, z, 0.06, S.paint(0x2a2c2e, 0.7), 8);
      b.rbox(x + 1.6, 4.3, z, 0.45, 0.25, 0.45, 0.06, S.glass(0x3a3a34));
    }
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.8;
      const x = Math.sin(a) * 14;
      const z = Math.cos(a) * 14;
      b.box(x, 0.45, z, 1.8, 0.06, 0.5, S.wood(0x6a4e32, 0.7), 0, a, k === 2 ? 0.25 : 0);
      b.box(x, 0.7, z, 1.8, 0.4, 0.06, S.wood(0x6a4e32, 0.7), 0, a, 0);
      for (const o of [-0.7, 0.7]) b.box(x + Math.cos(a) * o, 0.22, z - Math.sin(a) * o, 0.06, 0.44, 0.45, S.metal(0x2a2a2a), 0, a, 0);
    }
  }

  /** Rock formations standing in for the collider blocks of the canyon mouth and the flats. */
  boulder(x: number, z: number, scale: number, v: number, yaw = 0) {
    const m = new THREE.Mesh(boulderGeo(v % 3), kitMaterial());
    m.position.set(x, -scale * 0.12, z);
    m.scale.setScalar(scale);
    m.rotation.y = yaw;
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
  }

  /** Stone ring with charred logs and a few glowing embers. */
  fireRing(x: number, z: number) {
    const b = this.det;
    const s0 = b.vertexCount;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      b.add('ico1', x + Math.cos(a) * 1.0, 0.16, z + Math.sin(a) * 1.0, 0.42, 0.3, 0.38, S.rock(i % 2 ? 0x6a6460 : 0x5a5450), 0, a, 0);
    }
    b.displace(0.05, 6, 3, s0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI + 0.3;
      b.capsule(x + Math.cos(a) * 0.5, 0.12, z + Math.sin(a) * 0.5, x - Math.cos(a) * 0.4, 0.3, z - Math.sin(a) * 0.4, 0.08, S.wood(0x1c140e, 0.4), 8);
    }
    for (let i = 0; i < 6; i++) b.sphereAt(x + (hash2(i, 1, 3) - 0.5) * 0.6, 0.07, z + (hash2(i, 2, 3) - 0.5) * 0.6, 0.05, S.glow(0xff6a20, 3), false);
    crate(b, x + 2.4, 0.3, z + 0.6, 0.6, 0.6, 0.6, 0.4);
    spareTyre(b, x - 2.3, 0.12, z - 0.4, 0.4, 0.22, 0, 0);
    void plate;
  }

  /** Ground cover across the arena, avoiding anything `blocked` says is occupied. */
  scatter(blocked: (x: number, z: number, r: number) => boolean, density: number) {
    const city = this.biome === 'city';
    const grass: Spot[] = [];
    const shrubs: Spot[] = [];
    const pebbles: Spot[][] = [[], [], []];
    const step = city ? 3.6 : 2.2;
    for (let x = -FLAT_R; x <= FLAT_R; x += step) {
      for (let z = -FLAT_R; z <= FLAT_R; z += step) {
        const jx = x + hash2(Math.round(x * 3), Math.round(z * 3), this.seed) * step;
        const jz = z + hash2(Math.round(z * 3), Math.round(x * 3), this.seed + 1) * step;
        const r = Math.hypot(jx, jz);
        if (r > FLAT_R - 4 || r < 6) continue;
        const k = hash2(Math.round(jx * 5), Math.round(jz * 5), this.seed + 2);
        const clump = noise2(jx / 17, jz / 17, this.seed + 3);
        if (blocked(jx, jz, 0.6)) continue;
        if (k < (city ? 0.05 : smoothstep(0.35, 0.75, clump) * 0.55) * density) {
          grass.push({ x: jx, y: 0, z: jz, yaw: k * 40, s: 0.7 + k * 4, tilt: [0, 0] });
        } else if (!city && k > 0.985 - 0.02 * density) {
          shrubs.push({ x: jx, y: 0, z: jz, yaw: k * 30, s: 0.6 + (k - 0.96) * 20, tilt: [0, 0] });
        } else if (k > 0.9 && k < 0.9 + 0.05 * density) {
          pebbles[Math.floor((k - 0.9) * 40) % 2].push({ x: jx, y: 0, z: jz, yaw: k * 50, s: 0.8 + (k - 0.9) * 8, tilt: [0, 0] });
        }
      }
    }
    const set = scatterFromSpots(grass, shrubs, pebbles, city, this.land?.lush ?? 0);
    for (const im of [set.grass, set.shrubs, ...set.pebbles]) {
      if (!im) continue;
      this.group.add(im);
      this.instanced.push(im);
    }
    this.stones = set.pebbles;
    this.trees();
  }

  /**
   * On the green, the wood stands round the basin, outside the ground the raid crosses (it is scenery: nothing collides with
   * it), thick where the country is wooded and a scatter of lone trees where it is meadow.
   */
  private trees() {
    const land = this.land;
    if (!land || land.lush < 0.3) return;
    const pick = (k: number): TreeSpecies => (land.woods === 'broadleaf' ? (k < 0.8 ? 'oak' : k < 0.9 ? 'pine' : 'poplar') : woodSpecies(land.woods, k, land.lush, land.wood));
    const spots: TreeSpot[] = [];
    const p = Math.min(0.75, land.wood * 0.85 + 0.06);
    for (let r = FLAT_R + 8; r < FLAT_R + 120; r += 6.5) {
      const n = Math.floor((Math.PI * 2 * r) / 6.5);
      const ri = Math.round(r);
      for (let k = 0; k < n; k++) {
        const a = ((k + hash2(k, ri, this.seed + 31) * 0.6) / n) * Math.PI * 2;
        const rr = r + (hash2(k, ri, this.seed + 32) - 0.5) * 4;
        const x = Math.sin(a) * rr;
        const z = Math.cos(a) * rr;
        const roll = hash2(k, ri, this.seed + 33);
        // Thicker toward the back of the basin, so the edge of the wood is ragged.
        if (roll > p * smoothstep(FLAT_R, FLAT_R + 40, rr) * (0.7 + 0.6 * noise2(x / 50, z / 50, this.seed + 34))) continue;
        const y = this.heightAt(x, z);
        if (Math.abs(this.heightAt(x + 2, z) - this.heightAt(x - 2, z)) > 2.4 || Math.abs(this.heightAt(x, z + 2) - this.heightAt(x, z - 2)) > 2.4) continue;
        const kk = hash2(k, ri, this.seed + 35);
        spots.push({ x, y: y - 0.12, z, yaw: kk * Math.PI * 2, s: 0.75 + roll * 0.5, sp: TREE_SPECIES.indexOf(pick(kk)), v: Math.floor(hash2(k, ri, this.seed + 36) * 3), lean: [0, 0] });
      }
    }
    if (!spots.length) return;
    const g = buildTreesSteps(spots);
    let step = g.next();
    while (!step.done) step = g.next();
    for (const im of [...step.value.near, step.value.far]) {
      if (!im) continue;
      this.group.add(im);
      this.instanced.push(im);
    }
  }

  /** The instanced stones laid by `scatter`, so the scene can give each a collider. */
  stones: THREE.InstancedMesh[] = [];

  /** Build the accumulated facade and detail meshes. */
  finish() {
    if (!this.fb.empty) {
      const g = this.fb.build();
      this.geos.push(g);
      const m = new THREE.Mesh(g, facadeMaterial());
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    if (!this.det.empty) {
      const g = this.det.build();
      this.geos.push(g);
      const m = new THREE.Mesh(g, kitMaterial());
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const im of this.instanced) im.dispose();
  }
}
