import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { newAabbId } from '../src/world/layout';
import { equipFromBag, newGear } from '../src/sim/gear';
import {
  AMMO,
  ammoForGun,
  damageFraction,
  driftAt,
  dropAt,
  flightTime,
  limbsGone,
  legSpeedMult,
  armDamageMult,
  maskOf,
  massOf,
  newWounds,
  staggerSpeed,
  stepBullet,
  throughFlesh,
  throughSlab,
  wound,
  zeroPitch,
  zoneOf,
  type BulletState,
} from '../src/sim/ballistics';
import { HANDLING, kickVelocity, spring, stepSpring, swayAt } from '../src/sim/handling';
import { STORM_WIND, windAt } from '../src/sim/weather';
import { roadLift } from '../src/render/chunkview';
import { roadX } from '../src/world/terrain';
import { fakeServices } from './helpers/sim';

vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

/** Fly a round in free air to a horizontal distance and report where it is, how long that took and how fast it is going. */
function fly(kind: keyof typeof AMMO, dist: number, wind: [number, number] = [0, 0]) {
  const spec = AMMO[kind];
  const b: BulletState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: spec.speed };
  let t = 0;
  const h = 1 / 480;
  while (b.z < dist && t < 5) {
    stepBullet(b, h, spec.drag, wind[0], wind[1]);
    t += h;
  }
  return { ...b, t, speed: Math.hypot(b.vx, b.vy, b.vz) };
}

describe('flight', () => {
  it('a round takes real time to arrive and loses speed to the air', () => {
    const r = fly('pistol', 60);
    expect(r.t).toBeGreaterThan(0.2);
    expect(r.t).toBeLessThan(0.35);
    expect(r.speed).toBeLessThan(AMMO.pistol.speed * 0.9);
    // The closed-form time agrees with the stepped one.
    expect(flightTime(AMMO.pistol, 60)).toBeCloseTo(r.t, 1);
  });

  it('drops with distance, and a rifle drops far less than a pistol over the same ground', () => {
    const p = fly('pistol', 75);
    const r = fly('rifle', 75);
    expect(p.y).toBeLessThan(-0.3);
    expect(r.y).toBeGreaterThan(p.y);
    expect(r.y).toBeLessThan(0);
    expect(dropAt(AMMO.pistol, 75)).toBeCloseTo(-p.y, 1);
    // Zeroed sights bring the round back up onto the line of sight at the set range.
    const up = zeroPitch(AMMO.pistol, 200);
    expect(up * AMMO.pistol.zero).toBeCloseTo(dropAt(AMMO.pistol, AMMO.pistol.zero), 6);
    expect(zeroPitch(AMMO.pistol, 10)).toBeLessThan(up);
  });

  it('the wind pushes light, slow rounds sideways and barely moves a rifle round', () => {
    const calm = fly('pellet', 28);
    const gale = fly('pellet', 28, [STORM_WIND[0], 0]);
    expect(Math.abs(calm.x)).toBeLessThan(1e-6);
    expect(gale.x).toBeGreaterThan(0.2);
    const rifle = fly('rifle', 100, [STORM_WIND[0], 0]);
    expect(rifle.x).toBeGreaterThan(0);
    expect(rifle.x).toBeLessThan(gale.x);
    expect(driftAt(AMMO.pellet, 28, 18)).toBeGreaterThan(driftAt(AMMO.rifle, 28, 18));
  });

  it('a calm day has almost no wind and a storm blows the way the dust leans', () => {
    const [cx, cz] = windAt(0, 10);
    expect(Math.hypot(cx, cz)).toBeLessThan(3);
    let peak = 0;
    for (let t = 0; t < 30; t += 0.25) peak = Math.max(peak, windAt(1, t)[0]);
    expect(peak).toBeGreaterThan(STORM_WIND[0] * 0.7);
    expect(windAt(1, 3)[1]).toBeLessThan(0);
  });

  it('gun models map onto rounds, and a spent round does less', () => {
    expect(ammoForGun('pump')).toBe('pellet');
    expect(ammoForGun('rifle')).toBe('rifle');
    expect(ammoForGun('revolver')).toBe('magnum');
    expect(ammoForGun('pistol')).toBe('pistol');
    expect(damageFraction(1)).toBe(1);
    expect(damageFraction(0.5)).toBeLessThan(0.6);
    expect(damageFraction(0.5)).toBeGreaterThan(0.3);
  });
});

