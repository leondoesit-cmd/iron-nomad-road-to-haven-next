import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { GEAR, legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn } from '../src/input/intents';
import { newAabbId } from '../src/world/layout';
import { equipFromBag, newGear } from '../src/sim/gear';
import { AMMO, type AmmoKind } from '../src/sim/ballistics';
import {
  BLOOM,
  CONTACT,
  IMPACT_SOUND,
  MELEE,
  MUZZLE,
  PUMP_OPEN,
  SKIP,
  SKIP_SIN,
  TACTICAL,
  TRACER,
  bloomAfterShot,
  bloomSettle,
  knockFor,
  meleeFeel,
  reloadPlan,
  skipOf,
  swingArc,
  swingPose,
  tracerTint,
} from '../src/sim/weaponfx';
import { Tracers } from '../src/render/particles';
import { STAGE } from '../src/sim/reloads';
import { fakeServices } from './helpers/sim';

vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
const GUNS = ['pistol', 'revolver', 'smg', 'sawn', 'pump', 'rifle'] as const;

// ------------------------------------------------------------------ the rules

describe('muzzle, tracer and bloom tables', () => {
  it('every gun has a flash and bloom; bullets have tracers while arrows and bolts are drawn as shafts', () => {
    for (const m of GUNS) {
      expect(MUZZLE[m].flash).toBeGreaterThan(0);
      expect(MUZZLE[m].cone).toBeGreaterThan(0);
      expect(BLOOM[m].shot).toBeGreaterThan(0);
      expect(BLOOM[m].max).toBeGreaterThanOrEqual(BLOOM[m].shot);
    }
    // Arrows and crossbow bolts are drawn as themselves in flight, never as a streak.
    expect(TRACER.arrow.chance).toBe(0);
    expect(TRACER.bolt.chance).toBe(0);
    for (const k of Object.keys(AMMO) as AmmoKind[]) {
      if (k === 'arrow' || k === 'bolt') continue;
      expect(TRACER[k].life).toBeGreaterThan(0);
      expect(TRACER[k].chance).toBeGreaterThan(0);
      expect(TRACER[k].chance).toBeLessThanOrEqual(1);
    }
  });

  it('a shotgun throws a bigger, smokier flash than a pistol, and a rifle burns brighter and longer than an SMG', () => {
    expect(MUZZLE.sawn.flash).toBeGreaterThan(MUZZLE.pistol.flash * 2);
    expect(MUZZLE.sawn.smoke).toBeGreaterThan(MUZZLE.pistol.smoke);
    expect(MUZZLE.sawn.light).toBeGreaterThan(MUZZLE.pistol.light);
    expect(MUZZLE.rifle.reach).toBeGreaterThan(MUZZLE.smg.reach);
  });

  it('a pellet or an SMG round is drawn less often than a rifle round, so a burst is not a wall of lines', () => {
    expect(TRACER.pellet.chance).toBeLessThan(TRACER.rifle.chance);
    expect(TRACER.smg.chance).toBeLessThan(TRACER.pistol.chance);
    expect(TRACER.rifle.life).toBeGreaterThan(TRACER.pellet.life);
  });

  it("raiders' tracers are redder than the convoy's", () => {
    const [cr, cg, cb] = tracerTint(TRACER.pistol, false);
    const [rr, rg, rb] = tracerTint(TRACER.pistol, true);
    expect(rg / rr).toBeLessThan(cg / cr);
    expect(rb / rr).toBeLessThan(cb / cr);
  });

  it('sustained fire opens the spread up to a limit, and braced behind the sights it opens less', () => {
    let b = 0;
    for (let i = 0; i < 40; i++) b = bloomAfterShot('smg', b, 0);
    expect(b).toBe(BLOOM.smg.max);
    expect(bloomAfterShot('pistol', 0, 1)).toBeLessThan(bloomAfterShot('pistol', 0, 0));
  });

  it('bloom closes up with time, and a slow gun has nearly closed up before its next shot', () => {
    expect(bloomSettle('pistol', 0.5, 10)).toBe(0);
    expect(bloomSettle('pistol', 0.5, 0.1)).toBeCloseTo(0.5 - BLOOM.pistol.decay * 0.1, 6);
    // The pump's cycle time (0.85 s) closes most of one shot's worth.
    const pump = bloomAfterShot('pump', 0, 0);
    expect(bloomSettle('pump', pump, 0.85)).toBeLessThan(pump * 0.2);
    // The SMG's barely closes any: held down, it climbs.
    const smg = bloomAfterShot('smg', 0, 0);
    expect(bloomSettle('smg', smg, 0.085)).toBeGreaterThan(smg * 0.4);
  });
});

