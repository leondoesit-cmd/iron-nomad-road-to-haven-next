import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { equipFromBag, newGear } from '../src/sim/gear';
import { maskOf } from '../src/sim/ballistics';
import { PART_BIT } from '../src/sim/anatomy';
import { snapShare } from '../src/sim/treeDamage';
import {
  animalSection, BLADE, bladeWork, bodySection, chopGain, cutLine, deepen, DEAD_TOUGH, FLESH, sectionCost, stemCost, stroke, sweepCapsule, swingPlane,
  type BladeKind, type CutLine, type Section,
} from '../src/sim/blade';
import { vegetationIn, type VegetationPlant } from '../src/render/vegetation';
import { cutsOn } from '../src/game/bladeSwing';
import { fakeServices } from './helpers/sim';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics();
});

/** Strokes of a blade at full swing it takes to get through a section (99 if it never does). */
function strokesThrough(kind: BladeKind, sec: Section, mul = 1, tough = FLESH.rotten): number {
  const spec = BLADE[kind];
  const cost = sectionCost(sec, tough, mul);
  let done = 0;
  for (let n = 1; n <= 99; n++) {
    const s = stroke(spec, bladeWork(spec), cost, done, sec.width);
    if (s.through) return n;
    done = s.done;
  }
  return 99;
}

describe('the rules of a blade', () => {
  it('a machete carries about a hundred joules at its sweet spot, a knife a fraction of that, an axe more', () => {
    expect(bladeWork(BLADE.machete)).toBeGreaterThan(80);
    expect(bladeWork(BLADE.machete)).toBeLessThan(120);
    expect(bladeWork(BLADE.knife)).toBeLessThan(bladeWork(BLADE.machete) / 3);
    expect(bladeWork(BLADE.axe)).toBeGreaterThan(bladeWork(BLADE.machete));
  });

  it('a machete takes one of the dead\'s neck, arm or leg in one stroke, the waist in more than one', () => {
    expect(strokesThrough('machete', bodySection('head', 1.56))).toBe(1);
    expect(strokesThrough('machete', bodySection('armL', 1.0))).toBe(1);
    expect(strokesThrough('machete', bodySection('legR', 0.7))).toBe(1);
    expect(strokesThrough('machete', bodySection('torso', 1.1))).toBeGreaterThanOrEqual(2);
    // The top of the skull is mostly bone: harder going than the neck under it.
    expect(sectionCost(bodySection('head', 1.72), FLESH.rotten)).toBeGreaterThan(sectionCost(bodySection('head', 1.56), FLESH.rotten) * 1.5);
  });

  it('density counts: a brute\'s neck takes more strokes than a walker\'s, a knife more than a machete', () => {
    const walker = strokesThrough('machete', bodySection('head', 1.56));
    const brute = strokesThrough('machete', bodySection('head', 1.56, 1.45), DEAD_TOUGH.brute);
    expect(brute).toBeGreaterThan(walker);
    expect(strokesThrough('knife', bodySection('legL', 0.75))).toBeGreaterThan(strokesThrough('machete', bodySection('legL', 0.75)));
    // A knife is too short to get through a waist in one go, however hard it is swung.
    const spec = BLADE.knife;
    const waist = bodySection('torso', 1.1);
    expect(stroke(spec, 1e6, sectionCost(waist, FLESH.rotten), 0, waist.width).through).toBe(false);
  });

  it('a beast: a deer\'s leg goes in one stroke, a bear\'s takes several, and a body is never parted', () => {
    expect(strokesThrough('machete', animalSection('deer', 'legLF'), 1, FLESH.living)).toBe(1);
    expect(strokesThrough('machete', animalSection('bear', 'legLF'), 1.7, FLESH.living)).toBeGreaterThan(1);
    expect(strokesThrough('machete', animalSection('bear', 'head'), 1.7, FLESH.living)).toBeGreaterThan(strokesThrough('machete', animalSection('deer', 'head'), 1, FLESH.living));
  });

  it('what a stroke does not spend carries on: through grass hardly slowed, stopped dead in a body it does not get through', () => {
    const spec = BLADE.machete;
    const w = bladeWork(spec);
    const grass = stroke(spec, w, stemCost('grass', 0.3), 0, 0.1);
    expect(grass.through).toBe(true);
    expect(grass.left).toBeGreaterThan(w * 0.9);
    const waist = bodySection('torso', 1.1);
    const body = stroke(spec, w, sectionCost(waist, FLESH.rotten), 0, waist.width);
    expect(body.through).toBe(false);
    expect(body.left).toBe(0);
  });

  it('a bush lops easily near its top and takes strokes at its thick stems near the ground', () => {
    const spec = BLADE.machete;
    const top = stroke(spec, bladeWork(spec), stemCost('shrubs', 0.75, 1.2), 0, 0.4);
    expect(top.through).toBe(true);
    let done = 0;
    let n = 0;
    for (; n < 20; n++) {
      const s = stroke(spec, bladeWork(spec), stemCost('shrubs', 0.08, 1.2), done, 0.4);
      done = s.done;
      if (s.through) break;
    }
    expect(n + 1).toBeGreaterThan(1);
    // A flower or a clump of grass: next to nothing.
    expect(stemCost('flowers', 0.5)).toBeLessThan(3);
  });

  it('a machete fells a sapling in a handful of chops and barely dents a big trunk; an axe is far quicker', () => {
    const chops = (kind: BladeKind, d: number, hard = 1) => {
      const section = (Math.PI * d * d) / 4;
      let done = 0;
      for (let n = 1; n < 2000; n++) {
        done = Math.min(1, done + chopGain(BLADE[kind], bladeWork(BLADE[kind]), section, d, done, hard));
        if (done >= snapShare(0)) return n;
      }
      return Infinity;
    };
    expect(chops('machete', 0.08)).toBeLessThanOrEqual(8);
    expect(chops('machete', 0.4)).toBeGreaterThan(60);
    expect(chops('axe', 0.3)).toBeLessThan(chops('machete', 0.3) / 2);
  });

  it('strokes at the same place deepen one cut; a stroke elsewhere starts another', () => {
    const lines: CutLine[] = [];
    const a = cutLine(lines, 'legL', 0.6);
    deepen(a, 0.6, { gain: 0.4, done: 0.4, through: false, left: 0 });
    const b = cutLine(lines, 'legL', 0.64);
    expect(b).toBe(a);
    deepen(b, 0.64, { gain: 0.3, done: 0.7, through: false, left: 0 });
    expect(a.done).toBeCloseTo(0.7, 5);
    expect(a.y).toBeGreaterThan(0.6);
    expect(a.y).toBeLessThan(0.64);
    expect(cutLine(lines, 'legL', 0.3)).not.toBe(a);
    expect(cutLine(lines, 'armL', 0.62)).not.toBe(a);
  });
});

