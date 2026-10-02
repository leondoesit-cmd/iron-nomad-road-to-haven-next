import { describe, expect, it } from 'vitest';
import { GEAR, WEAR_SLOTS, gearDef, validateData } from '../src/data';
import { Rng } from '../src/core/rng';
import {
  BELT_SIZE,
  UTILITY_SLOT,
  addToBag,
  bagCap,
  bagRoom,
  compareStats,
  damageTaken,
  describeStats,
  effectiveGun,
  effectiveMelee,
  equipFromBag,
  findItem,
  gearDrop,
  giveItem,
  heldItem,
  moveBelt,
  newGear,
  rollGear,
  sanitizeLoadout,
  starterLoadout,
  statsOf,
  stepSel,
  takeFromBag,
  unequipBelt,
  unequipWorn,
  type Loadout,
} from '../src/sim/gear';

/** A loadout with the bag filled to the brim with cheap junk. */
function stuffed(l: Loadout) {
  while (bagRoom(l) > 0) l.bag.push(newGear('h_cap'));
  return l;
}

describe('gear catalogue', () => {
  it('passes the data checks and covers every wear slot with a starter', () => {
    expect(validateData()).toEqual([]);
    for (const s of WEAR_SLOTS) expect(GEAR.items.some((g) => g.starter && g.slot === s)).toBe(true);
  });

  it('every item has a unique id and sensible numbers', () => {
    expect(new Set(GEAR.items.map((g) => g.id)).size).toBe(GEAR.items.length);
    for (const g of GEAR.items) {
      expect(g.weight).toBeGreaterThan(0);
      if (g.kind === 'wear') expect(WEAR_SLOTS).toContain(g.slot);
      if (g.gun) expect(g.gun.adsSpread).toBeLessThanOrEqual(g.gun.spread);
    }
  });

  it('the starter pistol matches what the game fired before there was an inventory', () => {
    const g = gearDef('w_pistol').gun!;
    expect([g.dmg, g.cd, g.mag, g.reload, g.spread, g.adsSpread, g.range, g.noise]).toEqual([27, 0.2, 12, 1.3, 0.03, 0.008, 75, 60]);
  });
});

describe('starter loadout', () => {
  it('wears one starter in every slot and carries the four old tools in the old order', () => {
    const l = starterLoadout();
    for (const s of WEAR_SLOTS) expect(l.worn[s]).toBeDefined();
    expect(l.belt.map((b) => b?.id)).toEqual(['w_pistol', 't_wrench', 't_crowbar', 't_jerrycan']);
    expect(l.sel).toBe(0);
    expect(l.bag.length).toBeGreaterThan(0);
  });

  it('gives items unique ids and a full magazine', () => {
    const l = starterLoadout();
    const ids = [...Object.values(l.worn), ...l.belt, ...l.bag].map((i) => i!.uid);
    expect(new Set(ids).size).toBe(ids.length);
    expect(l.belt[0]!.mag).toBe(12);
  });

  it('is not shared between two scavengers', () => {
    const a = starterLoadout();
    const b = starterLoadout();
    a.bag.pop();
    expect(b.bag.length).toBe(a.bag.length + 1);
  });
});

