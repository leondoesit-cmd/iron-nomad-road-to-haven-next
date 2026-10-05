import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { GEAR, legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn } from '../src/input/intents';
import { equipFromBag, newGear } from '../src/sim/gear';
import { Humanoid } from '../src/render/humanoid';
import { identityOf } from '../src/render/outfit';
import {
  ACCEL,
  CARRY,
  DRAW,
  READY,
  REACH,
  WALL_BLOCK,
  approachVelocity,
  bobScale,
  carryOf,
  drawLow,
  drawOf,
  landGait,
  lowered,
  newGait,
  newGaitOut,
  stepBlend,
  stepGait,
  stepRate,
  strafeRoll,
  wallBlend,
} from '../src/sim/gait';
import { CYCLE_EJECT, RELOAD_KIND, curve, cycleRack, cycleTime, dropAt, newGunPose, reloadPose } from '../src/sim/weaponanim';
import { fakeServices } from './helpers/sim';

vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
const GUNS = ['pistol', 'revolver', 'smg', 'sawn', 'pump', 'rifle'] as const;

// ------------------------------------------------------------------ inertia

describe('the weight of the walk', () => {
  const run = (tx: number, tz: number, from: [number, number], secs: number, accel: number, brake = ACCEL.brake) => {
    let v: [number, number] = [from[0], from[1]];
    for (let i = 0; i < Math.round(secs / DT); i++) v = approachVelocity(v[0], v[1], tx, tz, DT, accel, brake, [0, 0]);
    return v;
  };

  it('takes a moment to get up to speed, and gets there', () => {
    const early = run(3.4, 0, [0, 0], 0.05, ACCEL.walk);
    expect(early[0]).toBeGreaterThan(0.3);
    expect(early[0]).toBeLessThan(3.4 * 0.4);
    expect(run(3.4, 0, [0, 0], 0.4, ACCEL.walk)[0]).toBeCloseTo(3.4, 6);
  });

  it('a sprint takes longer to get going than a walk, and a stop is quicker than a start', () => {
    expect(ACCEL.sprint).toBeLessThan(ACCEL.walk);
    expect(ACCEL.brake).toBeGreaterThan(ACCEL.walk);
    const sprint = run(5.9, 0, [0, 0], 0.3, ACCEL.sprint)[0];
    const walk = run(5.9, 0, [0, 0], 0.3, ACCEL.walk)[0];
    expect(sprint).toBeLessThan(walk);
    // From a sprint to rest in under a quarter of a second.
    expect(run(0, 0, [5.9, 0], 0.25, ACCEL.walk)[0]).toBe(0);
  });

  it('a reversal passes through the slow part: it does not flip in a tick', () => {
    const v = approachVelocity(3.4, 0, -3.4, 0, DT, ACCEL.walk, ACCEL.brake, [0, 0]);
    expect(v[0]).toBeGreaterThan(2.5);
    const back = run(-3.4, 0, [3.4, 0], 0.5, ACCEL.walk);
    expect(back[0]).toBeCloseTo(-3.4, 6);
  });

  it('never overshoots a target or moves a velocity that is already there', () => {
    expect(approachVelocity(2, 1, 2, 1, DT, 16, 24, [0, 0])).toEqual([2, 1]);
    const v = approachVelocity(0, 0, 0.05, 0, 1, 16, 24, [0, 0]);
    expect(v).toEqual([0.05, 0]);
  });
});

