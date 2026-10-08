import { PARTS, gearDef, mountsFor, partDef, type PartDef } from '../data';
import { allItems } from '../sim/gear';
import { partModelKey } from '../sim/carry';
import { defOf, tyreFits } from '../sim/garage';
import { newPart, slotsOf, type PartItem } from '../sim/parts';
import { haulExtraName, rollNightHaul, type HaulGrade, type HaulRoll } from '../sim/nightHaul';
import type { Campaign } from './campaign';

/** What a night's haul came to once it was handed over: the roll, the report's lines, and what to set out by the fire. */
export interface HaulGrant {
  roll: HaulRoll;
  /** "The night's haul" lines on the dawn report, in plain words with names. */
  lines: string[];
  /** Pickup model keys (`render/props.ts`) for the little pile by the camp fire. */
  models: string[];
  /** The part, wherever it went. */
  part: PartItem | null;
  /** Where the part went: the trucks, a crate left at the camp (the trucks were full), or broken down for Scrap. */
  stowed: 'trucks' | 'crate' | 'scrap' | null;
}

/** Part ids the convoy already has: on the vehicles rolling out, and in the trucks. */
export function partsHeld(c: Campaign): Set<string> {
  const out = new Set<string>();
  for (const it of c.inventory) out.add(it.id);
  for (const b of c.activeBuilds()) {
    for (const it of Object.values(b.fit)) if (it) out.add(it.id);
    for (const t of b.tyres) if (t) out.add(t.id);
  }
  return out;
}

/** Whether a part has a mount on one of the vehicles rolling out (a tyre: a hub made for it). */
export function fitsConvoy(c: Campaign, d: PartDef): boolean {
  return c.activeBuilds().some((b) => {
    const def = defOf(b);
    if (d.slot === 'wheels') return slotsOf(def).includes('wheels') && b.tyres.some((_, i) => tyreFits(def, i, d.id));
    return mountsFor(d.slot).some((m) => slotsOf(def).includes(m));
  });
}

/** One load of every gun the players carry (their magazines summed), and whether anybody carries a bow. */
export function gunsCarried(c: Campaign): { mags: number; bow: boolean } {
  let mags = 0;
  let bow = false;
  for (let i = 0; i < c.count; i++) {
    for (const it of allItems(c.players[i].gear)) {
      const g = gearDef(it.id).gun;
      if (!g) continue;
      if (g.draw) bow = true;
      else mags += g.mag;
    }
  }
  return { mags, bow };
}

/**
 * Roll the night's haul and hand it over: rounds into the convoy's ammunition, arrows to the quiver, the part into the
 * trucks, the extra into the medicine chest. A part that will not fit in full trucks goes to `crate` if one is offered (left
 * at the camp to be carried off in the morning), otherwise it is broken down for Scrap as anything else would be.
 */
export function grantNightHaul(c: Campaign, grade: HaulGrade, waves: number, o: { crate?: (item: PartItem) => boolean } = {}): HaulGrant {
  const guns = gunsCarried(c);
  const roll = rollNightHaul({ seed: c.seed, day: c.day, grade, waves, mags: guns.mags, bow: guns.bow, have: partsHeld(c), fits: (d) => fitsConvoy(c, d) });
  const out: HaulGrant = { roll, lines: [], models: [], part: null, stowed: null };
  if (roll.grade === 'none') return out;
  c.ammo += roll.ammo;
  out.lines.push(`${roll.ammo} rounds of ammunition for the guns you carry.`);
  out.models.push('ammo');
  if (roll.arrows) {
    c.items.arrow += roll.arrows;
    out.lines.push(`${roll.arrows} arrows for the bow.`);
  }
  if (roll.part) {
    const item = newPart(roll.part.id, roll.part.cond);
    const d = partDef(item.id);
    const what = `${d.name} (${PARTS.rarity[d.mk] ?? `Mk${d.mk}`}, ${PARTS.labels[d.slot].toLowerCase()})`;
    out.part = item;
    // The part's own model as it would lie on the ground (an engine, a disc, a tyre); the bolt-on kit by its own shape.
    const key = partModelKey(item.id);
    out.models.push(/^part\d$/.test(key) ? `part:${item.id}` : key);
    if (c.stowPart(item)) {
      out.stowed = 'trucks';
      out.lines.push(`A rare find: ${what}, stowed in the trucks.`);
    } else if (o.crate?.(item)) {
      out.stowed = 'crate';
      out.lines.push(`A rare find: ${what}. The trucks are full, so it waits in a crate by the vehicles: carry it off or fit it before you roll on.`);
    } else {
      const r = c.addPart(item);
      out.stowed = r.stored ? 'trucks' : 'scrap';
      out.lines.push(r.stored ? `A rare find: ${what}, stowed in the trucks.` : `A rare find: ${what}. The trucks are full, so it was broken down for ${r.scrap} Scrap.`);
    }
  }
  if (roll.extra) {
    const { id, n } = roll.extra;
    if (id === 'medicine') c.stocks.medicine += n;
    else c.items[id] += n;
    out.lines.push(`From the medicine chest: ${haulExtraName(id, n)}.`);
    out.models.push(id === 'medkit' ? 'medkit' : id === 'bandage' ? 'bandage' : 'medicine');
  }
  if (roll.grade === 'partial') out.lines.push('The night was cut short, so this is only part of what holding out would have brought.');
  return out;
}
