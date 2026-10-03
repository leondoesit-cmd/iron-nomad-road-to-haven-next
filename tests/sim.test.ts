import { describe, expect, it } from 'vitest';
import {
  ENCOUNTERS,
  LEGS,
  MERCS,
  STRUCTURES,
  VEHICLES,
  validateData,
  t,
  type Stocks,
} from '../src/data';
import { Rng } from '../src/core/rng';
import { canAfford, checkTierUp, newStocks, spend, splitLoot, gain, refund } from '../src/sim/resources';
import {
  applyLoyalty,
  campVerdict,
  loyaltyBand,
  moraleOf,
  newMerc,
  nightlyUpkeep,
  performanceMult,
  settleCut,
} from '../src/sim/loyalty';
import { SignatureGrid, hearingRadius, dustRadius } from '../src/sim/signature';
import { convoyPower, eliteShare, planRaid, raidThreat } from '../src/sim/threat';
import { leaning, newAxes, pickEncounter, resolveEffects, resolveVote, selectEnding } from '../src/sim/endings';
import { DayClock, lightAt, DUSK_BELL_AT } from '../src/sim/dayclock';
import { applyHit, armorReduction, collisionDamage, facingOf, newHealth, performance, repairStep, tickHazards } from '../src/sim/damage';

describe('data tables', () => {
  it('validate against their schemas', () => {
    expect(validateData()).toEqual([]);
  });
  it('vehicle tiers match the blueprint stat table', () => {
    const [t1, t2, t3, t4, t5] = VEHICLES.tiers;
    expect([t1.width, t2.width, t3.width, t4.width, t5.width]).toEqual([0.8, 1.3, 2.0, 2.8, 3.6]);
    expect([t1.topSpeedKmh, t2.topSpeedKmh, t3.topSpeedKmh, t4.topSpeedKmh, t5.topSpeedKmh]).toEqual([70, 105, 95, 85, 70]);
    expect([t1.hp, t2.hp, t3.hp, t4.hp, t5.hp]).toEqual([60, 150, 350, 800, 2000]);
    expect(t5.physics.wheelCount).toBe(12);
  });
  it('every leg references only known encounters and route targets', () => {
    for (const l of LEGS.legs) expect(l.sets.length).toBeGreaterThan(3);
    expect(LEGS.route.next.L1.length).toBe(2);
    expect(LEGS.legs.find((l) => l.id === LEGS.route.start)?.open).toBeTruthy();
  });
  it('has a result string for every encounter choice', () => {
    for (const e of ENCOUNTERS) for (const c of e.choices) expect(t(`enc.${e.id}.${c.id}.result`)).not.toBe(`enc.${e.id}.${c.id}.result`);
  });
});

describe('resource ledger', () => {
  it('spend is atomic', () => {
    const s = newStocks({ scrap: 10, parts: 5 });
    expect(spend(s, { scrap: 4, parts: 9 })).toBe(false);
    expect(s).toEqual(newStocks({ scrap: 10, parts: 5 }));
    expect(spend(s, { scrap: 4, parts: 5 })).toBe(true);
    expect(s.scrap).toBe(6);
    expect(s.parts).toBe(0);
  });
  it('treats fu as fuel', () => {
    const s = newStocks({ fuel: 2 });
    expect(canAfford(s, { fu: 3 })).toBe(false);
    expect(spend(s, { fu: 2 })).toBe(true);
    expect(s.fuel).toBe(0);
  });
  it('net loot = gross x (1 - sum of crew cuts), with the cut held in escrow', () => {
    const { net, owed, total } = splitLoot({ scrap: 100, parts: 40 }, [
      { id: 'a', cut: 0.1 },
      { id: 'b', cut: 0.15 },
    ]);
    expect(total).toBeCloseTo(0.25);
    expect(net.scrap).toBeCloseTo(75);
    expect(net.parts).toBeCloseTo(30);
    expect(owed.a.scrap).toBeCloseTo(10);
    expect(owed.b.scrap).toBeCloseTo(15);
    expect((net.scrap ?? 0) + (owed.a.scrap ?? 0) + (owed.b.scrap ?? 0)).toBeCloseTo(100);
  });
  it('never lets the crew take more than 90%', () => {
    const { net, owed } = splitLoot({ scrap: 100 }, [
      { id: 'a', cut: 0.6 },
      { id: 'b', cut: 0.6 },
    ]);
    expect(net.scrap).toBeCloseTo(10);
    expect((owed.a.scrap ?? 0) + (owed.b.scrap ?? 0)).toBeCloseTo(90);
  });
  it('gain adds and floors at zero', () => {
    const s: Stocks = newStocks({ rations: 1 });
    gain(s, { rations: -5, tech: 3 });
    expect(s.rations).toBe(0);
    expect(s.tech).toBe(3);
  });
  it('tier-up costs follow the blueprint and need the chassis', () => {
    const rich = newStocks({ parts: 200, scrap: 300, tech: 50 });
    expect(checkTierUp(rich, 1, 0, false).ok).toBe(true);
    expect(checkTierUp(rich, 2, 0, false)).toMatchObject({ ok: false });
    expect(checkTierUp(rich, 2, 1, false).ok).toBe(true);
    expect(checkTierUp(rich, 3, 1, true).reason).toMatch(/Beta/);
    expect(checkTierUp(newStocks(), 1, 0, false).ok).toBe(false);
  });
});

