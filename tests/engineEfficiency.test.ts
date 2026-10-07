import './helpers/sim';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Nearest } from '../src/core/nearest';
import { Rng } from '../src/core/rng';
import { ObstacleIndex } from '../src/game/obstacles';
import { SignatureGrid } from '../src/sim/signature';
import { ZombieSystem } from '../src/game/zombies';
import { WildlifeSystem } from '../src/game/wildlife';
import type { Ctx } from '../src/game/ctx';
import { ZombieRenderer } from '../src/render/zombieRender';
import { AnimalRenderer } from '../src/render/animalRender';
import { LifeRenderer } from '../src/render/lifeRender';
import { TrackMarks } from '../src/render/trackMarks';
import { markStyle } from '../src/sim/bodywork';
import { legacySegmentFirst, LegacySignatureGrid } from './helpers/engineReference';
import type { Aabb } from '../src/world/layout';

const box = (id: number, minX: number, minZ: number, w = 5, h = 5): Aabb => ({
  id, minX, maxX: minX + w, minZ, maxZ: minZ + h, y0: 0, y1: 3, kind: 'wall', hp: 100,
});

describe('engine spatial queries', () => {
  it('matches the original nearest obstacle and hit parameter for randomized rays, glass, heights and ignored kinds', () => {
    const rng = new Rng(7494), index = new ObstacleIndex();
    index.ground = (x, z) => Math.sin(x / 70) + Math.cos(z / 50);
    for (let i = 0; i < 400; i++) {
      const a = box(i, rng.int(-180, 180), rng.int(-180, 180), rng.int(0, 35), rng.int(0, 35));
      if (i % 4 === 0) a.mat = 'glass';
      if (i % 7 === 0) a.kind = 'furniture';
      a.y0 = rng.int(-1, 4); a.y1 = a.y0 + rng.int(0, 4);
      index.add(a);
    }
    for (let i = 0; i < 5000; i++) {
      const ax = rng.range(-250, 250), az = rng.range(-250, 250), bx = rng.range(-250, 250), bz = rng.range(-250, 250);
      const y = rng.range(-2, 5), ignore = i % 3 ? undefined : new Set(['furniture']);
      const expected = legacySegmentFirst(index, ax, az, bx, bz, y, ignore);
      const actual = index.segmentFirst(ax, az, bx, bz, y, ignore);
      expect(actual?.a).toBe(expected?.a);
      expect(actual?.t).toBe(expected?.t);
      expect(index.segmentBlocked(ax, az, bx, bz, y, ignore)).toBe(!!expected);
    }
  });

  it('covers grid edges, corners, reverse rays, almost-parallel rays, zero length and overlapping ties after re-addition', () => {
    const index = new ObstacleIndex();
    const boxes = [box(1, -32, -32, 64, 64), box(2, -16, -16, 32, 32), box(3, 16, 0, 0, 48), box(4, 0, 16, 48, 0)];
    boxes.forEach(b => index.add(b));
    const points = [[-64, -64], [-32, -16], [0, 0], [16, 0], [16, 16], [16 + 1e-10, 16 - 1e-10], [32, 32], [64, -64]];
    const check = () => {
      for (const [ax, az] of points) for (const [bx, bz] of points) {
        expect(index.segmentFirst(ax, az, bx, bz)).toEqual(legacySegmentFirst(index, ax, az, bx, bz));
      }
    };
    check(); index.remove(boxes[0]); index.add(boxes[0]); check();
    index.clear(); expect(index.segmentFirst(-64, 0, 64, 0)).toBeNull();
  });

  it('nested obstacle callbacks do not duplicate or omit outer candidates', () => {
    const index = new ObstacleIndex();
    [box(1, -20, -20, 80, 80), box(2, 10, 10, 80, 80)].forEach(b => index.add(b));
    const ids: number[] = [];
    index.near(20, 20, 100, a => {
      ids.push(a.id);
      index.near(20, 20, 100, () => {});
      index.segmentFirst(-50, -50, 50, 50);
    });
    expect(ids).toEqual([1, 2]);
    expect(() => index.near(0, 0, 10, () => { throw new Error('callback'); })).toThrow('callback');
    const retry: number[] = []; index.near(20, 20, 100, a => retry.push(a.id));
    expect(retry).toEqual([1, 2]);
  });

  it.each([12, 600])('matches legacy hearing and dust queries with %i emitters, including ties, replacement and decay', n => {
    const rng = new Rng(9932), current = new SignatureGrid(), original = new LegacySignatureGrid();
    for (let i = 0; i < n; i++) {
      const x = rng.int(-240, 240), z = rng.int(-240, 240), level = rng.int(1, 5) * 20, channel = i % 3 ? 'noise' : 'dust';
      current.emit(x, z, level, channel); original.emit(x, z, level, channel);
    }
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 1000; i++) {
        const x = rng.range(-300, 300), z = rng.range(-300, 300), indoors = i % 2 === 0, channel = i % 3 ? 'noise' : 'dust', radius = rng.int(0, 180);
        expect(current.loudestFor(x, z, indoors, channel)).toEqual(original.loudestFor(x, z, indoors, channel));
        expect(current.strongestWithin(x, z, radius, channel)).toEqual(original.strongestWithin(x, z, radius, channel));
      }
      current.decay(0.8); original.decay(0.8);
    }
    current.clear(); original.clear();
    expect(current.loudestFor(0, 0, false)).toBeNull();
  });
});

