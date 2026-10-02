import { describe, expect, it } from 'vitest';
import {
  BLACKOUT_AT,
  BLENDS,
  DRUGS,
  DRUG_IDS,
  DrugState,
  NEUTRAL,
  NO_LOOK,
  TOX_OVERDOSE,
  senseSpec,
  type DrugEvent,
  type DrugId,
} from '../src/sim/drugs';
import { Campaign } from '../src/game/campaign';
import { defaultBindings } from '../src/input/bindings';
import { RECIPES } from '../src/sim/resources';

/** A seeded generator, so events are the same every run. */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Step a state forward by whole seconds in 0.1 s ticks. */
const run = (d: DrugState, secs: number) => {
  for (let i = 0; i < Math.round(secs * 10); i++) d.update(0.1);
};

/** Dice that always come up the same: 0 makes every event fire the moment it can... */
const lucky = () => new DrugState(() => 0);
/** ...and 0.999 makes none fire. */
const dull = () => new DrugState(() => 0.999);
/** Dice loaded for just these events: they fire the moment they can, nothing else does. */
const only = (...tags: string[]) => new DrugState((tag) => (tag && tags.includes(tag) ? 0 : 0.999));

const events = (d: DrugState): DrugEvent[] => d.takeEvents();

describe('the basics', () => {
  it('is neutral with nothing taken', () => {
    const d = new DrugState();
    expect(d.mods()).toEqual(NEUTRAL);
    expect(d.look()).toEqual(NO_LOOK);
  });

  it('every drug has a definition, a belt slot and a distinct glyph', () => {
    expect(Object.keys(DRUGS).sort()).toEqual([...DRUG_IDS].sort());
    expect(new Set(DRUG_IDS.map((id) => DRUGS[id].glyph)).size).toBe(DRUG_IDS.length);
  });

  it('stim speeds you up, then the comedown slows you, then it wears off', () => {
    const d = dull();
    d.dose('stim');
    run(d, 10);
    expect(d.mods().speed).toBeGreaterThan(1.2);
    run(d, DRUGS.stim.duration);
    expect(d.mods().speed).toBeLessThan(1);
    run(d, DRUGS.stim.crash + 1);
    expect(d.active).toHaveLength(0);
    expect(d.mods().speed).toBe(1);
  });

  it('painkillers cut damage taken', () => {
    const d = dull();
    d.dose('painkiller');
    run(d, 15);
    expect(d.mods().damage).toBeCloseTo(0.5, 1);
  });

  it('adrenaline heals instantly', () => {
    expect(dull().dose('adrenaline').heal).toBe(30);
  });

  it('effects fade in over the onset instead of switching on', () => {
    const d = dull();
    d.dose('lsd');
    const at = (secs: number) => {
      run(d, secs);
      return d.look().hue;
    };
    const a = at(2);
    const b = at(10);
    const c = at(20);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(a).toBeLessThan(0.1);
  });

  it('tapers off at the end of a dose', () => {
    const d = dull();
    d.dose('stim');
    run(d, 20);
    const mid = d.mods().speed;
    run(d, 17);
    expect(d.phase('stim')).toBe('taper');
    expect(d.mods().speed).toBeLessThan(mid);
  });

  it('redosing a drug that does not stack restarts the clock without stacking the effect', () => {
    const d = dull();
    d.dose('painkiller');
    run(d, 60);
    d.dose('painkiller');
    expect(d.active).toHaveLength(1);
    expect(d.active[0].left).toBeCloseTo(DRUGS.painkiller.duration);
  });

  it('cycles the belt to the next drug in stock, in either direction', () => {
    const d = new DrugState();
    const stock: Record<string, number> = { painkiller: 0, stim: 0, adrenaline: 0, alcohol: 0, weed: 2, haze: 0, mushrooms: 0, lsd: 1, ayahuasca: 0 };
    expect(d.cycle((id) => stock[id])).toBe('weed');
    expect(d.cycle((id) => stock[id])).toBe('lsd');
    expect(d.cycle((id) => stock[id], -1)).toBe('weed');
    expect(d.step(1)).toBe('haze');
    expect(d.step(-1)).toBe('weed');
  });
});