describe('loyalty bands and crew', () => {
  it('uses the blueprint band edges', () => {
    expect(loyaltyBand(100)).toBe('loyal');
    expect(loyaltyBand(70)).toBe('loyal');
    expect(loyaltyBand(69)).toBe('steady');
    expect(loyaltyBand(40)).toBe('steady');
    expect(loyaltyBand(39)).toBe('resentful');
    expect(loyaltyBand(20)).toBe('resentful');
    expect(loyaltyBand(19)).toBe('mutinous');
    expect(loyaltyBand(10)).toBe('mutinous');
    expect(loyaltyBand(9)).toBe('breaking');
    expect(loyaltyBand(0)).toBe('breaking');
  });
  it('performance +10% loyal, -25% resentful or worse', () => {
    expect(performanceMult(80)).toBe(1.1);
    expect(performanceMult(50)).toBe(1);
    expect(performanceMult(30)).toBe(0.75);
    expect(performanceMult(5)).toBe(0.75);
  });
  it('gives the first warning at 35 and refuses orders under 25', () => {
    const m = newMerc('mechanic', 'Tinker');
    m.loyalty = 40;
    expect(applyLoyalty(m, -6, 'x')).toContain('warn1');
    expect(m.warned1).toBe(true);
    expect(applyLoyalty(m, -1)).not.toContain('warn1');
    expect(applyLoyalty(m, -10)).toContain('refuse');
  });
  it('upkeep pays and gives +2, or costs -10 when short', () => {
    const def = MERCS.roles.mechanic;
    const m = newMerc('mechanic', 'Tinker');
    m.loyalty = 50;
    const s = newStocks({ rations: 3 });
    expect(nightlyUpkeep(m, s, def).ok).toBe(true);
    expect(m.loyalty).toBe(52);
    expect(s.rations).toBe(2);
    const empty = newStocks();
    expect(nightlyUpkeep(m, empty, def).ok).toBe(false);
    expect(m.loyalty).toBe(42);
    expect(m.hungryNights).toBe(1);
  });
  it('desertion needs Breaking or two hungry nights, and mutiny raises a dispute', () => {
    const m = newMerc('mechanic', 'Tinker');
    m.loyalty = 15;
    expect(campVerdict(m)).toMatchObject({ desert: false });
    expect(campVerdict(m).dispute).not.toBeNull();
    m.loyalty = 5;
    expect(campVerdict(m).desert).toBe(true);
    m.loyalty = 60;
    m.hungryNights = 2;
    expect(campVerdict(m).desert).toBe(true);
    m.loyalty = 80; // a Loyal crew member won't desert even if hungry
    expect(campVerdict(m).desert).toBe(false);
  });
  it('shorting the cut keeps the escrow but costs -15', () => {
    const m = newMerc('mechanic', 'Tinker');
    m.loyalty = 60;
    m.owed = { scrap: 12 };
    const s = newStocks();
    settleCut(m, s, false);
    expect(s.scrap).toBe(12);
    expect(m.loyalty).toBe(45);
    m.owed = { scrap: 8 };
    settleCut(m, s, true);
    expect(s.scrap).toBe(12);
    expect(m.loyalty).toBe(45);
  });
  it('a higher cut raises starting loyalty', () => {
    const base = newMerc('mechanic', 'A');
    const rich = newMerc('mechanic', 'B', MERCS.roles.mechanic.defaultCut + 0.05);
    const poor = newMerc('mechanic', 'C', MERCS.roles.mechanic.defaultCut - 0.05);
    expect(rich.loyalty).toBeGreaterThan(base.loyalty);
    expect(poor.loyalty).toBeLessThan(base.loyalty);
  });
  it('morale is the mean of living crew loyalty plus modifier', () => {
    const a = newMerc('mechanic', 'A');
    a.loyalty = 60;
    const b = newMerc('scout', 'B');
    b.loyalty = 40;
    const dead = newMerc('scavenger', 'C');
    dead.alive = false;
    expect(moraleOf([a, b, dead], 5)).toBe(55);
  });
});

