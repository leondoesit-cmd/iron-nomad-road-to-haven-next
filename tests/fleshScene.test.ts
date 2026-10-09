import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { limbsGone } from '../src/sim/ballistics';
import { MELEE } from '../src/sim/weaponfx';
import { CHAINS, legsUseless } from '../src/sim/flesh';
import { fakeServices } from './helpers/sim';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics();
});

function scene() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  for (const p of sc.players) p.exitVehicle(false);
  for (let i = 0; i < 18; i++) sc.tick(DT);
  sc.zombies.list.length = 0;
  sc.wildlife.list.length = 0;
  return { sc, p: sc.players[0] };
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

/** A zombie standing `d` metres in front of the player (who faces +z), facing back at the player, asleep so it stays put. */
function facing(sc: LegScene, p: LegScene['players'][number], d = 1.3) {
  const zb = sc.zombies.spawn('walker', p.pos.x, p.pos.z + d, true);
  zb.y = sc.groundAt(zb.x, zb.z);
  zb.yaw = Math.PI;
  zb.hp = 5000;
  return zb;
}

/** Point the player's eyes at a height on the body in front of it. */
function look(p: LegScene['players'][number], zb: { y: number; def: { radius: number } }, height: number, d = 1.3) {
  const reach = d - zb.def.radius * 0.5;
  p.aimPitch = Math.atan2(zb.y + height - (p.pos.y + 1.6), reach);
}

function swing(sc: LegScene, p: LegScene['players'][number], model: 'katana' | 'axe' | 'bat' | 'machete' | 'sledge', dmg: number, cut: number) {
  return sc.zombies.meleeHit(p, p.pos.x, p.pos.z + 1, 0, 2.1, dmg, MELEE[model], cut, model);
}

