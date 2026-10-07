import { describe, expect, it } from 'vitest';
import { legById } from '../src/data';
import { clayAt, heightAt, makeTerrainDef, surfaceAt, waterAt, CHUNK } from '../src/world/terrain';
import { districtMask, nearestRoad } from '../src/world/openWorld';
import { courseAt } from '../src/world/hydro';
import { FLOOD_SPEED, floodAt, floodStage, panAt, panQ, washAt, type Pan } from '../src/world/washes';
import { HYDRO_DT, type Hydrograph } from '../src/sim/climate';
import { ChunkSource } from '../src/world/chunkgen';

const leg = legById('W');
const def = makeTerrainDef(leg);
const net = def.washes!;

/** A hydrograph with nothing in it, and one with a single flash flood leaving the mountains at `t0`. */
function hydro(t0 = -1, peak = 1): Hydrograph {
  const n = Math.round(1.25 / HYDRO_DT) + 1;
  const h: Hydrograph = { wet: new Float32Array(n), puddle: new Float32Array(n), wash: new Float32Array(n), river: new Float32Array(n), pan: new Float32Array(n) };
  if (t0 >= 0) {
    for (let i = 0; i < n; i++) {
      const dt = i * HYDRO_DT - t0;
      h.wash[i] = dt < 0 ? 0 : peak * Math.min(1, dt / 0.01) * Math.exp(-Math.max(0, dt - 0.02) / 0.03);
    }
  }
  return h;
}
const noPans = () => 0;

describe('dry washes and clay pans', () => {
  it('are planned from the spec, the same every time', () => {
    expect(net.washes.map((w) => w.name).sort()).toEqual(['Wadi Qedar', 'Wadi Sela', 'Wadi Shezaf', 'Wadi Zohar']);
    expect(net.pans.map((p) => p.name).sort()).toEqual(["Nar's Flat", 'Qedar Pan', 'the Zohar Flats']);
    // Nar's Flat is a dry salt flat with no wash: it never holds a sheet of water.
    expect(net.pans.find((p) => p.key === 'narflat')?.dry).toBe(true);
    const again = makeTerrainDef(leg).washes!;
    for (let k = 0; k < net.washes.length; k++) {
      expect(again.washes[k].n).toBe(net.washes[k].n);
      expect(Array.from(again.washes[k].bed)).toEqual(Array.from(net.washes[k].bed));
    }
  });

  it('never run uphill, and every bed lies cut into the land beside it', () => {
    const bare = { ...def, washes: undefined };
    for (const w of net.washes) {
      for (let i = 1; i < w.n; i++) expect(w.bed[i], `${w.name} at ${i}`).toBeLessThanOrEqual(w.bed[i - 1] + 1e-4);
      let below = 0;
      let n = 0;
      // Away from the gorge and the mouth, the land beside the bed stands over it.
      for (let i = 40; i < w.end - 20; i += 10) {
        const nx = -w.dz[i];
        const nz = w.dx[i];
        const off = w.half[i] + w.bank[i] + 3;
        const side = Math.max(heightAt(bare, w.x[i] + nx * off, w.z[i] + nz * off), heightAt(bare, w.x[i] - nx * off, w.z[i] - nz * off));
        if (side > w.bed[i] + 0.6) below++;
        n++;
      }
      expect(below / n, w.name).toBeGreaterThan(0.85);
    }
  });

  it('lay a flat gravel bed into the ground, and meet what they run into', () => {
    for (const w of net.washes) {
      for (let i = 30; i < w.end; i += 15) {
        const h = heightAt(def, w.x[i], w.z[i]);
        expect(Math.abs(h - w.bed[i]), `${w.name} at ${i}`).toBeLessThan(0.35);
      }
      const end = w.bed[w.end];
      if (w.into.kind === 'pan') expect(Math.abs(end - net.pans[w.into.ref].floor)).toBeLessThan(0.4);
      else {
        const c = courseAt(def.hydro!, w.x[w.n - 1], w.z[w.n - 1], 5)!;
        expect(c).not.toBeNull();
        expect(end).toBeLessThan(c.level + 0.2);
      }
    }
  });

  it('pans are dead flat clay in a shallow dish with a lip round it, holding no water of their own', () => {
    for (const p of net.pans) {
      const mid = heightAt(def, p.x, p.z);
      expect(mid).toBeCloseTo(p.floor, 1);
      expect(clayAt(def, p.x, p.z)).toBe(true);
      expect(waterAt(def, p.x, p.z)).toBeNull();
      expect(surfaceAt(def, p.x, p.z)).toBe('hardpan');
      // The floor rises by a hand or two to its edge, then the lip.
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        const pt = edgePoint(p, th, 0.6);
        expect(heightAt(def, pt[0], pt[1]) - p.floor).toBeLessThan(0.3);
        const lip = edgePoint(p, th, 1.0);
        expect(heightAt(def, lip[0], lip[1]) - p.floor).toBeGreaterThan(0.75);
      }
    }
  });

  it('keep clear of the places, the hubs and the city', () => {
    for (const s of def.sites) {
      if (s.kind.startsWith('island') || s.kind === 'lakeDock') continue;
      const c = washAt(net, s.x, s.z, 30 + s.radius);
      expect(c, `${s.kind} at ${Math.round(s.x)},${Math.round(s.z)}`).toBeNull();
      expect(panAt(net, s.x, s.z, 1.5), s.kind).toBeNull();
    }
    for (const w of net.washes) for (let i = 0; i < w.n; i += 5) expect(districtMask(def.open, w.x[i], w.z[i])).toBe(0);
  });

  it('give a road an easy way down into the bed and out again', () => {
    let crossings = 0;
    for (const w of net.washes) {
      for (let i = 30; i < w.end; i++) {
        const rd = nearestRoad(def.open!, w.x[i], w.z[i]);
        if (!rd.road || rd.edge > 0) continue;
        crossings++;
        // Along the road, through the dip: no step steeper than a car can take.
        const p = rd.road.pts;
        let worst = 0;
        for (let k = 0; k + 3 < p.length; k += 2) {
          const mx = (p[k] + p[k + 2]) / 2;
          const mz = (p[k + 1] + p[k + 3]) / 2;
          if (Math.hypot(mx - w.x[i], mz - w.z[i]) > 40) continue;
          const l = Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]);
          worst = Math.max(worst, Math.abs(heightAt(def, p[k + 2], p[k + 3]) - heightAt(def, p[k], p[k + 1])) / l);
        }
        expect(worst, `${rd.road.id} over ${w.name}`).toBeLessThan(Math.tan((14 * Math.PI) / 180));
        break;
      }
    }
    expect(crossings).toBeGreaterThan(0);
  });

  it('a wash bed is firm gravel, never wet mud, and no tree roots in it', () => {
    for (const w of net.washes) for (let i = 30; i < w.end; i += 9) expect(surfaceAt(def, w.x[i], w.z[i])).not.toBe('mud');
    const src = new ChunkSource(leg);
    for (const w of net.washes) {
      for (let i = 40; i < w.end; i += 60) {
        const data = src.get(Math.floor(w.x[i] / CHUNK), Math.floor(w.z[i] / CHUNK));
        for (const t of data.trees) {
          const c = washAt(net, t.x, t.z);
          if (c) expect(c.d, `${w.name}`).toBeGreaterThan(c.half + 1);
        }
      }
    }
  });
});