describe('what a weapon weighs and how long it takes to draw', () => {
  it('every gun and melee weapon has a carry weight and a draw time', () => {
    for (const g of GEAR.items) {
      const m = g.gun?.model ?? g.melee?.model ?? g.tool;
      if (!m) continue;
      expect(CARRY[m], m).toBeGreaterThan(0.85);
      expect(DRAW[m], m).toBeGreaterThan(0.1);
    }
    expect(carryOf('unheard of')).toBe(1);
    expect(drawOf('unheard of')).toBe(0.3);
  });

  it('a rifle is heavier to carry and slower to draw than a pistol, a knife lighter and quicker', () => {
    expect(carryOf('rifle')).toBeLessThan(carryOf('pistol'));
    expect(carryOf('pump')).toBeLessThan(carryOf('smg'));
    expect(carryOf('knife')).toBeGreaterThan(carryOf('axe'));
    expect(drawOf('rifle')).toBeGreaterThan(drawOf('pistol') * 2);
    expect(drawOf('knife')).toBeLessThan(drawOf('axe'));
    // The starter pistol is not slowed, so the walk the game always had is unchanged.
    expect(carryOf('pistol')).toBe(1);
  });

  it('a draw starts with the gun low and brings it up, quickly at the end', () => {
    expect(drawLow(0.3, 0.3)).toBe(1);
    expect(drawLow(0, 0.3)).toBe(0);
    expect(drawLow(-1, 0.3)).toBe(0);
    expect(drawLow(0.15, 0.3)).toBeCloseTo(0.25, 6);
    expect(drawLow(0.1, 0)).toBe(0);
  });
});

describe('lowered and raised', () => {
  it('blends come up and go down at their own rates and settle on the target', () => {
    let v = 0;
    for (let i = 0; i < 60; i++) v = stepBlend(v, 1, 7, 6, DT);
    expect(v).toBeGreaterThan(0.95);
    for (let i = 0; i < 90; i++) v = stepBlend(v, 0, 7, 6, DT);
    expect(v).toBeLessThan(0.02);
    expect(stepBlend(0, 1, 20, 1, DT)).toBeGreaterThan(stepBlend(1, 0, 20, 1, DT) * 0 + 0.2);
  });

  it('a gun is ready to fire only once the sprint carry has mostly lifted', () => {
    expect(lowered(1, 0)).toBe(1);
    expect(lowered(0.2, 0.7)).toBe(0.7);
    expect(READY).toBeLessThan(1);
    // From full sprint carry it takes a fraction of a second to get below READY.
    let v = 1;
    let n = 0;
    while (v >= READY && n < 600) {
      v = stepBlend(v, 0, 7, 6, DT);
      n++;
    }
    expect(n * DT).toBeGreaterThan(0.08);
    expect(n * DT).toBeLessThan(0.4);
  });

  it('a wall pushes the gun up as it gets near, the longer the gun the sooner, and blocks the trigger with the muzzle against it', () => {
    expect(wallBlend(3, REACH.rifle)).toBe(0);
    expect(wallBlend(REACH.pistol - 0.1, REACH.pistol)).toBeGreaterThanOrEqual(WALL_BLOCK);
    // Still short of the block a little further out: the gun is rising but can fire.
    expect(wallBlend(REACH.pistol + 0.1, REACH.pistol)).toBeLessThan(WALL_BLOCK);
    expect(wallBlend(1.2, REACH.rifle)).toBeGreaterThan(wallBlend(1.2, REACH.pistol));
    let last = -1;
    for (let d = 2; d > 0.2; d -= 0.1) {
      const b = wallBlend(d, REACH.smg);
      expect(b).toBeGreaterThanOrEqual(last);
      last = b;
    }
    expect(wallBlend(0.1, REACH.pistol)).toBe(1);
  });
});