describe('what a round goes through', () => {
  const v = (k: keyof typeof AMMO) => AMMO[k].speed;

  it('wooden planks stop pellets but not a pistol; a rifle goes through a house wall', () => {
    expect(throughSlab(AMMO.pellet, v('pellet'), 'wood', 0.04)).toBe(0);
    expect(throughSlab(AMMO.pistol, v('pistol'), 'wood', 0.04)).toBeGreaterThan(v('pistol') * 0.5);
    expect(throughSlab(AMMO.pistol, v('pistol'), 'wood', 0.3)).toBe(0);
    const out = throughSlab(AMMO.rifle, v('rifle'), 'wood', 0.3);
    expect(out).toBeGreaterThan(v('rifle') * 0.6);
    expect(out).toBeLessThan(v('rifle'));
  });

  it('sheet metal and car bodies need a heavier round', () => {
    // A thin plate is no match for a pistol round, but it leaves it little to hit with after.
    const plate = throughSlab(AMMO.pistol, v('pistol'), 'sheet', 0.002);
    expect(plate).toBeGreaterThan(0);
    expect(plate).toBeLessThan(v('pistol') * 0.5);
    expect(throughSlab(AMMO.smg, v('smg'), 'sheet', 0.002)).toBe(0);
    expect(throughSlab(AMMO.magnum, v('magnum'), 'sheet', 0.002)).toBeGreaterThan(0);
    expect(throughSlab(AMMO.rifle, v('rifle'), 'sheet', 0.002)).toBeGreaterThan(0);
    expect(throughSlab(AMMO.pistol, v('pistol'), 'car', 0.4)).toBe(0);
    expect(throughSlab(AMMO.rifle, v('rifle'), 'car', 0.4)).toBeGreaterThan(0);
  });

  it('nothing in the kit goes through concrete or the ground', () => {
    for (const k of Object.keys(AMMO) as (keyof typeof AMMO)[]) {
      expect(throughSlab(AMMO[k], v(k), 'concrete', 0.3)).toBe(0);
      expect(throughSlab(AMMO[k], v(k), 'dirt', 1)).toBe(0);
    }
  });

  it('a slow round has less bite: the same plank stops a rifle round that has nearly spent itself', () => {
    expect(throughSlab(AMMO.rifle, v('rifle'), 'car', 0.4)).toBeGreaterThan(0);
    expect(throughSlab(AMMO.rifle, v('rifle') * 0.25, 'car', 0.4)).toBe(0);
  });

  it('only the heavy rounds come out of a body', () => {
    expect(throughFlesh(AMMO.pistol, v('pistol'))).toBe(0);
    expect(throughFlesh(AMMO.pellet, v('pellet'))).toBe(0);
    expect(throughFlesh(AMMO.rifle, v('rifle'))).toBeGreaterThan(0);
  });
});

