import { newPart } from '../sim/parts';
import { specName, type LootSpec } from '../sim/loot';
import type { Ctx } from './ctx';

/**
 * Hand named finds to the convoy: what a searched locker, an opened chest or a stripped car holds. Every kind goes where
 * that kind goes. Parts go to the trucks (and onto the ground beside the find if the trucks are full: nothing is turned
 * into Scrap). Cans are hand-carried things, so they are set down beside the find for someone to lift; underground, where
 * nothing lies on the ground, they go straight into the reserves. Tins, pills, dressings and rounds are banked.
 *
 * Returns what was taken, as names, for the toast.
 */
export function grantLoot(ctx: Ctx, specs: LootSpec[], at: { x: number; z: number }, who?: { x: number; z: number }): string[] {
  const camp = ctx.campaign;
  const names: string[] = [];
  let n = 0;
  /** A spot on the ground beside the find, a little further round for each thing. */
  const spot = () => {
    const a = 0.7 + n++ * 1.15;
    const r = 1.1 + (n % 2) * 0.35;
    const cx = who ? (at.x + who.x) / 2 : at.x;
    const cz = who ? (at.z + who.z) / 2 : at.z;
    return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r };
  };
  for (const s of specs) {
    switch (s.kind) {
      case 'part': {
        const item = newPart(s.id, s.cond);
        if (camp.stowPart(item)) names.push(specName(s));
        else if (ctx.loose) {
          const p = spot();
          ctx.loose.drop(p.x, p.z, { kind: 'part', item });
          names.push(`${specName(s)} (set down: no room in the trucks)`);
        } else {
          // Underground nothing can be left on the floor to come back to.
          const r = camp.addPart(item);
          names.push(r.stored ? specName(s) : `${specName(s)} (no room: broken down)`);
        }
        break;
      }
      case 'fuel':
        if (ctx.loose) {
          const p = spot();
          ctx.loose.drop(p.x, p.z, { kind: 'fuel', amount: s.amount, fuel: s.fuel });
        } else camp.stowFuel(s.amount, s.fuel);
        names.push(specName(s));
        break;
      case 'oil':
        if (ctx.loose) {
          const p = spot();
          ctx.loose.drop(p.x, p.z, { kind: 'oil', amount: s.amount });
        } else camp.stowOil(s.amount);
        names.push(specName(s));
        break;
      case 'water':
        if (ctx.loose) {
          const p = spot();
          ctx.loose.drop(p.x, p.z, { kind: 'water', amount: s.amount });
        } else camp.stowWater(s.amount);
        names.push(specName(s));
        break;
      case 'paint': {
        if (ctx.loose) {
          const p = spot();
          ctx.loose.drop(p.x, p.z, { kind: 'paint', color: s.color, charges: s.charges });
          names.push(specName(s));
        } else {
          // Underground there is no ground to set a can on for later and no shelf in the hold for one: the convoy takes it
          // for what the can is worth rather than announcing a find that then vanishes.
          ctx.addLoot({ scrap: 2 }, 'search');
          names.push(`${specName(s)} (as scrap)`);
        }
        break;
      }
      case 'rations':
        ctx.addLoot({ rations: s.amount }, 'search');
        names.push(specName(s));
        break;
      case 'medicine':
        ctx.addLoot({ medicine: s.amount }, 'search');
        names.push(specName(s));
        break;
      case 'medkit':
        camp.items.medkit += s.amount;
        names.push(specName(s));
        break;
      case 'bandage':
        camp.items.bandage += s.amount * 3;
        names.push(specName(s));
        break;
      case 'ammo':
        camp.ammo += s.amount;
        names.push(specName(s));
        break;
    }
  }
  return names;
}