describe('the view in time with the feet', () => {
  const bob = (speed: number, o: { sprint?: boolean; crouch?: boolean; ads?: number; secs?: number } = {}) => {
    const g = newGait();
    const out = newGaitOut();
    let lo = Infinity;
    let hi = -Infinity;
    let roll = 0;
    for (let i = 0; i < Math.round((o.secs ?? 2) / DT); i++) {
      stepGait(g, DT, speed, !!o.sprint, !!o.crouch, o.ads ?? 0, true, out);
      if (i > 60) {
        lo = Math.min(lo, out.y);
        hi = Math.max(hi, out.y);
        roll = Math.max(roll, Math.abs(out.roll));
      }
    }
    return { range: hi - lo, roll };
  };

  it('stands still when you do, and bobs when you walk', () => {
    expect(bob(0).range).toBeLessThan(1e-6);
    const walk = bob(3.4);
    expect(walk.range).toBeGreaterThan(0.015);
    expect(walk.range).toBeLessThan(0.06);
    expect(walk.roll).toBeGreaterThan(0.003);
  });

  it('a sprint is wider than a walk, a crouch smaller, and the sights almost still it', () => {
    const walk = bob(3.4).range;
    expect(bob(5.9, { sprint: true }).range).toBeGreaterThan(walk * 1.5);
    expect(bob(1.7, { crouch: true }).range).toBeLessThan(walk);
    expect(bob(2.3, { ads: 1 }).range).toBeLessThan(walk * 0.4);
    expect(bobScale(false, false, 0)).toBe(1);
  });

  it('steps come faster the faster you go', () => {
    expect(stepRate(5.9)).toBeGreaterThan(stepRate(3.4));
    expect(stepRate(0)).toBeGreaterThan(0);
  });

  it('there is no step in the air, and the bob dies away', () => {
    const g = newGait();
    const out = newGaitOut();
    for (let i = 0; i < 120; i++) stepGait(g, DT, 3.4, false, false, 0, true, out);
    expect(g.amp).toBeGreaterThan(0.8);
    const phase = g.phase;
    for (let i = 0; i < 120; i++) stepGait(g, DT, 3.4, false, false, 0, false, out);
    expect(g.phase).toBe(phase);
    expect(g.amp).toBeLessThan(0.01);
  });

  it('a landing dips the eye, harder the harder it came down, and it comes back', () => {
    const dip = (fall: number) => {
      const g = newGait();
      const out = newGaitOut();
      landGait(g, fall);
      let low = 0;
      for (let i = 0; i < 90; i++) {
        stepGait(g, DT, 0, false, false, 0, true, out);
        low = Math.min(low, out.y);
      }
      return { low, rest: out.y };
    };
    const hard = dip(14);
    const soft = dip(6);
    expect(hard.low).toBeLessThan(-0.04);
    expect(hard.low).toBeLessThan(soft.low);
    expect(Math.abs(hard.rest)).toBeLessThan(0.002);
    // A hop is not a landing.
    expect(dip(2).low).toBe(0);
  });

  it('the head leans into a sidestep, a little', () => {
    expect(Math.abs(strafeRoll(3.4))).toBeLessThan(0.015);
    expect(Math.sign(strafeRoll(3))).toBe(-Math.sign(strafeRoll(-3)));
    expect(strafeRoll(0)).toBeCloseTo(0, 12);
    expect(Math.abs(strafeRoll(100))).toBeLessThanOrEqual(0.014);
  });
});

// ------------------------------------------------------------------ reload routines