describe('what a hit does to a body', () => {
  it('shoves harder with a heavy round and less on a heavy body', () => {
    const walker = massOf(1);
    const brute = massOf(1.45);
    const rifle = staggerSpeed(AMMO.rifle, AMMO.rifle.speed, walker);
    const pistol = staggerSpeed(AMMO.pistol, AMMO.pistol.speed, walker);
    expect(rifle).toBeGreaterThan(pistol * 2);
    expect(staggerSpeed(AMMO.rifle, AMMO.rifle.speed, brute)).toBeLessThan(rifle / 2);
    // A shotgun blast of eight pellets throws a walker back harder than one rifle round.
    expect(8 * staggerSpeed(AMMO.pellet, AMMO.pellet.speed, walker)).toBeGreaterThan(rifle);
  });

  it('reads the part of the body from height and side', () => {
    expect(zoneOf(0.9, 0, 1)).toBe('head');
    expect(zoneOf(0.65, 0.05, 1)).toBe('torso');
    expect(zoneOf(0.65, 0.28, 1)).toBe('armL');
    expect(zoneOf(0.65, -0.28, 1)).toBe('armR');
    expect(zoneOf(0.3, 0.1, 1)).toBe('legL');
    expect(zoneOf(0.3, -0.1, 1)).toBe('legR');
    // A bigger body has its arms further out.
    expect(zoneOf(0.65, 0.24, 1.5)).toBe('torso');
  });

  it('one pistol round never takes a limb, a few on the same one do; shotgun pellets take it in three and a rifle round in one', () => {
    const hp = 45;
    const w = newWounds();
    expect(wound(w, 'armL', 27, AMMO.pistol.gore, hp, false, 0.3).off).toEqual([]);
    expect(w.mask).toBe(0);
    expect(wound(w, 'armL', 27, AMMO.pistol.gore, hp, false, 0.3).off).toEqual(['armL']);
    // A pistol round to the body, however many, takes nothing with it.
    const body = newWounds();
    for (let i = 0; i < 20; i++) wound(body, 'torso', 27, AMMO.pistol.gore, hp, false, 0.3);
    expect(body.mask).toBe(0);
    // An SMG needs more rounds than a pistol, as each is lighter.
    const smg = newWounds();
    let rounds = 0;
    while (!smg.mask && rounds < 50) {
      wound(smg, 'legR', 14, AMMO.smg.gore, hp, false, 0.3);
      rounds++;
    }
    expect(rounds).toBeGreaterThan(2);
    expect(rounds).toBeLessThan(8);
    const w2 = newWounds();
    let off = 0;
    for (let i = 0; i < 3; i++) off += wound(w2, 'armR', 9, AMMO.pellet.gore, hp, false, 0.3).off.length;
    expect(off).toBe(1);
    expect(w2.mask & maskOf('armR')).toBe(maskOf('armR'));
    const w3 = newWounds();
    expect(wound(w3, 'legL', 80, AMMO.rifle.gore, hp, false, 0.3).off).toEqual(['legL']);
    // The same limb cannot come off twice.
    expect(wound(w3, 'legL', 80, AMMO.rifle.gore, hp, false, 0.3).off).toEqual([]);
  });

  it('a round that more than kills tears an arm off the body it hit, and a killing blow to the head takes the head', () => {
    const w = newWounds();
    expect(wound(w, 'torso', 80, AMMO.rifle.gore, 45, true, 0.2).off).toEqual(['armL']);
    const h = newWounds();
    expect(wound(h, 'head', 60, AMMO.rifle.gore, 45, true, 0.2).off).toEqual(['head']);
  });

  it('losing legs slows a body and losing arms weakens its claws', () => {
    const w = newWounds();
    wound(w, 'legL', 80, AMMO.rifle.gore, 45, false, 0);
    expect(limbsGone(w.mask)).toEqual({ legs: 1, arms: 0, head: false });
    expect(legSpeedMult(1)).toBeLessThan(1);
    expect(legSpeedMult(2)).toBeLessThan(legSpeedMult(1));
    expect(armDamageMult(2)).toBeLessThan(armDamageMult(1));
  });
});

