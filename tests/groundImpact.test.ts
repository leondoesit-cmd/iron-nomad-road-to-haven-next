import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import './helpers/sim';
import { GEAR } from '../src/data';
import { AMMO, ammoForGun, type AmmoKind } from '../src/sim/ballistics';
import { groundImpact, type GroundMaterial } from '../src/sim/groundImpact';
import { skipOf } from '../src/sim/weaponfx';
import { PhysicsWorld, initPhysics } from '../src/physics/physics';
import { Combat } from '../src/game/combat';
import { Gore } from '../src/game/gore';
import { Arrows } from '../src/game/arrows';
import { Projectiles } from '../src/game/projectiles';
import { Particles } from '../src/render/particles';
import type { Ctx } from '../src/game/ctx';
import { Rng } from '../src/core/rng';
import { Player } from '../src/game/player';
import { MELEE } from '../src/sim/weaponfx';

beforeAll(initPhysics);

function scene(material: GroundMaterial = 'hardpan', dry = 1) {
  const P = new PhysicsWorld();
  P.addHeightfield(-20, -20, 40, 2, new Float32Array(9));
  P.step();
  const ctx = {
    P, root: new THREE.Group(), fx: new Particles(), audio: { play: vi.fn() }, time: 0, storm: 0, rng: new Rng(42),
    groundAt: () => 0, drawnGroundAt: () => 0, groundDust: () => dry,
    surfaceAt: () => ({ name: material }), waterAt: () => null,
    vehicleByCollider: new Map(), obs: { near: () => {}, pointInside: () => false },
    zombies: { rayTest: () => null, forEachNear: () => {}, blast: () => {}, burnArea: () => {} },
    wildlife: { rayTest: () => null, blast: () => {}, burnArea: () => {} },
    raiders: { infantryRayTest: () => null, crewRayTest: () => null, forEachTarget: () => {}, blast: () => {}, burnArea: () => {} },
    travellers: { rayTest: () => null, heardShot: () => {}, blast: () => {}, burnArea: () => {} },
    players: [], vehicles: [], sig: { emit: () => {} }, signatureMult: 1,
    tracers: { add: vi.fn() }, campaign: { items: { arrow: 0 } },
  } as unknown as Ctx;
  ctx.gore = new Gore(ctx);
  ctx.arrows = new Arrows(ctx);
  ctx.combat = new Combat(ctx);
  ctx.projectiles = new Projectiles(ctx);
  const dispose = () => {
    ctx.gore.dispose(); ctx.arrows!.dispose();
    for (const layer of [ctx.fx.smoke, ctx.fx.glow]) {
      layer.points.geometry.dispose(); (layer.points.material as THREE.Material).dispose();
    }
    P.world.free();
  };
  return { ctx, dispose };
}

describe('weapon-specific ground disturbance', () => {
  it('covers every gun and melee model in the catalogue with finite, bounded effects', () => {
    for (const item of GEAR.items) {
      const weapon = item.gun ? ammoForGun(item.gun.model) : item.melee?.model;
      if (!weapon) continue;
      const speed = item.gun ? AMMO[weapon as AmmoKind].speed : 1;
      for (const material of ['asphalt', 'sand', 'hardpan', 'mud', 'stone', 'concrete'] as const) {
        const f = groundImpact(weapon, material, speed, 0.8);
        for (const value of [f.power, f.size, f.dust, f.eject, f.chips]) expect(Number.isFinite(value), item.id).toBe(true);
        expect(f.size).toBeLessThan(0.4);
        expect(f.chips).toBeLessThanOrEqual(10);
      }
    }
  });

  it('pellets make separate small strikes; rifles displace more soil than pistol ammunition', () => {
    const hit = (kind: AmmoKind) => groundImpact(kind, 'sand', AMMO[kind].speed, 1);
    expect(hit('pellet').size).toBeLessThan(hit('pistol').size);
    expect(hit('pellet').dust).toBeLessThan(hit('pistol').dust);
    expect(hit('rifle').dust).toBeGreaterThan(hit('pistol').dust);
    expect(hit('rifle').chips).toBeGreaterThan(hit('pistol').chips);
    expect(hit('rifle').size).toBeGreaterThan(hit('carbine').size);
  });

  it('spent rounds and grazing hits raise less soil, with a longer glancing mark', () => {
    const direct = groundImpact('rifle', 'sand', 520, 1);
    const spent = groundImpact('rifle', 'sand', 130, 1);
    const grazing = groundImpact('rifle', 'sand', 520, 0.05);
    expect(spent.dust).toBeLessThan(direct.dust);
    expect(spent.size).toBeLessThan(direct.size);
    expect(grazing.dust).toBeLessThan(direct.dust);
    expect(grazing.stretch).toBeGreaterThan(direct.stretch);
  });

  it('mud and wet earth throw clods without a dry dust cloud; heavy tools disturb more than a knife', () => {
    expect(groundImpact('rifle', 'mud', 520, 1).dust).toBe(0);
    expect(groundImpact('rifle', 'sand', 520, 1, 0).dust).toBe(0);
    expect(groundImpact('sledge', 'hardpan', 1, 1).power).toBeGreaterThan(groundImpact('knife', 'hardpan', 1, 1).power);
    for (const kind of ['arrow', 'bolt', 'pellet'] as const) {
      expect(groundImpact(kind, 'asphalt', AMMO[kind].speed, 1).sparks).toBe(0);
      expect(skipOf(kind, 'concrete', 150, [0, -0.1, 0.995], [0, 1, 0], 0, [0, 0, 0])).toBeNull();
    }
  });
});