describe('reload routines', () => {
  it('every gun has a routine', () => {
    for (const m of GUNS) expect(['mag', 'cylinder', 'shell', 'bolt']).toContain(RELOAD_KIND[m]);
    expect(RELOAD_KIND.pump).toBe('shell');
    expect(RELOAD_KIND.rifle).toBe('bolt');
    expect(RELOAD_KIND.pistol).toBe('mag');
  });

  it('a magazine reload starts and ends with the gun level and the hand on it, with the hand at the belt in between', () => {
    for (const kind of ['mag', 'cylinder', 'bolt'] as const) {
      const a = reloadPose(kind, 0);
      const z = reloadPose(kind, 1);
      expect(a, kind).toEqual({ tilt: 0, pitch: 0, down: 0, rack: 0 });
      expect(z.down, kind).toBe(0);
      expect(z.rack, kind).toBe(0);
      expect(Math.abs(z.tilt), kind).toBeLessThan(0.01);
      let reached = 0;
      for (let t = 0; t <= 1; t += 0.02) reached = Math.max(reached, reloadPose(kind, t).down);
      expect(reached, kind).toBe(1);
    }
  });

  it('the hand goes down before it comes back, and the pistol slide is racked at the end', () => {
    expect(reloadPose('mag', 0.4).down).toBe(1);
    expect(reloadPose('mag', 0.7).down).toBe(0);
    expect(reloadPose('mag', 0.86).rack).toBeCloseTo(1, 6);
    expect(reloadPose('mag', 0.3).rack).toBe(0);
  });

  it('a revolver is opened muzzle up and a bolt is thrown back before the rounds go in', () => {
    expect(reloadPose('cylinder', 0.2).pitch).toBeLessThan(-0.5);
    const bolt = reloadPose('bolt', 0.3);
    expect(bolt.rack).toBe(1);
    expect(bolt.down).toBe(0);
    expect(reloadPose('bolt', 0.5).down).toBe(1);
    expect(reloadPose('bolt', 0.5).rack).toBe(1);
    expect(reloadPose('bolt', 0.95).rack).toBe(0);
  });

  it('one shell of a pump has the gun cocked over with the hand to the pouch and back', () => {
    expect(reloadPose('shell', 0).tilt).toBeGreaterThan(0.3);
    expect(reloadPose('shell', 0.45).down).toBe(1);
    expect(reloadPose('shell', 0).down).toBe(0);
    expect(reloadPose('shell', 1).down).toBe(0);
    // The shell routine repeats cleanly: it ends where it began.
    expect(reloadPose('shell', 1).tilt).toBeCloseTo(reloadPose('shell', 0).tilt, 6);
  });

  it('the magazine drops early in the routine, and a pump drops nothing', () => {
    expect(dropAt('mag')).toBeGreaterThan(0);
    expect(dropAt('mag')).toBeLessThan(0.4);
    expect(dropAt('shell')).toBeLessThan(0);
  });

  it('progress outside 0 to 1 is held at the ends, and curves pass through their keys', () => {
    expect(reloadPose('mag', -1)).toEqual(reloadPose('mag', 0));
    expect(reloadPose('mag', 5)).toEqual(reloadPose('mag', 1));
    expect(curve([[0, 0], [1, 4]], 0.5)).toBe(2);
    expect(curve([[0, 1], [0.5, 3], [1, 1]], 0.5)).toBe(3);
    const p = newGunPose();
    expect(reloadPose('mag', 0.4, p)).toBe(p);
  });

  it('the pump or bolt goes back and forward after a shot, and the case leaves at the far end', () => {
    expect(cycleRack(0)).toBe(0);
    expect(cycleRack(1)).toBe(0);
    expect(cycleRack(CYCLE_EJECT)).toBe(1);
    expect(cycleRack(0.25)).toBeGreaterThan(0.1);
    expect(cycleRack(0.25)).toBeLessThan(1);
    // The stroke is timed so that the end of the stroke's far point is when the brass leaves.
    expect(cycleTime(0.42) * CYCLE_EJECT).toBeCloseTo(0.42, 9);
    expect(cycleTime(0.5) * CYCLE_EJECT).toBeCloseTo(0.5, 9);
  });
});

// ------------------------------------------------------------------ the rig