describe('reloading', () => {
  it('a magazine gun with a round still in it reloads faster than an empty one; other guns do not care', () => {
    expect(reloadPlan('pistol', 1.3, 12, 0).first).toBe(1.3);
    expect(reloadPlan('pistol', 1.3, 12, 3).first).toBeCloseTo(1.3 * TACTICAL, 6);
    expect(reloadPlan('smg', 1.9, 30, 1).first).toBeCloseTo(1.9 * TACTICAL, 6);
    expect(reloadPlan('ar', 2.3, 30, 1).first).toBeCloseTo(2.3 * TACTICAL, 6);
    for (const m of ['revolver', 'sawn', 'crossbow'] as const) expect(reloadPlan(m, 2.2, 6, 2).first).toBe(2.2);
    expect(reloadPlan('pistol', 1.3, 12, 3).each).toBe(0);
    expect(reloadPlan('pistol', 1.3, 12, 3).close).toBe(0);
  });

  it('a pump loads a shell at a time: the full magazine takes the whole reload, a little more from dry to chamber the first', () => {
    const plan = reloadPlan('pump', 3, 6, 0);
    expect(plan.each).toBeGreaterThan(0);
    // Turning the gun to load, six shells, and from dry the pump worked once.
    expect(plan.first).toBeCloseTo(3 * PUMP_OPEN, 6);
    expect(plan.first + 6 * plan.each + plan.close).toBeCloseTo(3 * (1 + STAGE.closeEmpty - STAGE.close), 6);
    expect(reloadPlan('pump', 3, 6, 2).close).toBeLessThan(plan.close);
  });
});

describe('skipped rounds', () => {
  const d: [number, number, number] = [0.98, 0, 0.2];
  const n: [number, number, number] = [0, 0, -1];
  const still: [number, number, number] = [0, 0, 0];

  it('a glancing round skips off steel, slower and heading away from the surface', () => {
    const sk = skipOf('pistol', 'steel', 250, d, n, 0, still);
    expect(sk).not.toBeNull();
    expect(sk!.speed).toBeLessThan(250 * 0.7);
    expect(sk!.speed).toBeGreaterThan(250 * 0.3);
    // It arrived heading into +z; it leaves heading back out, along the wall.
    expect(sk!.dz).toBeLessThan(0);
    expect(sk!.dx).toBeGreaterThan(0.9);
    expect(Math.hypot(sk!.dx, sk!.dy, sk!.dz)).toBeCloseTo(1, 6);
  });

  it('does the same whichever way the normal points', () => {
    const a = skipOf('pistol', 'steel', 250, d, n, 0, still)!;
    const b = skipOf('pistol', 'steel', 250, d, [0, 0, 1], 0, still)!;
    expect(b.dz).toBeCloseTo(a.dz, 6);
  });

  it('a head-on round does not skip, nor one on wood, plaster or earth, nor a shotgun pellet, nor a spent round', () => {
    expect(skipOf('pistol', 'steel', 250, [0, 0, 1], n, 0, still)).toBeNull();
    expect(skipOf('pistol', 'wood', 250, d, n, 0, still)).toBeNull();
    expect(skipOf('pistol', 'plaster', 250, d, n, 0, still)).toBeNull();
    expect(skipOf('pistol', 'dirt', 250, d, n, 0, still)).toBeNull();
    expect(skipOf('pellet', 'steel', 215, d, n, 0, still)).toBeNull();
    expect(skipOf('pistol', 'steel', 40, d, n, 0, still)).toBeNull();
  });

  it('the shallower the angle the likelier it skips, and harder surfaces skip more than softer ones', () => {
    const at = (s: number): [number, number, number] => [Math.sqrt(1 - s * s), 0, s];
    // A roll that lets the very shallow one skip but not the steeper one.
    expect(skipOf('rifle', 'concrete', 500, at(0.05), n, 0.3, still)).not.toBeNull();
    expect(skipOf('rifle', 'concrete', 500, at(SKIP_SIN - 0.01), n, 0.3, still)).toBeNull();
    expect(SKIP.steel!).toBeGreaterThan(SKIP.concrete!);
    expect(SKIP.concrete!).toBeGreaterThan(SKIP.car!);
    expect(skipOf('pistol', 'steel', 250, d, n, 0.999, still)).toBeNull();
  });

  it('what lands on a surface has a sound, except earth and glass', () => {
    expect(IMPACT_SOUND.steel).toBe('tink');
    expect(IMPACT_SOUND.concrete).toBe('chip');
    expect(IMPACT_SOUND.dirt).toBeUndefined();
    expect(IMPACT_SOUND.glass).toBeUndefined();
  });
});

