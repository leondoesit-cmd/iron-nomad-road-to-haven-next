import type { AnimalKind } from '../data';

/**
 * What a round can take off an animal, as pure rules (no engine imports): which part of the body a point is in, how much a
 * wound costs it in speed, and how fast it bleeds. Zombies have their own, in `ballistics.ts`; animals are alive, so a
 * missing leg is a limp and a long bleed, a missing head is the end of it, and a missing wing brings a bird down.
 */

export type AnimalPart = 'head' | 'legLF' | 'legRF' | 'legLB' | 'legRB' | 'wingL' | 'wingR';
export type AnimalZone = AnimalPart | 'torso';

/** Bit of the hidden-part mask for each part. A leg's bit is also its mount index in the animal mesh. */
export const PART_BIT: Record<AnimalPart, number> = { legLF: 1, legRF: 2, legLB: 4, legRB: 8, head: 16, wingL: 32, wingR: 64 };
export const LEGS: AnimalPart[] = ['legLF', 'legRF', 'legLB', 'legRB'];
export const WINGS: AnimalPart[] = ['wingL', 'wingR'];

/**
 * Build of each species (m, before scale): body length, half-width at the hips, leg length, standing height, and where the
 * head sits (height and distance ahead of the centre). It is how a hit is placed on the body and where a thrown part starts.
 */
export const BODY: Record<AnimalKind, { len: number; w: number; leg: number; height: number; headY: number; headZ: number }> = {
  hare: { len: 0.4, w: 0.1, leg: 0.17, height: 0.35, headY: 0.42, headZ: 0.22 },
  deer: { len: 0.95, w: 0.15, leg: 0.8, height: 1.3, headY: 1.57, headZ: 0.71 },
  vulture: { len: 0.7, w: 0.12, leg: 0, height: 0.4, headY: 0.14, headZ: 0.45 },
  dog: { len: 0.68, w: 0.1, leg: 0.42, height: 0.7, headY: 0.79, headZ: 0.45 },
  wolf: { len: 0.78, w: 0.12, leg: 0.5, height: 0.9, headY: 0.89, headZ: 0.52 },
  boar: { len: 1.0, w: 0.22, leg: 0.36, height: 0.85, headY: 0.83, headZ: 0.59 },
  bear: { len: 1.45, w: 0.36, leg: 0.62, height: 1.6, headY: 1.35, headZ: 0.85 },
  ibex: { len: 0.9, w: 0.15, leg: 0.62, height: 1.05, headY: 1.25, headZ: 0.62 },
  camel: { len: 1.5, w: 0.3, leg: 1.15, height: 2.1, headY: 2.2, headZ: 1.25 },
  fox: { len: 0.5, w: 0.08, leg: 0.28, height: 0.45, headY: 0.5, headZ: 0.34 },
  jackal: { len: 0.6, w: 0.09, leg: 0.38, height: 0.6, headY: 0.66, headZ: 0.4 },
  buffalo: { len: 1.7, w: 0.42, leg: 0.62, height: 1.55, headY: 1.2, headZ: 1.05 },
  heron: { len: 0.45, w: 0.1, leg: 0.55, height: 1.0, headY: 0.95, headZ: 0.3 },
  stork: { len: 0.5, w: 0.11, leg: 0.6, height: 1.05, headY: 1.0, headZ: 0.3 },
  duck: { len: 0.42, w: 0.11, leg: 0, height: 0.3, headY: 0.28, headZ: 0.22 },
  crow: { len: 0.38, w: 0.07, leg: 0.08, height: 0.3, headY: 0.22, headZ: 0.16 },
  egret: { len: 0.33, w: 0.07, leg: 0.4, height: 0.75, headY: 0.72, headZ: 0.22 },
};

/** The birds: a wing can be shot off them, and a bird that loses one comes down. */
export const WINGED = new Set<AnimalKind>(['vulture', 'crow', 'heron', 'stork', 'duck', 'egret']);

export interface AnimalWounds {
  mask: number;
  /** Damage each part has taken since it was last whole, in the same order as `ORDER`. */
  acc: number[];
  /** Hit points lost per second to bleeding (0 when nothing is open). */
  bleed: number;
}

const ORDER: AnimalPart[] = ['head', 'legLF', 'legRF', 'legLB', 'legRB', 'wingL', 'wingR'];
export const newAnimalWounds = (): AnimalWounds => ({ mask: 0, acc: ORDER.map(() => 0), bleed: 0 });
export const hasPart = (mask: number, p: AnimalPart) => (mask & PART_BIT[p]) !== 0;