describe('handling', () => {
  it('a kick snaps up and settles; a heavy gun kicks more and settles slower', () => {
    const peak = (model: keyof typeof HANDLING) => {
      const h = HANDLING[model];
      const s = spring();
      s.v += kickVelocity(h, h.kick);
      let top = 0;
      let t = 0;
      let settled = -1;
      for (let i = 0; i < 120; i++) {
        stepSpring(s, 0, h.settleK, h.settleZeta, DT);
        t += DT;
        top = Math.max(top, s.x);
        if (settled < 0 && i > 5 && Math.abs(s.x) < h.kick * 0.05 && Math.abs(s.v) < h.kick) settled = t;
      }
      return { top, settled };
    };
    const pistol = peak('pistol');
    const pump = peak('pump');
    expect(pistol.top).toBeGreaterThan(HANDLING.pistol.kick * 0.8);
    expect(pistol.top).toBeLessThan(HANDLING.pistol.kick * 1.25);
    expect(pump.top).toBeGreaterThan(pistol.top * 2);
    expect(pump.settled).toBeGreaterThan(pistol.settled);
  });

  it('sights come up with the weight of the gun: a pistol is quicker than a rifle, and the rifle rings past the mark', () => {
    const rise = (model: keyof typeof HANDLING) => {
      const h = HANDLING[model];
      const s = spring();
      let t90 = -1;
      let top = 0;
      for (let i = 0; i < 180; i++) {
        stepSpring(s, 1, h.adsK, h.adsZeta, DT);
        if (t90 < 0 && s.x >= 0.9) t90 = i * DT;
        top = Math.max(top, s.x);
      }
      return { t90, top };
    };
    const pistol = rise('pistol');
    const rifle = rise('rifle');
    expect(pistol.t90).toBeGreaterThan(0);
    expect(rifle.t90).toBeGreaterThan(pistol.t90);
    expect(rifle.top).toBeGreaterThan(1.005);
    expect(pistol.top).toBeLessThan(1.02);
  });

  it('the barrel wanders less behind the sights and when crouched, and more when winded or moving', () => {
    const amp = (ads: number, crouch: boolean, winded: boolean, moving: number) => {
      let m = 0;
      for (let t = 0; t < 20; t += 0.05) {
        const [x, y] = swayAt(HANDLING.rifle, t, 1.3, moving, ads, crouch, winded);
        m = Math.max(m, Math.hypot(x, y));
      }
      return m;
    };
    expect(amp(0, false, false, 0)).toBeGreaterThan(0.002);
    expect(amp(1, false, false, 0)).toBeLessThan(amp(0, false, false, 0));
    expect(amp(0, true, false, 0)).toBeLessThan(amp(0, false, false, 0));
    expect(amp(0, false, true, 0)).toBeGreaterThan(amp(0, false, false, 0));
    expect(amp(0, false, false, 4)).toBeGreaterThan(amp(0, false, false, 0));
  });

  it('every gun model has handling and ejects somewhere', () => {
    for (const m of ['pistol', 'revolver', 'smg', 'sawn', 'pump', 'rifle'] as const) {
      expect(HANDLING[m].kick).toBeGreaterThan(0);
      expect(['shot', 'cycle', 'reload']).toContain(HANDLING[m].eject);
    }
  });
});

// ------------------------------------------------------------------ in a real scene

function scene() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  for (const p of sc.players) p.exitVehicle(false);
  for (let i = 0; i < 18; i++) sc.tick(DT);
  sc.zombies.list.length = 0;
  sc.wildlife.list.length = 0;
  return { h, sc, p: sc.players[0] };
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

function equip(p: LegScene['players'][number], id: string, belt?: number) {
  const it = newGear(id);
  p.gear.bag.push(it);
  const r = equipFromBag(p.gear, it.uid, belt);
  expect(r.ok).toBe(true);
  p.refreshGear();
}

/** A standing target a way down the +z axis from the player, clear of the convoy. */
function target(sc: LegScene, p: LegScene['players'][number], dist: number, kind: 'walker' | 'brute' = 'walker') {
  const x = p.pos.x + 14;
  const z = p.pos.z + 4;
  const zb = sc.zombies.spawn(kind, x, z + dist, true);
  zb.yaw = 0;
  zb.y = sc.groundAt(x, z + dist);
  return { zb, from: { x, y: zb.y + 1.2, z } };
}