describe('melee weapons', () => {
  it('every melee weapon and bare hands have a feel; an unknown one gets the fist', () => {
    for (const g of GEAR.items) if (g.melee) expect(MELEE[g.melee.model]).toBeDefined();
    expect(meleeFeel(undefined)).toBe(MELEE.fist);
    expect(meleeFeel('none')).toBe(MELEE.fist);
    expect(meleeFeel('axe')).toBe(MELEE.axe);
  });

  it('a knife is quick, an axe slow and heavy, a bat throws things back and an axe goes through a crowd', () => {
    expect(MELEE.knife.windup).toBeLessThan(MELEE.machete.windup);
    expect(MELEE.machete.windup).toBeLessThan(MELEE.axe.windup);
    expect(MELEE.bat.knock).toBeGreaterThan(MELEE.machete.knock);
    expect(MELEE.bat.stun).toBeGreaterThan(MELEE.knife.stun);
    expect(MELEE.axe.cleave).toBeGreaterThan(MELEE.knife.cleave);
    expect(MELEE.axe.shake).toBeGreaterThan(MELEE.knife.shake);
    expect(MELEE.axe.pitch).toBeLessThan(MELEE.knife.pitch);
    // Every weapon lands before the next one can be swung, and as the arm comes through, near the end of its swing.
    for (const g of GEAR.items) if (g.melee) expect(MELEE[g.melee.model].windup).toBeLessThan(g.melee.cd);
    for (const m of Object.values(MELEE)) expect(m.windup / m.swing).toBeCloseTo(CONTACT, 2);
  });

  it('a heavy body is shoved less than a light one', () => {
    expect(knockFor(MELEE.bat, 70)).toBeCloseTo(MELEE.bat.knock, 6);
    expect(knockFor(MELEE.bat, 400)).toBeLessThan(MELEE.bat.knock * 0.4);
    expect(knockFor(MELEE.bat, 30)).toBeGreaterThan(MELEE.bat.knock);
    expect(knockFor(MELEE.bat, 1e6)).toBeGreaterThan(0);
  });

  it('the wrist leads the arm: the blade comes over the top and finishes forward and down', () => {
    expect(swingPose(0).blade).toBeLessThan(-2.5);
    expect(swingPose(1).blade).toBeGreaterThan(0.5);
    // Forward and a little down at contact.
    expect(swingPose(CONTACT).blade).toBeGreaterThan(0);
    expect(swingPose(CONTACT).blade).toBeLessThan(0.8);
    let last = -9;
    for (let e = 0; e <= 1; e += 0.05) {
      expect(swingPose(e).blade).toBeGreaterThan(last);
      last = swingPose(e).blade;
    }
    // The arm itself comes down from overhead to low.
    expect(swingPose(0).arm).toBeLessThan(-2.5);
    expect(swingPose(1).arm).toBeGreaterThan(-0.8);
  });

  it('the streak follows the tip of the weapon: cocked behind and overhead to start, level and in front at contact, low at the end', () => {
    const a = swingArc(0);
    const hit = swingArc(CONTACT);
    const b = swingArc(1);
    expect(a.y).toBeGreaterThan(b.y + 0.7);
    expect(a.r).toBeLessThan(0);
    expect(a.yaw).toBeGreaterThan(0);
    expect(b.yaw).toBeLessThan(0);
    // At contact the tip is about shoulder height and out in front.
    expect(Math.abs(hit.y - 1.45)).toBeLessThan(0.5);
    expect(hit.r).toBeGreaterThan(1);
    expect(hit.r).toBeGreaterThan(b.r);
    expect(swingArc(-3)).toEqual(a);
    expect(swingArc(9)).toEqual(b);
    // A longer weapon reaches further at contact.
    expect(swingArc(CONTACT, 0.3).r).toBeLessThan(hit.r);
    expect(swingArc(CONTACT, 1.2).r).toBeGreaterThan(hit.r);
  });
});