describe('alcohol', () => {
  it('stacks: each drink adds time and strength, and the effect grows with it', () => {
    const d = dull();
    d.dose('alcohol');
    run(d, 15);
    const one = d.mods().sway;
    d.dose('alcohol');
    d.dose('alcohol');
    run(d, 15);
    expect(d.drinks).toBeGreaterThan(2);
    expect(d.mods().sway).toBeGreaterThan(one * 2);
    expect(d.look().dbl).toBeGreaterThan(0.5);
  });

  it('is liquid courage: tougher and harder-hitting, and louder, and a worse shot', () => {
    const d = dull();
    d.dose('alcohol');
    d.dose('alcohol');
    run(d, 20);
    const m = d.mods();
    expect(m.damage).toBeLessThan(1);
    expect(m.melee).toBeGreaterThan(1);
    expect(m.noise).toBeGreaterThan(1);
    expect(m.spread).toBeGreaterThan(1);
  });

  it('wears off a drink at a time, then leaves a hangover that scales with how much you had', () => {
    const light = dull();
    light.dose('alcohol');
    run(light, 85);
    expect(light.phase('alcohol')).toBe('comedown');
    const heavy = dull();
    for (let i = 0; i < 4; i++) heavy.dose('alcohol');
    run(heavy, 4 * 70 + 5);
    expect(heavy.phase('alcohol')).toBe('comedown');
    expect(heavy.mods().speed).toBeLessThan(light.mods().speed);
    expect(heavy.look().glow).toBeGreaterThan(light.look().glow);
  });

  it('is sensibly safe at a drink a minute and deadly at six at once', () => {
    const slow = dull();
    for (let i = 0; i < 6; i++) {
      slow.dose('alcohol');
      run(slow, 60);
    }
    expect(slow.overdosing).toBe(false);
    const fast = dull();
    for (let i = 0; i < 6; i++) fast.dose('alcohol');
    expect(fast.overdosing).toBe(true);
  });

  it('puts you on the floor past four drinks, warns you first, and an adrenaline shot wakes you and burns it off', () => {
    const d = only('blackout');
    for (let i = 0; i < 4; i++) d.dose('alcohol');
    run(d, 1);
    expect(events(d).find((e) => e.type === 'warn')).toBeTruthy();
    expect(d.passedOut).toBe(false);
    d.dose('alcohol');
    d.dose('alcohol');
    expect(d.drinks).toBeGreaterThanOrEqual(BLACKOUT_AT);
    run(d, 3);
    expect(d.passedOut).toBe(true);
    expect(d.look().dark).toBeGreaterThan(0.2);
    const before = d.drinks;
    d.dose('adrenaline');
    expect(d.passedOut).toBe(false);
    expect(events(d).some((e) => e.type === 'wake')).toBe(true);
    expect(d.drinks).toBeLessThan(before);
  });

  it('never blacks out below the threshold', () => {
    const d = only('blackout');
    d.dose('alcohol');
    d.dose('alcohol');
    run(d, 60);
    expect(d.passedOut).toBe(false);
  });

  it('a hit wakes you', () => {
    const d = only('blackout');
    for (let i = 0; i < 5; i++) d.dose('alcohol');
    run(d, 3);
    expect(d.passedOut).toBe(true);
    d.wake();
    expect(d.passedOut).toBe(false);
  });
});

describe('weed', () => {
  it('slows you down, quiets you, and the dead lose interest', () => {
    const d = dull();
    d.dose('weed');
    run(d, 15);
    const m = d.mods();
    expect(m.speed).toBeLessThan(1);
    expect(m.noise).toBeLessThan(0.8);
    expect(m.aggro).toBeLessThan(0.9);
    expect(m.appetite).toBeGreaterThan(1.3);
  });

  it('gives you the munchies until you sleep', () => {
    const d = dull();
    expect(d.munchies).toBe(false);
    d.dose('weed');
    expect(d.munchies).toBe(true);
    d.rest();
    expect(d.munchies).toBe(false);
  });

  it('settles the stomach: it cancels nausea instead of making it negative', () => {
    const sober = dull();
    sober.dose('mushrooms');
    run(sober, 30);
    const d = dull();
    d.dose('mushrooms');
    d.dose('weed');
    run(d, 30);
    expect(d.mods().nausea).toBeLessThan(sober.mods().nausea * 0.5);
    expect(d.mods().nausea).toBeGreaterThanOrEqual(0);
  });
});