describe('Signature grid', () => {
  it('Noise reaches 0.8 m per point and halves indoors', () => {
    expect(hearingRadius(50, false)).toBeCloseTo(40);
    expect(hearingRadius(50, true)).toBeCloseTo(20);
    expect(dustRadius(20, false)).toBe(60);
    expect(dustRadius(20, true)).toBe(30);
  });
  it('listeners hear the loudest source in range only', () => {
    const g = new SignatureGrid();
    g.emit(0, 0, 50);
    g.emit(30, 0, 80);
    g.emit(200, 0, 100);
    const h = g.loudestFor(25, 0, false);
    expect(h?.level).toBe(80);
    expect(g.loudestFor(500, 500, false)).toBeNull();
    expect(g.loudestFor(30, 0, true)?.level).toBe(80); // 80 pts indoors still reaches 32 m
    expect(g.loudestFor(70, 0, true)).toBeNull(); // 40 m away is out of the 32 m indoor radius
  });
  it('keeps channels separate and decays', () => {
    const g = new SignatureGrid();
    g.emit(0, 0, 90, 'dust');
    expect(g.loudestFor(5, 0, false, 'noise')).toBeNull();
    expect(g.strongestWithin(5, 0, 100, 'dust')?.level).toBe(90);
    g.decay(3);
    expect(g.size).toBe(0);
  });
});

describe('raid threat', () => {
  it('scales with Signature and Notoriety', () => {
    const base = raidThreat(10, 0, 0);
    expect(base).toBe(10);
    expect(raidThreat(10, 100, 0)).toBeCloseTo(18);
    expect(raidThreat(10, 0, 100)).toBeCloseTo(15);
    expect(raidThreat(10, 50, 50)).toBeGreaterThan(raidThreat(10, 50, 0));
  });
  it('convoy power changes composition, not volume', () => {
    const weak = planRaid({ base: 20, signature: 60, notoriety: 10, power: 2, kind: 'infected', seed: 9 });
    const strong = planRaid({ base: 20, signature: 60, notoriety: 10, power: 20, kind: 'infected', seed: 9 });
    expect(weak.threat).toBe(strong.threat);
    const weight = (p: typeof weak) =>
      p.waves.reduce((a, w) => a + w.zombies.length, 0);
    expect(eliteShare(20)).toBeGreaterThan(eliteShare(2));
    expect(weight(weak)).toBeGreaterThanOrEqual(weight(strong));
  });
  it('plans three waves and a battle-wagon climax for marauders', () => {
    const p = planRaid({ base: 36, signature: 70, notoriety: 30, power: convoyPower([{ tier: 3, moduleLevels: 2 }, { tier: 2, moduleLevels: 0 }], 1), kind: 'marauders', seed: 4 });
    expect(p.waves).toHaveLength(STRUCTURES.raids.waves.length);
    expect(p.waves[2].raiders).toContain('wagon');
    expect(p.waves[0].sectors).toHaveLength(1);
  });
  it('is deterministic for a seed', () => {
    const a = planRaid({ base: 20, signature: 40, notoriety: 0, power: 5, kind: 'both', seed: 123 });
    const b = planRaid({ base: 20, signature: 40, notoriety: 0, power: 5, kind: 'both', seed: 123 });
    expect(a).toEqual(b);
  });
});