describe('stable bounded character selection', () => {
  it('matches stable full sorting through duplicate distances, visibility filtering, budget changes and repeated frames', () => {
    const rng = new Rng(84), selection = new Nearest<number>();
    for (let frame = 0; frame < 100; frame++) {
      const candidates = Array.from({ length: 800 }, (_, order) => ({ order, distance: rng.int(0, 80), seen: rng.chance(0.6) }));
      const limit = frame % 33;
      selection.begin(limit);
      for (const c of candidates) if (selection.accepts(c.distance, c.order) && c.seen) selection.offer(c.order, c.distance, c.order);
      const expected = candidates.filter(c => c.seen).sort((a, b) => a.distance - b.distance).slice(0, limit).map(c => c.order);
      expect(selection.finish().map(e => e.value)).toEqual(expected);
    }
  });

  it('keeps the same real zombie and animal instance order for one or two cameras, including screen-edge bodies', () => {
    const rng = new Rng(901), ctx = { groundAt: () => 0, rng: new Rng(10), campaign: { seed: 10 } } as unknown as Ctx;
    const zombies = new ZombieSystem(ctx), wildlife = new WildlifeSystem(ctx);
    for (let i = 0; i < 500; i++) {
      const x = rng.range(-160, 160), z = rng.range(-160, 160);
      const zb = zombies.spawn('walker', x, z, false), a = wildlife.spawn('hare', x, z);
      zb.active = a.active = i % 3 !== 0; zb.dead = a.dead = i % 11 === 0;
    }
    const c1 = new THREE.PerspectiveCamera(60, 1.7, 0.2, 300), c2 = c1.clone();
    c1.position.set(0, 2, 0); c1.lookAt(0, 2, -100); c1.updateMatrixWorld();
    c2.position.set(20, 2, 0); c2.lookAt(100, 2, 0); c2.updateMatrixWorld();
    for (const cameras of [[c1], [c1, c2]]) {
      const cams = cameras.map(c => c.position), fs = cameras.map(c => new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse)));
      const score = (a: { x: number; z: number }) => Math.min(...cams.map(c => (c.x - a.x) ** 2 + (c.z - a.z) ** 2));
      const seen = (a: { x: number; y: number; z: number }, heights: number[]) => fs.some(f => heights.some(y => f.containsPoint(new THREE.Vector3(a.x, a.y + y, a.z))));
      for (const budget of [1, 8, 30, 0.5]) {
        const zDraw: number[] = [], aDraw: number[] = [];
        zombies.render({ begin() {}, end() {}, push(_kind: unknown, _scale: number, x: number) { zDraw.push(x); } } as unknown as ZombieRenderer, 0, fs, budget, cams);
        wildlife.render({ begin() {}, end() {}, push(_kind: unknown, _scale: number, x: number) { aDraw.push(x); } } as unknown as AnimalRenderer, fs, budget, cams);
        expect(zDraw).toEqual(zombies.list.filter(a => a.active || a.dead).sort((a, b) => score(a) - score(b)).filter(a => seen(a, [0.9, 1.9, 0])).slice(0, Math.ceil(budget * 2)).map(a => a.x));
        expect(aDraw).toEqual(wildlife.list.filter(a => a.active || a.dead).sort((a, b) => score(a) - score(b)).filter(a => seen(a, [a.height * 0.5, a.height, 0])).slice(0, Math.ceil(budget)).map(a => a.x));
      }
    }
  });
});

