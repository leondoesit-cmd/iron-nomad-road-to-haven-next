import { describe, expect, it } from 'vitest';
import {
  BURST_CUT, CHAINS, INJURY, MAX_WOUNDS, NECK_CUT, WOUND, brainGone, fleshMoveMult, injure, legsUseless, newFlesh, pieceOf,
  surfaceHit, torsoAt, type Blow, type FleshState,
} from '../src/sim/flesh';

/** A blow from in front (the body faces +z, so the blow travels -z), at a rest-pose height and side. */
function blow(key: string, power: number, zone: Blow['zone'], y: number, x = 0, extra: Partial<Blow> = {}): Blow {
  let seed = 7;
  return {
    inj: INJURY[key], power, zone, x, y, z: 0.5, dx: 0, dy: 0, dz: -1, time: 0, killed: false,
    rng: () => ((seed = (seed * 16807) % 2147483647) / 2147483647), ...extra,
  };
}

const cut = (f: FleshState, c: (typeof CHAINS)[number]) => f.cut[CHAINS.indexOf(c)];

describe('where a blow lands on the body', () => {
  it('a shot from the front goes in at the chest and would come out of the back', () => {
    const s = torsoAt(1.3);
    const h = surfaceHit('torso', 0, 1.3, 1, 0, -1);
    expect(h.entry.z).toBeCloseTo(s.zc + s.d, 3);
    expect(h.entry.nz).toBeGreaterThan(0.95);
    expect(h.exit!.z).toBeCloseTo(s.zc - s.d, 3);
    expect(h.exit!.nz).toBeLessThan(-0.95);
  });

  it('a limb is hit on its own surface, round its own axis', () => {
    const h = surfaceHit('legL', 0.11, 0.7, 1, 0, -1);
    expect(h.entry.x).toBeGreaterThan(0.09);
    expect(h.entry.z).toBeGreaterThan(0.04);
    expect(h.exit!.z).toBeLessThan(0);
  });
});

describe('rounds', () => {
  it('a pistol round that stops in the body leaves a small hole going in and nothing out the back', () => {
    const f = newFlesh();
    const ev = injure(f, blow('pistol', 0.6, 'torso', 1.3));
    expect(f.wounds).toHaveLength(1);
    expect(f.wounds[0].k).toBe(WOUND.entry);
    expect(f.wounds[0].r).toBeLessThan(0.03);
    expect(ev.exit).toBeNull();
  });

  it('a rifle round blows a crater out of the back far bigger than the hole in front', () => {
    const f = newFlesh();
    const ev = injure(f, blow('rifle', 1.8, 'torso', 1.3, 0, { through: true }));
    expect(ev.exit).not.toBeNull();
    const entry = f.wounds.find((w) => w.k === WOUND.entry)!;
    const exit = f.wounds.find((w) => w.k === WOUND.crater)!;
    expect(exit.r).toBeGreaterThan(entry.r * 3);
    expect(exit.z).toBeLessThan(0);
  });

  it('a close blast of pellets runs together into one crater', () => {
    const f = newFlesh();
    for (let i = 0; i < 8; i++) injure(f, blow('pellet', 0.22, 'torso', 1.28 + (i % 3) * 0.015, (i % 4 - 1.5) * 0.012));
    expect(f.wounds.length).toBeLessThan(4);
    expect(f.wounds.some((w) => w.k === WOUND.crater && w.r > 0.035)).toBe(true);
  });

  it('a round through the belly opens it and the gut comes out', () => {
    const f = newFlesh();
    const ev = injure(f, blow('rifle', 1.8, 'torso', 1.08, 0, { through: true }));
    expect(ev.spill).toBe(true);
    expect(f.spilled).toBe(true);
    expect(f.open).not.toBeNull();
    // A pistol round to the belly does not.
    const g = newFlesh();
    expect(injure(g, blow('pistol', 0.6, 'torso', 1.08)).spill).toBe(false);
  });

  it('a heavy round that takes the head bursts the skull and leaves the jaw', () => {
    const f = newFlesh();
    const ev = injure(f, blow('rifle', 3.5, 'head', 1.72, 0, { killed: true, off: ['head'] }));
    expect(ev.head).toBe('burst');
    expect(cut(f, 'neck')).toBeCloseTo(BURST_CUT, 1);
    expect(ev.brain).toBeGreaterThan(0);
    expect(brainGone(f)).toBe(true);
  });

  it('a rifle round that takes an arm cuts it where it hit, torn', () => {
    const f = newFlesh();
    injure(f, blow('rifle', 1.8, 'armL', 1.05, 0.23, { off: ['armL'] }));
    expect(cut(f, 'armL')).toBeCloseTo(1.05, 2);
    expect(f.rag[CHAINS.indexOf('armL')]).toBe(1);
  });
});

describe('blunt weapons', () => {
  it('a bat to the shin breaks it: the leg bends at the break and the body limps', () => {
    const f = newFlesh();
    const ev = injure(f, blow('bat', 1.07, 'legL', 0.3, 0.11));
    expect(ev.broke).toContain('shinL');
    expect(f.bend[6]).toBeGreaterThan(0.3);
    expect(legsUseless(f)).toBe(1);
    expect(fleshMoveMult(f)).toBeLessThan(0.6);
    expect(f.wounds[0].k).toBe(WOUND.bruise);
  });

  it('a sledgehammer drives the broken bone out through the skin', () => {
    const f = newFlesh();
    const ev = injure(f, blow('sledge', 2.3, 'armR', 1.0, -0.23));
    expect(ev.compound).toContain('forearmR');
    expect(f.wounds.some((w) => w.k === WOUND.exit && w.depth > 0.6)).toBe(true);
  });

  it('a bat to the head caves the skull in; a sledgehammer bursts it', () => {
    const f = newFlesh();
    const ev = injure(f, blow('bat', 1.07, 'head', 1.72));
    expect(ev.head).toBe('crushed');
    expect(f.dents.length).toBe(1);
    expect(f.dents[0].depth).toBeGreaterThan(0.01);
    expect(brainGone(f)).toBe(true);
    const g = newFlesh();
    expect(injure(g, blow('sledge', 2.3, 'head', 1.72)).head).toBe('burst');
    // A fist does neither.
    const h = newFlesh();
    expect(injure(h, blow('fist', 0.6, 'head', 1.72)).head).toBeNull();
  });
});

