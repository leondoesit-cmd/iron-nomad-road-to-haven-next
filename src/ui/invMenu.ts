import { ATTACH_LABELS, gearDef, type WearSlot } from '../data';
import {
  BELT_SIZE,
  UTILITY_SLOT,
  bagCap,
  equipFromBag,
  findItem,
  isWeapon,
  itemAt,
  repairPrice,
  scrapOf,
  unequipBelt,
  unequipWorn,
  type GearItem,
  type Loadout,
  type Result,
} from '../sim/gear';
import { canFit, fitted, kitOf, slotsOfGun } from '../sim/gunmods';
import { UTILITIES, utilityName, type Player, type QuickId } from '../game/player';
import { dressCheck, dressOtherCheck, drinkCheck, drugCheck, drugWord, eatCheck, type Check } from '../game/consumables';
import { isDrug, supplyName, type SupplyId } from './supplies';
import type { Campaign } from '../game/campaign';

/**
 * The inventory's context menu: for whatever is picked (a piece of gear, a supply, a throwable), the things that can be done
 * with it, most likely first, each with why it cannot be done when it cannot. Pure: the actions call back into the view.
 */

export type Utility = (typeof UTILITIES)[number];

export type InvTarget = { kind: 'gear'; uid: string } | { kind: 'supply'; id: SupplyId } | { kind: 'util'; id: Utility };

export interface MenuItem {
  /** Stable id: the focus key of its button, and what tests ask for. */
  id: string;
  label: string;
  /** The keyboard shortcut (a letter or a digit), or empty for none. */
  key: string;
  enabled: boolean;
  /** Why it is greyed out. */
  reason?: string;
  /** A short figure on the right: what it costs or gives. */
  note?: string;
  /** Laid out as a small square in a row of its siblings (the belt slots). */
  chip?: boolean;
  /** Something that cannot be taken back (breaking an item down). */
  danger?: boolean;
  run: () => void;
}

/** What the menu needs from the inventory view: who, whose stores, and the operations. */
export interface MenuHost {
  readonly p: Player;
  readonly c: Campaign;
  /** Over a running scene: things can be put down on the ground. The Dawn Ledger has no ground to drop on. */
  readonly field: boolean;
  /** The other survivor, when there is one in the scene. */
  readonly partner: Player | undefined;
  equip(uid: string, slot?: number): void;
  takeOff(slot: WearSlot): void;
  hold(i: number): void;
  stow(i: number): void;
  moveBelt(from: number, to: number): void;
  load(uid: string): void;
  customise(uid: string): void;
  repair(uid: string): void;
  fit(gunUid: string, modUid: string): void;
  give(uid: string): void;
  drop(uid: string): void;
  scrap(uid: string): void;
  pickUtility(u: Utility): void;
  useDressing(kind: 'bandage' | 'medkit'): void;
  dressPartner(kind: 'bandage' | 'medkit'): void;
  setQuick(id: QuickId): void;
  takeDrug(id: SupplyId): void;
  eat(): void;
  drink(): void;
}

/** The fixed keyboard letters, so a habit carries from one item to the next. Digits are the belt slots and the guns to fit. */
export const MENU_KEYS = {
  use: 'U',
  partner: 'G',
  quick: 'Q',
  hold: 'H',
  wear: 'O',
  load: 'L',
  custom: 'M',
  repair: 'F',
  stow: 'B',
  give: 'G',
  drop: 'Z',
  scrap: 'P',
} as const;

const ok = (): Check => ({ ok: true });
const fromResult = (r: Result): Check => (r.ok ? { ok: true } : { ok: false, reason: r.reason });

/** A copy to try an operation on, so the menu can say whether it would work without doing it. */
function copyOf(L: Loadout): Loadout {
  return { worn: { ...L.worn }, belt: [...L.belt], sel: L.sel, bag: [...L.bag] };
}

/** Whether the belt would still have something to fight with after slot `skip` is emptied. */
function armedWithout(L: Loadout, skip: number): boolean {
  return L.belt.some((b, i) => i !== skip && !!b && isWeapon(gearDef(b.id)));
}

/**
 * Whether an item can leave the kit altogether (given away, dropped, broken down): a worn pack cannot while its pockets
 * are holding the bag, and the last weapon stays on the belt.
 */
export function canTakeOut(L: Loadout, uid: string): Check {
  const spot = findItem(L, uid);
  if (!spot) return { ok: false, reason: 'You do not have that' };
  const it = itemAt(L, spot)!;
  if (spot.zone === 'belt' && isWeapon(gearDef(it.id)) && !armedWithout(L, spot.i)) return { ok: false, reason: 'Keep a weapon on your belt' };
  if (spot.zone === 'worn' && L.bag.length > bagCap(L) - (gearDef(it.id).stats?.bag ?? 0)) return { ok: false, reason: 'Its pockets hold your bag: empty the bag first' };
  return ok();
}