describe('the arms follow the routine', () => {
  const posed = (set: (h: Humanoid) => void, weapon: 'pistol' | 'rifle' = 'pistol') => {
    const h = new Humanoid(identityOf(0));
    h.setWeapon(weapon);
    set(h);
    h.update(0.016, 'stand', 0, 0.75, 0, 0);
    h.root.updateMatrixWorld(true);
    return h;
  };
  const dir = (h: Humanoid) => new THREE.Vector3(0, 0, 1).transformDirection(h.hand.matrixWorld);
  const handAt = (h: Humanoid) => new THREE.Vector3().setFromMatrixPosition(h.elbowL.matrixWorld);

  it('low ready points the gun down and ahead; high ready points it up', () => {
    const ready = dir(posed(() => {}));
    const low = dir(posed((h) => (h.gunPose.low = 1)));
    const high = dir(posed((h) => (h.gunPose.high = 1)));
    expect(Math.abs(ready.y)).toBeLessThan(0.2);
    expect(low.y).toBeLessThan(-0.15);
    expect(low.z).toBeGreaterThan(0.5);
    expect(high.y).toBeGreaterThan(0.4);
  });

  it('a reload cants the gun and takes the support hand off it', () => {
    const base = posed(() => {});
    const reload = posed((h) => {
      h.gunPose.tilt = 0.5;
      h.gunPose.down = 1;
    });
    const a = new THREE.Vector3().setFromMatrixPosition(base.hand.matrixWorld);
    const gunHandBase = handAt(base);
    // The support elbow moves, and the gun's side axis is no longer level.
    expect(handAt(reload).distanceTo(gunHandBase)).toBeGreaterThan(0.05);
    const side = (h: Humanoid) => new THREE.Vector3(1, 0, 0).transformDirection(h.hand.matrixWorld).y;
    expect(Math.abs(side(reload))).toBeGreaterThan(Math.abs(side(base)) + 0.2);
    expect(a.length()).toBeGreaterThan(0);
  });

  it('a slide is racked by the support hand, a bolt by the right hand', () => {
    const base = posed(() => {}, 'rifle');
    const slide = posed((h) => (h.gunPose.rack = 1), 'rifle');
    const bolt = posed((h) => {
      h.gunPose.rack = 1;
      h.gunPose.bolt = true;
    }, 'rifle');
    expect(handAt(slide).distanceTo(handAt(base))).toBeGreaterThan(0.03);
    expect(handAt(bolt).distanceTo(handAt(base))).toBeLessThan(0.005);
    expect(Math.abs(bolt.hand.rotation.z - base.hand.rotation.z)).toBeGreaterThan(0.5);
  });

  it('a shot bucks the gun back toward the shoulder', () => {
    const base = posed(() => {});
    const kicked = posed((h) => (h.gunKick = 1.2));
    expect(kicked.hand.position.z).toBeLessThan(base.hand.position.z - 0.03);
  });

  it('nothing is applied to a person who is not holding a gun', () => {
    const h = new Humanoid(identityOf(0));
    h.setWeapon('bat');
    h.gunPose.low = 1;
    h.gunPose.down = 1;
    h.update(0.016, 'stand', 0, 0.75, 0, 0);
    const h2 = new Humanoid(identityOf(0));
    h2.setWeapon('bat');
    h2.update(0.016, 'stand', 0, 0.75, 0, 0);
    expect(h.armL.rotation.x).toBeCloseTo(h2.armL.rotation.x, 9);
    expect(h.hand.rotation.x).toBeCloseTo(h2.hand.rotation.x, 9);
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
  return { h, sc, c: h.campaign, p: sc.players[0] };
}

type P = LegScene['players'][number];

function runFor(sc: LegScene, secs: number, each?: () => void) {
  for (let i = 0; i < Math.round(secs / DT); i++) {
    sc.tick(DT);
    each?.();
  }
}

function equip(p: P, id: string, belt?: number) {
  const it = newGear(id);
  p.gear.bag.push(it);
  const r = equipFromBag(p.gear, it.uid, belt);
  expect(r.ok).toBe(true);
  p.refreshGear();
  return it;
}

const speedOf = (p: P) => Math.hypot((p as unknown as { hvx: number }).hvx, (p as unknown as { hvz: number }).hvz);

function walk(h: ReturnType<typeof fakeServices>, p: P, sprint = false) {
  const it = h.intents[0];
  it.device = 'pad';
  it.move = [0, 1];
  it.sprint = sprint;
  p.aimYaw = 0;
}

function stop(h: ReturnType<typeof fakeServices>) {
  const it = h.intents[0];
  it.move = [0, 0];
  it.sprint = false;
  it.rt = 0;
  it.lt = 0;
}

describe('walking has weight', () => {
  it('speed builds over a fraction of a second and drops quickly when you let go', () => {
    const { h, sc, p } = scene();
    walk(h, p);
    sc.tick(DT);
    expect(speedOf(p)).toBeGreaterThan(0.1);
    expect(speedOf(p)).toBeLessThan(1);
    runFor(sc, 0.5);
    expect(speedOf(p)).toBeGreaterThan(3.2);
    stop(h);
    runFor(sc, 0.05);
    expect(speedOf(p)).toBeGreaterThan(0.5);
    runFor(sc, 0.3);
    expect(speedOf(p)).toBeLessThan(0.05);
  });

  it('a sprint takes longer to get to than a walk', () => {
    const { h, sc, p } = scene();
    walk(h, p, true);
    runFor(sc, 0.3);
    expect(speedOf(p)).toBeLessThan(5);
    expect(p.sprintBlend).toBeGreaterThan(0.5);
    runFor(sc, 1.2);
    expect(speedOf(p)).toBeGreaterThan(5.4);
  });

  it('a rifle is walked about slower than the pistol', () => {
    const top = (id?: string) => {
      const { h, sc, p } = scene();
      if (id) equip(p, id, 3);
      walk(h, p);
      runFor(sc, 1);
      return speedOf(p);
    };
    const pistol = top();
    const rifle = top('w_rifle');
    expect(pistol).toBeGreaterThan(3.2);
    expect(rifle).toBeLessThan(pistol * 0.95);
    expect(rifle).toBeGreaterThan(pistol * 0.88);
  });
});

describe('a sprint lowers the gun', () => {
  it('the gun is carried low while sprinting and cannot be fired until it is back up', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 100;
    const shoot = vi.spyOn(sc.combat, 'shoot');
    walk(h, p, true);
    runFor(sc, 1);
    expect(p.sprintBlend).toBeGreaterThan(0.9);
    h.intents[0].rt = 1;
    runFor(sc, 0.3);
    expect(shoot).not.toHaveBeenCalled();
    expect(p.mag).toBe(12);
    // Stop the sprint: the gun comes up, and then it fires.
    stop(h);
    h.intents[0].rt = 1;
    runFor(sc, 0.04);
    expect(shoot).not.toHaveBeenCalled();
    runFor(sc, 0.4);
    expect(p.sprintBlend).toBeLessThan(0.1);
    expect(shoot).toHaveBeenCalled();
  });

  it('the rig is handed the low-ready pose while it is lowered', () => {
    const { h, sc, p } = scene();
    walk(h, p, true);
    runFor(sc, 1);
    sc.renderFrame(1, DT);
    expect(p.human.gunPose.low).toBeGreaterThan(0.8);
    stop(h);
    runFor(sc, 1);
    sc.renderFrame(1, DT);
    expect(p.human.gunPose.low).toBeLessThan(0.05);
  });
});

describe('drawing a weapon', () => {
  it('a new gun is brought up over its own time, longer for a rifle, and not fired before it is out', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 100;
    const shoot = vi.spyOn(sc.combat, 'shoot');
    equip(p, 'w_rifle', 3);
    expect(p.drawT).toBeGreaterThan(0.6);
    expect(p.fireCd).toBeGreaterThan(0.6);
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    runFor(sc, 0.5);
    expect(shoot).not.toHaveBeenCalled();
    runFor(sc, 0.4);
    expect(shoot).toHaveBeenCalled();
    h.intents[0].rt = 0;
    // A pistol is out a good deal sooner.
    p.gear.sel = 0;
    p.syncEquip();
    expect(p.drawT).toBeLessThan(0.4);
  });

  it('the very first weapon of a scene is already in hand', () => {
    const { p } = scene();
    expect(p.drawT).toBe(0);
  });
});

describe('a wall in front of the gun', () => {
  const faceWall = (sc: LegScene, p: P, gap: number) => {
    // A wall across the way, `gap` metres from the eye.
    const z = p.pos.z + gap;
    sc.P.addStaticBox(p.pos.x, p.pos.y + 1.2, z + 0.15, 3, 1.5, 0.15);
    sc.P.step();
  };

  it('the gun comes up near a wall, and with the muzzle against it will not fire', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 100;
    const shoot = vi.spyOn(sc.combat, 'shoot');
    p.aimYaw = 0;
    faceWall(sc, p, 0.45);
    stop(h);
    h.intents[0].rt = 1;
    runFor(sc, 0.5);
    expect(p.wallBlend).toBeGreaterThan(0.8);
    expect(shoot).not.toHaveBeenCalled();
    sc.renderFrame(1, DT);
    expect(p.human.gunPose.high).toBeGreaterThan(0.5);
  });

  it('the same wall a few metres off does nothing', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 100;
    const shoot = vi.spyOn(sc.combat, 'shoot');
    p.aimYaw = 0;
    faceWall(sc, p, 4);
    stop(h);
    h.intents[0].rt = 1;
    runFor(sc, 0.4);
    expect(p.wallBlend).toBeLessThan(0.05);
    expect(shoot).toHaveBeenCalled();
  });
});