describe('tracer drawing', () => {
  it('a streak dims over its life and is gone at the end', () => {
    const t = new Tracers(4);
    t.add(0, 0, 0, 1, 0, 0, 1, 1, 1, 0.2);
    const col = (t as unknown as { col: Float32Array }).col;
    const head = () => col[3];
    const first = head();
    expect(first).toBeCloseTo(1, 5);
    t.update(0.1);
    expect(head()).toBeLessThan(first);
    expect(head()).toBeGreaterThan(0);
    t.update(0.15);
    expect(head()).toBe(0);
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

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

function equip(p: LegScene['players'][number], id: string, belt?: number) {
  const it = newGear(id);
  p.gear.bag.push(it);
  const r = equipFromBag(p.gear, it.uid, belt);
  expect(r.ok).toBe(true);
  p.refreshGear();
  return it;
}

function tap(h: ReturnType<typeof fakeServices>, sc: LegScene, who: number, btn: number) {
  const it = h.intents[who];
  it.device = 'keyboard';
  it.held |= 1 << btn;
  it.pressed = 1 << btn;
  sc.tick(DT);
  it.held &= ~(1 << btn);
  it.pressed = 0;
  it.released = 1 << btn;
  sc.tick(DT);
  it.released = 0;
  sc.tick(DT);
}

function target(sc: LegScene, p: LegScene['players'][number], dist: number) {
  const x = p.pos.x + 14;
  const z = p.pos.z + 4;
  const zb = sc.zombies.spawn('walker', x, z + dist, true);
  zb.yaw = 0;
  zb.y = sc.groundAt(x, z + dist);
  return { zb, from: { x, y: zb.y + 1.2, z } };
}

describe('firing', () => {
  it('a held trigger opens the spread, and it closes up again when let go', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 200;
    expect(p.bloom).toBe(0);
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    run(sc, 0.8);
    h.intents[0].rt = 0;
    expect(p.bloom).toBeGreaterThan(0.2);
    expect(p.bloom).toBeLessThanOrEqual(BLOOM.pistol.max);
    run(sc, 1.5);
    expect(p.bloom).toBe(0);
  });

  it('each shot is wider than the last while bloom is up', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 200;
    const shoot = vi.spyOn(sc.combat, 'shoot');
    equip(p, 'w_smg', 3);
    p.fireCd = 0;
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    run(sc, 1);
    h.intents[0].rt = 0;
    const spreads = shoot.mock.calls.map((cl) => cl[6].spread as number);
    expect(spreads.length).toBeGreaterThan(5);
    expect(spreads[spreads.length - 1]).toBeGreaterThan(spreads[0] * 1.3);
  });

  it('a shot flashes the shared light, and it dies away at once', () => {
    const { h, sc, p } = scene();
    expect(sc.combat.light.intensity).toBe(0);
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    sc.tick(DT);
    h.intents[0].rt = 0;
    expect(p.mag).toBeLessThan(12);
    expect(sc.combat.light.intensity).toBeGreaterThan(0);
    run(sc, 0.2);
    expect(sc.combat.light.intensity).toBe(0);
  });
});

describe('reloading in the hand', () => {
  it('a part-empty pistol reloads faster than an empty one', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 40;
    p.mag = 4;
    tap(h, sc, 0, Btn.X);
    const partial = p.reloadT;
    p.reloadT = 0;
    p.mag = 0;
    tap(h, sc, 0, Btn.X);
    expect(partial).toBeLessThan(p.reloadT - 0.2);
  });

  it('a pump takes its shells one at a time, and the trigger stops the loading and fires what is in', () => {
    const { h, sc, c, p } = scene();
    equip(p, 'w_pump', 3);
    c.ammo = 40;
    p.mag = 0;
    p.fireCd = 0;
    tap(h, sc, 0, Btn.X);
    expect(p.mag).toBe(0);
    // The action opens and the first shell goes in at 0.8 s, the next at 1.24 s.
    run(sc, 0.85);
    expect(p.mag).toBe(1);
    run(sc, 0.45);
    expect(p.mag).toBe(2);
    expect(c.ammo).toBe(38);
    // Pull the trigger: the loading stops and a shell goes.
    const shoot = vi.spyOn(sc.combat, 'shoot');
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    run(sc, 0.1);
    h.intents[0].rt = 0;
    expect(p.reloadT).toBe(0);
    expect(shoot).toHaveBeenCalled();
    expect(p.mag).toBe(1);
    // Left alone it fills right up.
    tap(h, sc, 0, Btn.X);
    run(sc, 3.6);
    expect(p.mag).toBe(6);
    expect(c.ammo).toBe(38 - 5);
  });

  it('a pump with no shells left in the pouch stops loading and says so only when it is empty', () => {
    const { h, sc, c, p } = scene();
    equip(p, 'w_pump', 3);
    c.ammo = 2;
    p.mag = 1;
    tap(h, sc, 0, Btn.X);
    run(sc, 3);
    expect(p.mag).toBe(3);
    expect(c.ammo).toBe(0);
    expect(p.reloadT).toBeLessThanOrEqual(0);
  });
});

describe('melee in a real scene', () => {
  it('the blow lands part-way through the swing, not on the click, and carries the weapon\'s feel', () => {
    const { h, sc, p } = scene();
    const hit = vi.spyOn(sc.zombies, 'meleeHit').mockImplementation(() => 0);
    equip(p, 'm_axe', 3);
    expect(p.equip).toBe('melee');
    // A blade only strikes what its swing passes through: one of the dead in front.
    p.aimYaw = 0;
    const zb = sc.zombies.spawn('walker', p.pos.x, p.pos.z + 1.2, true);
    zb.y = sc.groundAt(zb.x, zb.z);
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    sc.tick(DT);
    h.intents[0].rt = 0;
    expect(p.swingT).toBeGreaterThan(0);
    expect(hit).not.toHaveBeenCalled();
    run(sc, 0.3);
    expect(hit).toHaveBeenCalledTimes(1);
    expect(hit.mock.calls[0][6]).toBe(MELEE.axe);
  });

  it('a landed blow shoves and staggers the body, a bat more than a knife, and the arm hangs on the hit', () => {
    const stunOf = (id: string) => {
      const { h, sc, p } = scene();
      equip(p, id, 3);
      p.aimYaw = 0;
      const zb = sc.zombies.spawn('walker', p.pos.x, p.pos.z + 1.3, true);
      zb.y = sc.groundAt(zb.x, zb.z);
      zb.hp = 5000;
      h.intents[0].device = 'pad';
      h.intents[0].rt = 1;
      let held = 0;
      for (let i = 0; i < 40; i++) {
        sc.tick(DT);
        h.intents[0].rt = 0;
        if (p.swingT > 0 && zb.hp < 5000 && !held) held = p.swingT;
      }
      expect(zb.hp).toBeLessThan(5000);
      return { stun: zb.stun, held };
    };
    const bat = stunOf('m_bat');
    const knife = stunOf('m_knife');
    expect(bat.stun).toBeGreaterThan(knife.stun);
    expect(bat.held).toBeGreaterThan(0);
  });

  it('an axe goes through a neck and on into the next body, a knife stops in the first', () => {
    const hitsOf = (id: string) => {
      const { h, sc, p } = scene();
      equip(p, id, 3);
      p.aimYaw = 0;
      // Two side by side, facing the swing; it comes down from the right (-x), so it crosses the right one's neck first.
      const zs = [-0.18, 0.18].map((dx) => {
        const zb = sc.zombies.spawn('walker', p.pos.x + dx, p.pos.z + 1.2, true);
        zb.y = sc.groundAt(zb.x, zb.z);
        zb.yaw = Math.PI;
        zb.hp = 5000;
        return zb;
      });
      const eye = p.pos.y + (p as unknown as { eyeH: number }).eyeH;
      p.aimPitch = Math.atan2(zs[0].y + 1.45 - eye, 1.12);
      h.intents[0].device = 'pad';
      h.intents[0].rt = 1;
      sc.tick(DT);
      h.intents[0].rt = 0;
      run(sc, 0.3);
      return zs.filter((z) => z.hp < 5000).length;
    };
    expect(hitsOf('m_axe')).toBe(2);
    expect(hitsOf('m_knife')).toBe(1);
  });

  it('bare hands still hit, with the fist\'s feel', () => {
    const { h, sc, p } = scene();
    const hit = vi.spyOn(sc.zombies, 'meleeHit').mockImplementation(() => 0);
    p.gear.sel = 1;
    p.syncEquip();
    expect(p.equip).toBe('wrench');
    tap(h, sc, 0, Btn.RB);
    run(sc, 0.2);
    expect(hit).toHaveBeenCalled();
    expect(hit.mock.calls[0][6]).toBe(MELEE.fist);
  });
});

describe('rounds off hard surfaces', () => {
  const wall = (sc: LegScene, p: LegScene['players'][number], mat: 'steel' | 'wood') => {
    const { from } = target(sc, p, 30);
    const fz = from.z + 1;
    sc.obs.add({ id: newAabbId(), minX: from.x - 4, maxX: from.x + 4, minZ: fz - 0.03, maxZ: fz + 0.03, y0: from.y - 3, y1: from.y + 3, kind: 'partition', hp: 99999, mat });
    sc.P.addStaticBox(from.x, from.y, fz, 4, 3, 0.03);
    return { from, fz };
  };
  /** Fire a pistol round at a wall along (dx, dz) from just in front of it, and report whether it skipped. */
  const fired = (sc: LegScene, from: { x: number; y: number; z: number }, fz: number, dx: number, dz: number, tries = 14) => {
    let skipped = 0;
    let vz = 0;
    let dmg = 27;
    for (let n = 0; n < tries; n++) {
      sc.combat.clear();
      const l = Math.hypot(dx, dz);
      sc.combat.shoot(from.x - 2.5, from.y, fz - 0.5, dx / l, 0, dz / l, { side: 'convoy', damage: 27, range: 40, ammo: 'pistol', tracer: false });
      for (let i = 0; i < 12; i++) {
        sc.tick(DT);
        const b = sc.combat.bullets[0];
        if (b?.skipped) {
          skipped++;
          vz = b.vz;
          dmg = b.o.damage;
          break;
        }
      }
    }
    return { skipped, vz, dmg };
  };

  it('a glancing round off a steel plate skips, and leaves weaker and heading away', () => {
    const { sc, p } = scene();
    const { from, fz } = wall(sc, p, 'steel');
    const r = fired(sc, from, fz, 1, 0.2);
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.vz).toBeLessThan(0);
    expect(r.dmg).toBeLessThan(27);
  });

  it('a head-on round into the same plate does not skip, and nor does a glancing one into planks', () => {
    const { sc, p } = scene();
    const steel = wall(sc, p, 'steel');
    // Straight at it from in front.
    let skipped = 0;
    for (let n = 0; n < 8; n++) {
      sc.combat.clear();
      sc.combat.shoot(steel.from.x, steel.from.y, steel.fz - 3, 0, 0, 1, { side: 'convoy', damage: 27, range: 40, ammo: 'pistol', tracer: false });
      for (let i = 0; i < 12; i++) {
        sc.tick(DT);
        if (sc.combat.bullets[0]?.skipped) skipped++;
      }
    }
    expect(skipped).toBe(0);
    const { sc: sc2, p: p2 } = scene();
    const wood = wall(sc2, p2, 'wood');
    expect(fired(sc2, wood.from, wood.fz, 1, 0.2).skipped).toBe(0);
  });
});

