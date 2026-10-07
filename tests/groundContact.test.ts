import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { G, GROUPS, groups, initPhysics, PhysicsWorld } from '../src/physics/physics';
import { BOATS, boatDef, legById } from '../src/data';
import { ChunkSource } from '../src/world/chunkgen';
import { CHUNK } from '../src/world/terrain';
import { roadLayer } from '../src/world/openWorld';
import { ChunkView, makeChunkMaterials, roadLift } from '../src/render/chunkview';

// What a wheel, a foot or a hull rests on is what is drawn: the ground mesh's own triangles, the road ribbon laid over it,
// and a waterline low on a boat's side. Each of these was out by 10 to 30 cm, so cars, mopeds and boats sat sunk in it.

beforeAll(initPhysics);

/** A small repeatable sequence in [0, 1). */
function seq(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe('the ground collider', () => {
  it('is split into triangles the way the ground mesh is, so it meets the drawn ground in the middle of a cell', () => {
    const n = 4;
    const size = 8;
    const cell = size / n;
    const N1 = n + 1;
    const x0 = 10;
    const z0 = -20;
    const h = new Float32Array(N1 * N1);
    // Rough ground: neighbouring corners far apart, so the two ways of splitting a cell differ by tens of centimetres.
    for (let i = 0; i < h.length; i++) h[i] = Math.sin(i * 1.7) * 0.6 + (i % 3) * 0.25;
    const P = new PhysicsWorld();
    P.addHeightfield(x0, z0, size, n, h);
    P.step();
    // The drawn triangles of a cell are (a, d, e) and (a, e, b): see ChunkView.buildTerrain and LegScene.drawnGroundAt.
    const drawn = (x: number, z: number) => {
      const fc = (x - x0) / cell;
      const fr = (z - z0) / cell;
      const c = Math.min(n - 1, Math.floor(fc));
      const r = Math.min(n - 1, Math.floor(fr));
      const tx = fc - c;
      const tz = fr - r;
      const H = (cc: number, rr: number) => h[cc * N1 + rr];
      const a = H(c, r);
      const b = H(c + 1, r);
      const d = H(c, r + 1);
      const e = H(c + 1, r + 1);
      return tx > tz ? a + (b - a) * tx + (e - b) * tz : a + (d - a) * tz + (e - d) * tx;
    };
    const rnd = seq(7);
    let worst = 0;
    for (let k = 0; k < 300; k++) {
      const x = x0 + 0.01 + rnd() * (size - 0.02);
      const z = z0 + 0.01 + rnd() * (size - 0.02);
      worst = Math.max(worst, Math.abs(P.groundHeight(x, z, 50)! - drawn(x, z)));
    }
    expect(worst).toBeLessThan(0.002);
  });
});

describe('the road', () => {
  const leg = legById('W');
  const src = new ChunkSource(leg);
  const def = src.layout.terrain;
  const o = def.open!;
  // A road laid a step up because it crosses one planned before it: the highest the open world draws a road.
  const ri = o.roads.findIndex((r, i) => r.kind !== 'track' && roadLayer(o, i) >= 1);
  const road = o.roads[ri];
  const mid = (road.pts.length / 2) >> 1;
  const rx = road.pts[mid * 2];
  const rz = road.pts[mid * 2 + 1];
  const data = src.get(Math.floor(rx / CHUNK), Math.floor(rz / CHUNK));
  let P: PhysicsWorld;
  let ribbons: THREE.Mesh[] = [];
  beforeAll(() => {
    P = new PhysicsWorld();
    const view = new ChunkView(data, def, makeChunkMaterials('wasteland', leg.theme), P, { scatter: 0 });
    P.step();
    ribbons = view.group.children.filter((m) => (m as THREE.Mesh).geometry?.attributes.rtan) as THREE.Mesh[];
    view.group.updateMatrixWorld(true);
  });
  const ray = new THREE.Raycaster();
  const drawnRoad = (x: number, z: number) => {
    ray.set(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0));
    return ray.intersectObjects(ribbons, false)[0]?.point.y ?? null;
  };
  // Across the carriageway and its shoulders at the road's middle point, and along it a little way.
  const tx = road.pts[mid * 2 + 2] - road.pts[mid * 2 - 2];
  const tz = road.pts[mid * 2 + 3] - road.pts[mid * 2 - 1];
  const tl = Math.hypot(tx, tz);
  const spots: [number, number][] = [];
  for (const along of [-3, 0, 2.5]) for (const across of [-1.1, -0.6, -0.2, 0, 0.35, 0.8, 1.05]) spots.push([rx + (tx / tl) * along + (tz / tl) * across * road.half, rz + (tz / tl) * along - (tx / tl) * across * road.half]);

  it('is ridden on as it is drawn: wheel rays meet the ribbon, not the ground under it', () => {
    expect(ribbons.length).toBeGreaterThan(0);
    let n = 0;
    for (const [x, z] of spots) {
      const y = drawnRoad(x, z);
      if (y === null) continue;
      const r = P.raycast(x, 400, z, 0, -1, 0, 800, GROUPS.wheelRays)!;
      expect(Math.abs(400 - r.toi - y)).toBeLessThan(0.005);
      n++;
    }
    expect(n).toBeGreaterThan(15);
  });

  it('keeps rounds and marks on the ground under it, and `roadLift` puts them back on top', () => {
    const rounds = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN | G.LOOSE);
    for (const [x, z] of spots) {
      const y = drawnRoad(x, z);
      if (y === null) continue;
      const g = 400 - P.raycast(x, 400, z, 0, -1, 0, 800, rounds)!.toi;
      expect(y - g).toBeGreaterThan(0.02);
      expect(Math.abs(g + roadLift(def, x, z) - y)).toBeLessThan(0.025);
    }
  });

  it('is drawn a step up only where it crosses another, not a step for every road planned before it', () => {
    const paved = o.roads.map((r, i) => (r.kind === 'track' ? -1 : roadLayer(o, i))).filter((l) => l >= 0);
    expect(Math.max(...paved)).toBeLessThan(paved.length - 1);
    expect(Math.max(...paved)).toBeLessThanOrEqual(3);
  });

  it('can be driven onto from the ground: a ramp at the edge, not a ledge', () => {
    // Just past the drawn shoulder the wheel rays already climb toward the road, and they never stand above it.
    const side = road.half + 0.7;
    const at = (d: number) => {
      const x = rx + (tz / tl) * d;
      const z = rz - (tx / tl) * d;
      return 400 - P.raycast(x, 400, z, 0, -1, 0, 800, GROUPS.wheelRays)!.toi;
    };
    let prev = at(side + 1.5);
    for (let d = side + 1.4; d >= side - 0.1; d -= 0.1) {
      const y = at(d);
      expect(y - prev).toBeLessThan(0.05);
      prev = y;
    }
  });
});

describe('boats', () => {
  it('ride with most of the hull out of the water', () => {
    for (const b of BOATS) {
      const def = boatDef(b.id);
      expect(def.physics.boat!.draft).toBeLessThan(def.physics.halfExtents[1] * 0.6);
    }
  });
});