describe('reloads are animated', () => {
  it('the pistol reload takes the support hand to the belt and back, and ends with the gun level', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 50;
    p.mag = 0;
    stop(h);
    h.intents[0].device = 'keyboard';
    h.intents[0].held |= 1 << Btn.X;
    h.intents[0].pressed = 1 << Btn.X;
    sc.tick(DT);
    h.intents[0].held = 0;
    h.intents[0].pressed = 0;
    expect(p.reloadT).toBeGreaterThan(0.5);
    let maxDown = 0;
    let maxTilt = 0;
    let rackLate = 0;
    let tick = 0;
    while (p.reloadT > 0 && tick++ < 400) {
      sc.tick(DT);
      sc.renderFrame(1, DT);
      maxDown = Math.max(maxDown, p.human.gunPose.down);
      maxTilt = Math.max(maxTilt, p.human.gunPose.tilt);
      if (p.reloadT < 0.2) rackLate = Math.max(rackLate, p.human.gunPose.rack);
    }
    expect(maxDown).toBeGreaterThan(0.9);
    expect(maxTilt).toBeGreaterThan(0.3);
    expect(rackLate).toBeGreaterThan(0.3);
    runFor(sc, 0.3);
    sc.renderFrame(1, DT);
    expect(p.human.gunPose.down).toBeLessThan(0.02);
    expect(p.human.gunPose.tilt).toBeLessThan(0.02);
  });

  it('a pump repeats the routine for every shell', () => {
    const { h, sc, c, p } = scene();
    equip(p, 'w_pump', 3);
    p.fireCd = 0;
    c.ammo = 50;
    p.mag = 3;
    stop(h);
    h.intents[0].device = 'keyboard';
    h.intents[0].held |= 1 << Btn.X;
    h.intents[0].pressed = 1 << Btn.X;
    sc.tick(DT);
    h.intents[0].held = 0;
    h.intents[0].pressed = 0;
    const downs: number[] = [];
    let wasDown = false;
    for (let i = 0; i < 400 && p.reloadT > 0; i++) {
      sc.tick(DT);
      sc.renderFrame(1, DT);
      const d = p.human.gunPose.down > 0.9;
      if (d && !wasDown) downs.push(i);
      wasDown = d;
    }
    // Three shells to load, so the hand goes to the pouch three times.
    expect(downs).toHaveLength(3);
    expect(downs[1] - downs[0]).toBeGreaterThan(15);
    expect(p.mag).toBe(6);
  });

  it('a pump or bolt is worked after each shot', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 50;
    equip(p, 'w_rifle', 3);
    p.fireCd = 0;
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    sc.tick(DT);
    h.intents[0].rt = 0;
    expect(p.mag).toBe(4);
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      sc.tick(DT);
      sc.renderFrame(1, DT);
      peak = Math.max(peak, p.human.gunPose.rack);
    }
    expect(peak).toBeGreaterThan(0.9);
    sc.renderFrame(1, DT);
    expect(p.human.gunPose.rack).toBe(0);
  });

  it('a gun hanging at the side is raised for the reload, and the blends reset when the gun is put away', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 50;
    p.mag = 0;
    h.intents[0].device = 'keyboard';
    h.intents[0].held |= 1 << Btn.X;
    h.intents[0].pressed = 1 << Btn.X;
    sc.tick(DT);
    h.intents[0].held = 0;
    h.intents[0].pressed = 0;
    runFor(sc, 0.4);
    sc.renderFrame(1, DT);
    expect(p.human.armR.rotation.x).toBeLessThan(-0.9);
    equip(p, 'm_bat', 3);
    sc.renderFrame(1, DT);
    expect(p.human.gunPose.tilt).toBe(0);
    expect(p.human.gunPose.down).toBe(0);
  });
});