describe('capacity and stats', () => {
  it('the bag is the base plus whatever is worn', () => {
    const l = starterLoadout();
    expect(bagCap(l)).toBe(GEAR.bagBase + 6); // the starter rucksack
    delete l.worn.back;
    expect(bagCap(l)).toBe(GEAR.bagBase);
  });

  it('stats add across slots and are held to the caps', () => {
    const l = starterLoadout();
    const s = statsOf(l);
    expect(s.armor).toBeCloseTo(0.04 + 0.03, 6);
    // Stack every armour piece: the cap, not the sum, applies.
    l.worn.head = newGear('h_riot');
    l.worn.body = newGear('b_riot');
    l.worn.legs = newGear('l_greave');
    l.worn.hands = newGear('g_padded');
    l.worn.feet = newGear('s_steel');
    l.worn.face = newGear('f_gas');
    const heavy = statsOf(l);
    expect(heavy.armor).toBeLessThanOrEqual(GEAR.caps.armor);
    expect(heavy.armor).toBeGreaterThan(0.5);
    expect(heavy.speed).toBeGreaterThanOrEqual(GEAR.caps.speedLo);
    expect(heavy.speed).toBeLessThan(-0.1);
  });

  it('armour cuts blows, masks cut spores, boots cut falls, and fire ignores all of it', () => {
    const l = starterLoadout();
    l.worn.face = newGear('f_resp');
    l.worn.feet = newGear('s_steel');
    l.worn.body = newGear('b_plate');
    const r = statsOf(l);
    expect(damageTaken(r, 'bullet')).toBeCloseTo(1 - r.armor, 9);
    expect(damageTaken(r, 'bite')).toBeCloseTo(1 - r.armor, 9);
    expect(damageTaken(r, 'spore')).toBeLessThan(0.45);
    expect(damageTaken(r, 'fall')).toBeCloseTo(1 - r.fall, 9);
    expect(damageTaken(r, 'fire')).toBe(1);
  });

  it('no gear at all takes full damage', () => {
    const r = statsOf({ worn: {}, belt: [], sel: 0, bag: [] });
    for (const k of ['bullet', 'melee', 'bite', 'blast', 'ram', 'spore', 'fall', 'fire'] as const) expect(damageTaken(r, k)).toBe(1);
  });

  it('gloves speed up reloading and goggles tighten the spread; the base gun is unchanged by neutral gear', () => {
    const g = gearDef('w_pistol').gun!;
    const neutral = effectiveGun(g, { reload: 0, steady: 0 });
    expect(neutral.reload).toBe(g.reload);
    expect(neutral.spread).toBe(g.spread);
    const l = starterLoadout();
    l.worn.hands = newGear('g_tac');
    l.worn.face = newGear('f_goggles');
    const fast = effectiveGun(g, statsOf(l));
    expect(fast.reload).toBeLessThan(g.reload);
    expect(fast.spread).toBeLessThan(g.spread);
  });

  it('melee with nothing in hand is the old 35 damage; a better weapon and gloves add up', () => {
    expect(effectiveMelee(null, { melee: 0 }).dmg).toBe(35);
    const axe = gearDef('m_axe').melee!;
    expect(effectiveMelee(axe, { melee: 0.18 }).dmg).toBeCloseTo(85 * 1.18, 6);
  });

  it('describes stats in plain words and flags which changes are good news', () => {
    const lines = describeStats(gearDef('s_sneak').stats);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('-35% footstep noise');
    expect(lines[0].good).toBe(true);
    const bad = describeStats(gearDef('b_riot').stats);
    expect(bad.find((s) => s.key === 'speed')!.good).toBe(false);
    expect(bad.find((s) => s.key === 'noise')!.good).toBe(false);
    expect(describeStats(gearDef('k_duffel').stats).find((s) => s.key === 'bag')!.text).toBe('+10 bag slots');
  });

  it('compares a swap per stat', () => {
    const diff = compareStats(gearDef('b_jacket'), gearDef('b_plate'));
    expect(diff.find((d) => d.key === 'armor')!.good).toBe(true);
    expect(diff.find((d) => d.key === 'speed')!.good).toBe(false);
    expect(compareStats(gearDef('b_jacket'), gearDef('b_jacket'))).toEqual([]);
  });
});

