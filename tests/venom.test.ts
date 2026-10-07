import { describe, expect, it } from 'vitest';
import { VENOM, bindVenom, drawVenom, envenom, newVenom, tickVenom, venomLabel, venomSlow } from '../src/sim/venom';

// Snake venom: what a bite puts in, how fast it works, and what treats it.

const spend = (v: ReturnType<typeof newVenom>, pace: number, secs: number) => {
  let lost = 0;
  for (let i = 0; i < secs * 10; i++) lost += tickVenom(v, 0.1, pace);
  return lost;
};

describe('venom', () => {
  it('a Palestine viper takes its whole dose untreated, and a healthy person lives through one bite', () => {
    const v = newVenom();
    envenom(v, 'palestine');
    expect(venomLabel(v)).toBe('ENVENOMED (SEVERE)');
    const lost = spend(v, 1, 200);
    expect(lost).toBeCloseTo(VENOM.palestine.dose, 3);
    expect(VENOM.palestine.bite + VENOM.palestine.dose).toBeLessThan(100);
    expect(v.dose).toBe(0);
    expect(venomLabel(v)).toBe('');
  });

  it('two bites can kill', () => {
    const v = newVenom();
    envenom(v, 'palestine');
    envenom(v, 'palestine');
    expect(spend(v, 1, 400) + VENOM.palestine.bite * 2).toBeGreaterThan(100);
  });

  it('works faster on someone running and slower on someone keeping still', () => {
    const run = newVenom();
    const still = newVenom();
    envenom(run, 'horned');
    envenom(still, 'horned');
    expect(spend(run, 2, 10)).toBeGreaterThan(spend(still, 0, 10) * 2);
  });

  it('a pressure bandage halves the spread; a medkit draws most of it', () => {
    const a = newVenom();
    const b = newVenom();
    envenom(a, 'palestine');
    envenom(b, 'palestine');
    expect(bindVenom(b)).toBe(true);
    expect(bindVenom(b)).toBe(false);
    expect(spend(b, 1, 10)).toBeCloseTo(spend(a, 1, 10) / 2, 3);
    const c = newVenom();
    envenom(c, 'palestine');
    const saved = drawVenom(c);
    expect(saved).toBeGreaterThan(VENOM.palestine.dose * 0.6);
    expect(c.dose).toBeLessThan(VENOM.palestine.dose * 0.35);
  });

  it('slows you while it works', () => {
    const v = newVenom();
    expect(venomSlow(v)).toBe(1);
    envenom(v, 'palestine');
    expect(venomSlow(v)).toBeLessThan(1);
    expect(venomSlow(v)).toBeGreaterThanOrEqual(0.78);
  });
});