const attributes = (mesh: THREE.InstancedMesh) => [mesh.instanceMatrix, ...(mesh.instanceColor ? [mesh.instanceColor] : [])];
const acknowledge = (a: THREE.BufferAttribute) => a.clearUpdateRanges();
describe('live GPU uploads', () => {
  it('uploads only drawn zombie instances, retains pending writes, and stops touching empty batches', () => {
    const zr = new ZombieRenderer({ max: 600 });
    const attrs = [zr.mesh.instanceMatrix, ...['aAnim', 'aKind', 'aGore', 'aMotion'].map(n => zr.mesh.geometry.getAttribute(n) as THREE.BufferAttribute)];
    zr.begin(); for (let i = 0; i < 12; i++) zr.push('walker', 1, i, 0, 0, 0, 0, 0, 0, 0, i); zr.end(0);
    for (const a of attrs) expect(a.updateRanges).toEqual([{ start: 0, count: 12 * a.itemSize }]);
    zr.begin(); zr.push('walker', 1, 9, 0, 0, 0, 0, 0, 0, 0, 0); zr.end(1);
    for (const a of attrs) expect(a.updateRanges).toEqual([{ start: 0, count: 12 * a.itemSize }]);
    attrs.forEach(acknowledge); const versions = attrs.map(a => a.version);
    zr.begin(); zr.end(2);
    expect(zr.mesh.count).toBe(0); expect(attrs.map(a => a.version)).toEqual(versions);
    expect(zr.mesh.instanceMatrix.getX(0)).toBe(1); // Full matrix data stays untouched by flushes.
    zr.mesh.dispose();
  });

  it('limits body, mounted limb, ambient life, ring and point uploads and idles species independently', () => {
    const ar = new AnimalRenderer(), lr = new LifeRenderer();
    ar.begin(); ar.push('hare', 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1); ar.end();
    const meshes = ar.group.children as THREE.InstancedMesh[];
    expect(meshes.length).toBeGreaterThan(1);
    for (const m of meshes) for (const a of attributes(m)) expect(a.updateRanges).toEqual([{ start: 0, count: m.count * a.itemSize }]);
    lr.begin(); lr.putFish(0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 2, 0.2); lr.ring(0, 0, 0, 1, 0, 1); lr.glow.add(0, 0, 0, 1, 1, 1, 1, 1); lr.end();
    const fish = lr.group.children.find(o => (o as THREE.Mesh).geometry?.getAttribute('aWig')) as THREE.InstancedMesh;
    expect((fish.geometry.getAttribute('aWig') as THREE.BufferAttribute).updateRanges).toEqual([{ start: 0, count: 3 }]);
    const ring = lr.group.children.find(o => (o as THREE.Mesh).geometry?.getAttribute('aRing')) as THREE.InstancedMesh;
    expect((ring.geometry.getAttribute('aRing') as THREE.BufferAttribute).updateRanges).toEqual([{ start: 0, count: 2 }]);
    const allAttrs = [...meshes.flatMap(attributes), ...attributes(fish), fish.geometry.getAttribute('aWig') as THREE.BufferAttribute,
      ...attributes(ring), ring.geometry.getAttribute('aRing') as THREE.BufferAttribute, ...Object.values(lr.glow.points.geometry.attributes) as THREE.BufferAttribute[]];
    allAttrs.forEach(acknowledge); const versions = allAttrs.map(a => a.version);
    ar.begin(); ar.end(); lr.begin(); lr.end();
    expect(allAttrs.map(a => a.version)).toEqual(versions);
    ar.dispose(); lr.dispose();
  });

  it('uploads two small track spans at wraparound, preserves pending restoration, and reuses wheel edge buffers', () => {
    const marks = new TrackMarks(), style = markStyle('sand', 0, 10, 0)!, ground = () => 0;
    for (let i = 0; i <= 6999; i++) marks.lay(1, 0, i * 0.5, 0.12, style, ground);
    marks.update(0); const attrs = Object.values(marks.mesh.geometry.attributes) as THREE.BufferAttribute[];
    attrs.forEach(acknowledge);
    marks.lay(1, 0, 3500, 0.12, style, ground); marks.lay(1, 0, 3500.5, 0.12, style, ground); marks.update(0);
    for (const a of attrs) expect(a.updateRanges).toEqual([{ start: 6999 * 10 * a.itemSize, count: 10 * a.itemSize }, { start: 0, count: 10 * a.itemSize }]);
    const saved = marks.snapshot(); marks.restore(saved); marks.update(0);
    marks.lay(1, 0, 3501, 0.12, style, ground); marks.lay(1, 0, 3501.5, 0.12, style, ground); marks.update(0);
    for (const a of attrs) expect(a.updateRanges.some(r => r.count === 7000 * 10 * a.itemSize)).toBe(true);
    const trails = (marks as unknown as { trails: Map<number, { edge: Float32Array; next: Float32Array }> }).trails;
    const trail = trails.get(1)!, buffers = new Set([trail.edge, trail.next]);
    for (let i = 0; i < 100; i++) marks.lay(1, 0, 3502 + i * 0.5, 0.12, style, ground);
    expect(buffers.has(trail.edge) && buffers.has(trail.next)).toBe(true);
    marks.dispose();
  });
});
