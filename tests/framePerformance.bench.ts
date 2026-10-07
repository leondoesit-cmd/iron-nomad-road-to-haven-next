import * as THREE from 'three';
import { it } from 'vitest';
import { staticTransform } from '../src/render/staticTransform';
import { colliderRadius, type Collider } from '../src/physics/physics';
import { ObstacleIndex } from '../src/game/obstacles';
import { SignatureGrid } from '../src/sim/signature';
import { Nearest } from '../src/core/nearest';
import { Rng } from '../src/core/rng';
import { legacySegmentFirst, LegacySignatureGrid } from './helpers/engineReference';

// Subsystem benchmarks: these do not measure whole-game FPS or GPU time.
function scenery(cached: boolean) {
  const scene = new THREE.Scene();
  const root = new THREE.Group(); scene.add(root);
  for (let chunk = 0; chunk < 100; chunk++) {
    const group = new THREE.Group(); root.add(group);
    for (let i = 0; i < 100; i++) {
      const mesh = new THREE.Object3D(); mesh.position.set(i * 13, 0, chunk * 128);
      group.add(mesh);
    }
  }
  if (cached) scene.traverse(staticTransform);
  scene.updateMatrixWorld();
  return scene;
}
const dynamic = scenery(false), cached = scenery(true);
it('10,000 immutable scenery nodes, both views', async ({ bench }) => {
  const result = await bench.compare(
    bench('original automatic transforms', () => { dynamic.updateMatrixWorld(); dynamic.updateMatrixWorld(); }),
    bench('cached local transforms', () => { cached.updateMatrixWorld(); cached.updateMatrixWorld(); }),
    { time: 300, warmupTime: 100 },
  );
  console.log('Scenery CPU ms per two-view frame:', {
    before: result.get('original automatic transforms')!.latency.mean,
    after: result.get('cached local transforms')!.latency.mean,
  });
});

const vertices = Float32Array.from({ length: 3072 }, (_, i) => Math.sin(i * 0.7) * (i % 17));
const collider = { shape: { vertices } } as unknown as Collider;
const cachedRadius = colliderRadius;
function originalRadius() {
  let radius = 0;
  for (let j = 0; j < vertices.length; j += 3) radius = Math.max(radius, Math.hypot(vertices[j], vertices[j + 1], vertices[j + 2]));
  return radius || 2;
}
let sink = 0;
it('1,000 repeated compound-hull radius queries', async ({ bench }) => {
  const result = await bench.compare(
    bench('original vertex scan', () => { for (let i = 0; i < 1000; i++) sink = originalRadius(); }),
    bench('cached shape radius', () => { for (let i = 0; i < 1000; i++) sink = cachedRadius(collider); }),
    { time: 300, warmupTime: 100 },
  );
  console.log('Hull CPU ms per 1,000 queries:', {
    before: result.get('original vertex scan')!.latency.mean,
    after: result.get('cached shape radius')!.latency.mean,
  });
});
void sink;

const obstacles = new ObstacleIndex();
let obstacleId = 0;
for (let x = -25; x < 25; x++) for (let z = -25; z < 25; z++) obstacles.add({
  id: obstacleId++, minX: x * 16 + 4, maxX: x * 16 + 8, minZ: z * 16 + 4, maxZ: z * 16 + 8,
  y0: 0, y1: 3, kind: 'wall', hp: 100,
});
const benchRng = new Rng(9184);
const rays = Array.from({ length: 128 }, () => ({ ax: benchRng.range(-180, 180), az: benchRng.range(-180, 180), bx: benchRng.range(-180, 180), bz: benchRng.range(-180, 180) }));
const beforeSegment = legacySegmentFirst;
it('128 city sight/cover rays in a 2,500-obstacle scene', async ({ bench }) => {
  const result = await bench.compare(
    bench('original broad-square scan', () => { for (const r of rays) sink = beforeSegment(obstacles, r.ax, r.az, r.bx, r.bz)?.t ?? 0; }),
    bench('thin segment cell walk', () => { for (const r of rays) sink = obstacles.segmentFirst(r.ax, r.az, r.bx, r.bz)?.t ?? 0; }),
    { time: 300, warmupTime: 100 },
  );
  console.log('Sight CPU ms per 128 queries:', { before: result.get('original broad-square scan')!.latency.mean, after: result.get('thin segment cell walk')!.latency.mean });
});

const signatures = new SignatureGrid(), oldSignatures = new LegacySignatureGrid();
for (let i = 0; i < 13; i++) {
  const x = benchRng.range(-75, 75), z = benchRng.range(-75, 75), level = benchRng.range(30, 100);
  signatures.emit(x, z, level); oldSignatures.emit(x, z, level);
}
const listeners = Array.from({ length: 800 }, () => ({ x: benchRng.range(-90, 90), z: benchRng.range(-90, 90) }));
it('800 hearing queries around 13 vehicle/weapon emitters', async ({ bench }) => {
  const result = await bench.compare(
    bench('original empty-cell probes', () => { for (const p of listeners) sink = oldSignatures.loudestFor(p.x, p.z, false)?.level ?? 0; }),
    bench('adaptive sparse hearing', () => { for (const p of listeners) sink = signatures.loudestFor(p.x, p.z, false)?.level ?? 0; }),
    { time: 300, warmupTime: 100 },
  );
  console.log('Hearing CPU ms per 800 queries:', { before: result.get('original empty-cell probes')!.latency.mean, after: result.get('adaptive sparse hearing')!.latency.mean });
});

const actors = Array.from({ length: 3000 }, () => ({ x: benchRng.range(-300, 300), z: benchRng.range(-300, 300), active: benchRng.chance(0.8), visible: benchRng.chance(0.6) }));
const actorScore = (a: typeof actors[number]) => Math.min(a.x ** 2 + a.z ** 2, (a.x - 40) ** 2 + (a.z - 20) ** 2);
const actorNearest = new Nearest<typeof actors[number]>();
it('nearest 160 visible actors from 3,000 candidates, two viewpoints', async ({ bench }) => {
  const result = await bench.compare(
    bench('original full actor sort', () => {
      const live = actors.filter(a => a.active).sort((a, b) => actorScore(a) - actorScore(b));
      let drawn = 0;
      for (const a of live) { if (drawn === 160) break; if (a.visible) { sink = a.x; drawn++; } }
    }),
    bench('bounded stable actor selection', () => {
      actorNearest.begin(160);
      for (let i = 0; i < actors.length; i++) { const a = actors[i]; if (!a.active) continue; const d = actorScore(a); if (actorNearest.accepts(d, i) && a.visible) actorNearest.offer(a, d, i); }
      for (const a of actorNearest.finish()) sink = a.value.x;
    }),
    { time: 300, warmupTime: 100 },
  );
  console.log('Character selection CPU ms per frame:', { before: result.get('original full actor sort')!.latency.mean, after: result.get('bounded stable actor selection')!.latency.mean });
});