describe('equipping', () => {
  it('wearing from the bag swaps with what is worn and the old item takes the same bag slot', () => {
    const l = starterLoadout();
    const vest = newGear('b_vest');
    l.bag.splice(1, 0, vest);
    const jacket = l.worn.body!;
    const r = equipFromBag(l, vest.uid);
    expect(r.ok).toBe(true);
    expect(l.worn.body).toBe(vest);
    expect(l.bag[1]).toBe(jacket);
    expect(findItem(l, vest.uid)).toEqual({ zone: 'worn', slot: 'body' });
  });

  it('wearing into an empty slot uses up the bag slot', () => {
    const l = starterLoadout();
    delete l.worn.head;
    const cap = l.bag.find((b) => b.id === 'h_cap')!;
    const n = l.bag.length;
    expect(equipFromBag(l, cap.uid).ok).toBe(true);
    expect(l.worn.head).toBe(cap);
    expect(l.bag.length).toBe(n - 1);
  });

  it('refuses a bigger bag swap when the smaller pack could not hold what is in it', () => {
    const l = starterLoadout();
    const satchel = newGear('k_satchel'); // 4 slots against the rucksack's 6
    l.bag.push(satchel);
    stuffed(l);
    expect(l.bag.length).toBe(bagCap(l));
    const before = JSON.stringify(l);
    const r = equipFromBag(l, satchel.uid);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(l)).toBe(before);
    // Empty the bag down to the smaller pack's size and it goes through.
    while (l.bag.length > 4) l.bag.pop();
    if (!l.bag.includes(satchel)) l.bag.push(satchel);
    while (l.bag.length > 4) l.bag.splice(l.bag.findIndex((b) => b !== satchel), 1);
    expect(equipFromBag(l, satchel.uid).ok).toBe(true);
    expect(l.worn.back).toBe(satchel);
  });

  it('a hand item takes the first empty belt slot, and becomes the one in hand', () => {
    const l = starterLoadout();
    l.belt[2] = null;
    const knife = l.bag.find((b) => b.id === 'm_knife')!;
    expect(equipFromBag(l, knife.uid).ok).toBe(true);
    expect(l.belt[2]).toBe(knife);
    expect(l.sel).toBe(2);
    expect(heldItem(l)).toBe(knife);
  });

  it('with a full belt a hand item replaces the slot in hand, which goes back in the bag', () => {
    const l = starterLoadout();
    l.sel = 1;
    const wrench = l.belt[1]!;
    const knife = l.bag.find((b) => b.id === 'm_knife')!;
    equipFromBag(l, knife.uid);
    expect(l.belt[1]).toBe(knife);
    expect(l.bag).toContain(wrench);
    expect(l.bag).not.toContain(knife);
  });

  it('an explicit belt slot is honoured and an invalid one is refused', () => {
    const l = starterLoadout();
    const knife = l.bag.find((b) => b.id === 'm_knife')!;
    expect(equipFromBag(l, knife.uid, 3).ok).toBe(true);
    expect(l.belt[3]).toBe(knife);
    const rev = newGear('w_revolver');
    l.bag.push(rev);
    expect(equipFromBag(l, rev.uid, 9).ok).toBe(false);
  });

  it('equipping something that is not in the bag does nothing', () => {
    const l = starterLoadout();
    expect(equipFromBag(l, 'nope').ok).toBe(false);
  });

  it('a gun keeps its own magazine when it moves', () => {
    const l = starterLoadout();
    const rev = newGear('w_revolver');
    rev.mag = 2;
    l.bag.push(rev);
    equipFromBag(l, rev.uid, 3); // beside the pistol, so the belt stays armed either way
    expect(l.belt[3]!.mag).toBe(2);
    expect(unequipBelt(l, 3).ok).toBe(true);
    expect(l.bag.find((b) => b.id === 'w_revolver')!.mag).toBe(2);
  });
});

describe('taking things off', () => {
  it('moves a worn item into the bag', () => {
    const l = starterLoadout();
    const n = l.bag.length;
    expect(unequipWorn(l, 'head').ok).toBe(true);
    expect(l.worn.head).toBeUndefined();
    expect(l.bag.length).toBe(n + 1);
  });

  it('is refused when the bag is full', () => {
    const l = stuffed(starterLoadout());
    expect(unequipWorn(l, 'head').ok).toBe(false);
    expect(l.worn.head).toBeDefined();
  });

  it('the starter bag still fits once the pack comes off, with one slot to spare for the pack itself', () => {
    const l = starterLoadout();
    expect(l.bag.length + 1).toBeLessThanOrEqual(GEAR.bagBase);
    expect(unequipWorn(l, 'back').ok).toBe(true);
    expect(l.bag.some((b) => b.id === 'k_ruck')).toBe(true);
  });

  it('refuses to strip a pack that the bag would overflow without', () => {
    const l = starterLoadout();
    while (l.bag.length < GEAR.bagBase + 2) l.bag.push(newGear('h_cap'));
    expect(unequipWorn(l, 'back').ok).toBe(false);
    expect(l.worn.back).toBeDefined();
  });

  it('stowing a belt tool works, and the selection moves off an emptied slot', () => {
    const l = starterLoadout();
    l.sel = 1;
    expect(unequipBelt(l, 1).ok).toBe(true);
    expect(l.belt[1]).toBeNull();
    expect(l.sel).not.toBe(1);
    expect(l.belt[l.sel]).not.toBeNull();
  });

  it('the belt always keeps a weapon', () => {
    const l = starterLoadout();
    expect(unequipBelt(l, 0).ok).toBe(false); // the only gun
    const knife = l.bag.find((b) => b.id === 'm_knife')!;
    equipFromBag(l, knife.uid, 3);
    expect(unequipBelt(l, 0).ok).toBe(true); // the knife counts as a weapon
  });

  it('rearranges the belt and keeps the selection on the same item', () => {
    const l = starterLoadout();
    l.sel = 0;
    const gun = l.belt[0];
    expect(moveBelt(l, 0, 3).ok).toBe(true);
    expect(l.belt[3]).toBe(gun);
    expect(l.sel).toBe(3);
    expect(moveBelt(l, 2, 2).ok).toBe(false);
  });
});