/** Take an item out of the kit, wherever it is. The selection moves on if it was in hand. */
export function takeOut(L: Loadout, uid: string): GearItem | null {
  if (!canTakeOut(L, uid).ok) return null;
  const spot = findItem(L, uid)!;
  const it = itemAt(L, spot)!;
  if (spot.zone === 'bag') L.bag.splice(spot.i, 1);
  else if (spot.zone === 'worn') delete L.worn[spot.slot];
  else {
    L.belt[spot.i] = null;
    if (L.sel === spot.i) {
      const j = L.belt.findIndex((b) => !!b);
      L.sel = j >= 0 ? j : UTILITY_SLOT;
    }
  }
  return it;
}

/** The magazine a gun could hold, and what loading it from the stores would put in. */
export function loadPlan(it: GearItem, rounds: number): { cap: number; add: number; why?: string } {
  const d = gearDef(it.id);
  if (!d.gun) return { cap: 0, add: 0, why: 'Not a gun' };
  if (d.gun.draw) return { cap: 1, add: 0, why: 'Arrows are nocked as you draw' };
  const cap = kitOf(it).gun.mag;
  const mag = it.mag ?? cap;
  if (mag >= cap) return { cap, add: 0, why: 'Already full' };
  if (rounds <= 0) return { cap, add: 0, why: 'No rounds left' };
  return { cap, add: Math.min(cap - mag, rounds) };
}

function item(id: string, label: string, key: string, check: Check, run: () => void, extra: Partial<MenuItem> = {}): MenuItem {
  return { id, label, key, enabled: check.ok, reason: check.ok ? undefined : check.reason, run, ...extra };
}

/** Everything that can be done with a piece of gear, in the order a player reaches for it. */
function gearMenu(h: MenuHost, uid: string): MenuItem[] {
  const L = h.p.gear;
  const spot = findItem(L, uid);
  const it = spot ? itemAt(L, spot) : null;
  if (!spot || !it) return [];
  const d = gearDef(it.id);
  const out: MenuItem[] = [];
  const K = MENU_KEYS;
  const handItem = d.kind === 'gun' || d.kind === 'melee' || d.kind === 'tool';

  if (spot.zone === 'bag') {
    if (d.kind === 'wear') out.push(item('a-equip', `Wear it`, K.wear, fromResult(equipFromBag(copyOf(L), uid)), () => h.equip(uid)));
    else if (handItem) {
      out.push(item('a-equip', 'Put it in hand', K.hold, ok(), () => h.equip(uid)));
      for (let i = 0; i < BELT_SIZE; i++) {
        const o = L.belt[i];
        out.push(item(`a-slot${i}`, String(i + 1), String(i + 1), ok(), () => h.equip(uid, i), { chip: true, note: o ? (gearDef(o.id).short ?? gearDef(o.id).name) : 'free' }));
      }
    } else if (d.mod) {
      // Fit it to any gun that takes it: the one in hand first, then the belt, then the bag.
      const guns = [L.belt[L.sel], ...L.belt, ...L.bag].filter((g, i, a): g is GearItem => !!g && !!gearDef(g.id).gun && a.indexOf(g) === i && canFit(g.id, it.id));
      guns.slice(0, 4).forEach((g, i) => {
        const where = L.belt.includes(g) ? (L.belt[L.sel] === g ? 'in hand' : 'belt') : 'bag';
        out.push(item(`a-fit${g.uid}`, `Fit to ${gearDef(g.id).name}`, String(i + 1), ok(), () => h.fit(g.uid, it.uid), { note: where }));
      });
      if (guns.length > 4) out.push(item('a-fitmore', `${guns.length - 4} more guns take it`, '', { ok: false, reason: 'Customise one of them to fit it' }, () => {}));
      if (!guns.length) out.push(item('a-fit', `Fit to a gun`, '', { ok: false, reason: `Nothing you carry has a ${ATTACH_LABELS[d.mod.slot].toLowerCase()} slot for it` }, () => {}));
    }
  } else if (spot.zone === 'worn') {
    out.push(item('a-off', 'Take it off', K.wear, fromResult(unequipWorn(copyOf(L), spot.slot)), () => h.takeOff(spot.slot)));
  } else {
    out.push(item('a-hold', 'Hold it', K.hold, L.sel === spot.i ? { ok: false, reason: 'Already in hand' } : ok(), () => h.hold(spot.i)));
  }

  if (d.gun && spot.zone !== 'worn') {
    const lp = loadPlan(it, h.c.ammo);
    if (!d.gun.draw) out.push(item('a-load', 'Load it', K.load, lp.why ? { ok: false, reason: lp.why } : ok(), () => h.load(uid), { note: `${it.mag ?? lp.cap}/${lp.cap}` }));
    const slots = slotsOfGun(d).length;
    if (slots) out.push(item('a-cust', 'Customise', K.custom, ok(), () => h.customise(uid), { note: `${fitted(it).length}/${slots}` }));
  }
  const fix = repairPrice(it);
  if (fix > 0) out.push(item('a-repair', 'Repair', K.repair, h.c.stocks.scrap >= fix ? ok() : { ok: false, reason: `Needs ${fix} Scrap, you have ${Math.floor(h.c.stocks.scrap)}` }, () => h.repair(uid), { note: `${fix} Scrap` }));

  if (spot.zone === 'belt') {
    for (let i = 0; i < BELT_SIZE; i++) {
      if (i === spot.i) continue;
      const o = L.belt[i];
      out.push(item(`a-mv${i}`, String(i + 1), String(i + 1), ok(), () => h.moveBelt(spot.i, i), { chip: true, note: o ? (gearDef(o.id).short ?? gearDef(o.id).name) : 'free' }));
    }
    out.push(item('a-stow', 'Stow it in the bag', K.stow, fromResult(unequipBelt(copyOf(L), spot.i)), () => h.stow(spot.i)));
  }

  // Leaving the kit: to the partner, on the ground, or broken down.
  const out_ = canTakeOut(L, uid);
  if (!h.c.solo) {
    const them = h.c.players[1 - h.p.index];
    const room = them.gear.bag.length < bagCap(them.gear);
    out.push(item('a-give', `Give to ${them.name}`, K.give, !room ? { ok: false, reason: 'Their bag is full' } : out_, () => h.give(uid)));
  }
  // Set down at your feet; in deep water it would only sink out of reach.
  if (h.field) out.push(item('a-drop', 'Drop it', K.drop, h.p.swimming ? { ok: false, reason: 'Not while you are swimming' } : out_, () => h.drop(uid)));
  out.push(item('a-scrap', 'Break down', K.scrap, out_, () => h.scrap(uid), { danger: true, note: `+${scrapOf({ ...it, att: undefined })} Scrap` }));
  return out;
}