describe('impacts through real physics and render pools', () => {
  it('every ballistic type hits soil once, stops, leaves a small mark, and never sparks', () => {
    const { ctx, dispose } = scene();
    try {
      const impacts: string[] = [];
      ctx.combat.onImpact = e => impacts.push(e.surface);
      const spark = vi.spyOn(ctx.fx, 'spark');
      for (const kind of Object.keys(AMMO) as AmmoKind[]) {
        ctx.combat.shoot(0, 2, 0, 0, -1, 0, { side: 'convoy', damage: 100, ammo: kind, range: 30, tracer: false });
        for (let i = 0; i < 30 && ctx.combat.bullets.length; i++) ctx.combat.update(1 / 60);
        expect(ctx.combat.bullets).toHaveLength(0);
      }
      expect(impacts).toEqual(Object.keys(AMMO).map(() => 'dirt'));
      expect(ctx.gore.marks.count).toBe(Object.keys(AMMO).length);
      expect(spark).not.toHaveBeenCalled();
      expect(ctx.arrows!.stuck.some(s => s.bolt)).toBe(true);
      expect(ctx.arrows!.stuck.some(s => !s.bolt)).toBe(true);
    } finally { dispose(); }
  });

  it('paved terrain chips and stops the round; mud emits no smoke particles', () => {
    const road = scene('asphalt');
    const mud = scene('mud');
    try {
      const seen: string[] = [];
      road.ctx.combat.onImpact = e => { seen.push(e.surface); expect(e.penetrated).toBe(false); };
      road.ctx.combat.shoot(0, 2, 0, 0, -1, 0, { side: 'convoy', damage: 80, ammo: 'rifle', tracer: false });
      road.ctx.combat.update(1 / 60);
      expect(seen).toEqual(['concrete']);
      expect(road.ctx.audio.play).toHaveBeenCalledWith('chip', expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Object));
      const smoke = vi.spyOn(mud.ctx.fx.smoke, 'emit');
      mud.ctx.gore.groundStrike('rifle', 'mud', 0, 0, 0, 0, 1, 0, 0, -1, 0, 520);
      expect(smoke).not.toHaveBeenCalled();
      expect(mud.ctx.gore.gibs.counts().chunk).toBeGreaterThan(0);
    } finally { road.dispose(); mud.dispose(); }
  });

  it('a molotov breaks into glass and flame without an explosive blast', () => {
    const { ctx, dispose } = scene();
    try {
      const explosion = vi.spyOn(ctx.fx, 'explosion');
      ctx.projectiles.throw('molotov', 0, 0.1, 0, 0, -1, 0, null);
      ctx.projectiles.update(1 / 60);
      expect(ctx.projectiles.burners[0].kind).toBe('fire');
      expect(ctx.gore.gibs.counts().shard).toBe(8);
      expect(explosion).not.toHaveBeenCalled();
      expect(ctx.audio.play).not.toHaveBeenCalledWith('boom', expect.anything(), expect.anything(), expect.anything());
    } finally { dispose(); }
  });

  it('a downward melee swing strikes reachable terrain; a level swing does not disturb it', () => {
    const { ctx, dispose } = scene();
    try {
      for (const system of [ctx.zombies, ctx.wildlife, ctx.raiders, ctx.travellers]) system.meleeHit = () => 0;
      ctx.phantoms = { onSwing: () => {} } as unknown as Ctx['phantoms'];
      const pending = () => ({ t: 0, dmg: 85, reach: 2.1, yaw: 0, feel: MELEE.axe, cut: 1.5, model: 'axe' });
      const actor = {
        ctx, state: 'foot', pos: new THREE.Vector3(), swingFeel: null, swingT: 0, swingPend: pending(),
        smashGlass: () => {}, meleeWeapon: () => ({ model: 'axe' }), cam: { addShake: vi.fn() },
        computeAim: () => ({ dx: 0, dy: -1, dz: 0 }), hitStop: 0,
      };
      const strike = vi.spyOn(ctx.gore, 'groundStrike');
      const update = (Player.prototype as unknown as { updateSwing(dt: number): void }).updateSwing;
      update.call(actor, 1 / 60);
      expect(strike).toHaveBeenCalledOnce();
      expect(strike.mock.calls[0][0]).toBe('axe');
      expect(actor.hitStop).toBe(MELEE.axe.hitStop);
      actor.swingPend = pending();
      actor.computeAim = () => ({ dx: 0, dy: 0, dz: 1 });
      update.call(actor, 1 / 60);
      expect(strike).toHaveBeenCalledOnce();
    } finally { dispose(); }
  });

  it('debris and dust leave a sloped ground surface instead of travelling into it', () => {
    const { ctx, dispose } = scene();
    try {
      const emit = vi.spyOn(ctx.fx.smoke, 'emit');
      const fragments = vi.spyOn(ctx.gore.gibs, 'throw');
      const n = [0.8, 0.6, 0];
      ctx.gore.groundStrike('rifle', 'sand', 0, 0, 0, ...n as [number, number, number], -0.8, -0.6, 0, 520);
      expect(emit).toHaveBeenCalled();
      for (const args of emit.mock.calls) expect(args[3] * n[0] + args[4] * n[1]).toBeGreaterThan(0);
      for (const args of fragments.mock.calls) expect(args[4] * n[0] + args[5] * n[1]).toBeGreaterThan(0);
      const matrix = new THREE.Matrix4();
      ctx.gore.marks.mesh.getMatrixAt(0, matrix);
      const normal = new THREE.Vector3().setFromMatrixColumn(matrix, 2).normalize();
      expect(normal.dot(new THREE.Vector3(...n))).toBeCloseTo(1);
    } finally { dispose(); }
  });

  it('submerged thrown fire does not burn the river bed', () => {
    const { ctx, dispose } = scene();
    try {
      ctx.waterAt = () => ({ depth: 2, level: 2 });
      for (const kind of ['flare', 'molotov'] as const) {
        ctx.projectiles.throw(kind, 0, 2.1, 0, 0, -10, 0, null);
        ctx.projectiles.update(1 / 60);
      }
      // Nothing burns on the bed: a flare burns on under the water, and a bottle's fuel floats and burns on the surface.
      expect(ctx.projectiles.burners.every((b) => b.water)).toBe(true);
      expect(ctx.gore.marks.count).toBe(0);
    } finally { dispose(); }
  });

  it('ground explosions throw debris; high airbursts leave no ground scorch', () => {
    const { ctx, dispose } = scene();
    try {
      ctx.gore.groundBlast(0, 10, 0, 5, 260);
      expect(ctx.gore.marks.count).toBe(0);
      expect(ctx.gore.gibs.counts().chunk).toBe(0);
      ctx.gore.groundBlast(0, 1, 0, 5, 260);
      expect(ctx.gore.marks.count).toBe(2);
      expect(ctx.gore.gibs.counts().chunk).toBeGreaterThan(0);
    } finally { dispose(); }
  });
});