// Each test builds a real leg scene: give them room when other test runs share the machine.
describe('the flesh engine in a scene', { timeout: 120_000 }, () => {
  it('a rifle round through the belly spills the gut, and it hangs from the body down to the ground', () => {
    const { sc, p } = scene();
    const zb = facing(sc, p, 6);
    const from = { x: zb.x, y: zb.y + 1.08, z: zb.z - 10 };
    sc.combat.shoot(from.x, from.y, from.z, 0, 0, 1, { side: 'convoy', damage: 80, range: 60, ammo: 'rifle', tracer: false, headshots: false });
    run(sc, 0.3);
    expect(zb.flesh?.spilled).toBe(true);
    const fx = sc.gore.anatomy;
    expect(fx.ropes.length).toBeGreaterThanOrEqual(2);
    run(sc, 2.5);
    const ground = sc.groundAt(zb.x, zb.z);
    for (const r of fx.ropes) {
      // Still hanging from it, and the far end lying on the ground near its feet.
      expect(r.attached).toBe(true);
      expect(Math.hypot(r.x[0] - zb.x, r.z[0] - zb.z)).toBeLessThan(0.5);
      expect(r.y[r.n - 1]).toBeLessThan(ground + 0.15);
    }
  });

  it('a katana swung at the waist cuts a walker in two: the legs fall away as a piece', () => {
    const { sc, p } = scene();
    const zb = facing(sc, p);
    look(p, zb, 1.08);
    expect(swing(sc, p, 'katana', 72, 1.3)).toBe(1);
    expect(zb.flesh!.cut[CHAINS.indexOf('waist')]).toBeGreaterThan(0.9);
    expect(legsUseless(zb.flesh!)).toBe(2);
    expect(limbsGone(zb.wounds.mask).legs).toBe(2);
    const legs = sc.gore.anatomy.pieces.find((q) => q.chain === CHAINS.indexOf('waist'));
    expect(legs).toBeDefined();
    run(sc, 3);
    // It lies on the ground, not in it and not above it.
    const g = sc.groundAt(legs!.pos.x, legs!.pos.z);
    expect(legs!.pos.y).toBeGreaterThan(g);
    expect(legs!.pos.y).toBeLessThan(g + 0.4);
  });

  it('a bat to the head caves the skull in and that is the end of it, whatever it had left', () => {
    const { sc, p } = scene();
    const zb = facing(sc, p);
    look(p, zb, 1.72);
    swing(sc, p, 'bat', 48, 0);
    expect(zb.flesh!.head).toBe('crushed');
    expect(zb.dead).toBe(true);
  });

  it('a bat to the shin snaps it: the body goes down and limps after', () => {
    const { sc, p } = scene();
    const zb = facing(sc, p);
    look(p, zb, 0.32);
    swing(sc, p, 'bat', 48, 0);
    const f = zb.flesh!;
    expect(f.bone[6] + f.bone[7]).toBeGreaterThanOrEqual(1);
    expect(zb.moveMult).toBeLessThan(0.6);
    expect(zb.stun).toBeGreaterThan(0.8);
  });

  it('an axe at the arm takes it off where it struck, and the arm is thrown', () => {
    const { sc, p } = scene();
    const zb = facing(sc, p);
    // Facing back at the player, its left arm is on the player's right (-x... the body's +x turned half round).
    zb.yaw = Math.PI;
    look(p, zb, 1.05);
    // Swing a little to the side so the blow lands on the arm, not the chest.
    const n = sc.zombies.meleeHit(p, p.pos.x, p.pos.z + 1, 0, 2.1, 85, MELEE.axe, 1.5, 'axe', (z) => ({
      x: z.x + 0.23, y: z.y + 1.05, z: z.z - 0.05, dx: -0.6, dy: -0.5, dz: 0.6, zone: 'armR',
    }));
    expect(n).toBe(1);
    expect(zb.flesh!.cut[CHAINS.indexOf('armR')]).toBeGreaterThan(0.9);
    expect(sc.gore.anatomy.pieces.some((q) => q.chain === CHAINS.indexOf('armR'))).toBe(true);
  });

  it('the dead stay lying where they fell long after they stopped moving', () => {
    const { sc, p } = scene();
    const zb = facing(sc, p, 8);
    zb.hp = 1;
    sc.combat.shoot(zb.x, zb.y + 1.2, zb.z - 10, 0, 0, 1, { side: 'convoy', damage: 27, range: 60, ammo: 'pistol', tracer: false, headshots: false });
    run(sc, 0.4);
    expect(zb.dead).toBe(true);
    run(sc, 6);
    expect(sc.zombies.list).not.toContain(zb);
    expect(sc.zombies.corpses).toContain(zb);
    expect(sc.zombies.poseOf(zb).y).toBeGreaterThan(zb.y);
  });

  it('the dead can still be shot apart where they lie, and hacked at when looked down on', () => {
    const { sc, p } = scene();
    const zb = facing(sc, p, 3);
    zb.hp = 1;
    sc.combat.shoot(zb.x, zb.y + 1.2, zb.z - 8, 0, 0, 1, { side: 'convoy', damage: 27, range: 60, ammo: 'pistol', tracer: false, headshots: false });
    run(sc, 2.5);
    expect(zb.dead).toBe(true);
    const lie = sc.gore.anatomy.lie(zb);
    // Shoot straight down into the middle of it.
    const before = zb.flesh?.wounds.length ?? 0;
    sc.combat.shoot(lie[3], lie[4] + 3, lie[5] + 0.01, 0, -1, 0, { side: 'convoy', damage: 80, range: 10, ammo: 'rifle', tracer: false, headshots: false });
    run(sc, 0.2);
    expect(zb.flesh!.wounds.length).toBeGreaterThan(before);
    // And an axe brought down on it where the player looks.
    const hits = sc.gore.anatomy.stats.hits;
    p.pos.x = lie[3];
    p.pos.z = lie[5] - 1.1;
    p.pos.y = sc.groundAt(p.pos.x, p.pos.z);
    p.aimPitch = -0.95;
    const n = sc.zombies.meleeHit(p, p.pos.x, p.pos.z + 1, 0, 2.1, 85, MELEE.axe, 1.5, 'axe');
    expect(n).toBe(1);
    expect(sc.gore.anatomy.stats.hits).toBe(hits + 1);
  });

  it('a swept blade that finishes its cut through a lying body takes the part off there', () => {
    const { sc, p } = scene();
    const zb = facing(sc, p, 3);
    zb.hp = 1;
    sc.combat.shoot(zb.x, zb.y + 1.2, zb.z - 8, 0, 0, 1, { side: 'convoy', damage: 27, range: 60, ammo: 'pistol', tracer: false, headshots: false });
    run(sc, 2.5);
    const lying = [...sc.zombies.lyingBodies()];
    expect(lying.map((l) => l.zb)).toContain(zb);
    const segs = lying.find((l) => l.zb === zb)!.segs;
    // Halfway from the hips to the feet: a leg.
    const x = (segs[3] + segs[6]) / 2;
    const y = (segs[4] + segs[7]) / 2;
    const z = (segs[5] + segs[8]) / 2;
    const pieces = sc.gore.anatomy.pieces.length;
    sc.zombies.hackAt(p, zb, { x, y, z, dx: 1, dy: -0.6, dz: 0, zone: 'torso', depth: 1, through: true }, 58, 0.9, 'machete');
    expect(limbsGone(zb.wounds.mask).legs).toBe(1);
    expect(sc.gore.anatomy.pieces.length).toBe(pieces + 1);
  });
});