/** A dressing, food, water or a drug: use it, put it on the quick belt, or (dressings) use it on a partner. */
function supplyMenu(h: MenuHost, id: SupplyId): MenuItem[] {
  const p = h.p;
  const K = MENU_KEYS;
  const out: MenuItem[] = [];
  const quickId: QuickId = id === 'ration' ? 'eat' : id === 'water' ? 'drink' : id;
  const onBelt = p.quickSel === quickId;
  if (id === 'bandage' || id === 'medkit') {
    out.push(item('a-use', id === 'bandage' ? 'Apply a bandage' : 'Use a medkit', K.use, dressCheck(p, id), () => h.useDressing(id)));
    if (!h.c.solo) {
      const who = h.partner;
      const name = who?.name ?? h.c.players[1 - p.index].name;
      out.push(item('a-other', id === 'bandage' ? `Bandage ${name}` : `Patch up ${name}`, K.partner, dressOtherCheck(p, who, id), () => h.dressPartner(id)));
    }
  } else if (id === 'ration') out.push(item('a-eat', 'Eat a ration', K.use, eatCheck(p), () => h.eat()));
  else if (id === 'water') out.push(item('a-drink', 'Drink', K.use, drinkCheck(p), () => h.drink()));
  else if (isDrug(id)) out.push(item('a-take', `Take ${drugWord(id)}`, K.use, drugCheck(p, id), () => h.takeDrug(id)));
  out.push(item('a-quick', 'Put on quick belt', K.quick, onBelt ? { ok: false, reason: 'It is on the quick belt already' } : ok(), () => h.setQuick(quickId)));
  return out;
}

function utilMenu(h: MenuHost, u: Utility): MenuItem[] {
  const L = h.p.gear;
  const n = u === 'horn' ? Infinity : (h.c.items[u] ?? 0);
  const held = L.sel === UTILITY_SLOT && h.p.utility === u;
  const why: Check = held ? { ok: false, reason: 'Already in hand' } : n <= 0 ? { ok: false, reason: `No ${utilityName(u).toLowerCase()}s left` } : ok();
  return [item('a-util', `Hold the ${utilityName(u).toLowerCase()}`, MENU_KEYS.hold, why, () => h.pickUtility(u), { note: n === Infinity ? '' : `×${n}` })];
}

/** The menu for a target. Empty when the target is gone. */
export function menuFor(h: MenuHost, t: InvTarget): MenuItem[] {
  if (t.kind === 'gear') return gearMenu(h, t.uid);
  if (t.kind === 'supply') return supplyMenu(h, t.id);
  return utilMenu(h, t.id);
}

/** Rows that send the item out of the kit: never what X does on its own, so a stray press loses nothing. */
const LEAVES = new Set(['a-give', 'a-drop', 'a-scrap']);

/** The action X (and a double click) does: the first that can be done that keeps the item, never breaking it down. */
export function defaultAction(items: MenuItem[]): MenuItem | null {
  return items.find((i) => i.enabled && !i.danger && !i.chip && !LEAVES.has(i.id)) ?? null;
}

/** A heading for the menu. */
export function targetName(h: MenuHost, t: InvTarget): string {
  if (t.kind === 'gear') {
    const spot = findItem(h.p.gear, t.uid);
    const it = spot ? itemAt(h.p.gear, spot) : null;
    return it ? gearDef(it.id).name : '';
  }
  if (t.kind === 'supply') return supplyName(t.id);
  return utilityName(t.id);
}