describe('rounds in the air', () => {
  it('a shot does not land the instant it leaves: the round has to get there', () => {
    const { sc, p } = scene();
    const { zb, from } = target(sc, p, 60);
    const hp = zb.hp;
    sc.combat.shoot(from.x, from.y, from.z, 0, 0, 1, { side: 'convoy', damage: 27, range: 90, ammo: 'pistol', headshots: false });
    expect(sc.combat.bullets).toHaveLength(1);
    sc.tick(DT);
    expect(zb.hp).toBe(hp);
    let ticks = 1;
    while (zb.hp === hp && ticks < 120) {
      sc.tick(DT);
      ticks++;
    }
    expect(zb.hp).toBeLessThan(hp);
    // ~0.26 s of flight at 60 m.
    expect(ticks).toBeGreaterThan(10);
    expect(ticks).toBeLessThan(24);
    expect(sc.combat.bullets).toHaveLength(0);
  });

  it('a round that runs out of range is gone, and one that hits something is gone', () => {
    const { sc, p } = scene();
    const { from } = target(sc, p, 200);
    sc.combat.shoot(from.x, from.y, from.z, 0, 0.05, 1, { side: 'convoy', damage: 27, range: 20, ammo: 'pistol' });
    run(sc, 0.6);
    expect(sc.combat.bullets).toHaveLength(0);
  });

  it('a storm blows a shot off its line and a calm day does not', () => {
    const { sc, p } = scene();
    const x0 = p.pos.x + 14;
    const z0 = p.pos.z + 4;
    const endX = (storm: number) => {
      sc.combat.clear();
      sc.combat.shoot(x0, sc.groundAt(x0, z0) + 1.4, z0, 0, 0, 1, { side: 'convoy', damage: 9, range: 40, ammo: 'pellet', tracer: false });
      let lastX = x0;
      for (let i = 0; i < 40 && sc.combat.bullets.length; i++) {
        sc.storm = storm;
        sc.tick(DT);
        if (sc.combat.bullets[0]) lastX = sc.combat.bullets[0].x;
      }
      return lastX - x0;
    };
    const calm = endX(0);
    const storm = endX(1);
    expect(storm - calm).toBeGreaterThan(0.15);
  });

  it('thin cover stops what it should and lets the rest through: a plank fence, then the zombie behind it', () => {
    const { sc, p } = scene();
    const { zb, from } = target(sc, p, 20);
    zb.hp = 1000;
    // A plank fence between the shooter and the zombie.
    const fz = from.z + 9;
    const box = { id: newAabbId(), minX: from.x - 3, maxX: from.x + 3, minZ: fz - 0.03, maxZ: fz + 0.03, y0: zb.y - 1, y1: zb.y + 3, kind: 'partition' as const, hp: 9999, mat: 'wood' as const };
    sc.obs.add(box);
    sc.P.addStaticBox(from.x, zb.y + 1, fz, 3, 2, 0.03);
    const seen: { surface: string; penetrated: boolean }[] = [];
    sc.combat.onImpact = (e) => seen.push({ surface: e.surface, penetrated: e.penetrated });
    const shot = (ammo: 'pellet' | 'pistol') => {
      zb.hp = 1000;
      sc.combat.shoot(from.x, from.y, from.z, 0, 0, 1, { side: 'convoy', damage: 20, range: 60, ammo, tracer: false });
      run(sc, 0.6);
      return 1000 - zb.hp;
    };
    expect(shot('pellet')).toBe(0);
    expect(seen[0]).toEqual({ surface: 'wood', penetrated: false });
    seen.length = 0;
    const dealt = shot('pistol');
    expect(dealt).toBeGreaterThan(5);
    // It arrived slower, so it hit softer than a clean shot would.
    expect(dealt).toBeLessThan(20);
    expect(seen[0]).toEqual({ surface: 'wood', penetrated: true });
    expect(sc.gore.decals.count).toBeGreaterThan(0); // the hole it left
  });

  it('a thick wall stops a hunting rifle', () => {
    const { sc, p } = scene();
    const { zb, from } = target(sc, p, 20);
    zb.hp = 1000;
    const wz = from.z + 9;
    sc.obs.add({ id: newAabbId(), minX: from.x - 3, maxX: from.x + 3, minZ: wz - 0.6, maxZ: wz + 0.6, y0: zb.y - 1, y1: zb.y + 4, kind: 'building', hp: 99999 });
    sc.P.addStaticBox(from.x, zb.y + 1.5, wz, 3, 2.5, 0.6);
    sc.combat.shoot(from.x, from.y, from.z, 0, 0, 1, { side: 'convoy', damage: 80, range: 60, ammo: 'rifle', tracer: false });
    run(sc, 0.6);
    expect(zb.hp).toBe(1000);
  });

  it('a rifle round goes through the first zombie and into the one behind', () => {
    const { sc, p } = scene();
    const a = target(sc, p, 12).zb;
    const b = sc.zombies.spawn('walker', a.x, a.z + 4, true);
    b.y = a.y;
    a.hp = b.hp = 500;
    const from = { x: a.x, y: a.y + 1.2, z: a.z - 12 };
    sc.combat.shoot(from.x, from.y, from.z, 0, 0, 1, { side: 'convoy', damage: 80, range: 60, ammo: 'rifle', tracer: false });
    run(sc, 0.5);
    expect(a.hp).toBeLessThan(500);
    expect(b.hp).toBeLessThan(500);
    // A pistol round stops in the first.
    a.hp = b.hp = 500;
    sc.combat.shoot(from.x, from.y, from.z, 0, 0, 1, { side: 'convoy', damage: 27, range: 60, ammo: 'pistol', tracer: false });
    run(sc, 0.5);
    expect(a.hp).toBeLessThan(500);
    expect(b.hp).toBe(500);
  });
});