describe('a flash flood', () => {
  const w = net.washes.find((q) => q.name === 'Wadi Qedar')!;
  const at = (i: number) => [w.x[i], w.z[i]] as const;

  it('is no water at all while the hills are dry', () => {
    const h = hydro();
    for (let i = 0; i < w.n; i += 20) expect(floodAt(def, net, ...at(i), 0.4, h, noPans)).toBeNull();
  });

  it('comes down the wash as a front: the head fills first, the foot later, and it drains again', () => {
    const t0 = 0.3;
    const h = hydro(t0);
    const head = 40;
    const foot = w.end - 10;
    const travel = (w.s[foot] - w.s[head]) / (FLOOD_SPEED * leg.dayLength);
    const tHead = t0 + 0.015 + w.s[head] / (FLOOD_SPEED * leg.dayLength);
    // The head is running while the foot is still dry.
    const a = floodAt(def, net, ...at(head), tHead, h, noPans);
    expect(a?.kind).toBe('flood');
    expect(a!.depth).toBeGreaterThan(0.6);
    expect(floodAt(def, net, ...at(foot), tHead, h, noPans)).toBeNull();
    // The front reaches the foot later.
    const b = floodAt(def, net, ...at(foot), tHead + travel, h, noPans);
    expect(b?.kind).toBe('flood');
    // It runs down the wash, fast.
    const sp = Math.hypot(b!.flow![0], b!.flow![1]);
    expect(sp).toBeGreaterThan(3);
    expect(b!.flow![0] * w.dx[foot] + b!.flow![1] * w.dz[foot]).toBeGreaterThan(sp * 0.95);
    // Minutes later the wash is dry again.
    expect(floodAt(def, net, ...at(head), tHead + 0.25, h, noPans)).toBeNull();
    expect(floodStage(net, w, w.s[foot], tHead + 0.3, h)).toBeLessThan(0.05);
  });

  it('fills its bed and climbs the banks, but stays in the wash', () => {
    const h = hydro(0.3);
    const i = 90;
    const t = 0.3 + 0.02 + w.s[i] / (FLOOD_SPEED * leg.dayLength);
    expect(floodAt(def, net, w.x[i], w.z[i], t, h, noPans)).not.toBeNull();
    const nx = -w.dz[i];
    const nz = w.dx[i];
    const off = w.half[i] + w.bank[i] + 6;
    expect(floodAt(def, net, w.x[i] + nx * off, w.z[i] + nz * off, t, h, noPans)).toBeNull();
  });

  it('leaves a sheet of water on its pan that is real water, shallow, still and silty', () => {
    const p = net.pans[w.into.ref];
    const hit = floodAt(def, net, p.x, p.z, 0.6, hydro(), () => 0.8);
    expect(hit?.kind).toBe('pool');
    expect(hit!.depth).toBeGreaterThan(0.3);
    expect(hit!.depth).toBeLessThan(0.7);
    expect(hit!.flow).toBeUndefined();
    // A drying pan shrinks to its middle: the edge of the floor is dry while the middle still holds water.
    const low = () => 0.15;
    expect(floodAt(def, net, p.x, p.z, 0.6, hydro(), low)).not.toBeNull();
    const e = edgePoint(p, 0.4, 0.68);
    expect(floodAt(def, net, e[0], e[1], 0.6, hydro(), low)).toBeNull();
  });
});

function edgePoint(p: Pan, th: number, q: number): [number, number] {
  // Walk out from the middle until panQ reaches q.
  for (let r = 0; r < p.r * 3; r += 0.5) {
    const x = p.x + Math.cos(th) * r;
    const z = p.z + Math.sin(th) * r;
    if (panQ(p, x, z) >= q) return [x, z];
  }
  return [p.x, p.z];
}