describe('the sweep', () => {
  // Standing at the origin, shoulder 1.45 up, looking level along +z.
  const pl = (style: 'fore' | 'back' | 'over') => swingPlane([0, 1.45, 0], [0, 0, 1], style, 1.6, 0.46);

  it('a stem a centimetre thick in front is struck where the plane crosses it, not slipped past', () => {
    const c = sweepCapsule(pl('fore'), [0, 0, 1.2], [0, 3, 1.2], 0.005);
    expect(c).not.toBeNull();
    expect(c!.y).toBeGreaterThan(1.3);
    expect(c!.y).toBeLessThan(1.6);
    // Behind, and out of reach, nothing.
    expect(sweepCapsule(pl('fore'), [0, 0, -1.2], [0, 3, -1.2], 0.05)).toBeNull();
    expect(sweepCapsule(pl('fore'), [0, 0, 3], [0, 3, 3], 0.05)).toBeNull();
  });

  it('a forehand comes down from the right: it reaches a stem on the right first, and crosses it higher', () => {
    const fore = pl('fore');
    const right = sweepCapsule(fore, [-0.4, 0, 1.1], [-0.4, 3, 1.1], 0.01)!;
    const left = sweepCapsule(fore, [0.4, 0, 1.1], [0.4, 3, 1.1], 0.01)!;
    expect(right.angle).toBeGreaterThan(left.angle);
    expect(right.y).toBeGreaterThan(left.y + 0.3);
    // A backhand the other way, flatter.
    const back = pl('back');
    const r2 = sweepCapsule(back, [-0.4, 0, 1.1], [-0.4, 3, 1.1], 0.01)!;
    const l2 = sweepCapsule(back, [0.4, 0, 1.1], [0.4, 3, 1.1], 0.01)!;
    expect(l2.angle).toBeGreaterThan(r2.angle);
    expect(l2.y - r2.y).toBeLessThan(right.y - left.y);
  });

  it('an overhead chop meets an upright body at the top first', () => {
    const c = sweepCapsule(pl('over'), [0, 0, 1.1], [0, 1.7, 1.1], 0.12)!;
    expect(c).not.toBeNull();
    expect(c.y).toBeGreaterThan(1.6);
  });
});