describe('blades', () => {
  it('a knife opens a long shallow gash, not a hole', () => {
    const f = newFlesh();
    injure(f, blow('knife', 0.67, 'torso', 1.3));
    const w = f.wounds[0];
    expect(w.k).toBe(WOUND.gash);
    expect(w.len).toBeGreaterThan(w.r * 2);
  });

  it('a katana through the waist cuts the body in two and spills it', () => {
    const f = newFlesh();
    const ev = injure(f, blow('katana', 1.6, 'torso', 1.1));
    expect(ev.bisect).toBeCloseTo(1.1, 2);
    expect(cut(f, 'waist')).toBeCloseTo(1.1, 2);
    expect(f.spilled).toBe(true);
    expect(legsUseless(f)).toBe(2);
    // A machete does not, at the same power: it chops deep and opens the belly.
    const g = newFlesh();
    const e2 = injure(g, blow('machete', 1.29, 'torso', 1.1));
    expect(e2.bisect).toBe(0);
    expect(g.spilled).toBe(true);
  });

  it('an axe into the crown splits the skull; at the neck it takes the head off', () => {
    const f = newFlesh();
    expect(injure(f, blow('axe', 1.9, 'head', 1.76, 0, { off: ['head'], killed: true })).head).toBe('split');
    expect(cut(f, 'neck')).toBe(0);
    const g = newFlesh();
    expect(injure(g, blow('axe', 1.9, 'head', 1.6, 0, { off: ['head'], killed: true })).head).toBe('off');
    expect(cut(g, 'neck')).toBeCloseTo(NECK_CUT, 1);
  });

  it('a swing that reckons its own cut: part way opens it that deep, through takes it off or parts the waist', () => {
    const f = newFlesh();
    injure(f, blow('machete', 1, 'torso', 1.1, 0, { cutDepth: 0.3, cutThrough: false }));
    expect(f.wounds[0].depth).toBeCloseTo(0.3, 5);
    expect(cut(f, 'waist')).toBe(0);
    const ev = injure(f, blow('machete', 0.4, 'torso', 1.1, 0, { cutDepth: 1, cutThrough: true }));
    expect(ev.bisect).toBeGreaterThan(0);
    const g = newFlesh();
    expect(injure(g, blow('machete', 0.5, 'head', 1.72, 0, { off: ['head'], cutThrough: true })).head).toBe('sliced');
  });
});

describe('the state of a body', () => {
  it('keeps at most a set number of wounds, losing the least of them first', () => {
    const f = newFlesh();
    for (let i = 0; i < MAX_WOUNDS + 6; i++) injure(f, blow(i % 2 ? 'fist' : 'pistol', 0.5, 'torso', 0.95 + i * 0.03, ((i % 5) - 2) * 0.05));
    expect(f.wounds.length).toBe(MAX_WOUNDS);
  });

  it('a severed piece is the part below a limb cut, above a neck cut, below a waist cut', () => {
    const arm = pieceOf('armL', 1.1);
    expect(arm.cy).toBeLessThan(1.1);
    expect(arm.cy + arm.hy).toBeCloseTo(1.1, 5);
    const head = pieceOf('neck', NECK_CUT);
    expect(head.cy - head.hy).toBeCloseTo(NECK_CUT, 5);
    const legs = pieceOf('waist', 1.1);
    expect(legs.cy).toBeLessThan(0.7);
  });
});

describe('the anatomy under the skin', () => {
  it('nothing inside a body reaches its skin: organs, bone and muscle all sit within the torso and limbs', async () => {
    const { innardsGeometry } = await import('../src/render/innards');
    const { limbAt, skullAt } = await import('../src/sim/flesh');
    const g = innardsGeometry();
    const pos = g.getAttribute('position');
    const z4 = g.getAttribute('aZ');
    const bad: string[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const part = Math.round(z4.getX(i));
      const layer = Math.round(z4.getW(i)) - 100;
      let k = 0;
      if (part === 0 && y > 0.86 && y < 1.47) {
        const s = torsoAt(y);
        k = Math.hypot(x / s.w, (z - s.zc) / s.d);
      } else if (part === 9 && y > 1.64 && y < 1.8) {
        const s = skullAt(y);
        k = Math.hypot(x / s.w, (z - s.zc) / s.d);
      } else if (part >= 1 && part <= 8) {
        const chain = part === 5 || part === 7 ? 'armL' : part === 6 || part === 8 ? 'armR' : part === 1 || part === 3 ? 'legL' : 'legR';
        const a = limbAt(chain, y);
        k = Math.hypot(x - a.x, z - a.z) / a.r;
      }
      // Muscle and the skull line the inside of the skin; other bone and the organs keep well clear of it.
      const shell = layer === 1 || (part === 9 && layer === 2);
      if (k > (shell ? 0.97 : 0.9)) bad.push(`part ${part} layer ${layer} at ${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}: ${k.toFixed(2)}`);
    }
    expect(bad.slice(0, 12)).toEqual([]);
  });
});
