import { appendFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { legById } from '../src/data';
import { heightAt, makeTerrainDef, waterAt, type TerrainDef } from '../src/world/terrain';
import { riverRibbonGeometry, RIBBON_NX } from '../src/render/riverWater';
import { floodRibbonGeometry, FLOOD_NX } from '../src/render/floodWater';
import { floodAt, floodStage } from '../src/world/washes';
import { courseAt, FLOOD_REACH, riseTaper, spillDepth, swampQ, type River } from '../src/world/hydro';
import { lakeWater } from '../src/world/lakes';
import { riverFloodRise } from '../src/game/weatherSystem';
import { DrawnGround } from '../src/render/drawnGround';
import { bump, plainSample, type Tally } from './helpers/waterScan';

/**
 * The water fits the land: wherever water is drawn the ground really holds it, wherever the physics has water you can see it,
 * and the two agree. The scan walks every course and wash cross-section by cross-section, finely across, holds the drawn
 * water (the ribbon's own vertex data, put through the same tests its shader makes) against the ground as it is drawn
 * (`DrawnGround`: the chunks' 2 m mesh, and the far landscape's coarse one for the view from afar), and asks the physics
 * (`waterAt`, the flood queries) about the same point.
 *
 * Set WATER_SCAN_OUT to a file path to get the per-course tallies.
 */

const OUT = process.env.WATER_SCAN_OUT ?? '';
const log = (s: string) => OUT && appendFileSync(OUT, s + '\n');

let def: TerrainDef;
let G: DrawnGround;
beforeAll(() => {
  if (OUT) writeFileSync(OUT, '');
  def = makeTerrainDef(legById('W'));
  G = new DrawnGround(def);
});

/** A ribbon row's attributes, interpolated across at `u` metres from the centre-line (as the rasteriser would). */
function rowAt(g: THREE.BufferGeometry, base: number, nx: number, key: string, comp: 'getX' | 'getY', u: number) {
  const across = g.getAttribute(key) as THREE.BufferAttribute;
  let k = 0;
  while (k < nx - 2 && across[comp](base + k + 1) < u) k++;
  const u0 = across[comp](base + k);
  const u1 = across[comp](base + k + 1);
  const f = Math.min(1, Math.max(0, (u - u0) / (u1 - u0 || 1)));
  return (name: string, c: 'getX' | 'getY' | 'getZ' | 'getW') => {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    return a[c](base + k) + (a[c](base + k + 1) - a[c](base + k)) * f;
  };
}

/** Whether a lake's, a swamp's or a spring pool's own sheet is drawn at a point (a course fades out under it). */
function sheetOver(x: number, z: number): boolean {
  const hy = def.hydro!;
  const l = lakeWater(def.lakes, x, z);
  if (l && l.depth > 0.02) return true;
  for (const sp of hy.springs) if (Math.hypot(x - sp.x, z - sp.z) < sp.r + 1.2 && sp.level - heightAt(def, x, z) > 0.02) return true;
  for (const s of hy.swamps) if (swampQ(s, x, z) < 1.08 && s.level - heightAt(def, x, z) > 0.02) return true;
  return false;
}

/** Physics water of a river in flood, as `WeatherSystem.water` hands it out with the rivers risen by `riseOf`. */
function risenPhysics(x: number, z: number, riseOf: (r: River) => number): number {
  const hy = def.hydro!;
  const base = waterAt(def, x, z);
  if (base && base.kind !== 'river' && base.kind !== 'stream') return base.depth;
  const c = courseAt(hy, x, z, 10);
  if (!c) return base?.depth ?? 0;
  const r = c.river;
  const rise = riseOf(r) * riseTaper(hy, r, Math.min(r.n - 1, c.i + (c.t > 0.5 ? 1 : 0)));
  if (base) return base.depth + rise;
  if (rise <= 0.005) return 0;
  return c.d < c.half + FLOOD_REACH ? spillDepth(def, c, x, z, c.level + rise) : 0;
}

interface RiverScan {
  rows: number;
  pts: number;
  chan: number;
  /** Drawn water outside the channel the ground does not hold (behind a bank, in low ground beyond). */
  spill: number;
  /** Drawn water where the physics has none. */
  phantom: number;
  /** Water the physics has (over 15 cm deep) that is not drawn. */
  invisible: number;
  /** In the channel, water hidden from afar by the far landscape's mesh. */
  farHidden: number;
  /** Drawn water standing over the far mesh outside the channel the ground holds. */
  farSpill: number;
  /** A side of a cross-section whose bank crest stands less than 25 cm over the water. */
  lowBank: number;
  sides: number;
}

function scanRivers(risen: boolean): RiverScan {
  const hy = def.hydro!;
  const rib = riverRibbonGeometry(def)!;
  const g = rib.geometry;
  const pos = g.getAttribute('position');
  const t: RiverScan = { rows: 0, pts: 0, chan: 0, spill: 0, phantom: 0, invisible: 0, farHidden: 0, farSpill: 0, lowBank: 0, sides: 0 };
  const riseOf = (r: River) => (risen ? riverFloodRise(r.kind) : 0);
  for (const c of rib.courses) {
    const r = hy.rivers[c.river];
    const per: Tally = {};
    for (let i = 0; i < r.end; i++) {
      if (!plainSample(def, hy, r, i)) continue;
      t.rows++;
      const base = c.first + i * RIBBON_NX;
      const h = r.half[i];
      const nx = -r.dz[i];
      const nz = r.dx[i];
      const rise = riseOf(r) * riseTaper(hy, r, i);
      const L = r.level[i] + rise;
      const y = pos.getY(base + (RIBBON_NX >> 1)) + rise;
      const reach = Math.abs(g.getAttribute('aFlow').getX(base));
      for (const side of [-1, 1]) {
        let connected = true;
        let crest = -Infinity;
        for (let a = 0; a <= reach; a += 0.25) {
          const u = a * side;
          const at = rowAt(g, base, RIBBON_NX, 'aFlow', 'getX', u);
          const x = r.x[i] + nx * u;
          const z = r.z[i] + nz * u;
          const m = G.mesh(x, z);
          if (a >= h && a <= h + 4) crest = Math.max(crest, heightAt(def, x, z));
          if (a > h && m >= L) connected = false;
          // The shader's tests (near view: rMin is its least).
          const rD = at('aFlow', 'getZ') + rise;
          const bar = rise - at('aRise', 'getZ');
          const fade = at('aFade', 'getX');
          const drawn = rD >= 0.015 && bar >= 0 && fade >= 0.01 && Math.min(1, rD / 0.14) * Math.min(1, bar / 0.03) * fade > 0.05;
          const vis = drawn && y > m + 0.005;
          let wet: number;
          if (risen) wet = risenPhysics(x, z, riseOf);
          else {
            const w = waterAt(def, x, z);
            wet = w && (w.kind === 'river' || w.kind === 'stream') ? w.depth : 0;
          }
          t.pts++;
          if (a < h - 0.25) t.chan++;
          if (vis && a > h && !connected) bump(per, 'spill');
          // (Within a hand's breadth of the waterline the 2 m ground mesh and the exact ground part a little: only drawn water
          // over ground standing clearly above it counts.)
          if (vis && wet < 0.02 && a > h && heightAt(def, x, z) > L + 0.12) {
            bump(per, 'phantom');
          }
          if (wet > 0.15 && !vis && !sheetOver(x, z)) {
            bump(per, 'invisible');
          }
          // From afar the far mesh stands in for the ground; the water rides over it by its lift.
          const fm = G.far(x, z);
          const lifted = y + Math.max(0, at('aFade', 'getY') - rise);
          if (a < h - 0.25 && wet > 0.15 && fm >= lifted) bump(per, 'farHidden');
          if (drawn && a > h && !connected && lifted > fm) bump(per, 'farSpill');
        }
        t.sides++;
        // (Not in the last stretch, where the banks open into what the course runs into.)
        if (!risen && i < r.end - 6 && crest - r.level[i] < 0.25) bump(per, 'lowBank');
      }
    }
    log(`${risen ? 'risen ' : ''}${r.key} ${JSON.stringify(per)}`);
    for (const k of ['spill', 'phantom', 'invisible', 'farHidden', 'farSpill', 'lowBank'] as const) t[k] += per[k] ?? 0;
  }
  log(`${risen ? 'risen ' : ''}ALL ${JSON.stringify(t)}`);
  return t;
}

describe('the water fits the land', () => {
  it('draws the rivers and streams only where the ground holds them, and the physics agrees', () => {
    const t = scanRivers(false);
    expect(t.rows).toBeGreaterThan(2000);
    expect(t.spill / t.pts).toBeLessThan(0.001);
    expect(t.phantom / t.pts).toBeLessThan(0.005);
    expect(t.invisible / t.pts).toBeLessThan(0.005);
    expect(t.farHidden / t.chan).toBeLessThan(0.01);
    expect(t.farSpill / t.pts).toBeLessThan(0.001);
    expect(t.lowBank / t.sides).toBeLessThan(0.005);
  });

  it('spreads a river in flood only over the low ground it can reach, where the physics floods it too', () => {
    const t = scanRivers(true);
    expect(t.spill / t.pts).toBeLessThan(0.001);
    expect(t.phantom / t.pts).toBeLessThan(0.005);
    expect(t.invisible / t.pts).toBeLessThan(0.005);
  });

  it('keeps a flash flood in its wash, drawn where the physics has it, and off the river it runs into', () => {
    const net = def.washes!;
    const hy = def.hydro!;
    const g = floodRibbonGeometry(def, net)!;
    const ones = new Float32Array(2000).fill(1);
    const hgr = { wet: ones, puddle: ones, wash: ones, river: ones, pan: ones };
    const t: Tally = {};
    let v0 = 0;
    for (const w of net.washes) {
      const per: Tally = {};
      const rows = Math.min(w.n - 1, w.end + 6) + 1;
      for (let i = 0; i < rows; i++) {
        const base = v0 + i * FLOOD_NX;
        const nx = -w.dz[i];
        const nz = w.dx[i];
        const reach = Math.abs(g.getAttribute('aWash').getY(base));
        const stage = floodStage(net, w, w.s[i], 0.5, hgr);
        for (const side of [-1, 1]) {
          let behind = -Infinity;
          for (let a = 0; a <= reach; a += 0.25) {
            const u = a * side;
            const at = rowAt(g, base, FLOOD_NX, 'aWash', 'getY', u);
            // The flood's shader at a full flood (the hydrograph texture all ones).
            const st = Math.min(at('aWash', 'getW') * (1 - 0.35 * Math.min(1, at('aWash', 'getX') / w.len)), at('aWash3', 'getX')) * at('aWash3', 'getY');
            const d = st - at('aWash', 'getZ');
            const bar = st - at('aWash3', 'getZ');
            const fade = at('aWash2', 'getW');
            const x = w.x[i] + nx * u;
            const z = w.z[i] + nz * u;
            const y = w.bed[i] + st;
            const vis = d >= 0.012 && bar >= 0 && fade >= 0.02 && st / Math.max(0.3, w.flood) >= 0.015 && y > G.mesh(x, z) + 0.005;
            const ph = floodAt(def, net, x, z, 0.5, hgr, () => 0);
            const wet = ph && ph.kind === 'flood' ? ph.depth : 0;
            bump(per, 'pts');
            // Ten centimetres of water drawn where the physics has none.
            if (vis && wet < 0.02 && d > 0.1) bump(per, 'phantom');
            if (wet > 0.15 && !vis) bump(per, 'invisible');
            const c = courseAt(hy, x, z);
            if (vis && c && c.d < c.half + 0.5) bump(per, 'overRiver');
            // Still drawn at the far edge of the ribbon: the flood has topped the banks and is cut off by the ribbon's edge.
            if (vis && a > reach - 0.25) bump(per, 'edge');
            // Drawn behind a bank that stands over it: spilled out of the wash.
            if (a > w.half[i]) {
              if (vis && behind > y + 0.1) bump(per, 'overBank');
              behind = Math.max(behind, heightAt(def, x, z));
            }
          }
        }
      }
      v0 += rows * FLOOD_NX;
      log(`wash ${w.key} ${JSON.stringify(per)}`);
      for (const [k, n] of Object.entries(per)) bump(t, k, n);
    }
    log(`wash ALL ${JSON.stringify(t)}`);
    expect(t.pts).toBeGreaterThan(10000);
    expect((t.phantom ?? 0) / t.pts).toBeLessThan(0.005);
    expect((t.invisible ?? 0) / t.pts).toBeLessThan(0.005);
    expect(t.overRiver ?? 0).toBe(0);
    expect((t.overBank ?? 0) / t.pts).toBeLessThan(0.001);
    expect(t.edge ?? 0).toBe(0);
  });

  it('leaves no two sheets of water within a hair of each other', () => {
    // Where a course runs into a lake or out of a spring pool the ribbon fades out under that sheet: wherever both draw and
    // the ribbon still shows, it lies clearly under the sheet.
    const hy = def.hydro!;
    const rib = riverRibbonGeometry(def)!;
    const g = rib.geometry;
    const pos = g.getAttribute('position');
    const fade = g.getAttribute('aFade');
    let both = 0;
    let close = 0;
    for (const c of rib.courses) {
      const r = hy.rivers[c.river];
      for (let i = 0; i < c.rows; i++) {
        for (let k = 0; k < RIBBON_NX; k++) {
          const v = c.first + i * RIBBON_NX + k;
          if (fade.getX(v) < 0.02) continue;
          const x = pos.getX(v);
          const z = pos.getZ(v);
          let other: number | null = null;
          if (r.into.kind === 'lake') {
            const w = lakeWater([def.lakes[r.into.ref]], x, z);
            if (w && w.depth > 0.05) other = w.level;
          }
          if (r.spring >= 0) {
            const sp = hy.springs[r.spring];
            if (Math.hypot(x - sp.x, z - sp.z) < sp.r + 1.2 && sp.level - heightAt(def, x, z) > 0.05) other = sp.level;
          }
          if (other === null) continue;
          both++;
          if (other - pos.getY(v) < 0.01 && fade.getX(v) > 0.2) close++;
        }
      }
    }
    log(`sheets both=${both} close=${close}`);
    expect(close).toBe(0);
  });
});