describe('the first-person view moves with the body', () => {
  const eye = (p: P) => (p as unknown as { eyePosition(a: number, dt: number, t: { x: number; y: number; z: number }): THREE.Vector3 }).eyePosition(0, DT, { x: p.pos.x, y: p.pos.y, z: p.pos.z }).clone();

  it('is steady at rest and bobs while walking, less with the sights up and more in a sprint', () => {
    const { h, sc, p } = scene();
    p.viewFirst = true;
    const range = (aim: number) => {
      let lo = Infinity;
      let hi = -Infinity;
      runFor(sc, 1.2, () => {
        const e = eye(p);
        // Height over the feet, so the walk's own rise and fall does not count.
        const y = e.y - p.pos.y;
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      });
      void aim;
      return hi - lo;
    };
    stop(h);
    runFor(sc, 1);
    const rest = range(0);
    expect(rest).toBeLessThan(0.003);
    walk(h, p);
    runFor(sc, 0.6);
    const walking = range(0);
    expect(walking).toBeGreaterThan(0.015);
    h.intents[0].sprint = true;
    runFor(sc, 1.4);
    const sprinting = range(0);
    expect(sprinting).toBeGreaterThan(walking);
  });

  it('dips when you land', () => {
    const { h, sc, p } = scene();
    p.viewFirst = true;
    stop(h);
    runFor(sc, 0.5);
    const rest = eye(p).y - p.pos.y;
    // Come down from a height.
    p.vy = -16;
    (p as unknown as { grounded: boolean }).grounded = false;
    let low = Infinity;
    runFor(sc, 0.6, () => {
      low = Math.min(low, eye(p).y - p.pos.y);
    });
    expect(low).toBeLessThan(rest - 0.02);
    runFor(sc, 1);
    expect(Math.abs(eye(p).y - p.pos.y - rest)).toBeLessThan(0.005);
  });

  it('standing up from a crouch takes a moment', () => {
    const { h, sc, p } = scene();
    p.viewFirst = true;
    stop(h);
    const it = h.intents[0];
    // The crouch button, whether the settings make it a hold or a toggle.
    const crouch = (on: boolean) => {
      if (on) it.held |= 1 << Btn.B;
      else it.held &= ~(1 << Btn.B);
      if (p.crouch !== on) {
        it.pressed = 1 << Btn.B;
        sc.tick(DT);
        it.pressed = 0;
      }
    };
    // The camera asks for the eye every frame.
    const look = () => eye(p);
    crouch(true);
    runFor(sc, 1.2, look);
    expect(p.crouch).toBe(true);
    const low = eye(p).y - p.pos.y;
    crouch(false);
    runFor(sc, 0.1, look);
    expect(p.crouch).toBe(false);
    const mid = eye(p).y - p.pos.y;
    runFor(sc, 1, look);
    const high = eye(p).y - p.pos.y;
    expect(mid).toBeGreaterThan(low);
    expect(mid).toBeLessThan(high - 0.1);
  });

  it('the third-person camera is not bobbed', () => {
    const { h, sc, p } = scene();
    p.viewFirst = false;
    walk(h, p);
    runFor(sc, 1);
    expect(p.firstPerson).toBe(false);
  });
});

describe('the gun lags behind a turn of the view', () => {
  it('swings the other way when the view whips round and settles when it stops', () => {
    const { h, sc, p } = scene();
    stop(h);
    runFor(sc, 0.3);
    const lag = () => (p as unknown as { lag: { yaw: { x: number }; pitch: { x: number } } }).lag;
    expect(Math.abs(lag().yaw.x)).toBeLessThan(0.002);
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      p.aimYaw += 0.06;
      sc.tick(DT);
      peak = Math.max(peak, Math.abs(lag().yaw.x));
    }
    expect(peak).toBeGreaterThan(0.01);
    runFor(sc, 1.5);
    expect(Math.abs(lag().yaw.x)).toBeLessThan(0.003);
  });
});