describe('thrown fire', () => {
  it('a bottle in the air is a thing you can see, and it is hidden once it has burst', () => {
    const { sc, p } = scene();
    sc.campaign.items.molotov = 3;
    sc.projectiles.throw('molotov', p.pos.x + 20, sc.groundAt(p.pos.x + 20, p.pos.z) + 3, p.pos.z, 0, 0, 2, p);
    const f = sc.projectiles.flying[0];
    expect(f.mesh).not.toBeNull();
    expect(f.mesh!.visible).toBe(true);
    sc.tick(DT);
    expect(f.mesh!.position.y).toBeCloseTo(f.y, 5);
    run(sc, 2);
    expect(sc.projectiles.flying).toHaveLength(0);
    expect(f.mesh!.visible).toBe(false);
    expect(sc.projectiles.burners.some((b) => b.kind === 'fire')).toBe(true);
  });

  it('a bottle bursts on the first body it reaches, not further on at the ground', () => {
    const { sc, p } = scene();
    const x = p.pos.x + 20;
    const z = p.pos.z;
    const zb = sc.zombies.spawn('walker', x, z + 3.5, true);
    zb.y = sc.groundAt(zb.x, zb.z);
    zb.hp = 5000;
    // Flat and fast, a little above the zombie's chest, heading straight at it. Left alone it would come down past it.
    sc.projectiles.throw('molotov', x, zb.y + 1.1, z, 0, 0, 12, p);
    sc.projectiles.flying[0].vy = 0;
    const landsAt = z + 12 * Math.sqrt((2 * 1.0) / 18);
    expect(landsAt).toBeGreaterThan(zb.z);
    for (let i = 0; i < 90 && sc.projectiles.flying.length; i++) sc.tick(DT);
    const fire = sc.projectiles.burners.find((b) => b.kind === 'fire');
    expect(fire).toBeDefined();
    expect(fire!.z).toBeLessThan(zb.z);
    expect(fire!.z).toBeGreaterThan(zb.z - 1.5);
  });

  it('a flare in the air is a thing you can see too', () => {
    const { sc, p } = scene();
    sc.projectiles.throw('flare', p.pos.x + 20, sc.groundAt(p.pos.x + 20, p.pos.z) + 3, p.pos.z, 0, 0, 2, p);
    expect(sc.projectiles.flying[0].mesh!.visible).toBe(true);
    run(sc, 2);
    expect(sc.projectiles.burners.some((b) => b.kind === 'flare')).toBe(true);
  });
});
