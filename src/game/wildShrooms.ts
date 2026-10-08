import { promptLabel } from '../input/input';
import { SHROOMS, SHROOM_LOOK, SHROOM_NAME, WILD_ITEM, eatWild, sortWild, type Shroom } from '../sim/forage';
import { NEEDS } from '../sim/needs';
import type { Campaign } from './campaign';
import type { Player } from './player';

/**
 * The convoy's stash of wild mushrooms nobody knew when they were picked (`items.wild*`, by what they really are), and the
 * quick belt's slot for them: one slot that walks through the lots by their look ("little pointed brown caps"), so what you
 * eat is what you chose. Eating one is how you find out (`sim/forage.ts` `eatWild`); once anyone in the convoy knows a kind,
 * its lot is sorted where it belongs (`sortStash`).
 *
 * Knowledge stays where `Foraging` kept it: `campaign.flags['forage.<hero>.<kind>']`. A death cap eaten anywhere leaves
 * `forage.sick.<hero>` set, and the open world's `Foraging` turns that into the poisoning (so it waits out a delve).
 */

/** A lot nobody knows, as short as a HUD chip wants it. */
const SHORT: Record<Shroom, string> = { field: 'White caps?', liberty: 'Brown caps?', deathcap: 'Olive caps?' };

/** Belt order of the lots: the ones that do something first. */
const LOTS: Shroom[] = ['liberty', 'field', 'deathcap'];

/** Which lot each player's mushroom slot rests on. */
const lotOf = new WeakMap<Player, Shroom>();

export const knowsShroom = (c: Campaign, hero: string, s: Shroom): boolean => !!c.flags[`forage.${hero}.${s}`];

/** Whether anyone playing knows a kind. */
export function anyKnows(c: Campaign, heroes: readonly string[], s: Shroom): boolean {
  return heroes.some((h) => knowsShroom(c, h, s));
}

export function learnShroom(c: Campaign, hero: string, s: Shroom) {
  c.flags[`forage.${hero}.${s}`] = true;
}

/** Wild mushrooms in the stash, all lots. */
export function wildTotal(c: Campaign): number {
  let n = 0;
  for (const s of SHROOMS) n += c.items[WILD_ITEM[s]];
  return n;
}

/** The lot the slot will eat from: the chosen one while it lasts, else the first that has any. Null when the stash is empty. */
export function wildLot(p: Player): Shroom | null {
  const items = p.ctx.campaign.items;
  const sel = lotOf.get(p);
  if (sel && items[WILD_ITEM[sel]] > 0) return sel;
  return LOTS.find((s) => items[WILD_ITEM[s]] > 0) ?? null;
}

/**
 * Step the slot to the next lot that has any (`dir` along the belt). False when there is no further lot that way, so the belt
 * moves on to its next slot instead.
 */
export function stepWildLot(p: Player, dir: 1 | -1): boolean {
  const items = p.ctx.campaign.items;
  const cur = wildLot(p);
  if (!cur) return false;
  for (let i = LOTS.indexOf(cur) + dir; i >= 0 && i < LOTS.length; i += dir) {
    if (items[WILD_ITEM[LOTS[i]]] > 0) {
      lotOf.set(p, LOTS[i]);
      return true;
    }
  }
  return false;
}

/** Point the slot at a lot (the one just picked). */
export function selectWildLot(p: Player, s: Shroom) {
  lotOf.set(p, s);
}

/** What a lot is called by this player: its name if they know it, else its look. */
export function lotName(p: Player, s: Shroom): string {
  return knowsShroom(p.ctx.campaign, p.hero, s) ? SHROOM_NAME[s] : `${SHROOM_LOOK[s]} (unknown)`;
}

/** The belt slot as the HUD shows it to one player (`chip`: the short name for the chip under the belt). */
export function wildSlot(p: Player): { name: string; chip: string; glyph: string; color: string; blurb: string; n: number } {
  const lot = wildLot(p);
  const n = lot ? p.ctx.campaign.items[WILD_ITEM[lot]] : 0;
  const lots = LOTS.filter((s) => p.ctx.campaign.items[WILD_ITEM[s]] > 0).length;
  const name = lot ? cap(lotName(p, lot)) : 'Wild mushrooms';
  const blurb = lot
    ? `Mushrooms you picked without knowing them. Eat one to find out what they do: food, a trip, or a very bad day.${lots > 1 ? ' ◀ ▶ walks through the kinds you have.' : ''}`
    : 'Mushrooms picked in the woods that nobody knew go here, by their look. Eating one is how you learn them.';
  const chip = lot ? (knowsShroom(p.ctx.campaign, p.hero, lot) ? SHROOM_NAME[lot] : SHORT[lot]) : 'Wild mushrooms';
  return { name, chip, glyph: '🍄', color: '#c9a36a', blurb, n };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Eat one from the slot's lot: the gamble. Returns false when there was nothing to eat. */
export function eatWildShroom(p: Player): boolean {
  const ctx = p.ctx;
  const c = ctx.campaign;
  const lot = wildLot(p);
  if (!lot) {
    p.note('No wild mushrooms in the stash', 'warn');
    ctx.audio.play('deny');
    return false;
  }
  c.items[WILD_ITEM[lot]]--;
  const o = eatWild(lot, p.needs);
  const n = p.needs;
  if (o.food > 0) {
    n.food = Math.min(1, n.food + o.food);
    n.bowel = Math.min(1, n.bowel + o.food * NEEDS.bowelPerFood * 0.45);
  }
  ctx.audio.play('munch', p.pos.x, p.pos.z, 0.5);
  p.note(o.note, o.tone);
  if (o.trip) {
    const r = p.drugs.dose('mushrooms');
    for (const t of r.notes) p.note(t, 'warn');
  }
  if (o.poison) c.flags[`forage.sick.${p.hero}`] = true;
  if (o.learn) {
    learnShroom(c, p.hero, o.learn);
    sortStash(c, ctx.players);
  }
  return true;
}

/**
 * Sort whatever lots of the stash someone playing now knows: liberty caps onto the belt with the drugs, field mushrooms into
 * the stores, death caps thrown away. The one who knows says so. Returns whether anything moved.
 */
export function sortStash(c: Campaign, players: readonly Player[]): boolean {
  let moved = false;
  for (const s of SHROOMS) {
    const n = c.items[WILD_ITEM[s]];
    if (n <= 0) continue;
    const who = players.find((p) => knowsShroom(c, p.hero, s));
    if (!who) continue;
    const r = sortWild(s, n);
    c.items[WILD_ITEM[s]] = 0;
    c.items.mushrooms += r.mushrooms;
    if (r.rations) c.stocks.rations += r.rations;
    const hand = n === 1 ? 'handful' : 'handfuls';
    const key = promptLabel(who.ctx.input.slots?.[who.index] ?? null, 'Down');
    who.note(
      s === 'liberty'
        ? `You sort the stash: ${n} ${hand} of liberty caps go on the quick belt with the drugs (${key})`
        : s === 'field'
          ? `You sort the stash: ${n} ${hand} of field mushrooms go in the stores`
          : `You sort the stash: ${n} ${hand} of death caps, thrown away`,
      s === 'deathcap' ? 'warn' : 'good',
    );
    moved = true;
  }
  return moved;
}