describe('sharing', () => {
  it('hands an item to a partner with room, and refuses when their bag is full', () => {
    const a = starterLoadout();
    const b = starterLoadout();
    const cap = a.bag.find((x) => x.id === 'h_cap')!;
    const n = b.bag.length;
    expect(giveItem(a, b, cap.uid).ok).toBe(true);
    expect(a.bag).not.toContain(cap);
    expect(b.bag).toContain(cap);
    expect(b.bag.length).toBe(n + 1);
    stuffed(b);
    const goggles = a.bag.find((x) => x.id === 'f_goggles')!;
    expect(giveItem(a, b, goggles.uid).ok).toBe(false);
    expect(a.bag).toContain(goggles);
  });

  it('adds to a bag only while there is room, and takes things out by id', () => {
    const l = stuffed(starterLoadout());
    expect(addToBag(l, newGear('h_cap'))).toBe(false);
    const first = l.bag[0];
    expect(takeFromBag(l, first.uid)).toBe(first);
    expect(takeFromBag(l, first.uid)).toBeNull();
    expect(addToBag(l, newGear('h_cap'))).toBe(true);
  });
});

describe('cycling the hand', () => {
  it('steps through filled belt slots and the utility, skipping the empty ones', () => {
    const l = starterLoadout();
    l.belt[2] = null;
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      l.sel = stepSel(l, 1, true);
      seen.push(l.sel);
    }
    expect(seen).toEqual([1, 3, UTILITY_SLOT, 0, 1]);
  });

  it('skips the utility when there is nothing to throw', () => {
    const l = starterLoadout();
    l.sel = 3;
    expect(stepSel(l, 1, false)).toBe(0);
    expect(stepSel(l, 1, true)).toBe(UTILITY_SLOT);
  });

  it('goes backward too', () => {
    const l = starterLoadout();
    expect(stepSel(l, -1, true)).toBe(UTILITY_SLOT);
    expect(stepSel(l, -1, false)).toBe(3);
  });
});

describe('reading saves', () => {
  it('a save without gear gets the starter kit', () => {
    for (const bad of [undefined, null, 7, 'x', [], {}]) {
      const l = sanitizeLoadout(bad);
      expect(l.belt[0]?.id).toBe('w_pistol');
      expect(l.worn.back?.id).toBe('k_ruck');
    }
  });

  it('round-trips through JSON unchanged', () => {
    const l = starterLoadout();
    equipFromBag(l, l.bag[0].uid);
    l.belt[0]!.mag = 5;
    const back = sanitizeLoadout(JSON.parse(JSON.stringify(l)));
    expect(back).toEqual(l);
  });

  it('drops items that no longer exist and puts misfiled ones where they belong', () => {
    const l = starterLoadout();
    const raw = JSON.parse(JSON.stringify(l));
    raw.bag.push({ uid: 'x1', id: 'removed_item' });
    raw.worn.head = { uid: 'x2', id: 'b_vest' }; // a vest in the head slot
    raw.belt[1] = { uid: 'x3', id: 'h_cap' }; // a cap on the belt
    const c = sanitizeLoadout(raw);
    expect(c.bag.some((b) => b.id === 'removed_item')).toBe(false);
    expect(c.worn.head).toBeUndefined();
    expect(c.belt[1]).toBeNull();
    expect(c.bag.some((b) => b.id === 'b_vest')).toBe(true);
    expect(c.bag.some((b) => b.id === 'h_cap' && b.uid === 'x3')).toBe(true);
  });

  it('fixes duplicate ids, clamps magazines and the selection', () => {
    const raw = JSON.parse(JSON.stringify(starterLoadout()));
    raw.bag.push({ uid: raw.belt[0].uid, id: 'h_cap' });
    raw.belt[0].mag = 999;
    raw.sel = 77;
    const c = sanitizeLoadout(raw);
    const uids = [...Object.values(c.worn), ...c.belt, ...c.bag].filter(Boolean).map((i) => i!.uid);
    expect(new Set(uids).size).toBe(uids.length);
    expect(c.belt[0]!.mag).toBe(12);
    expect(c.sel).toBeLessThanOrEqual(UTILITY_SLOT);
  });

  it('never leaves anyone unarmed', () => {
    const raw = JSON.parse(JSON.stringify(starterLoadout()));
    raw.belt = [null, raw.belt[1], raw.belt[2], raw.belt[3]];
    raw.bag = [];
    const c = sanitizeLoadout(raw);
    expect(c.belt.some((b) => b && ['gun', 'melee'].includes(gearDef(b.id).kind))).toBe(true);
  });

  it('puts a selection on an emptied slot onto something real', () => {
    const raw = JSON.parse(JSON.stringify(starterLoadout()));
    raw.belt[2] = null;
    raw.sel = 2;
    const c = sanitizeLoadout(raw);
    expect(c.sel === UTILITY_SLOT || c.belt[c.sel] !== null).toBe(true);
  });
});

