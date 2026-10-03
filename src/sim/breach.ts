import type { Opening, Wall } from '../world/interiors';
import type { AmmoKind, Surface } from './ballistics';

/**
 * Knocking holes in buildings, as pure rules. A wall of a wasteland building is made of pieces, each with the hit points of
 * what it is built from. Enough damage to a piece opens a breach in the wall's plan at the spot, which the scene then turns
 * into a gap you can walk through (the geometry and the colliders are rebuilt from the plan).
 */

/** Hit points of one wall piece, by what it is made of. Concrete and brick take a charge and more than this world has. */
export const WALL_HP: Partial<Record<Surface, number>> = { glass: 12, wood: 220, plaster: 150, sheet: 260 };

/** Hit points a wall piece of this material starts with, or null if it cannot be broken. */
export function wallHp(surface: Surface): number | null {
  return WALL_HP[surface] ?? null;
}

/**
 * How much of a round's damage goes into the structure it hits, by what it hits. A pistol round is nothing to a wall of
 * wood or plaster, but it shatters glass and (slowly) chews through sheet metal; a shotgun blast or a .38 can do real harm
 * to a wall; a rifle or a mounted gun can open it. Blasts do not use this: they are all damage.
 */
const STRUCTURAL: Record<AmmoKind, Partial<Record<Surface, number>>> = {
  pistol: { glass: 1, sheet: 0.35 },
  raider: { glass: 1, sheet: 0.35 },
  smg: { glass: 1, sheet: 0.3 },
  magnum: { glass: 1, sheet: 0.9, plaster: 0.25, wood: 0.2 },
  pellet: { glass: 0.8, sheet: 0.3, plaster: 0.55, wood: 0.45 },
  rifle: { glass: 1, sheet: 1.2, plaster: 1, wood: 1 },
  sniper: { glass: 1, sheet: 1, plaster: 0.9, wood: 0.9 },
  turret: { glass: 1, sheet: 1.1, plaster: 1, wood: 1 },
};

export function structuralMul(ammo: AmmoKind, surface: Surface): number {
  return STRUCTURAL[ammo][surface] ?? 0;
}

/** Damage a hit does to a wall: bullets bite, a blast breaks, a ram batters. */
export function wallDamage(how: 'bullet' | 'blast' | 'ram', amount: number): number {
  return how === 'bullet' ? amount : how === 'blast' ? amount * 1.4 : amount;
}

/** The widest a breach gets, and the narrowest that can be walked through. */
export const BREACH_MAX = 3.8;
export const BREACH_MIN = 1.3;

/** How wide a breach a given hit tears: a bullet hole's worth of damage opens a person-sized gap; a blast opens a lot. */
export function breachWidth(how: 'bullet' | 'blast' | 'ram', radius = 0): number {
  if (how === 'blast') return Math.max(BREACH_MIN, Math.min(BREACH_MAX, radius * 0.75));
  if (how === 'ram') return 2.4;
  return BREACH_MIN + 0.2;
}

/**
 * Open a breach in a wall, centred on `centre` (a coordinate along the wall) and `width` wide, folded into any doors and
 * windows it overlaps. Returns the opening, or null if the wall is too short to take one. Mutates the wall's openings.
 */
export function breachWall(w: Wall, centre: number, width: number): Opening | null {
  const lo = w.a + 0.12;
  const hi = w.b - 0.12;
  if (hi - lo < BREACH_MIN) return null;
  const wd = Math.min(width, hi - lo);
  let a = centre - wd / 2;
  let b = centre + wd / 2;
  if (a < lo) {
    b += lo - a;
    a = lo;
  }
  if (b > hi) {
    a -= b - hi;
    b = hi;
  }
  // Fold in whatever it overlaps, so openings never touch.
  const keep: Opening[] = [];
  for (const o of w.ops) {
    if (a < o.b + 0.15 && b > o.a - 0.15) {
      a = Math.min(a, o.a);
      b = Math.max(b, o.b);
    } else keep.push(o);
  }
  // Folding can reach neighbours that were just clear of the first range.
  for (let again = true; again; ) {
    again = false;
    for (let i = keep.length - 1; i >= 0; i--) {
      const o = keep[i];
      if (a < o.b + 0.15 && b > o.a - 0.15) {
        a = Math.min(a, o.a);
        b = Math.max(b, o.b);
        keep.splice(i, 1);
        again = true;
      }
    }
  }
  const op: Opening = { a, b, kind: 'breach', sill: 0, head: Math.min(w.h, Math.max(2.3, w.h * 0.85)), leaf: 'none', glass: 'none' };
  w.ops = keep;
  w.ops.push(op);
  w.ops.sort((p, q) => p.a - q.a);
  return op;
}