describe('psychedelics', () => {
  it('LSD brings phantoms, auras on the dead, trails and a flood of colour', () => {
    const d = dull();
    d.dose('lsd');
    run(d, 60);
    const l = d.look();
    const m = d.mods();
    expect(m.phantoms).toBeGreaterThan(0.4);
    expect(m.sight).toBeGreaterThan(0.1);
    expect(l.hue).toBeGreaterThan(0.7);
    expect(l.trail).toBeGreaterThan(0.4);
    expect(l.breathe).toBeGreaterThan(0.5);
    expect(l.sky).toBeGreaterThan(0.5);
  });

  it('tolerance: the next tab lands softer, a rested body is fresher, a fresh one is full strength', () => {
    const d = dull();
    d.dose('lsd');
    run(d, 60);
    const first = d.look().hue;
    // Back to back, with only a night between, builds a tolerance.
    d.rest();
    d.dose('lsd');
    d.rest();
    d.dose('lsd');
    run(d, 60);
    expect(d.look().hue).toBeLessThan(first * 0.95);
    // The first dose did not blunt itself.
    const fresh = dull();
    fresh.dose('lsd');
    run(fresh, 60);
    expect(fresh.look().hue).toBeCloseTo(first, 5);
  });

  it('mushrooms let you feel the living through the walls, and grow giant mushrooms', () => {
    const d = dull();
    d.dose('mushrooms');
    run(d, 50);
    expect(d.mods().sight).toBeGreaterThan(0.4);
    expect(d.look().mush).toBeGreaterThan(0.8);
  });

  it('the stomach turns on the way up, worst around the onset, and settles by the peak', () => {
    const d = dull();
    d.dose('mushrooms');
    const samples: number[] = [];
    for (let t = 0; t < 90; t++) {
      run(d, 1);
      samples.push(d.mods().nausea);
    }
    const peak = Math.max(...samples);
    expect(peak).toBeGreaterThan(0.5);
    // Peak is somewhere around the onset time, not at the start or the end.
    const at = samples.indexOf(peak);
    expect(at).toBeGreaterThan(15);
    expect(at).toBeLessThan(50);
    expect(samples[samples.length - 1]).toBeLessThan(peak * 0.3);
  });

  it('vomits when the dice allow, and when the stomach is turning', () => {
    const d = only('vomit');
    d.dose('mushrooms');
    run(d, 25);
    expect(events(d).some((e) => e.type === 'vomit')).toBe(true);
    const calm = only('vomit');
    run(calm, 25);
    expect(events(calm).some((e) => e.type === 'vomit')).toBe(false);
  });

  it('vomits are spaced out, not a machine gun', () => {
    const d = only('vomit');
    d.dose('ayahuasca');
    run(d, 120);
    const n = events(d).filter((e) => e.type === 'vomit').length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(10);
  });

  it('flashbacks turn the visuals up for a few seconds, then let go', () => {
    const d = only('surge');
    d.dose('lsd');
    run(d, 40);
    const ev = events(d);
    expect(ev.some((e) => e.type === 'surge')).toBe(true);
    const before = d.look().hue;
    expect(d.surge > 0 || before > 0).toBe(true);
    run(d, 10);
    expect(d.surge).toBe(0);
  });

  it('paranoia puts something behind you', () => {
    const d = only('paranoia');
    d.dose('lsd');
    run(d, 40);
    expect(events(d).some((e) => e.type === 'paranoia')).toBe(true);
  });
});

describe('ayahuasca', () => {
  it('takes a minute to come on, then shows you everything: the dead, the loot and the road', () => {
    const d = dull();
    d.dose('ayahuasca');
    run(d, 10);
    expect(senseSpec(d.mods().sight).guide).toBe(false);
    run(d, 100);
    const spec = senseSpec(d.mods().sight);
    expect(spec.guide).toBe(true);
    expect(spec.loot).toBe(true);
    expect(d.look().eye).toBeGreaterThan(0.8);
  });

  it('amplifies whatever else is in the system', () => {
    const vine = dull();
    vine.dose('weed');
    vine.dose('ayahuasca');
    run(vine, 70);
    const plain = dull();
    plain.dose('weed');
    run(plain, 70);
    expect(plain.intensity('weed')).toBeGreaterThan(0);
    expect(vine.intensity('weed')).toBeGreaterThan(plain.intensity('weed') * 1.2);
  });

  it('and makes everything cost more: a dose on top of the vine is more toxic', () => {
    const a = dull();
    a.dose('weed');
    const base = a.toxicity;
    const b = dull();
    b.dose('ayahuasca');
    run(b, 5);
    const before = b.toxicity;
    b.dose('weed');
    expect(b.toxicity - before).toBeGreaterThan(base);
  });

  it('purging brings the toxicity down and burns off alcohol', () => {
    const d = only('vomit');
    d.dose('ayahuasca');
    for (let i = 0; i < 3; i++) d.dose('alcohol');
    const tox = d.toxicity;
    const drinks = d.drinks;
    run(d, 90);
    const vomits = events(d).filter((e) => e.type === 'vomit');
    expect(vomits.some((v) => v.type === 'vomit' && v.purge)).toBe(true);
    expect(d.toxicity).toBeLessThan(tox);
    expect(d.drinks).toBeLessThan(drinks);
  });

  it('the vine and a stimulant is a very bad idea', () => {
    const d = dull();
    d.dose('ayahuasca');
    const r = d.dose('adrenaline');
    expect(r.notes.length).toBeGreaterThan(0);
    expect(d.toxicity).toBeGreaterThan(0.3 + 0.45 * 1.5);
  });
});

