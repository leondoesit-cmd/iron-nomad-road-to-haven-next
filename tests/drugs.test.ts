import { describe, expect, it } from 'vitest';
import { DRUGS, DRUG_IDS, DrugState, NEUTRAL, TOX_OVERDOSE } from '../src/sim/drugs';
import { Campaign } from '../src/game/campaign';
import { defaultBindings } from '../src/input/bindings';

const run = (d: DrugState, secs: number) => {
  for (let i = 0; i < secs * 10; i++) d.update(0.1);
};

describe('drugs', () => {
  it('is neutral with nothing taken', () => {
    expect(new DrugState().mods()).toEqual(NEUTRAL);
  });

  it('stim speeds you up, then the comedown slows you, then it wears off', () => {
    const d = new DrugState();
    d.dose('stim');
    expect(d.mods().speed).toBeGreaterThan(1.2);
    run(d, DRUGS.stim.duration + 1);
    expect(d.mods().speed).toBeLessThan(1);
    run(d, DRUGS.stim.crash + 1);
    expect(d.active).toHaveLength(0);
    expect(d.mods().speed).toBe(1);
  });

  it('painkillers cut damage taken', () => {
    const d = new DrugState();
    d.dose('painkiller');
    expect(d.mods().damage).toBeCloseTo(0.5);
  });

  it('adrenaline heals instantly', () => {
    expect(new DrugState().dose('adrenaline').heal).toBe(30);
  });

  it('redosing refreshes the timer instead of stacking the effect', () => {
    const d = new DrugState();
    d.dose('painkiller');
    run(d, 60);
    d.dose('painkiller');
    expect(d.active).toHaveLength(1);
    expect(d.mods().damage).toBeCloseTo(0.5);
    expect(d.active[0].left).toBeCloseTo(DRUGS.painkiller.duration);
  });

  it('too much overdoses, which hurts until it fades', () => {
    const d = new DrugState();
    d.dose('adrenaline');
    d.dose('adrenaline');
    const r = d.dose('adrenaline');
    expect(r.overdose).toBe(true);
    expect(d.toxicity).toBeGreaterThanOrEqual(TOX_OVERDOSE);
    expect(d.mods().poison).toBeGreaterThan(0);
    run(d, 120);
    expect(d.overdosing).toBe(false);
    expect(d.mods().poison).toBe(0);
  });

  it('a dependent body withdraws after a while without, and a dose relieves it', () => {
    const d = new DrugState();
    for (let i = 0; i < 3; i++) {
      d.dose('haze');
      run(d, 10);
    }
    expect(d.withdrawal).toBe(0);
    run(d, 200);
    expect(d.active).toHaveLength(0);
    expect(d.withdrawal).toBeGreaterThan(0.3);
    expect(d.mods().speed).toBeLessThan(1);
    expect(d.status().some((s) => s.text === 'WITHDRAWAL')).toBe(true);
    expect(d.dose('haze').relieved).toBe(true);
  });

  it('haze quiets you and bends the picture', () => {
    const d = new DrugState();
    d.dose('haze');
    expect(d.mods().noise).toBeLessThan(1);
    expect(d.mods().haze).toBeGreaterThan(0.5);
  });

  it('cycles to the next drug that is in stock', () => {
    const d = new DrugState();
    const stock: Record<string, number> = { stim: 0, painkiller: 0, adrenaline: 2, haze: 0 };
    expect(d.cycle((id) => stock[id])).toBe('adrenaline');
    expect(DRUG_IDS).toContain(d.selected);
  });

  it('the campaign carries drug counts and old saves still load', () => {
    const c = new Campaign();
    expect(c.items.stim).toBeGreaterThan(0);
    const data = c.serialize();
    const legacy = JSON.parse(JSON.stringify(data));
    delete legacy.items.stim;
    delete legacy.items.painkiller;
    expect(typeof Campaign.deserialize(legacy).items.stim).toBe("number");
  });

  it('has a default key and pad button for taking drugs', () => {
    const b = defaultBindings();
    expect(b.kb[0].use).toBeDefined();
    expect(b.kb[1].use).toBeDefined();
    expect(b.pad.use).toBeDefined();
  });
});