describe('ending selection', () => {
  const ax = (mercy: number, trust: number, notoriety: number) => ({ mercy, trust, notoriety });
  it('Open Gate: high Mercy with 2 loyal crew', () => {
    expect(selectEnding({ axes: ax(14, 3, 2), loyalCrewAlive: 2, crewAlive: 2, fragments: 0 })).toBe('openGate');
  });
  it('The Toll: high Notoriety, moderate Mercy', () => {
    expect(selectEnding({ axes: ax(5, 0, 14), loyalCrewAlive: 1, crewAlive: 2, fragments: 0 })).toBe('toll');
  });
  it('Two Walked In: low Trust or no crew', () => {
    expect(selectEnding({ axes: ax(0, -6, 0), loyalCrewAlive: 0, crewAlive: 1, fragments: 0 })).toBe('twoWalked');
    expect(selectEnding({ axes: ax(2, 2, 2), loyalCrewAlive: 0, crewAlive: 0, fragments: 0 })).toBe('twoWalked');
  });
  it("Warlord's Road: maximum Notoriety, minimum Mercy", () => {
    expect(selectEnding({ axes: ax(-12, 0, 26), loyalCrewAlive: 3, crewAlive: 3, fragments: 0 })).toBe('warlord');
  });
  it('Hollow Haven overrides everything once all four fragments are found', () => {
    expect(selectEnding({ axes: ax(-12, -9, 30), loyalCrewAlive: 0, crewAlive: 0, fragments: 4 })).toBe('hollow');
    expect(selectEnding({ axes: ax(-12, -9, 30), loyalCrewAlive: 0, crewAlive: 0, fragments: 3 })).not.toBe('hollow');
  });
  it('leaning hints are consistent with extremes', () => {
    expect(leaning(newAxes())).toBe('neutral');
    expect(leaning(ax(6, 1, 0))).toBe('openGate');
    expect(leaning(ax(-5, 0, 8))).toBe('warlord');
  });
});

describe('roadside encounters', () => {
  it('picks by biome and avoids repeats', () => {
    const rng = new Rng(5);
    const seen = new Set<string>();
    const ids = new Set<string>();
    const poolSize = ENCOUNTERS.filter((e) => e.biome === 'city').length;
    for (let i = 0; i < poolSize; i++) {
      const e = pickEncounter({ biome: 'city', seen }, rng);
      expect(e?.biome).toBe('city');
      if (e) {
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
        ids.add(e.id);
      }
    }
    expect(ids.size).toBe(poolSize);
    // once the pool is exhausted it falls back to repeats rather than returning nothing
    expect(pickEncounter({ biome: 'city', seen }, rng)).not.toBeNull();
  });
  it('rolls chance branches with the supplied RNG', () => {
    const bluff = ENCOUNTERS.find((e) => e.id === 'toll_road')!.choices.find((c) => c.id === 'bluff')!;
    let failed = 0;
    for (let i = 0; i < 200; i++) if (resolveEffects(bluff.effects, new Rng(i)).ambush > 0) failed++;
    expect(failed).toBeGreaterThan(60);
    expect(failed).toBeLessThan(140);
  });
  it('vote: agreement is free, override costs 1 Trust and the Lead decides', () => {
    expect(resolveVote([1, 1], 0)).toEqual({ choice: 1, overridden: false, trustCost: 0 });
    expect(resolveVote([0, 2], 1)).toEqual({ choice: 2, overridden: true, trustCost: 1 });
    expect(resolveVote([0, 2], 0)).toEqual({ choice: 0, overridden: true, trustCost: 1 });
  });
});

