import { describe, expect, it } from 'vitest';
import { blastCrater, crater, plateSinkage, SOILS, talus, wheelSinkage, G } from '../src/sim/soil';
import { DCELL, GroundField, type Press } from '../src/sim/groundField';
import { AMMO } from '../src/sim/ballistics';

const sand = SOILS.sand;
const field = (soil = sand) => new GroundField({ soilAt: () => soil });

/** A tyre pressed down a straight run along +z, one physics step at a time. */
function roll(f: GroundField, o: { x: number; z0: number; z1: number; W: number; b: number; r: number; pass: number; soil?: typeof sand; speed?: number }) {
  const s = o.soil ?? sand;
  const { p, z } = wheelSinkage(s, o.W, o.b, o.r, o.speed ?? 3);
  const halfL = Math.min(0.15, Math.sqrt(2 * o.r * 1.5 * z));
  const step = 0.06;
  let fresh = 0;
  const mid = (o.z0 + o.z1) / 2;
  for (let zz = o.z0; zz < o.z1; zz += step) {
    const res = f.press({ ax: o.x, az: zz, bx: o.x, bz: zz + step, fx: 0, fz: 1, halfW: o.b / 2, halfL, p, soil: s, pass: o.pass });
    // What it was cutting halfway along (at the end it runs out onto fresh ground again).
    if (zz <= mid && zz + step > mid) fresh = res.fresh;
  }
  return { z, fresh };
}

describe('soil rules', () => {
  it('sink a tyre by its load: a lorry deeper than a car, a car deeper than a moped on the same tyre', () => {
    const car = wheelSinkage(sand, 1400 * G * 0.25, 0.2, 0.33).z;
    const lorry = wheelSinkage(sand, 9000 * G * 0.25, 0.3, 0.5).z;
    const light = wheelSinkage(sand, 400 * G * 0.25, 0.2, 0.33).z;
    expect(car).toBeGreaterThan(0.025);
    expect(car).toBeLessThan(0.07);
    expect(lorry).toBeGreaterThan(car * 1.6);
    expect(light).toBeLessThan(car * 0.6);
    // Firm ground carries the same car on a few millimetres.
    expect(wheelSinkage(SOILS.loam, 1400 * G * 0.25, 0.2, 0.33).z).toBeLessThan(0.012);
    expect(wheelSinkage(SOILS.clay, 1400 * G * 0.25, 0.2, 0.33).z).toBeLessThan(0.002);
    // Fast over sand, a tyre has no time to sink as far.
    expect(wheelSinkage(sand, 1400 * G * 0.25, 0.2, 0.33, 20).z).toBeLessThan(car * 0.7);
  });

  it('leave a boot print of a centimetre or two in sand and none in hardpan', () => {
    const p = (80 * G * 1.3) / (0.1 * 0.26);
    const z = plateSinkage(sand, p, 0.1);
    expect(z).toBeGreaterThan(0.008);
    expect(z).toBeLessThan(0.03);
    expect(p).toBeLessThan(SOILS.loam.crust);
  });

  it('dig a crater by the round\'s energy: a rifle bigger than a pistol, a grazing hit long and shallow', () => {
    const e = (k: keyof typeof AMMO) => 0.5 * AMMO[k].mass * AMMO[k].speed ** 2;
    const pistol = crater(sand, e('pistol'), 1);
    const rifle = crater(sand, e('rifle'), 1);
    expect(rifle.volume).toBeGreaterThan(pistol.volume * 3);
    // A round shallow dish in sand: a hand across for a pistol, a forearm for a rifle, a few centimetres deep.
    expect(pistol.across * 2).toBeGreaterThan(0.08);
    expect(pistol.across * 2).toBeLessThan(0.2);
    expect(rifle.across * 2).toBeGreaterThan(0.18);
    expect(rifle.across * 2).toBeLessThan(0.34);
    expect(rifle.depth / rifle.across).toBeLessThan(0.25);
    // Sand stays round even for a glancing round; packed earth is gouged long, and deeper downrange.
    const sandGraze = crater(sand, e('rifle'), 0.25);
    const earthGraze = crater(SOILS.loam, e('rifle'), 0.25);
    expect(sandGraze.along / sandGraze.across).toBeLessThan(1.5);
    expect(earthGraze.along / earthGraze.across).toBeGreaterThan(2);
    expect(earthGraze.asym).toBeGreaterThan(sandGraze.asym);
    // Packed earth: a hole, deeper for its width than sand's dish.
    const earth = crater(SOILS.loam, e('rifle'), 1);
    expect(earth.depth / earth.across).toBeGreaterThan(rifle.depth / rifle.across * 2);
    const graze = crater(SOILS.loam, e('rifle'), 0.15);
    expect(graze.along / graze.across).toBeGreaterThan(1.8);
    expect(graze.depth).toBeLessThan(earth.depth);
    expect(graze.shift).toBeGreaterThan(0);
    // Packed earth is harder to dig than sand, dry clay crust harder again.
    expect(crater(SOILS.loam, e('rifle'), 1).volume).toBeLessThan(rifle.volume * 0.8);
    expect(crater(SOILS.clay, e('rifle'), 1).volume).toBeLessThan(crater(SOILS.loam, e('rifle'), 1).volume * 0.5);
    const mine = blastCrater(sand, 8e5);
    expect(mine.across * 2).toBeGreaterThan(1);
    expect(mine.depth).toBeLessThanOrEqual(0.6);
  });
});