/**
 * Which part a point is in. `fwd` is how far ahead of the body's centre it is, `lateral` how far to its left (the model's
 * +x), `relY` the height as a share of the animal's standing height. A bird is all wing at its sides and body between.
 */
export function animalZoneOf(kind: AnimalKind, fwd: number, lateral: number, relY: number, size = 1): AnimalZone {
  const b = BODY[kind];
  const half = (b.len * size) / 2;
  if (kind === 'vulture' || kind === 'crow') return Math.abs(lateral) > b.w * size ? (lateral > 0 ? 'wingL' : 'wingR') : 'torso';
  if (WINGED.has(kind)) {
    // A wading or swimming bird: wings folded at its sides, the head ahead on its neck, and long bare legs under a wader.
    if (Math.abs(lateral) > b.w * 1.4 * size) return lateral > 0 ? 'wingL' : 'wingR';
    if (b.leg > 0 && relY < (b.leg / b.height) * 0.9) return lateral >= 0 ? 'legLF' : 'legRF';
    return fwd > half * 0.6 && relY > 0.55 ? 'head' : 'torso';
  }
  const f = fwd / Math.max(0.05, half);
  // The head and neck stand out ahead of the shoulders, and above them for the tall ones.
  if (f > 0.78 && relY > 0.45) return 'head';
  if (f > 1.0) return 'head';
  if (relY < 0.46) {
    const front = f > 0;
    return lateral >= 0 ? (front ? 'legLF' : 'legLB') : front ? 'legRF' : 'legRB';
  }
  return 'torso';
}

/** Share of its hit points a leg takes to come off, a wing, and the head. A small animal loses parts to less. */
export const LEG_HP = 0.34;
export const WING_HP = 0.4;
export const HEAD_HP = 0.5;

export interface AnimalWoundResult {
  off: AnimalPart[];
  /** Died of it on the spot (a head gone). */
  fatal: boolean;
}

/**
 * Take a blow to a zone. `power` is damage times the round's `gore`, `hp` the animal's full hit points. Legs and wings come
 * off once they have taken enough; a head takes a hard hit or a kill; a very hard blow to the body takes a leg with it.
 */
export function woundAnimal(w: AnimalWounds, kind: AnimalKind, zone: AnimalZone, power: number, hp: number, killed: boolean, pick: number): AnimalWoundResult {
  const off: AnimalPart[] = [];
  let fatal = false;
  if (power <= 0) return { off, fatal };
  const take = (p: AnimalPart) => {
    if (hasPart(w.mask, p)) return;
    // A bird without a wing is a stone; there is no shot that leaves it flying.
    if (!WINGED.has(kind) && WINGS.includes(p)) return;
    w.mask |= PART_BIT[p];
    off.push(p);
    if (p === 'head' || WINGS.includes(p)) fatal = true;
    else w.bleed += Math.max(0.6, hp * 0.025);
  };
  if (zone === 'torso') {
    if (power >= hp * 1.2) take(LEGS[Math.floor(pick * LEGS.length) % LEGS.length]);
  } else {
    const i = ORDER.indexOf(zone);
    w.acc[i] += power;
    const need = zone === 'head' ? HEAD_HP : WINGS.includes(zone) ? WING_HP : LEG_HP;
    if (w.acc[i] >= hp * need || (zone === 'head' && killed && power >= hp * 0.35)) take(zone);
  }
  return { off, fatal };
}

/** Legs gone, wings gone, head gone. */
export function partsGone(mask: number): { legs: number; frontLegs: number; backLegs: number; wings: number; head: boolean } {
  const f = (hasPart(mask, 'legLF') ? 1 : 0) + (hasPart(mask, 'legRF') ? 1 : 0);
  const b = (hasPart(mask, 'legLB') ? 1 : 0) + (hasPart(mask, 'legRB') ? 1 : 0);
  return { legs: f + b, frontLegs: f, backLegs: b, wings: (hasPart(mask, 'wingL') ? 1 : 0) + (hasPart(mask, 'wingR') ? 1 : 0), head: hasPart(mask, 'head') };
}

/**
 * How fast it can still go: a limp on one leg, a hobble on two, a drag on three. A beast built to run on four loses more of
 * its speed to each than a heavy one does (a bear on three legs is still a bear).
 */
export function animalSpeedMult(legsGone: number, heavy: boolean): number {
  if (legsGone <= 0) return 1;
  if (legsGone === 1) return heavy ? 0.72 : 0.55;
  if (legsGone === 2) return heavy ? 0.4 : 0.28;
  return 0.1;
}
