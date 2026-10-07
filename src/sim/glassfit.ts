import { GLASS_NONE, GLASS_SLOTS, GLASS_STOCK, isGlassSlot, partDef, type PartSlot, type VehicleDef } from '../data';
import type { VehicleBuild } from './garage';
import { newPart, slotsOf, type Fit, type PartItem } from './parts';

/**
 * Glass as a part. The windscreen, the rear window and a window in each door are slots of their own (`glassF`, `glassB`,
 * `glassL`, `glassR`): a car can lack any of them, a pane can be lifted out of a wreck and fitted to another car, and a door
 * with no window in it (a canvas flap, an armoured slit) or no door at all has no side glass to show. The panes themselves
 * (what each has taken, what it shows) are `game/carGlass.ts`; this file is the rules that tie them to the fitted parts.
 */

/** The pane keys each glass slot owns (see `render/carModels.ts` `carPanes`): the side windows are a front run and a quarter. */
export const GLASS_KEYS: Record<string, string[]> = { glassF: ['ws'], glassB: ['rw'], glassL: ['sL0', 'sL1'], glassR: ['sR0', 'sR1'] };

/** The panes a chassis has, by key (the cars with windows). Tests check this against the model's own list. */
export const CHASSIS_PANES: Record<string, string[]> = {
  hatch: ['ws', 'rw', 'sL0', 'sL1', 'sR0', 'sR1'],
  sedan: ['ws', 'rw', 'sL0', 'sL1', 'sR0', 'sR1'],
  pickup: ['ws', 'rw', 'sL0', 'sR0'],
  van: ['ws', 'sL0', 'sR0'],
};

/** Which slot a pane belongs to. */
export function slotOfPane(key: string): PartSlot {
  return key === 'ws' ? 'glassF' : key === 'rw' ? 'glassB' : key.startsWith('sL') ? 'glassL' : 'glassR';
}

/** The pane that is part of a door: the front run of the side glass. The quarter behind the pillar is part of the body. */
export const inDoor = (key: string) => key === 'sL0' || key === 'sR0';

/** Side of the car a pane is on: +1 left, -1 right, 0 for the screens. */
export const paneSide = (key: string): 1 | -1 | 0 => (key.startsWith('sL') ? 1 : key.startsWith('sR') ? -1 : 0);

/** The panes of a glass slot on this chassis. */
export function panesOfSlot(def: VehicleDef, slot: PartSlot): string[] {
  const have = CHASSIS_PANES[def.id];
  if (!have) return [];
  return GLASS_KEYS[slot]?.filter((k) => have.includes(k)) ?? [];
}

// ---------------------------------------------------------------- how worn a pane is

/** The glass of a pane as a part would be carried: whole, cracked (1), crazed (2). A pane that has gone (3) is no part at all. */
export const stageCond = (stage: number): number => (stage <= 0 ? 1 : stage === 1 ? 0.6 : stage === 2 ? 0.25 : 0);

/** The stage a carried pane of this condition goes on the car in. */
export const condStage = (cond: number): 0 | 1 | 2 => (cond >= 0.8 ? 0 : cond >= 0.4 ? 1 : 2);

// ---------------------------------------------------------------- what is fitted

/** The part fitted in a glass slot: the fitted item, the factory pane, or null for an empty frame (or no such mount). */
export function glassIdIn(def: VehicleDef, fit: Fit, slot: PartSlot): string | null {
  if (!isGlassSlot(slot) || !slotsOf(def).includes(slot)) return null;
  const it = fit[slot];
  if (it) return partDef(it.id).empty ? null : it.id;
  return GLASS_STOCK[slot] ?? null;
}

/** How tough a glass part is compared with the stock pane. */
export const glassStrength = (id: string | null): number => (id ? partDef(id).glass?.hp ?? 1 : 1);

/** Is there a door on this side, and has it a window in it? A stripped door, a canvas flap and an armoured slit have none. */
export function doorWindow(def: VehicleDef, fit: Fit, side: 1 | -1): boolean {
  const slot: PartSlot = side > 0 ? 'doorL' : 'doorR';
  if (!slotsOf(def).includes(slot)) return true;
  const it = fit[slot];
  if (!it) return true;
  const d = partDef(it.id);
  return !d.empty && d.window !== false;
}

/**
 * The panes a car has with these parts on it. A glass slot with nothing in it has none; the front run of a side window is in
 * the door, so it goes with the door (or is never there if the door has no window).
 */
export function panesPresent(def: VehicleDef, fit: Fit): string[] {
  const have = CHASSIS_PANES[def.id];
  if (!have) return [];
  return have.filter((key) => {
    const slot = slotOfPane(key);
    if (!slotsOf(def).includes(slot) || glassIdIn(def, fit, slot) === null) return false;
    const side = paneSide(key);
    return !(inDoor(key) && side !== 0 && !doorWindow(def, fit, side));
  });
}

// ---------------------------------------------------------------- the build's own state

/**
 * The stage a pane is at on a build that is not live: what was saved for it, or, when none of its slot's panes was saved
 * (they are whole, or this is a pane that was just carried over), what the fitted pane's wear says.
 */
export function stageOnBuild(b: VehicleBuild, key: string): number {
  const slot = slotOfPane(key);
  const saved = b.body?.glass;
  if (saved && (GLASS_KEYS[slot] ?? []).some((k) => saved[k] !== undefined)) return saved[key] ?? 0;
  const it = b.fit[slot];
  return it && !partDef(it.id).empty ? condStage(it.cond) : 0;
}

/** The pane in a glass slot as something you could carry, wearing what it wears now. Null when there is none, or it has gone. */
export function glassItem(b: VehicleBuild, def: VehicleDef, slot: PartSlot): PartItem | null {
  const id = glassIdIn(def, b.fit, slot);
  if (!id) return null;
  const keys = panesOfSlot(def, slot);
  if (!keys.length) return null;
  const conds = keys.map((k) => stageCond(stageOnBuild(b, k)));
  if (conds.every((c) => c === 0)) return null;
  const cond = conds.reduce((a, c) => a + c, 0) / conds.length;
  const it = b.fit[slot];
  return it && it.id === id ? { ...it, cond } : newPart(id, cond);
}

/** How worn the glass in a slot is (0 for a pane that has gone). */
export function glassCond(b: VehicleBuild, def: VehicleDef, slot: PartSlot): number {
  return glassItem(b, def, slot)?.cond ?? 0;
}

/** Forget what was saved about a slot's panes: a new pane has gone in, or the old one came out. */
export function clearPanes(b: VehicleBuild, slot: PartSlot) {
  const glass = b.body?.glass;
  if (!glass) return;
  for (const k of GLASS_KEYS[slot] ?? []) delete glass[k];
  if (!Object.keys(glass).length) delete b.body!.glass;
}

/** What an empty frame of a slot holds. */
export const emptyGlassId = (slot: PartSlot): string | undefined => GLASS_NONE[slot];

export { GLASS_SLOTS };