describe('the ground field', () => {
  it('presses a rut as deep as the tyre sinks, with berms either side, and keeps the volume', () => {
    const f = field();
    const { z } = roll(f, { x: 0.5, z0: 0, z1: 3, W: 1400 * G * 0.25, b: 0.2, r: 0.33, pass: 1 });
    const floor = f.heightAt(0.5, 1.5);
    expect(floor).toBeLessThan(-z * 0.8);
    expect(floor).toBeGreaterThan(-z * 1.2);
    // Berms just outside the tread on both sides.
    const bermL = Math.max(...[0.62, 0.64, 0.66, 0.68].map((x) => f.heightAt(x, 1.5)));
    const bermR = Math.max(...[0.32, 0.34, 0.36, 0.38].map((x) => f.heightAt(x, 1.5)));
    expect(bermL).toBeGreaterThan(0.004);
    expect(bermR).toBeGreaterThan(0.004);
    // What went down was packed or pushed aside: nothing is made or lost.
    expect(Math.abs(f.volume() + f.packed)).toBeLessThan(1e-7);
  });

  it('remembers how hard it has been pressed: the same load again barely deepens a rut, a heavier one does', () => {
    const f = field();
    const car = { x: 0.5, z0: 0, z1: 3, W: 1400 * G * 0.25, b: 0.2, r: 0.33 };
    const first = roll(f, { ...car, pass: 1 });
    const d1 = -f.heightAt(0.5, 1.5);
    const again = roll(f, { ...car, pass: 2 });
    const d2 = -f.heightAt(0.5, 1.5);
    expect(d2 - d1).toBeLessThan(d1 * 0.2);
    expect(again.fresh).toBeLessThan(first.fresh * 0.3);
    roll(f, { ...car, W: 9000 * G * 0.25, pass: 3 });
    expect(-f.heightAt(0.5, 1.5)).toBeGreaterThan(d2 * 1.5);
  });

  it('digs a crater and hands back what it throws, the rest heaped on the rim or packed', () => {
    const f = field();
    const c = crater(sand, 0.5 * AMMO.rifle.mass * AMMO.rifle.speed ** 2, 0.9);
    const thrown = f.crater(1, 1, 0, 1, c, sand);
    expect(f.heightAt(1, 1 + c.shift)).toBeLessThan(-c.depth * 0.6);
    expect(thrown).toBeCloseTo(c.volume * c.eject, 9);
    expect(Math.abs(f.volume() + f.packed + thrown)).toBeLessThan(1e-8);
    // Thrown soil comes down again: the volume is whole once it has landed.
    f.deposit(1.4, 1.8, thrown, 0.12, sand);
    expect(Math.abs(f.volume() + f.packed)).toBeLessThan(1e-8);
  });

  it('lets a heap too steep for sand slump to its angle of repose, keeping the volume', () => {
    const f = field();
    f.deposit(3, 3, 0.002, 0.05, sand);
    const v0 = f.volume();
    for (let k = 0; k < 400 && f.settling; k++) f.relax(1e6);
    expect(f.settling).toBe(0);
    expect(Math.abs(f.volume() - v0)).toBeLessThan(1e-9);
    let steepest = 0;
    for (let iz = 60; iz < 90; iz++) {
      for (let ix = 60; ix < 90; ix++) steepest = Math.max(steepest, Math.abs(f.hAt(ix + 1, iz) - f.hAt(ix, iz)));
    }
    expect(steepest).toBeLessThan(talus(sand, DCELL) * 1.15);
  });

  it('a spinning tyre digs only down to the firm ground under the sand', () => {
    const f = field();
    let dug = 0;
    for (let k = 0; k < 600; k++) dug += f.dig(0, 0, 0, 1, 0.1, 0.12, 0.002, sand);
    expect(f.heightAt(0, 0)).toBeGreaterThanOrEqual(-sand.floor - 1e-6);
    // Float32 heights: the books balance to a hundred-thousandth of what was dug.
    expect(Math.abs(f.volume() + dug)).toBeLessThan(dug * 1e-5);
  });

  it('tells a wheel in a rut which way its walls lean', () => {
    const f = field();
    roll(f, { x: 0.5, z0: 0, z1: 3, W: 1400 * G * 0.25, b: 0.2, r: 0.33, pass: 1 });
    for (let k = 0; k < 200 && f.settling; k++) f.relax(1e6);
    const out = { h: 0, hi: 0, gx: 0, gz: 0 };
    // A wheel a little left of the rut (+x) is on its wall: the ground falls away toward the rut, to -x.
    f.under(0.6, 1.5, 0, 1, 0.1, 0.1, out);
    expect(out.gx).toBeGreaterThan(0.02);
    f.under(0.5, 1.5, 0, 1, 0.1, 0.1, out);
    const z = wheelSinkage(sand, 1400 * G * 0.25, 0.2, 0.33, 3).z;
    expect(out.h).toBeLessThan(-z * 0.75);
  });

  it('keeps a snapshot from one day to the next, filled in a little by the wind each night', () => {
    const f = field();
    roll(f, { x: 0.5, z0: 0, z1: 2, W: 1400 * G * 0.25, b: 0.2, r: 0.33, pass: 1 });
    const d = f.heightAt(0.5, 1);
    const g = field();
    g.restore(f.snapshot(), 0);
    expect(g.heightAt(0.5, 1)).toBeCloseTo(d, 3);
    g.restore(f.snapshot(), 1);
    expect(g.heightAt(0.5, 1)).toBeCloseTo(d * 0.75, 3);
  });
});

describe('a load', () => {
  it('presses a boot print with its soil pushed out all round', () => {
    const f = field();
    const p = (80 * G * 1.3) / (0.1 * 0.26);
    const o: Press = { ax: 0, az: 0, bx: 0, bz: 0, fx: 0, fz: 1, halfW: 0.05, halfL: 0.13, p, soil: sand, pass: 9, left: 0.5, ahead: 0.25, behind: 0.25 };
    f.press(o);
    expect(f.heightAt(0, 0)).toBeLessThan(-0.008);
    expect(Math.abs(f.volume() + f.packed)).toBeLessThan(1e-8);
  });
});