describe('blends', () => {
  const active = (d: DrugState) => d.blends().map((b) => b.id);

  it('need every ingredient working, and fade with the weakest', () => {
    const d = dull();
    d.dose('alcohol');
    run(d, 20);
    expect(active(d)).not.toContain('couchlock');
    d.dose('weed');
    run(d, 20);
    expect(active(d)).toContain('couchlock');
    expect(d.mods().speed).toBeLessThan(0.9);
  });

  it('announce themselves when they start and when they stop', () => {
    const d = dull();
    d.dose('alcohol');
    d.dose('weed');
    run(d, 20);
    const on = events(d).filter((e) => e.type === 'blend' && e.on);
    expect(on.length).toBe(1);
    run(d, 200);
    const off = events(d).filter((e) => e.type === 'blend' && !e.on);
    expect(off.length).toBe(1);
  });

  it('weed and LSD make the things that are not there friendly', () => {
    const d = dull();
    d.dose('lsd');
    expect(d.friendly).toBe(false);
    d.dose('weed');
    run(d, 40);
    expect(d.friendly).toBe(true);
  });

  it('alcohol and painkillers poison you, quietly, for as long as both are in you', () => {
    const d = dull();
    d.dose('painkiller');
    const r = d.dose('alcohol');
    expect(r.notes.join(' ')).toMatch(/painkillers/i);
    const tox0 = d.toxicity;
    run(d, 20);
    expect(active(d)).toContain('liver');
    // Left alone the toxicity would fall by 0.012 a second (0.24 here); the blend holds most of it up.
    expect(d.toxicity).toBeGreaterThan(tox0 - 0.15);
  });

  it('a stim hides how drunk you are, but you are still that drunk', () => {
    const d = dull();
    for (let i = 0; i < 3; i++) d.dose('alcohol');
    run(d, 15);
    const drunkSway = d.mods().sway;
    d.dose('stim');
    run(d, 15);
    expect(active(d)).toContain('wired');
    expect(d.mods().sway).toBeLessThan(drunkSway);
    expect(d.drinks).toBeGreaterThan(1.5);
  });

  it('stim and weed cancel into steady hands', () => {
    const d = dull();
    d.dose('stim');
    d.dose('weed');
    run(d, 15);
    expect(active(d)).toContain('focus');
    expect(d.mods().spread).toBeLessThan(1);
  });

  it('every blend names real drugs, and no two blends share a name', () => {
    expect(new Set(BLENDS.map((b) => b.id)).size).toBe(BLENDS.length);
    for (const b of BLENDS) for (const n of b.needs) expect(DRUG_IDS).toContain(n);
  });
});