// ------------------------------------------------------------------ in a scene

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

function equip(p: LegScene['players'][number], id: string) {
  const it = newGear(id);
  p.gear.bag.push(it);
  expect(equipFromBag(p.gear, it.uid, 3).ok).toBe(true);
  p.refreshGear();
}

/** Look at a point (feet-level `y` plus `height`) straight ahead at `d` metres, and swing once. */
function swingAt(h: ReturnType<typeof fakeServices>, sc: LegScene, p: LegScene['players'][number], height: number, d: number) {
  p.aimYaw = 0;
  const eye = p.pos.y + (p as unknown as { eyeH: number }).eyeH;
  p.aimPitch = Math.atan2(height - eye, d - 0.08);
  p.meleeCd = 0;
  h.intents[0].device = 'pad';
  h.intents[0].rt = 1;
  sc.tick(DT);
  h.intents[0].rt = 0;
  // The blow lands part-way through the swing; let it land and the swing finish.
  run(sc, 0.45);
}

function walker(sc: LegScene, p: LegScene['players'][number], d = 1.15, kind: 'walker' | 'brute' = 'walker') {
  const zb = sc.zombies.spawn(kind, p.pos.x, p.pos.z + d, true);
  zb.y = sc.groundAt(zb.x, zb.z);
  zb.yaw = Math.PI;
  zb.hp = 5000;
  zb.stun = 99;
  return zb;
}

