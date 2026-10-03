import { clamp } from '../core/math';

/**
 * Panes of glass, as pure rules: how much each kind takes before it goes, when it shows cracks, and what a crash or a
 * blast does to the windows of a car. No engine imports, so every number is testable.
 *
 * A pane has hit points like any other part. As they run down it passes through three looks: whole, cracked (a web round
 * each hit), crazed (the whole pane white with cracks) and then gone.
 */

export type GlassKind = 'window' | 'shop' | 'screen' | 'side' | 'rear';

/** Hit points by kind. A house window gives to a pistol round; a shop's plate glass takes a few; a laminated screen holds. */
export const GLASS_HP: Record<GlassKind, number> = { window: 12, shop: 36, screen: 42, side: 10, rear: 16 };

/** How much of a blow lands, by how it came: a blast shatters, a bullet punches a neat hole, a shoulder barely marks it. */
export type GlassHow = 'bullet' | 'blast' | 'ram' | 'melee' | 'crash';

export function glassDamage(how: GlassHow, amount: number, kind: GlassKind): number {
  const m = how === 'blast' ? 2.5 : how === 'crash' ? 1.6 : how === 'ram' ? 1.4 : how === 'melee' ? 1.2 : 1;
  // A laminated screen is tough against a blunt blow and soft only to something sharp or fast.
  const tough = kind === 'screen' && (how === 'melee' || how === 'ram') ? 0.5 : 1;
  return amount * m * tough;
}

/** 0 whole, 1 cracked, 2 crazed, 3 gone. */
export type PaneStage = 0 | 1 | 2 | 3;

export function stageOf(hp: number, max: number): PaneStage {
  if (hp <= 0) return 3;
  const f = hp / max;
  return f > 0.66 ? 0 : f > 0.33 ? 1 : 2;
}

export interface PaneState {
  kind: GlassKind;
  hp: number;
  max: number;
  stage: PaneStage;
}

export const newPane = (kind: GlassKind): PaneState => ({ kind, hp: GLASS_HP[kind], max: GLASS_HP[kind], stage: 0 });

export interface PaneHit {
  /** The stage before and after. */
  from: PaneStage;
  to: PaneStage;
  /** The blow took the pane out. */
  broke: boolean;
}

/** Take a blow. Returns how the pane changed. A pane that is already gone does not change. */
export function hitPane(p: PaneState, amount: number): PaneHit {
  const from = p.stage;
  if (from === 3) return { from, to: 3, broke: false };
  p.hp = Math.max(0, p.hp - Math.max(0, amount));
  p.stage = stageOf(p.hp, p.max);
  return { from, to: p.stage, broke: p.stage === 3 };
}

/** Pieces thrown when a pane goes, by its area in m². */
export function shardCount(area: number): number {
  return Math.round(clamp(8 + area * 7, 10, 26));
}

// ------------------------------------------------------------------ the windows of a car

/** One window of a car, in the chassis frame: centre, outward normal, and half the width and height along the glass. */
export interface CarPane {
  key: string;
  kind: GlassKind;
  c: [number, number, number];
  n: [number, number, number];
  hw: number;
  hh: number;
}

/**
 * How hard a crash is to a window facing the direction of the blow (`facing` is the dot of its outward normal with the
 * direction the car was hit from, -1..1): glass on the side that took it suffers, the rest hardly at all.
 */
export function crashGlassDamage(impact: number, facing: number): number {
  if (impact < 5.5) return 0;
  return (clamp(facing, 0, 1) * 0.95 + 0.05) * (impact - 4) * 1.6;
}

/** A blast breaks the windows of a car by how close it was (`f` is 1 at the car, 0 at the edge of the blast): past a third of the way in, all go. */
export function blastGlassDamage(f: number, kind: GlassKind): number {
  return f <= 0 ? 0 : GLASS_HP[kind] * 3 * clamp(f, 0, 1);
}
