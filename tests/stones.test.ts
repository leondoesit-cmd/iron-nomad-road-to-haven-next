import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { stoneHit } from '../src/game/stones';
import { Sparks } from '../src/render/sparks';
import { AMMO } from '../src/sim/ballistics';
import type { StoneTarget } from '../src/physics/physics';
import type { Ctx } from '../src/game/ctx';

// A round into a stone lying about: a small one splits (into smaller pieces the harder the blow), a bigger one only chips,
// one too big to split but light enough is knocked off its place, and the rest of its cluster lies loose. Sparks are
// always small: a blow changes how many and which way.

/** One pebble cluster (variant 0) at the origin, `scale` times its drawn size, and a scene that records what it was sent. */
function setup(scale: number) {
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 1);
  im.setMatrixAt(0, new THREE.Matrix4().makeScale(scale, scale, scale));
  let removed = 0;
  const t: StoneTarget = { im, i: 0, kind: 'pebble', v: 0, remove: () => removed++ };
  const gibs: { size: number }[] = [];
  const loose: { vel: THREE.Vector3; keep?: boolean }[] = [];
  const ctx = {
    gore: { gibs: { throw: (...a: number[]) => gibs.push({ size: a[7] }) }, spall: () => 0.02 },
    debris: { spawn: (o: { vel: THREE.Vector3; keep?: boolean }) => loose.push(o) },
    ground: { grit() {} },
    fx: { puff() {} },
    audio: { play() {} },
  };
  return { t, ctx: ctx as unknown as Ctx, gibs, loose, removed: () => removed };
}

const ke = (k: keyof typeof AMMO) => 0.5 * AMMO[k].mass * AMMO[k].speed ** 2;
const mom = (k: keyof typeof AMMO) => AMMO[k].mass * AMMO[k].speed;
/** Straight down onto the middle stone of the cluster. */
const down = (s: ReturnType<typeof setup>, k: keyof typeof AMMO, glance = 0) =>
  stoneHit(s.ctx, s.t, 0, 0.05, 0, 0, 1, 0, Math.sin(glance), -Math.cos(glance), 0, ke(k), mom(k));

describe('a round into a stone', () => {
  it('splits a small one into pieces, the rest of its cluster left lying loose', () => {
    const s = setup(0.5);
    expect(down(s, 'pistol').did).toBe('shattered');
    expect(s.removed()).toBe(1);
    expect(s.gibs.length).toBeGreaterThanOrEqual(3);
    // The other two stones of the cluster, kept, at rest.
    expect(s.loose.length).toBe(2);
    for (const l of s.loose) {
      expect(l.keep).toBe(true);
      expect(l.vel.length()).toBe(0);
    }
  });

  it('breaks it into more and smaller pieces the harder the blow', () => {
    const p = setup(0.5);
    down(p, 'pistol');
    const r = setup(0.5);
    down(r, 'rifle');
    expect(r.gibs.length).toBeGreaterThan(p.gibs.length);
    expect(Math.max(...r.gibs.map((g) => g.size))).toBeLessThan(Math.max(...p.gibs.map((g) => g.size)));
  });

  it('only chips a stone too big for the blow, and a glancing round splits less than a square one', () => {
    expect(down(setup(1.5), 'pistol').did).toBe('chipped');
    expect(down(setup(1.5), 'rifle').did).toBe('shattered');
    expect(down(setup(1.5), 'rifle', 1.35).did).toBe('chipped');
  });

  it('knocks a stone it cannot split but can shift off its place', () => {
    const s = setup(0.7);
    // A pistol round grazing a stone a hand and a half across: too little of the blow goes into it to split it, but the
    // round's momentum carries it off.
    const r = down(s, 'pistol', 1.5);
    expect(r.did).toBe('knocked');
    const moved = s.loose.filter((l) => l.vel.length() > 0.1);
    expect(moved.length).toBe(1);
    expect(s.loose.length).toBe(3);
  });

  it('leaves boulders to chip', () => {
    const s = setup(1);
    s.t.kind = 'boulder';
    expect(down(s, 'sniper').did).toBe('chipped');
    expect(s.removed()).toBe(0);
  });
});

describe('sparks', () => {
  it('leave a glancing blow in a tight fan along the glance and a square one in a wide splash', () => {
    const spread = (ux: number, uy: number, uz: number, cone: number) => {
      const sp = new Sparks(400);
      sp.shower(0, 0, 0, ux, uy, uz, 300, 8, cone);
      sp.update(1e-3);
      // Mean direction of the streaks' heads from the origin.
      const pos = (sp.lines.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (let i = 0; i < sp.count; i++) {
        const l = Math.hypot(pos[i * 6], pos[i * 6 + 1], pos[i * 6 + 2]) || 1;
        mx += pos[i * 6] / l;
        my += pos[i * 6 + 1] / l;
        mz += pos[i * 6 + 2] / l;
      }
      return Math.hypot(mx, my, mz) / sp.count;
    };
    // A tight fan holds together far better than a wide splash.
    expect(spread(1, 0.1, 0, 0.25)).toBeGreaterThan(0.95);
    expect(spread(0, 1, 0, 1.25)).toBeLessThan(0.85);
  });

  it('are streaks a pixel wide however many: only the count grows', () => {
    const sp = new Sparks(100);
    sp.shower(0, 0, 0, 0, 1, 0, 5, 6, 1);
    sp.update(1 / 60);
    expect(sp.count).toBe(5);
    expect(sp.lines.material).toBeInstanceOf(THREE.LineBasicMaterial);
    sp.shower(0, 0, 0, 0, 1, 0, 50, 6, 1);
    expect(sp.count).toBe(55);
  });
});