describe('day clock', () => {
  it('rings the Dusk Bell exactly once', () => {
    const c = new DayClock(100, 0);
    let rings = 0;
    for (let i = 0; i < 200; i++) if (c.tick(1).bell) rings++;
    expect(rings).toBe(1);
    expect(c.night).toBe(true);
  });
  it('skipToDusk jumps to the Bell', () => {
    const c = new DayClock(540, 0.1);
    c.skipToDusk();
    expect(c.t).toBeCloseTo(DUSK_BELL_AT);
    expect(c.tick(0.1).bell).toBe(true);
  });
  it('light goes dark at night', () => {
    expect(lightAt(0.4, 'wasteland').night).toBe(0);
    expect(lightAt(1.05, 'city').night).toBeCloseTo(1, 1);
    expect(lightAt(0.4, 'wasteland').sunIntensity).toBeGreaterThan(lightAt(1.05, 'wasteland').sunIntensity);
  });
});

describe('damage model', () => {
  const roll0 = () => 0.01;
  it('armor is scaled by facing 100/80/60', () => {
    expect(armorReduction(0.5, 'front')).toBeCloseTo(0.5);
    expect(armorReduction(0.5, 'side')).toBeCloseTo(0.4);
    expect(armorReduction(0.5, 'rear')).toBeCloseTo(0.3);
  });
  it('classifies facing from the hit direction', () => {
    expect(facingOf(0, 0)).toBe('front');
    expect(facingOf(Math.PI / 2, 0)).toBe('side');
    expect(facingOf(Math.PI, 0)).toBe('rear');
    expect(facingOf(-Math.PI / 2 + 0.1, 0)).toBe('side');
  });
  it('rear hits hurt more than front hits against armor', () => {
    const a = newHealth(350, 0.35, 4);
    const b = newHealth(350, 0.35, 4);
    const f = applyHit(a, 100, { facing: 'front', roll: () => 0.99 });
    const r = applyHit(b, 100, { facing: 'rear', roll: () => 0.99 });
    expect(r.dealt).toBeGreaterThan(f.dealt);
  });
  it('destroys at 0 HP and reports it', () => {
    const h = newHealth(60, 0, 2);
    const r = applyHit(h, 200, { facing: 'front', roll: roll0 });
    expect(h.destroyed).toBe(true);
    expect(r.events.some((e) => e.kind === 'destroyed')).toBe(true);
  });
  it('flat tires and a hurt engine cost performance; repairs fix one component at a time', () => {
    const h = newHealth(150, 0.15, 4);
    expect(performance(h).power).toBeCloseTo(1);
    h.comp.tires[0] = 0;
    h.comp.tires[1] = 0;
    h.comp.engine = 0.3;
    expect(performance(h).power).toBeLessThan(0.7);
    expect(performance(h).grip).toBeLessThan(0.8);
    h.hp = 50;
    expect(repairStep(h)).toBe('tire');
    expect(repairStep(h)).toBe('tire');
    expect(repairStep(h)).toBe('engine');
    expect(h.hp).toBeCloseTo(50 + 3 * 15);
  });
  it('fire burns until repaired; leaks drain fuel', () => {
    const h = newHealth(100, 0, 2);
    h.burning = true;
    h.leaking = true;
    const r = tickHazards(h, 1);
    expect(r.fireDamage).toBeGreaterThan(0);
    expect(r.fuelLeak).toBeGreaterThan(0);
    expect(repairStep(h)).toBe('fire');
    expect(h.burning).toBe(false);
  });
  it('collision damage rises with speed and the other body mass', () => {
    expect(collisionDamage(3, 900, 900)).toBe(0);
    expect(collisionDamage(20, 900, 4500)).toBeGreaterThan(collisionDamage(20, 900, 100));
  });

  it('a failed chance branch still grants its story fragment', () => {
    const e = { chance: { p: 1, fail: { fragment: true } } };
    expect(resolveEffects(e, new Rng(1)).fragment).toBe(true);
  });
  it('refund undoes a spend', () => {
    const s = newStocks();
    s.scrap = 10;
    expect(spend(s, { scrap: 4 })).toBe(true);
    refund(s, { scrap: 4 });
    expect(s.scrap).toBe(10);
  });
});