describe('a machete in the world', { timeout: 90_000 }, () => {
  it('aimed at the neck it takes the head; aimed at the knee, the leg', () => {
    const { h, sc, p } = scene();
    equip(p, 'm_machete');
    const zb = walker(sc, p);
    swingAt(h, sc, p, zb.y + 1.56, 1.15);
    expect(zb.wounds.mask & maskOf('head')).toBe(maskOf('head'));
    expect(zb.wounds.mask & (maskOf('legL') | maskOf('legR'))).toBe(0);

    const z2 = walker(sc, p, 1.1);
    z2.x += 4;
    p.placeAt(p.pos.x + 4, p.pos.z, 0);
    run(sc, 0.2);
    swingAt(h, sc, p, z2.y + 0.5, 1.1);
    expect(z2.wounds.mask & (maskOf('legL') | maskOf('legR'))).not.toBe(0);
    expect(z2.wounds.mask & maskOf('head')).toBe(0);
  });

  it('a brute\'s neck takes more than one stroke, and each one goes into the same cut', () => {
    const { h, sc, p } = scene();
    equip(p, 'm_machete');
    const zb = walker(sc, p, 1.3, 'brute');
    const neck = zb.y + 1.56 * zb.def.scale;
    swingAt(h, sc, p, neck, 1.3);
    expect(zb.wounds.mask & maskOf('head')).toBe(0);
    const cut = cutsOn(zb).find((l) => l.part === 'head');
    expect(cut?.done ?? 0).toBeGreaterThan(0.1);
    let n = 1;
    while (!(zb.wounds.mask & maskOf('head')) && n < 8) {
      swingAt(h, sc, p, neck, 1.3);
      n++;
    }
    expect(n).toBeGreaterThan(1);
    expect(zb.wounds.mask & maskOf('head')).toBe(maskOf('head'));
  });

  it('one of the dead lying on the ground is hacked where the edge comes down on it', () => {
    const { h, sc, p } = scene();
    equip(p, 'm_machete');
    const zb = walker(sc, p, 1.6);
    zb.stun = 0;
    sc.zombies.damage(zb, 99999, { fromX: p.pos.x, fromZ: p.pos.z, killer: 0 });
    run(sc, 2.5);
    const lying = [...sc.zombies.lyingBodies()].find((b) => b.zb === zb);
    expect(lying).toBeTruthy();
    const s = lying!.segs;
    // Stand back from its middle and chop down onto it.
    p.placeAt(s[3], s[5] - 1.0, 0);
    run(sc, 0.2);
    const hack = vi.spyOn(sc.zombies, 'hackAt');
    swingAt(h, sc, p, s[4], 1.0);
    expect(p.swingStyle).toBe('over');
    expect(hack).toHaveBeenCalled();
    expect(hack.mock.calls[0][1]).toBe(zb);
  });

  it('a deer\'s leg comes off where the edge crosses it', () => {
    const { h, sc, p } = scene();
    equip(p, 'm_machete');
    const deer = sc.wildlife.spawn('deer', p.pos.x, p.pos.z + 1.15);
    deer.y = sc.groundAt(deer.x, deer.z);
    deer.yaw = Math.PI / 2;
    deer.hp = 5000;
    deer.stun = 99;
    swingAt(h, sc, p, deer.y + 0.35, 1.15);
    const legs = PART_BIT.legLF | PART_BIT.legRF | PART_BIT.legLB | PART_BIT.legRB;
    expect(deer.wounds.mask & legs).not.toBe(0);
  });

  it('grass and a bush in the arc are cut down and throw their pieces, and the blade goes on through the grass', () => {
    const { h, sc, p } = scene();
    equip(p, 'm_machete');
    const near = (kinds: string[]) => {
      let best: VegetationPlant | null = null;
      let bd = Infinity;
      for (const veg of vegetationIn(sc.P)) for (const pl of veg.plants) {
        if (!kinds.includes(pl.kind) || pl.record.broken) continue;
        const d = Math.hypot(pl.position.x - p.pos.x, pl.position.z - p.pos.z);
        if (d < bd) {
          bd = d;
          best = pl;
        }
      }
      return best!;
    };
    const bush = near(['shrubs']);
    expect(bush).toBeTruthy();
    // Stand a metre short of the bush, facing it, and swing into its upper half.
    p.placeAt(bush.position.x, bush.position.z - 1.1, 0);
    run(sc, 0.2);
    const chips = sc.gore.timber.chips;
    const before = chips.count('leaf') + chips.count('chip');
    swingAt(h, sc, p, bush.position.y + bush.height * 0.7, 1.1);
    expect(bush.record.trim ?? 1).toBeLessThan(0.85);
    expect(chips.count('leaf') + chips.count('chip')).toBeGreaterThan(before);

    const grass = near(['grass']);
    p.placeAt(grass.position.x, grass.position.z - 1.0, 0);
    run(sc, 0.2);
    // Looking down at the clump: an overhead chop through it into the earth.
    swingAt(h, sc, p, grass.position.y + grass.height * 0.4, 1.0);
    expect(grass.record.trim ?? 1).toBeLessThan(1);
  });

  it('a dead tree takes a notch and throws chips with each chop, and goes over in the end', () => {
    const { h, sc, p } = scene();
    equip(p, 'm_axe');
    let tree: VegetationPlant | null = null;
    for (const veg of vegetationIn(sc.P)) for (const pl of veg.plants) if (pl.kind === 'deadTree' && !pl.record.broken) tree = pl;
    expect(tree).toBeTruthy();
    const t = tree!;
    p.placeAt(t.position.x, t.position.z - 1.0, 0);
    run(sc, 0.3);
    const chips = sc.gore.timber.chips;
    const before = chips.count('chip');
    swingAt(h, sc, p, t.position.y + 0.9, 1.0);
    expect(Math.max(0, ...(t.record.notch ?? [0]))).toBeGreaterThan(0);
    expect(chips.count('chip')).toBeGreaterThan(before);
    for (let i = 0; i < 40 && !t.record.broken; i++) swingAt(h, sc, p, t.position.y + 0.9, 1.0);
    expect(t.record.broken).toBe(true);
  });
});