describe('gore', () => {
  it('a shotgun blast at close range shoves a zombie back and leaves blood on the road', () => {
    const { sc, p } = scene();
    const { zb, from } = target(sc, p, 3);
    zb.hp = 1000;
    const before = sc.gore.decals.count;
    for (let i = 0; i < 8; i++) sc.combat.shoot(from.x, from.y, from.z, 0, 0, 1, { side: 'convoy', damage: 9, range: 30, ammo: 'pellet', spread: 0.02, tracer: false, headshots: false });
    run(sc, 0.12);
    expect(zb.stagger).toBeGreaterThan(0.3);
    expect(zb.vz).toBeGreaterThan(1.5);
    run(sc, 0.5);
    expect(zb.z).toBeGreaterThan(from.z + 3.7);
    expect(sc.gore.decals.count).toBeGreaterThan(before + 3);
  });

  it('a hunting rifle takes an arm off and the arm flies', () => {
    const { sc, p } = scene();
    const { zb, from } = target(sc, p, 6);
    zb.hp = 400;
    // Aim a quarter metre to the zombie's left (+x at yaw 0), at chest height.
    const aim = { x: zb.x + 0.25, y: zb.y + 1.15, z: zb.z };
    const dx = aim.x - from.x;
    const dz = aim.z - from.z;
    const dy = aim.y - from.y;
    const l = Math.hypot(dx, dy, dz);
    sc.combat.shoot(from.x, from.y, from.z, dx / l, dy / l, dz / l, { side: 'convoy', damage: 80, range: 60, ammo: 'rifle', tracer: false, headshots: false });
    run(sc, 0.3);
    expect(zb.wounds.mask & maskOf('armL')).toBe(maskOf('armL'));
    expect(limbsGone(zb.wounds.mask).arms).toBe(1);
    expect(zb.biteMult).toBeLessThan(1);
    // The arm itself flies, cut where the round hit it (the flesh engine throws the zombie's own arm).
    expect(sc.gore.anatomy.pieces.length).toBe(1);
    expect(sc.gore.anatomy.pieces[0].chain).toBe(0);
    expect(sc.gore.gibs.counts().chunk).toBeGreaterThan(0);
  });

  it('a pistol takes no limb in one round, but a limb that keeps being hit comes off', () => {
    const { sc, p } = scene();
    const { zb, from } = target(sc, p, 6);
    zb.hp = 5000;
    sc.combat.shoot(from.x, from.y, from.z, 0.04, -0.02, 1, { side: 'convoy', damage: 27, range: 60, ammo: 'pistol', tracer: false });
    run(sc, 0.15);
    expect(zb.wounds.mask).toBe(0);
    for (let i = 0; i < 12; i++) {
      sc.combat.shoot(from.x, from.y, from.z, 0.04, -0.02, 1, { side: 'convoy', damage: 27, range: 60, ammo: 'pistol', tracer: false });
      run(sc, 0.15);
    }
    expect(zb.wounds.mask).not.toBe(0);
  });

  it('a headshot with a heavy round takes the head and kills; the body falls the way the shot went', () => {
    const { sc, p } = scene();
    const { zb, from } = target(sc, p, 8);
    const aim = { x: zb.x, y: zb.y + 1.7, z: zb.z };
    const dx = aim.x - from.x;
    const dy = aim.y - from.y;
    const dz = aim.z - from.z;
    const l = Math.hypot(dx, dy, dz);
    sc.combat.shoot(from.x, from.y, from.z, dx / l, dy / l, dz / l, { side: 'convoy', damage: 80, range: 60, ammo: 'rifle', tracer: false, headshots: true });
    run(sc, 0.4);
    expect(zb.dead).toBe(true);
    expect(limbsGone(zb.wounds.mask).head).toBe(true);
    // A rifle round bursts the skull: the jaw stays, bone and brain fly.
    expect(zb.flesh?.head).toBe('burst');
    expect(sc.gore.anatomy.organs.counts().skull).toBeGreaterThan(0);
    expect(sc.gore.anatomy.organs.counts().brain).toBeGreaterThan(0);
    // It was shot from the -z side, so it faces back toward the shooter and topples along +z.
    expect(Math.cos(zb.yaw)).toBeLessThan(-0.8);
  });

  it('a body without legs drags itself slowly', () => {
    const { sc, p } = scene();
    const { zb, from } = target(sc, p, 5);
    zb.hp = 400;
    for (const x of [zb.x + 0.1, zb.x - 0.1]) {
      const aim = { x, y: zb.y + 0.45, z: zb.z };
      const l = Math.hypot(aim.x - from.x, aim.y - from.y, aim.z - from.z);
      sc.combat.shoot(from.x, from.y, from.z, (aim.x - from.x) / l, (aim.y - from.y) / l, (aim.z - from.z) / l, { side: 'convoy', damage: 80, range: 60, ammo: 'rifle', tracer: false, headshots: false });
      run(sc, 0.3);
    }
    expect(limbsGone(zb.wounds.mask).legs).toBe(2);
    expect(zb.moveMult).toBeLessThan(0.3);
  });

  it('blood stays: marks outlive the bodies and old ones give way to new when the pool is full', () => {
    const { sc } = scene();
    const d = sc.gore.decals;
    const cap = d.capacity;
    for (let i = 0; i < cap + 50; i++) sc.gore.groundSplat(0, i * 0.1, 0.3, 0);
    expect(d.count).toBe(cap);
    d.clear();
    expect(d.count).toBe(0);
  });

  it('the spray that leaves a body paints the wall behind it, facing the shooter', () => {
    const { sc, p } = scene();
    const { zb, from } = target(sc, p, 8);
    zb.hp = 1000;
    const wz = zb.z + 2.5;
    sc.obs.add({ id: newAabbId(), minX: zb.x - 4, maxX: zb.x + 4, minZ: wz - 0.4, maxZ: wz + 0.4, y0: zb.y - 1, y1: zb.y + 4, kind: 'building', hp: 99999 });
    sc.P.addStaticBox(zb.x, zb.y + 1.5, wz, 4, 2.5, 0.4);
    const add = vi.spyOn(sc.gore.decals, 'add');
    sc.combat.shoot(from.x, from.y, from.z, 0, 0, 1, { side: 'convoy', damage: 40, range: 40, ammo: 'pistol', tracer: false });
    run(sc, 0.6);
    const onWall = add.mock.calls.filter(([, y, , o]) => Math.abs(o.nz) > 0.9 && o.ny === 0 && y > zb.y + 0.3 && y < zb.y + 3.5 && o.cell !== 6);
    expect(onWall.length).toBeGreaterThan(0);
    // The wall faces the shooter, so the mark's normal points back at them.
    expect(onWall[0][3].nz).toBeLessThan(0);
  });

  it('marks on the road sit on the drawn road, not buried under it', () => {
    const { sc } = scene();
    const def = sc.terrain!;
    const z = 40;
    const centre = roadLift(def, roadX(def, z), z);
    expect(centre).toBeGreaterThan(0.04);
    expect(centre).toBeLessThan(0.12);
    expect(roadLift(def, roadX(def, z) + def.roadHalf + 3, z)).toBe(0);
    const add = vi.spyOn(sc.gore.decals, 'add');
    sc.gore.groundSplat(roadX(def, z), z, 0.5, 0);
    const y = add.mock.calls[0][1];
    expect(y).toBeGreaterThan(sc.groundAt(roadX(def, z), z) + 0.03);
  });

  it('a body that dies leaves a pool, bigger for a bigger blow', () => {
    const { sc, p } = scene();
    const a = target(sc, p, 6).zb;
    const n0 = sc.gore.decals.count;
    sc.zombies.kill(a, 0);
    expect(sc.gore.decals.count).toBeGreaterThan(n0);
  });
});