describe('loot', () => {
  it('rolls are deterministic for a seed', () => {
    const a = rollGear(new Rng(5), { bias: 0.5 }).id;
    const b = rollGear(new Rng(5), { bias: 0.5 }).id;
    expect(a).toBe(b);
  });

  it('respects rarity, kind and slot limits', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 200; i++) {
      const g = gearDef(rollGear(rng, { minR: 2, maxR: 2, kinds: ['wear'], slots: ['head', 'back'] }).id);
      expect(g.rarity).toBe(2);
      expect(['head', 'back']).toContain(g.slot);
    }
  });

  it('a bias toward rarity and a matching tag shift the odds', () => {
    const rare = (o: Parameters<typeof rollGear>[1]) => {
      const rng = new Rng(3);
      let n = 0;
      for (let i = 0; i < 3000; i++) if (gearDef(rollGear(rng, o).id).rarity === 3) n++;
      return n;
    };
    expect(rare({ bias: 2 })).toBeGreaterThan(rare({ bias: 0 }));
    const vault = (tags?: string[]) => {
      const rng = new Rng(4);
      let n = 0;
      for (let i = 0; i < 3000; i++) if (gearDef(rollGear(rng, { tags }).id).tags?.includes('vault')) n++;
      return n;
    };
    expect(vault(['vault'])).toBeGreaterThan(vault());
  });

  it('every source respects its own rules', () => {
    // A boss hoard always pays, and never in common grade.
    for (let s = 1; s < 60; s++) {
      const d = gearDrop(new Rng(s), 'hoard', { tier: 3 });
      expect(d).not.toBeNull();
      expect(gearDef(d!.id).rarity).toBeGreaterThanOrEqual(2);
    }
    // Loose finds are rare and never better than uncommon; a safe can go higher.
    let loose = 0;
    let safeRare = 0;
    for (let s = 1; s < 4000; s++) {
      const a = gearDrop(new Rng(s), 'search', { depth: 0 });
      if (a) {
        loose++;
        expect(gearDef(a.id).rarity).toBeLessThanOrEqual(2);
      }
      const b = gearDrop(new Rng(s), 'search', { depth: 2 });
      if (b && gearDef(b.id).rarity === 3) safeRare++;
    }
    expect(loose / 4000).toBeGreaterThan(0.02);
    expect(loose / 4000).toBeLessThan(0.1);
    expect(safeRare).toBeGreaterThan(0);
    // A wreck is a bit better than a car trunk.
    let wreck = 0;
    let trunk = 0;
    for (let s = 1; s < 2000; s++) {
      if (gearDrop(new Rng(s), 'wreck')) wreck++;
      if (gearDrop(new Rng(s), 'trunk')) trunk++;
    }
    expect(wreck).toBeGreaterThan(trunk * 3);
  });

  it('later in the campaign finds skew better', () => {
    const avg = (progress: number) => {
      let sum = 0;
      let n = 0;
      for (let s = 1; s < 3000; s++) {
        const d = gearDrop(new Rng(s), 'chest', { tier: 3, progress });
        if (d) {
          sum += gearDef(d.id).rarity;
          n++;
        }
      }
      return sum / n;
    };
    expect(avg(1)).toBeGreaterThan(avg(0));
  });

  it('a belt is as big as the data says', () => {
    expect(starterLoadout().belt).toHaveLength(BELT_SIZE);
  });
});
