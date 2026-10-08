import { BLEED, bind } from '../sim/vitals';
import { bindVenom, drawVenom } from '../sim/venom';
import { drink, eat, type Needs } from '../sim/needs';
import { DRUGS, type DrugId } from '../sim/drugs';
import { whole } from '../sim/resources';
import { MEDKIT_HEAL, type Player } from './player';

/**
 * Using up the convoy's supplies from the inventory: the same rules as the quick belt and the chore keys, asked first as a
 * check (so a menu can grey an action out and say why) and then done. Dressings can also go on a partner standing close.
 */

export type Check = { ok: true } | { ok: false; reason: string };
const yes: Check = { ok: true };
const no = (reason: string): Check => ({ ok: false, reason });

/** How close a partner has to be to have their wounds bound from your pack. */
export const DRESS_REACH = 3;

const hurtOf = (p: Player) => p.hp < p.maxHp - 0.5 || p.bleed.level > 0 || p.venom.dose > 0;
const plural = (kind: 'bandage' | 'medkit') => (kind === 'bandage' ? 'bandages' : 'medkits');

/** A dressing on yourself: one in the stores and something for it to do. */
export function dressCheck(p: Player, kind: 'bandage' | 'medkit'): Check {
  if (p.ctx.campaign.items[kind] <= 0) return no(`No ${plural(kind)} left`);
  if (!hurtOf(p)) return no('You are not hurt');
  return yes;
}

/** A dressing on someone else: they have to be up, out of the vehicle, close, and hurt. */
export function dressOtherCheck(by: Player, who: Player | undefined, kind: 'bandage' | 'medkit'): Check {
  if (!who) return no('Nobody with you');
  if (by.ctx.campaign.items[kind] <= 0) return no(`No ${plural(kind)} left`);
  if (who.state === 'dead') return no(`${who.name} is gone`);
  if (who.state === 'downed') return no(`${who.name} is down: hold interact by them to revive`);
  if (who.state !== 'foot' || by.state !== 'foot') return no(`${who.name} needs to be out of the vehicle`);
  if (Math.hypot(who.pos.x - by.pos.x, who.pos.z - by.pos.z) > DRESS_REACH) return no(`Too far: get within ${DRESS_REACH} m of ${who.name}`);
  if (!hurtOf(who)) return no(`${who.name} is not hurt`);
  return yes;
}

/** Bind a partner's wounds (or a bite) from your own pack. The same dressing does the same as it would on you. */
export function dressOther(by: Player, who: Player, kind: 'bandage' | 'medkit'): boolean {
  if (!dressOtherCheck(by, who, kind).ok) return false;
  const items = by.ctx.campaign.items;
  items[kind]--;
  const venom = who.venom.dose > 0;
  if (venom) {
    if (kind === 'medkit') drawVenom(who.venom);
    else bindVenom(who.venom);
  }
  const closed = bind(who.bleed);
  const before = who.hp;
  who.heal(kind === 'medkit' ? MEDKIT_HEAL : BLEED.bandageHeal);
  by.ctx.audio.play('pill', who.pos.x, who.pos.z, 0.5);
  const what = venom ? (kind === 'medkit' ? 'drew the venom' : 'slowed the venom') : closed ? 'stopped the bleeding' : `+${Math.round(who.hp - before)} HP`;
  by.note(`You dressed ${who.name}'s wounds: ${what}`, 'good');
  who.note(`${by.name} dressed your wounds: ${what}`, 'good');
  return true;
}

/** Eating a ration: one in the stores, and room for it. */
export function eatCheck(p: Player): Check {
  const n: Needs = { ...p.needs };
  const r = eat(n, whole(p.ctx.campaign.stocks.rations));
  return r.ok ? yes : no(r.reason ?? 'You cannot eat now');
}

/** The water you are standing at, if any: drinking there is free. */
export function waterHere(p: Player) {
  if (p.state !== 'foot') return null;
  const ctx = p.ctx;
  return ctx.waterAt(p.pos.x + Math.sin(p.aimYaw) * 1.2, p.pos.z + Math.cos(p.aimYaw) * 1.2) ?? ctx.waterAt(p.pos.x, p.pos.z);
}

/** Drinking: from the water you stand at, else the reserve. */
export function drinkCheck(p: Player): Check {
  const n: Needs = { ...p.needs };
  const r = drink(n, p.ctx.campaign.items.water, { lake: !!waterHere(p), roll: 1 });
  return r.ok ? yes : no(r.reason ?? 'You cannot drink now');
}

/** A dose: one in the stores and someone in a state to take it. */
export function drugCheck(p: Player, id: DrugId): Check {
  if ((p.ctx.campaign.items[id] ?? 0) <= 0) return no(`No ${DRUGS[id].name.toLowerCase()} left`);
  if (p.state === 'dead' || p.state === 'downed') return no('Not now');
  if (p.drugs.passedOut) return no('You are passed out');
  return yes;
}