describe('brass and kick', () => {
  const fire = (h: ReturnType<typeof fakeServices>, sc: LegScene, secs = 0.1) => {
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    run(sc, secs);
    h.intents[0].rt = 0;
  };

  it('a pistol throws its case out with each shot, and the case lands and stays', () => {
    const { h, sc, p } = scene();
    expect(p.equip).toBe('gun');
    fire(h, sc, 0.45);
    const n = sc.gore.brass.count;
    expect(n).toBeGreaterThanOrEqual(2);
    run(sc, 3);
    expect(sc.gore.brass.count).toBe(n);
  });

  it('a bolt rifle ejects after the bolt is worked, not with the shot; a revolver holds its empties until the reload', () => {
    const { h, sc, p } = scene();
    equip(p, 'w_rifle', 3);
    p.fireCd = 0;
    fire(h, sc, 0.05);
    expect(sc.gore.brass.count).toBe(0);
    run(sc, 0.7);
    expect(sc.gore.brass.count).toBe(1);

    equip(p, 'w_revolver', 3);
    p.fireCd = 0;
    const before = sc.gore.brass.count;
    fire(h, sc, 0.05);
    run(sc, 0.8);
    expect(sc.gore.brass.count).toBe(before);
  });

  it('firing kicks the view up and it settles back; a heavier gun kicks harder', () => {
    const { h, sc, p } = scene();
    const kickOf = () => {
      p.fireCd = 0;
      let top = 0;
      fire(h, sc, 0.02);
      for (let i = 0; i < 12; i++) {
        sc.tick(DT);
        top = Math.max(top, p.kick.pitch.x);
      }
      run(sc, 1.5);
      return { top, rest: p.kick.pitch.x };
    };
    const pistol = kickOf();
    expect(pistol.top).toBeGreaterThan(0.003);
    expect(Math.abs(pistol.rest)).toBeLessThan(0.002);
    equip(p, 'w_pump', 3);
    run(sc, 0.5);
    const pump = kickOf();
    expect(pump.top).toBeGreaterThan(pistol.top * 2);
  });

  it('the sights come up with the weight of the gun', () => {
    const { h, sc, p } = scene();
    const ticksToAds = () => {
      h.intents[0].device = 'pad';
      h.intents[0].lt = 1;
      let n = 0;
      while (p.ads < 0.9 && n < 200) {
        sc.tick(DT);
        n++;
      }
      h.intents[0].lt = 0;
      run(sc, 1);
      return n;
    };
    const pistol = ticksToAds();
    equip(p, 'w_rifle', 3);
    run(sc, 0.3);
    const rifle = ticksToAds();
    expect(rifle).toBeGreaterThan(pistol);
  });

  it('the camera is handed the kick and applies it', () => {
    const { h, sc, p } = scene();
    p.fireCd = 0;
    fire(h, sc, 0.03);
    sc.renderFrame(1, DT);
    expect(p.cam['kick']?.pitch).toBeDefined();
  });
});