describe('the body keeps score', () => {
  it('too much overdoses, which hurts until it fades', () => {
    const d = dull();
    d.dose('adrenaline');
    d.dose('adrenaline');
    const r = d.dose('adrenaline');
    expect(r.overdose).toBe(true);
    expect(d.toxicity).toBeGreaterThanOrEqual(TOX_OVERDOSE);
    expect(events(d).some((e) => e.type === 'overdose')).toBe(true);
    expect(d.mods().poison).toBeGreaterThan(0);
    run(d, 150);
    expect(d.overdosing).toBe(false);
    expect(d.mods().poison).toBe(0);
  });

  it('a dependent body withdraws after a while without, and a dose relieves it', () => {
    const d = dull();
    for (let i = 0; i < 3; i++) {
      d.dose('haze');
      run(d, 10);
    }
    expect(d.withdrawal).toBe(0);
    run(d, 200);
    expect(d.active).toHaveLength(0);
    expect(d.withdrawal).toBeGreaterThan(0.3);
    expect(d.mods().speed).toBeLessThan(1);
    expect(d.look().warp).toBeGreaterThan(0);
    expect(d.status().some((s) => s.text === 'WITHDRAWAL')).toBe(true);
    expect(d.dose('haze').relieved).toBe(true);
  });

  it('sleep clears the blood, half-clears the habit and forgets half the tolerance', () => {
    const d = dull();
    d.dose('alcohol');
    d.dose('alcohol');
    d.dose('lsd');
    d.dose('lsd');
    const dep = d.dependence;
    const tol = d.tolerance.lsd ?? 0;
    d.rest();
    expect(d.active).toHaveLength(0);
    expect(d.toxicity).toBe(0);
    expect(d.dependence).toBeLessThan(dep);
    expect(d.tolerance.lsd ?? 0).toBeLessThan(tol);
    expect(d.takeEvents()).toHaveLength(0);
  });

  it('status labels say what is happening', () => {
    const d = dull();
    d.dose('alcohol');
    d.dose('lsd');
    const text = d.status().map((s) => s.text).join(' | ');
    expect(text).toMatch(/MOONSHINE/);
    expect(text).toMatch(/LSD COMING ON/);
  });
});

describe('sense', () => {
  it('shows more the deeper you go', () => {
    const a = senseSpec(0);
    const b = senseSpec(0.2);
    const c = senseSpec(0.55);
    const e = senseSpec(1);
    expect(a.radius).toBe(0);
    expect(b.zombies).toBe(true);
    expect(b.animals).toBe(false);
    expect(c.loot).toBe(true);
    expect(c.guide).toBe(false);
    expect(e.guide).toBe(true);
    expect(e.radius).toBeGreaterThan(c.radius);
  });
});

describe('persistence', () => {
  it('a state survives a save and a load, trip and all', () => {
    const d = dull();
    d.dose('alcohol');
    d.dose('mushrooms');
    run(d, 40);
    const back = DrugState.restore(JSON.parse(JSON.stringify(d.serialize())), () => 0.999);
    expect(back.active.map((a) => a.id).sort()).toEqual(['alcohol', 'mushrooms']);
    expect(back.toxicity).toBeCloseTo(d.toxicity, 5);
    expect(back.look().mush).toBeCloseTo(d.look().mush, 5);
    expect(back.selected).toBe(d.selected);
  });

  it('forgets drugs that no longer exist rather than choking on them', () => {
    const back = DrugState.restore({ active: [{ id: 'bogus' as DrugId, age: 1, left: 10, crash: 0, crashMax: 0, peak: 1 }], toxicity: 0.2, selected: 'nope' as DrugId });
    expect(back.active).toHaveLength(0);
    expect(back.toxicity).toBe(0.2);
    expect(back.selected).toBe('painkiller');
  });

  it('the campaign carries drug counts and old saves still load', () => {
    const c = new Campaign();
    for (const id of DRUG_IDS) expect(typeof c.items[id]).toBe('number');
    c.drugs[0].dose('lsd');
    const data = JSON.parse(JSON.stringify(c.serialize()));
    expect(Campaign.deserialize(data).drugs[0].active[0].id).toBe('lsd');
    const legacy = JSON.parse(JSON.stringify(c.serialize()));
    delete legacy.drugs;
    delete legacy.items.alcohol;
    delete legacy.items.ayahuasca;
    const old = Campaign.deserialize(legacy);
    expect(old.drugs[0].active).toHaveLength(0);
    expect(typeof old.items.alcohol).toBe('number');
  });

  it('a night in camp clears everyone', () => {
    const c = new Campaign();
    c.drugs[0].dose('ayahuasca');
    c.drugs[1].dose('weed');
    c.restDrugs();
    expect(c.drugs[0].active).toHaveLength(0);
    expect(c.drugs[1].munchies).toBe(false);
  });
});

describe('content', () => {
  it('has a key and pad button for taking drugs', () => {
    const b = defaultBindings();
    expect(b.kb[0].use).toBeDefined();
    expect(b.kb[1].use).toBeDefined();
    expect(b.pad.use).toBeDefined();
  });

  it('every drug can be made at the still, and nothing else is a drug recipe', () => {
    const made = new Set<string>();
    for (const r of RECIPES) for (const id of DRUG_IDS) if (r.yields[id]) made.add(id);
    for (const id of DRUG_IDS) expect(made.has(id)).toBe(true);
  });
});
