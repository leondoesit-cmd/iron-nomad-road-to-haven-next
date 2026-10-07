import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { ATTACH_SLOTS, GEAR, GUN_MODELS, gearDef, legById, validateData, type AttachSlot } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Campaign } from '../src/game/campaign';
import { Rng } from '../src/core/rng';
import { AMMO, ammoForGun } from '../src/sim/ballistics';
import { HANDLING } from '../src/sim/handling';
import {
  bagCap,
  detachToBag,
  equipFromBag,
  fitBest,
  fitFromBag,
  giveItem,
  gearDrop,
  moveBelt,
  newGear,
  rollGearId,
  sanitizeLoadout,
  scrapOf,
  starterLoadout,
  type GearItem,
  type Loadout,
} from '../src/sim/gear';
import { canFit, cleanAtt, compareKits, describeMod, dressGun, fittingMods, kitFor, kitOf, kitWith, lookKey, newMod, parseLooks, slotsOfGun, whyNot } from '../src/sim/gunmods';
import { GUN_LOOT_CONTEXTS, rollGunLoot, type GunLootContext } from '../src/sim/gunLoot';
import { Humanoid } from '../src/render/humanoid';
import { ANCHORS, muzzleAt } from '../src/render/gunMods';
import { gearIcon } from '../src/ui/gearIcons';
import { InventoryView } from '../src/ui/inventory';
import { fakeServices } from './helpers/sim';

vi.setConfig({ testTimeout: 90000 });

const GUNS = GEAR.items.filter((g) => g.gun);
const MODS = GEAR.items.filter((g) => g.mod);
const bareLoadout = (): Loadout => starterLoadout();

/** A gun in the bag with the add-ons named fitted straight on, bypassing the bag rules (a loot roll or a save would do this). */
function gunWith(id: string, att: Partial<Record<AttachSlot, string>> = {}): GearItem {
  const it = newGear(id);
  if (Object.keys(att).length) it.att = att;
  it.mag = kitOf(it).gun.mag;
  return it;
}

describe('the weapon catalogue', () => {
  it('passes the data checks, with unique ids', () => {
    expect(validateData()).toEqual([]);
    expect(new Set(GEAR.items.map((g) => g.id)).size).toBe(GEAR.items.length);
  });

  it('has many more weapons across the classes, and every gun has its full data wired through', () => {
    expect(GUNS.length).toBeGreaterThanOrEqual(18);
    expect(GEAR.items.filter((g) => g.melee).length).toBeGreaterThanOrEqual(7);
    const sounds = new Set(['pistol', 'mg', 'sniper', 'shotgun', 'bolt', 'bow']);
    const shells = new Set(['pistol', 'magnum', 'carbine', 'rifle', 'hull']);
    for (const g of GUNS) {
      const s = g.gun!;
      expect(s.dmg, g.id).toBeGreaterThan(0);
      expect(s.cd, g.id).toBeGreaterThan(0);
      expect(s.mag, g.id).toBeGreaterThan(0);
      expect(s.reload, g.id).toBeGreaterThan(0);
      expect(s.range, g.id).toBeGreaterThan(0);
      expect(s.noise, g.id).toBeGreaterThan(0);
      expect(s.adsSpread, g.id).toBeLessThanOrEqual(s.spread);
      expect(g.short, g.id).toBeTruthy();
      expect(g.blurb.length, g.id).toBeGreaterThan(10);
      expect(sounds.has(s.sound), g.id).toBe(true);
      // Ballistics, handling, brass, the held model's anchors: every model is known to all of them.
      expect(GUN_MODELS, g.id).toContain(s.model);
      expect(AMMO[ammoForGun(s.model)], g.id).toBeDefined();
      const h = HANDLING[s.model];
      expect(h.kick, g.id).toBeGreaterThan(0);
      expect(['shot', 'cycle', 'reload', 'none'], g.id).toContain(h.eject);
      expect(shells.has(h.shell), g.id).toBe(true);
      expect(ANCHORS[s.model], g.id).toBeDefined();
    }
    // Each class is there: pistols, SMGs, assault and battle rifles, DMR and sniper, shotguns, lever, crossbow, LMG.
    const models = new Set(GUNS.map((g) => g.gun!.model));
    for (const m of ['pistol', 'compact', 'revolver', 'cannon', 'smg', 'mp', 'smg2', 'carbine', 'ar', 'br', 'dmr', 'sniper', 'rifle', 'lever', 'crossbow', 'sawn', 'pump', 'combat', 'coach', 'lmg'] as const) expect(models.has(m), m).toBe(true);
    expect(GEAR.items.some((g) => g.melee?.model === 'katana')).toBe(true);
  });

  it('the old guns keep the numbers they always had', () => {
    const num = (id: string) => {
      const g = gearDef(id).gun!;
      return [g.dmg, g.cd, g.mag, g.reload, g.spread, g.adsSpread, g.range, g.noise, g.pierce ?? 0];
    };
    expect(num('w_pistol')).toEqual([27, 0.2, 12, 1.3, 0.03, 0.008, 75, 60, 0]);
    expect(num('w_revolver')).toEqual([55, 0.52, 6, 2.2, 0.028, 0.004, 90, 72, 0.3]);
    expect(num('w_smg')).toEqual([14, 0.085, 30, 1.9, 0.055, 0.026, 55, 64, 0]);
    expect(num('w_rifle')).toEqual([80, 0.9, 5, 2.6, 0.012, 0.002, 110, 90, 0.5]);
  });

  it('the crossbow is the quiet one: a slow heavy bolt that drops, and no brass', () => {
    const g = gearDef('w_crossbow').gun!;
    expect(g.noise).toBeLessThan(15);
    expect(g.sound).toBe('bolt');
    expect(HANDLING.crossbow.eject).toBe('none');
    expect(AMMO[ammoForGun('crossbow')].speed).toBeLessThan(200);
  });

  it('has add-ons in every slot, in more than one rarity of improved parts, and each one fits at least one weapon', () => {
    expect(MODS.length).toBeGreaterThanOrEqual(40);
    for (const slot of ATTACH_SLOTS) expect(MODS.some((m) => m.mod!.slot === slot), slot).toBe(true);
    for (const m of MODS) {
      expect(m.short, m.id).toBeTruthy();
      expect(
        GUNS.some((g) => canFit(g.id, m.id)),
        `${m.id} fits nothing`,
      ).toBe(true);
    }
    // Improved barrels come in three rarities for a family, each better than the last.
    for (const fam of ['bar_h', 'bar_c', 'bar_r', 'bar_g']) {
      const tiers = MODS.filter((m) => m.mod!.fam === fam).sort((a, b) => a.rarity - b.rarity);
      expect(new Set(tiers.map((m) => m.rarity)).size, fam).toBeGreaterThanOrEqual(3);
    }
    const bar = (id: string) => kitFor(gearDef('w_ar').gun!, { barrel: id }).gun;
    expect(bar('a_bar_r3').range).toBeGreaterThan(bar('a_bar_r2').range);
    expect(bar('a_bar_r2').range).toBeGreaterThan(bar('a_bar_r1').range);
    expect(bar('a_bar_r3').spread).toBeLessThan(bar('a_bar_r2').spread);
  });

  it('every slot a gun declares has something that fits it, and a bare gun has no phantom slots', () => {
    for (const g of GUNS) {
      for (const slot of slotsOfGun(g)) expect(fittingMods(g.id, slot).length, `${g.id} ${slot}`).toBeGreaterThan(0);
    }
    expect(slotsOfGun(gearDef('w_crossbow'))).not.toContain('muzzle');
    expect(slotsOfGun(gearDef('w_sawn'))).not.toContain('optic');
    expect(slotsOfGun(gearDef('m_axe'))).toEqual([]);
  });
});

describe('what an add-on does to the gun', () => {
  const rifle = gearDef('w_ar').gun!;

  it('a suppressor takes noise, flash and some speed and reach', () => {
    const bare = kitFor(rifle, undefined);
    const sup = kitFor(rifle, { muzzle: 'a_sup_r' });
    expect(sup.gun.noise).toBeLessThan(bare.gun.noise * 0.5);
    expect(sup.flash).toBeLessThan(bare.flash * 0.4);
    expect(sup.vel).toBeLessThan(1);
    expect(sup.gun.range).toBeLessThan(bare.gun.range);
    // A crude can is worse than the real thing on every count.
    const can = kitFor(rifle, { muzzle: 'a_sup_rc' });
    expect(can.gun.noise).toBeGreaterThan(sup.gun.noise);
    expect(can.vel).toBeLessThan(sup.vel);
    // A brake does the opposite to noise.
    expect(kitFor(rifle, { muzzle: 'a_brake' }).gun.noise).toBeGreaterThan(bare.gun.noise);
  });

  it('a scope sets the aiming zoom, a better one more, and a bare gun has none', () => {
    expect(kitFor(rifle, undefined).zoom).toBe(1);
    const z = (id: string) => kitFor(rifle, { optic: id }).zoom;
    expect(z('a_dot')).toBe(1);
    expect(z('a_scope2')).toBeGreaterThan(1.4);
    expect(z('a_scope4')).toBeGreaterThan(z('a_scope2'));
    expect(kitFor(gearDef('w_sniper').gun!, { optic: 'a_scope8' }).zoom).toBeGreaterThan(3.5);
    // Sights tighten the aimed shot; a scope trades sway for reach.
    expect(kitFor(rifle, { optic: 'a_holo' }).gun.adsSpread).toBeLessThan(rifle.adsSpread);
    expect(kitFor(gearDef('w_sniper').gun!, { optic: 'a_scope8' }).sway).toBeGreaterThan(1);
    // The hunting rifle's own worn scope magnifies until a better optic replaces it.
    const hunting = gearDef('w_rifle').gun!;
    expect(kitFor(hunting, undefined).zoom).toBeGreaterThan(1);
    expect(kitFor(hunting, { optic: 'a_dot' }).zoom).toBe(1);
  });

  it('magazines change capacity and reload; recoil add-ons change the kick', () => {
    const bare = kitFor(rifle, undefined);
    const ext = kitFor(rifle, { mag: 'a_mag_r' });
    expect(ext.gun.mag).toBeGreaterThan(bare.gun.mag);
    expect(ext.gun.reload).toBeGreaterThan(bare.gun.reload);
    const drum = kitFor(rifle, { mag: 'a_mag_rd' });
    expect(drum.gun.mag).toBeGreaterThanOrEqual(bare.gun.mag * 3);
    expect(drum.gun.reload).toBeGreaterThan(ext.gun.reload);
    expect(kitFor(rifle, { mag: 'a_mag_rq' }).gun.reload).toBeLessThan(bare.gun.reload);
    expect(kitFor(gearDef('w_pump').gun!, { mag: 'a_tube' }).gun.mag).toBe(9);
    expect(kitFor(gearDef('w_revolver').gun!, { mag: 'a_loader' }).gun.reload).toBeLessThan(gearDef('w_revolver').gun!.reload);
    expect(kitFor(rifle, { muzzle: 'a_brake' }).recoil).toBeLessThan(1);
    expect(kitFor(rifle, { under: 'a_grip' }).recoil).toBeLessThan(1);
    expect(kitFor(rifle, { under: 'a_bipod' }).sway).toBeLessThan(0.8);
    expect(kitFor(rifle, { stock: 'a_stock_l1' }).aimSpeed).toBeGreaterThan(1);
    expect(kitFor(rifle, { stock: 'a_stock_l2' }).aimSpeed).toBeLessThan(1);
  });

  it('barrels and chokes change spread, range and speed; a laser helps the hip, not the sights', () => {
    const bare = kitFor(rifle, undefined);
    const heavy = kitFor(rifle, { barrel: 'a_bar_r3' });
    expect(heavy.gun.spread).toBeLessThan(bare.gun.spread);
    expect(heavy.gun.range).toBeGreaterThan(bare.gun.range);
    expect(heavy.vel).toBeGreaterThan(1);
    expect(heavy.gun.dmg).toBeGreaterThan(bare.gun.dmg);
    const laser = kitFor(rifle, { rail: 'a_laser' });
    expect(laser.gun.spread).toBeLessThan(bare.gun.spread);
    expect(laser.gun.adsSpread).toBe(bare.gun.adsSpread);
    expect(laser.beam).toBe('laser');
    expect(kitFor(rifle, { rail: 'a_combo' }).beam).toBe('both');
    const sg = gearDef('w_pump').gun!;
    expect(kitFor(sg, { muzzle: 'a_choke' }).gun.spread).toBeLessThan(sg.spread);
  });

  it('stacking is clamped so nothing goes silent, instant or infinitely tight', () => {
    const k = kitFor(gearDef('w_pistol').gun!, { muzzle: 'a_sup_h', barrel: 'a_bar_h3', optic: 'a_pdot', rail: 'a_laser', stock: 'a_stock_p', mag: 'a_mag_h' });
    expect(k.gun.noise).toBeGreaterThan(0);
    expect(k.gun.adsSpread).toBeLessThanOrEqual(k.gun.spread);
    expect(k.gun.adsSpread).toBeGreaterThan(0);
    expect(k.recoil).toBeGreaterThanOrEqual(0.35);
    expect(k.count).toBe(6);
  });

  it('describes itself, and previews what a swap would change', () => {
    expect(describeMod(gearDef('a_sup_r').mod!).some((l) => /noise/.test(l.text) && l.good)).toBe(true);
    expect(describeMod(gearDef('a_scope4').mod!).some((l) => /zoom/.test(l.text))).toBe(true);
    const gun = gunWith('w_ar');
    const lines = compareKits(kitOf(gun), kitWith(gun, 'muzzle', 'a_sup_r'));
    expect(lines.some((l) => l.key === 'noise' && l.good)).toBe(true);
    expect(lines.some((l) => l.key === 'range' && !l.good)).toBe(true);
    expect(compareKits(kitOf(gun), kitOf(gun))).toEqual([]);
  });
});

describe('what fits what', () => {
  it('is decided by each weapon\'s own slots and families', () => {
    expect(canFit('w_ar', 'a_sup_r')).toBe(true);
    expect(canFit('w_pistol', 'a_sup_r')).toBe(false);
    expect(canFit('w_pistol', 'a_sup_h')).toBe(true);
    expect(canFit('w_sawn', 'a_scope4')).toBe(false);
    expect(canFit('w_sniper', 'a_scope8')).toBe(true);
    expect(canFit('w_pistol', 'a_scope8')).toBe(false);
    expect(canFit('w_pump', 'a_mag_r')).toBe(false);
    expect(canFit('w_pump', 'a_tube')).toBe(true);
    expect(canFit('w_revolver', 'a_loader')).toBe(true);
    expect(canFit('w_crossbow', 'a_bar_x2')).toBe(true);
    expect(canFit('w_crossbow', 'a_sup_h')).toBe(false);
    expect(canFit('m_axe', 'a_dot')).toBe(false);
    expect(canFit('w_ar', 'h_cap')).toBe(false);
    expect(canFit('nothing', 'a_dot')).toBe(false);
  });

  it('refuses a wrong fit with a reason, and leaves the bag and the gun alone', () => {
    const l = bareLoadout();
    const gun = newGear('w_pistol');
    const bad = newMod('a_sup_r');
    l.bag.push(gun, bad);
    const n = l.bag.length;
    const r = fitFromBag(l, gun.uid, bad.uid);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/does not fit/);
    expect(gun.att).toBeUndefined();
    expect(l.bag.length).toBe(n);
    // No slot at all, not a gun, not an add-on.
    const sawn = newGear('w_sawn');
    l.bag.push(sawn);
    expect(fitFromBag(l, sawn.uid, newMod('a_dot').uid).ok).toBe(false);
    expect(whyNot(sawn, newMod('a_dot'))).toMatch(/no optic slot/);
    expect(whyNot(newGear('m_axe'), newMod('a_dot'))).toMatch(/firearms/);
    expect(whyNot(gun, newGear('h_cap'))).toMatch(/not an add-on/);
  });

  it('fits from the bag, swaps what was there back into the bag, and takes it off again', () => {
    const l = bareLoadout();
    const gun = l.belt[0]!;
    const dot = newMod('a_pdot');
    const scope = newMod('a_scope4');
    l.bag.push(dot, scope);
    const n = l.bag.length;
    expect(fitFromBag(l, gun.uid, dot.uid).ok).toBe(true);
    expect(gun.att).toEqual({ optic: 'a_pdot' });
    expect(l.bag.length).toBe(n - 1);
    // A 9mm takes a pistol dot, not a rifle scope.
    expect(fitFromBag(l, gun.uid, scope.uid).ok).toBe(false);
    // Swapping on a rifle: the first sight comes back to the bag as the better one goes on.
    const ar = gunWith('w_ar');
    const red = newMod('a_dot');
    l.bag.push(ar, red);
    expect(fitFromBag(l, ar.uid, red.uid).ok).toBe(true);
    const before = l.bag.length;
    expect(fitFromBag(l, ar.uid, scope.uid).ok).toBe(true);
    expect(l.bag.length).toBe(before); // one in, one out
    expect(l.bag.some((x) => x.id === 'a_dot')).toBe(true);
    expect(ar.att!.optic).toBe('a_scope4');
    const r = detachToBag(l, ar.uid, 'optic');
    expect(r.ok).toBe(true);
    expect(ar.att).toBeUndefined();
    expect(l.bag.some((x) => x.id === 'a_scope4')).toBe(true);
    expect(detachToBag(l, ar.uid, 'optic').ok).toBe(false);
  });

  it('will not take an add-on off into a full bag', () => {
    const l = bareLoadout();
    const gun = newGear('w_pistol');
    gun.att = { muzzle: 'a_sup_h' };
    l.belt[0] = gun;
    while (l.bag.length < bagCap(l)) l.bag.push(newGear('h_cap'));
    const r = detachToBag(l, gun.uid, 'muzzle');
    expect(r.ok).toBe(false);
    expect(gun.att).toEqual({ muzzle: 'a_sup_h' });
  });

  it('a bigger magazine that comes off trims the loaded rounds, and says how many came out', () => {
    const l = bareLoadout();
    const ar = gunWith('w_ar', { mag: 'a_mag_rd' });
    l.belt[1] = ar;
    expect(ar.mag).toBe(kitOf(ar).gun.mag);
    expect(ar.mag!).toBeGreaterThan(60);
    const r = detachToBag(l, ar.uid, 'mag');
    expect(r.ok).toBe(true);
    expect(ar.mag).toBe(gearDef('w_ar').gun!.mag);
    expect((r as { rounds?: number }).rounds).toBeGreaterThan(30);
  });

  it('the quick action fits an add-on to the gun in hand if it takes it, else any gun that does', () => {
    const l = bareLoadout();
    const ar = newGear('w_ar');
    l.belt[1] = ar;
    const sup = newMod('a_sup_r');
    l.bag.push(sup);
    const r = equipFromBag(l, sup.uid); // the X button on a bag item
    expect(r.ok).toBe(true);
    expect(ar.att).toEqual({ muzzle: 'a_sup_r' });
    const none = newMod('a_scope8');
    l.bag.push(none);
    expect(fitBest(l, none.uid).ok).toBe(false); // no gun that takes a long scope
    expect(l.belt.every((b) => !b || !b.att?.optic)).toBe(true);
  });
});

describe('a weapon keeps its add-ons, wear and magazine wherever it goes', () => {
  it('through belt swaps, stowing, equipping and handing to a partner', () => {
    const a = bareLoadout();
    const b = bareLoadout();
    const gun = gunWith('w_carbine', { optic: 'a_scope2', muzzle: 'a_sup_r', mag: 'a_mag_r' });
    gun.cond = 0.42;
    gun.mag = 11;
    a.belt[1] = gun;
    const keep = () => ({ att: gun.att, cond: gun.cond, mag: gun.mag });
    const want = JSON.parse(JSON.stringify(keep()));
    moveBelt(a, 1, 3);
    expect(a.belt[3]).toBe(gun);
    a.bag.length = 0;
    a.belt[3] = null;
    a.bag.push(gun);
    expect(equipFromBag(a, gun.uid, 2).ok).toBe(true);
    expect(a.belt[2]).toBe(gun);
    // Stow, then give.
    a.belt[2] = null;
    a.bag.push(gun);
    expect(giveItem(a, b, gun.uid).ok).toBe(true);
    expect(b.bag).toContain(gun);
    expect(JSON.parse(JSON.stringify(keep()))).toEqual(want);
    // And it survives a round trip through the save intact.
    const back = sanitizeLoadout(JSON.parse(JSON.stringify(b)));
    const again = back.bag.find((x) => x.id === 'w_carbine')!;
    expect(again.att).toEqual(want.att);
    expect(again.cond).toBeCloseTo(0.42, 5);
    expect(again.mag).toBe(11);
  });

  it('breaking a gun down is worth its add-ons too', () => {
    const plain = newGear('w_ar');
    const dressed = gunWith('w_ar', { optic: 'a_scope4', muzzle: 'a_sup_r' });
    expect(scrapOf(dressed)).toBe(scrapOf(plain) + gearDef('a_scope4').scrap + gearDef('a_sup_r').scrap);
  });
});

describe('saving and repairing add-ons', () => {
  it('a dressed loadout survives a save with every add-on, magazine and the hand in use', () => {
    const l = bareLoadout();
    l.belt[1] = gunWith('w_br', { optic: 'a_scope4', muzzle: 'a_brake', under: 'a_grip', mag: 'a_mag_r', stock: 'a_stock_l2', barrel: 'a_bar_r2', rail: 'a_laser' });
    l.belt[1]!.mag = 17;
    l.sel = 1;
    l.bag.push(newMod('a_dot'));
    const back = sanitizeLoadout(JSON.parse(JSON.stringify(l)));
    expect(back.belt[1]!.att).toEqual(l.belt[1]!.att);
    expect(back.belt[1]!.mag).toBe(17);
    expect(back.sel).toBe(1);
    expect(back.bag.some((b) => b.id === 'a_dot')).toBe(true);
  });

  it('an old save with no add-ons loads exactly as it did', () => {
    const old = JSON.parse(JSON.stringify(starterLoadout()));
    for (const it of old.belt) if (it) expect('att' in it).toBe(false);
    const back = sanitizeLoadout(old);
    expect(back.belt[0]!.id).toBe('w_pistol');
    expect(back.belt[0]!.att).toBeUndefined();
    expect(back.belt[0]!.mag).toBe(12);
  });

  it('a campaign round trip keeps them', () => {
    const c = new Campaign();
    const gun = gunWith('w_smg2', { muzzle: 'a_sup_h', mag: 'a_mag_sd' });
    c.players[0].gear.belt[2] = gun;
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    expect(back.players[0].gear.belt[2]!.att).toEqual({ muzzle: 'a_sup_h', mag: 'a_mag_sd' });
    expect(back.players[0].gear.belt[2]!.mag).toBe(gun.mag);
  });

  it('corrupt add-on data is repaired: unknown ids, the wrong slot, a gun that does not take it, junk', () => {
    const l = bareLoadout();
    const raw = JSON.parse(JSON.stringify(l));
    raw.belt[0].att = { muzzle: 'no_such_thing', optic: 'a_sup_h', rail: 'a_laser', stock: 123, under: ['a_grip'], bogus: 'a_dot' };
    raw.belt[1] = { uid: 'x1', id: 'm_knife', att: { optic: 'a_dot' } };
    raw.belt[2] = { uid: 'x2', id: 'w_pistol', att: 'banana', mag: 99 };
    raw.belt[3] = { uid: 'x3', id: 'a_dot' };
    const back = sanitizeLoadout(raw);
    // Only the laser stays on the pistol: the rest is not a real add-on, is in the wrong slot, or is junk.
    expect(back.belt[0]!.att).toEqual({ rail: 'a_laser' });
    // The suppressor named in the optic slot is a real item that does not belong there, so it is handed back in the bag.
    expect(back.bag.some((b) => b.id === 'a_sup_h')).toBe(true);
    // A knife takes nothing; a pistol with a junk att is just a pistol, and its magazine cannot exceed what it holds.
    expect(back.belt[1]!.att).toBeUndefined();
    expect(back.belt[2]!.att).toBeUndefined();
    expect(back.belt[2]!.mag).toBe(12);
    // An add-on on the belt belongs in the bag.
    expect(back.belt[3]).toBeNull();
    expect(back.bag.some((b) => b.id === 'a_dot')).toBe(true);
    // A magazine saved with a big mag fitted is kept; without it, trimmed.
    const big = JSON.parse(JSON.stringify(l));
    big.belt[0].att = { mag: 'a_mag_h' };
    big.belt[0].mag = 18;
    expect(sanitizeLoadout(big).belt[0]!.mag).toBe(18);
    delete big.belt[0].att;
    expect(sanitizeLoadout(big).belt[0]!.mag).toBe(12);
    expect(cleanAtt('w_pistol', undefined, [])).toBeUndefined();
  });
});

describe('seeded gun loot', () => {
  const shape = (items: GearItem[]) => items.map((i) => ({ id: i.id, att: i.att, mag: i.mag, cond: i.cond }));

  it('is deterministic: the same context, seed and depth give the same items', () => {
    for (const ctx of GUN_LOOT_CONTEXTS) {
      for (let seed = 1; seed < 40; seed++) {
        for (const depth of [0, 1, 2]) expect(shape(rollGunLoot(ctx, seed, depth)), `${ctx} ${seed} ${depth}`).toEqual(shape(rollGunLoot(ctx, seed, depth)));
      }
    }
    // And different seeds give different finds.
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) seen.add(JSON.stringify(shape(rollGunLoot('military', seed, 1))));
    expect(seen.size).toBeGreaterThan(30);
  });

  it('only hands out real items, with add-ons that fit, full magazines and sane wear', () => {
    for (const ctx of GUN_LOOT_CONTEXTS) {
      for (let seed = 1; seed < 200; seed++) {
        for (const it of rollGunLoot(ctx, seed, seed % 3)) {
          const d = gearDef(it.id);
          expect(['gun', 'melee', 'mod']).toContain(d.kind);
          if (d.gun) {
            for (const [slot, id] of Object.entries(it.att ?? {})) {
              expect(canFit(it.id, id), `${ctx}: ${id} on ${it.id}`).toBe(true);
              expect(gearDef(id).mod!.slot).toBe(slot);
            }
            expect(it.mag).toBe(kitOf(it).gun.mag);
          } else expect(it.att).toBeUndefined();
          if (d.gun || d.melee) {
            expect(it.cond ?? 1).toBeGreaterThan(0);
            expect(it.cond ?? 1).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('suits the place', () => {
    const tally = (ctx: GunLootContext, depth = 0, n = 600) => {
      const ids = new Map<string, number>();
      let gunsWithAtt = 0;
      let guns = 0;
      let total = 0;
      let empty = 0;
      for (let s = 1; s <= n; s++) {
        const loot = rollGunLoot(ctx, s, depth);
        if (!loot.length) empty++;
        total += loot.length;
        for (const it of loot) {
          ids.set(it.id, (ids.get(it.id) ?? 0) + 1);
          if (gearDef(it.id).gun) {
            guns++;
            if (it.att) gunsWithAtt++;
          }
        }
      }
      const has = (pred: (id: string) => boolean) => [...ids.keys()].some(pred);
      return { ids, has, total, empty, gunsWithAtt, guns, n };
    };
    const modOf = (id: string) => gearDef(id).mod;
    const house = tally('house');
    // A house is mostly empty-handed, and what it has is domestic: no rifles of war, no scopes.
    expect(house.empty / house.n).toBeGreaterThan(0.5);
    expect(house.has((id) => ['w_ar', 'w_br', 'w_lmg', 'w_dmr', 'w_sniper', 'w_combat', 'w_smg2'].includes(id))).toBe(false);
    expect(house.has((id) => !!modOf(id))).toBe(false);
    expect(house.has((id) => ['w_pistol', 'w_pump', 'w_rifle', 'w_sawn', 'w_revolver'].includes(id))).toBe(true);

    const mil = tally('military');
    expect(mil.has((id) => ['w_ar', 'w_br', 'w_lmg', 'w_dmr', 'w_sniper'].includes(id))).toBe(true);
    expect(mil.has((id) => ['a_scope4', 'a_scope8', 'a_sup_r'].includes(id))).toBe(true);
    expect(mil.has((id) => ['w_crossbow', 'w_sawn', 'w_lever'].includes(id))).toBe(false);
    expect(mil.gunsWithAtt / mil.guns).toBeGreaterThan(0.5);

    const shop = tally('gun_shop');
    expect(shop.empty).toBe(0);
    expect(shop.has((id) => ['a_dot', 'a_pdot', 'a_scope2', 'a_scope4'].includes(id))).toBe(true);
    expect(shop.has((id) => ['w_pistol', 'w_pump', 'w_rifle', 'w_lever', 'w_crossbow'].includes(id))).toBe(true);
    expect(shop.has((id) => ['w_lmg', 'w_sniper', 'w_br', 'w_ar'].includes(id))).toBe(false);
    expect(shop.total / shop.n).toBeGreaterThan(house.total / house.n * 3);

    const police = tally('police');
    expect(police.has((id) => ['w_smg2', 'w_pump', 'w_pistol'].includes(id))).toBe(true);
    expect(police.has((id) => ['w_sniper', 'w_lmg', 'w_dmr', 'a_scope8'].includes(id))).toBe(false);

    const bunker = tally('bunker');
    expect(bunker.empty).toBe(0);
    expect(bunker.has((id) => ['w_sniper', 'w_dmr', 'w_lmg'].includes(id))).toBe(true);
    expect(bunker.has((id) => ['w_pistol', 'w_compact', 'w_sawn', 'm_bat'].includes(id))).toBe(false);

    const raider = tally('raider');
    expect(raider.empty / raider.n).toBeGreaterThan(0.2);
    expect(raider.has((id) => ['w_mp', 'w_smg', 'w_sawn', 'w_revolver'].includes(id))).toBe(true);
    expect(raider.has((id) => ['a_scope8', 'a_sup_r', 'w_sniper'].includes(id))).toBe(false);

    // Deeper is more, and better.
    const rarityScore = (ctx: GunLootContext, depth: number) => {
      let n = 0;
      for (let s = 1; s <= 300; s++) for (const it of rollGunLoot(ctx, s, depth)) n += gearDef(it.id).rarity;
      return n;
    };
    expect(rarityScore('gun_shop', 2)).toBeGreaterThan(rarityScore('gun_shop', 0));
    expect(rarityScore('house', 2)).toBeGreaterThan(rarityScore('house', 0));
  });

  it('the existing finds still work and still have to follow their own rules, and now carry add-ons', () => {
    let withAtt = 0;
    let mods = 0;
    let guns = 0;
    for (let s = 1; s < 3000; s++) {
      const d = gearDrop(new Rng(s), 'wreck', { progress: 0.5 });
      if (!d) continue;
      if (gearDef(d.id).mod) mods++;
      if (gearDef(d.id).gun) {
        guns++;
        if (d.att) withAtt++;
      }
    }
    expect(guns).toBeGreaterThan(50);
    expect(withAtt).toBeGreaterThan(0);
    expect(mods).toBeGreaterThan(0);
    // Same seed, same find, add-ons and all.
    for (let s = 1; s < 200; s++) {
      const a = gearDrop(new Rng(s), 'hoard', { tier: 3 });
      const b = gearDrop(new Rng(s), 'hoard', { tier: 3 });
      expect(a && { id: a.id, att: a.att }).toEqual(b && { id: b.id, att: b.att });
    }
    // Add-ons never come out of ordinary rolls unless asked for.
    for (let s = 1; s < 500; s++) expect(gearDef(rollGearId(new Rng(s))).kind).not.toBe('mod');
    expect(gearDef(rollGearId(new Rng(1), { kinds: ['mod'] })).kind).toBe('mod');
  });

  it('dressing a gun is seeded and never over-fills it', () => {
    for (let s = 1; s < 100; s++) {
      const a = dressGun(newGear('w_ar'), new Rng(s), { odds: 3, maxR: 3, most: 3 });
      const b = dressGun(newGear('w_ar'), new Rng(s), { odds: 3, maxR: 3, most: 3 });
      expect(a.att).toEqual(b.att);
      expect(Object.keys(a.att ?? {}).length).toBeLessThanOrEqual(3);
    }
    expect(dressGun(newGear('w_ar'), new Rng(1), { odds: 0, maxR: 3 }).att).toBeUndefined();
  });
});

describe('what you can see: the held model and the inventory icon', () => {
  /** What is in hand: the weapon in the right hand, or a bow's riser, limbs and string in the left. */
  const held = (h: Humanoid) => [...h.hand.children, ...h.handL.children.flatMap((c) => c.children)].filter((c) => (c as { isMesh?: boolean }).isMesh && c !== h.flash.group) as THREE.Mesh[];
  const verts = (h: Humanoid) => held(h).reduce((n, m) => n + m.geometry.getAttribute('position').count, 0);

  it('every gun model builds, bare and with a full set of fitting add-ons, and the add-ons add solids', () => {
    for (const g of GUNS) {
      const h = new Humanoid({ jacket: 0x884422, trim: 0x222222 });
      h.setWeapon(g.gun!.model);
      const bare = verts(h);
      expect(bare, g.id).toBeGreaterThan(30);
      // A bow takes no add-ons.
      if (!slotsOfGun(g).length) continue;
      const att: Partial<Record<AttachSlot, string>> = {};
      for (const slot of slotsOfGun(g)) att[slot] = fittingMods(g.id, slot).sort((a, b) => b.rarity - a.rarity)[0].id;
      const key = lookKey(att);
      expect(Object.keys(parseLooks(key)).length).toBe(Object.keys(att).length);
      h.setWeapon(g.gun!.model, key);
      expect(verts(h), g.id).toBeGreaterThan(bare);
      const pos = held(h)[0].geometry.getAttribute('position');
      for (let i = 0; i < pos.array.length; i++) expect(Number.isFinite(pos.array[i]), g.id).toBe(true);
    }
  });

  it('a muzzle device moves the flash out to the new tip, and the melee additions build', () => {
    expect(muzzleAt('pistol', { muzzle: 'supp_s' }).z).toBeGreaterThan(muzzleAt('pistol', {}).z + 0.1);
    expect(muzzleAt('ar', { barrel: 'bar_r', muzzle: 'brake' }).z).toBeGreaterThan(muzzleAt('ar', {}).z);
    for (const id of ['m_pipe', 'm_sledge', 'm_katana']) {
      const h = new Humanoid({ jacket: 0x884422, trim: 0x222222 });
      h.setWeapon(gearDef(id).melee!.model);
      expect(verts(h), id).toBeGreaterThan(10);
    }
  });

  it('every item has an icon, and a dressed gun\'s icon shows what is on it', () => {
    for (const g of GEAR.items.filter((x) => x.gun || x.melee || x.mod)) expect(gearIcon(g, 0)).toMatch(/^<svg/);
    for (const g of GUNS.filter((x) => slotsOfGun(x).length)) {
      const att: Partial<Record<AttachSlot, string>> = {};
      for (const slot of slotsOfGun(g)) att[slot] = fittingMods(g.id, slot)[0].id;
      expect(gearIcon(g, 0, '', att).length, g.id).toBeGreaterThan(gearIcon(g, 0).length + 100);
    }
    expect(gearIcon(gearDef('a_scope4'), 0)).not.toBe(gearIcon(gearDef('a_scope8'), 0));
  });
});

// ------------------------------------------------------------------ in a real scene

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

function scene() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  for (const p of sc.players) p.exitVehicle(false);
  for (let i = 0; i < 18; i++) sc.tick(DT);
  sc.zombies.list.length = 0;
  sc.wildlife.list.length = 0;
  return { h, sc, p: sc.players[0] };
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

/** Put a dressed gun on belt slot 3 and into the hand. */
function arm(p: LegScene['players'][number], id: string, att: Partial<Record<AttachSlot, string>> = {}) {
  const it = gunWith(id, att);
  p.gear.belt[3] = it;
  p.gear.sel = 3;
  p.refreshGear();
  return it;
}

describe('add-ons in play', () => {
  const fire = (h: ReturnType<typeof fakeServices>, sc: LegScene, secs = 0.1) => {
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    run(sc, secs);
    h.intents[0].rt = 0;
  };

  it('a bare gun plays exactly as it did, and fitted numbers reach the gun in hand', () => {
    const { p } = scene();
    expect(p.kit().count).toBe(0);
    expect(p.gun().mag).toBe(12);
    arm(p, 'w_ar', { mag: 'a_mag_r', muzzle: 'a_sup_r' });
    expect(p.gun().mag).toBe(45);
    expect(p.mag).toBe(45);
    expect(p.gun().noise).toBeLessThan(gearDef('w_ar').gun!.noise * 0.5);
    expect(p.heldName()).toBe('Assault Rifle');
  });

  it('a suppressed shot is quieter on the Signature grid, slower in the air, and muffled to the ear', () => {
    const { h, sc, p } = scene();
    const shoot = vi.spyOn(sc.combat, 'shoot');
    const play = vi.spyOn(sc.audio, 'play');
    arm(p, 'w_pistol');
    p.fireCd = 0;
    fire(h, sc, 0.03);
    const loud = shoot.mock.calls[0][6];
    shoot.mockClear();
    arm(p, 'w_pistol', { muzzle: 'a_sup_h' });
    p.fireCd = 0;
    fire(h, sc, 0.03);
    const quiet = shoot.mock.calls[0][6];
    expect(quiet.noise!).toBeLessThan(loud.noise! * 0.4);
    expect(quiet.vel!).toBeLessThan(1);
    expect(loud.vel).toBeUndefined();
    expect(quiet.range!).toBeLessThan(loud.range!);
    expect(play.mock.calls.some((c) => c[0] === 'pistol' && (c[4] as { muffle?: number } | undefined)?.muffle)).toBe(true);
    // And the muzzle flash is smaller.
    expect(p.human.flashK).toBeLessThan(0.5);
  });

  it('a scope narrows the view while aiming, and the sights coming down put it back', () => {
    const { h, sc, p } = scene();
    arm(p, 'w_dmr', { optic: 'a_scope4' });
    h.intents[0].device = 'pad';
    h.intents[0].lt = 1;
    run(sc, 1.2);
    sc.renderFrame(1, DT);
    expect(p.zoomNow).toBeGreaterThan(2);
    expect((sc.R.views[0] as { zoom?: number }).zoom).toBeGreaterThan(2);
    h.intents[0].lt = 0;
    run(sc, 1);
    sc.renderFrame(1, DT);
    expect(p.zoomNow).toBeLessThan(1.1);
    expect((sc.R.views[0] as { zoom?: number }).zoom).toBeLessThan(1.1);
    // Without a scope there is no zoom at all.
    arm(p, 'w_ar');
    h.intents[0].lt = 1;
    run(sc, 1);
    expect(p.zoomNow).toBeCloseTo(1, 5);
  });

  it('recoil add-ons and heavier stocks change the kick and the speed of the sights', () => {
    const { h, sc, p } = scene();
    const kickOf = () => {
      p.fireCd = 0;
      let top = 0;
      fire(h, sc, 0.02);
      for (let i = 0; i < 12; i++) {
        sc.tick(DT);
        top = Math.max(top, p.kick.pitch.x);
      }
      run(sc, 1.5);
      return top;
    };
    arm(p, 'w_br');
    run(sc, 0.3);
    const bare = kickOf();
    arm(p, 'w_br', { muzzle: 'a_brake', under: 'a_grip', stock: 'a_stock_l2' });
    p.mag = 20;
    run(sc, 0.3);
    expect(kickOf()).toBeLessThan(bare * 0.8);
    const toAds = () => {
      h.intents[0].lt = 1;
      let n = 0;
      while (p.ads < 0.9 && n < 300) {
        sc.tick(DT);
        n++;
      }
      h.intents[0].lt = 0;
      run(sc, 1);
      return n;
    };
    arm(p, 'w_br', { stock: 'a_stock_l1' });
    run(sc, 0.3);
    const light = toAds();
    arm(p, 'w_br', { stock: 'a_stock_l2', under: 'a_bipod' });
    run(sc, 0.3);
    expect(toAds()).toBeGreaterThan(light);
  });

  it('the held model and the rest of the loadout follow what is fitted', () => {
    const { sc, p } = scene();
    arm(p, 'w_ar');
    sc.renderFrame(1, DT);
    const count = () => {
      const m = p.human.hand.children.find((c) => (c as { isMesh?: boolean }).isMesh && c !== p.human.flash.group) as THREE.Mesh;
      return m.geometry.getAttribute('position').count;
    };
    const bare = count();
    arm(p, 'w_ar', { optic: 'a_scope4', muzzle: 'a_sup_r' });
    sc.renderFrame(1, DT);
    expect(count()).toBeGreaterThan(bare);
    // Fitting through the loadout rules updates the numbers once the player is told.
    const sup = newMod('a_comp');
    p.gear.bag.push(sup);
    p.gear.belt[3] = gunWith('w_pistol');
    p.refreshGear();
    expect(fitFromBag(p.gear, p.gear.belt[3]!.uid, sup.uid).ok).toBe(true);
    p.refreshGear();
    expect(p.kit().recoil).toBeLessThan(1);
  });

  it('a laser draws its dot where the aim lands, and a crossbow fires a slow, quiet bolt with no brass', () => {
    const { h, sc, p } = scene();
    arm(p, 'w_pistol', { rail: 'a_laser' });
    run(sc, 0.3);
    sc.renderFrame(1, DT);
    expect(p.kit().beam).toBe('laser');
    const shoot = vi.spyOn(sc.combat, 'shoot');
    arm(p, 'w_crossbow');
    p.fireCd = 0;
    const before = sc.gore.brass.count;
    fire(h, sc, 0.03);
    run(sc, 1);
    expect(shoot).toHaveBeenCalled();
    expect(shoot.mock.calls[0][6]).toMatchObject({ ammo: 'bolt', noise: 6 });
    expect(sc.gore.brass.count).toBe(before);
  });
});

describe('the customise screen', () => {
  /** An inventory view with a host that records every button it asks for, as the real screen does for the focus ring. */
  function view() {
    const { sc, h, p } = scene();
    const acts = new Map<string, (pl: number) => void>();
    let renders = 0;
    const host = {
      c: h.campaign,
      audio: { play: () => {} },
      slot: () => null,
      btn: (id: string, inner: string, act: (pl: number) => void, enabled = true) => {
        acts.set(id, act);
        return `<button data-fid="${id}" ${enabled ? '' : 'disabled'}>${inner}</button>`;
      },
      rerender: () => {
        renders++;
        acts.clear();
      },
    };
    const v = new InventoryView(host);
    v.reset(p);
    const html = () => {
      acts.clear();
      return v.columnsHtml();
    };
    return { sc, h, p, v, acts, html, renders: () => renders };
  }

  it('opens from a selected gun, lists its slots and the bag add-ons that fit, with what each would change, and fits one', () => {
    const { p, v, acts, html, h } = view();
    const ar = newGear('w_ar');
    p.gear.belt[1] = ar;
    p.gear.bag.push(newMod('a_sup_r'), newMod('a_scope4'), newMod('a_sup_h'));
    p.refreshGear();
    v.sel = ar.uid;
    let out = html();
    expect(acts.has('a-cust')).toBe(true);
    acts.get('a-cust')!(0);
    expect(v.custom).toBe(ar.uid);
    out = html();
    for (const slot of slotsOfGun(gearDef('w_ar'))) expect(acts.has(`cs:${slot}`), slot).toBe(true);
    // Pick the muzzle: the rifle suppressor is offered with its changes, the pistol one is not.
    acts.get('cs:muzzle')!(0);
    out = html();
    expect(out).toMatch(/Rifle Suppressor/);
    expect(out).not.toMatch(/Pistol Suppressor/);
    expect(out).toMatch(/shot noise/);
    const cand = [...acts.keys()].find((k) => k.startsWith('cand:'))!;
    expect(cand).toBeTruthy();
    // Everything clickable on the panel is one of the host's buttons (so the pad can reach it).
    expect((out.match(/<button(?![^>]*(data-fid|data-slot))/g) ?? []).length).toBe(0);
    const ammoBefore = h.campaign.ammo;
    acts.get(cand)!(0);
    expect(ar.att).toEqual({ muzzle: 'a_sup_r' });
    expect(p.kit().count).toBe(0); // the gun in hand is the pistol; the rifle is on the belt
    // Taking it off again puts it back in the bag.
    out = html();
    expect(acts.has('c-remove')).toBe(true);
    acts.get('c-remove')!(0);
    expect(ar.att).toBeUndefined();
    expect(p.gear.bag.some((b) => b.id === 'a_sup_r')).toBe(true);
    expect(h.campaign.ammo).toBe(ammoBefore);
  });

  it('an add-on in the bag shows what it does, what it fits, and fits from its own buttons', () => {
    const { p, v, acts, html } = view();
    const sup = newMod('a_sup_h');
    p.gear.bag.push(sup);
    v.sel = sup.uid;
    const out = html();
    expect(out).toMatch(/Pistol Suppressor/);
    expect(out).toMatch(/9mm Pistol/);
    const fit = [...acts.keys()].find((k) => k.startsWith('a-fit'))!;
    expect(fit).toBeTruthy();
    acts.get(fit)!(0);
    expect(p.gear.belt[0]!.att).toEqual({ muzzle: 'a_sup_h' });
    p.refreshGear();
    expect(p.kit().quiet).toBeLessThan(0.5);
  });

  it('breaking down a dressed gun keeps its add-ons while the bag has room', () => {
    const { p, v, acts, html } = view();
    const ar = gunWith('w_ar', { optic: 'a_scope4', muzzle: 'a_sup_r' });
    p.gear.bag.push(ar);
    v.sel = ar.uid;
    html();
    acts.get('a-scrap')!(0);
    expect(p.gear.bag.some((b) => b.id === 'a_scope4')).toBe(true);
    expect(p.gear.bag.some((b) => b.id === 'a_sup_r')).toBe(true);
    expect(p.gear.bag.some((b) => b.id === 'w_ar')).toBe(false);
  });

  it('a gun on the belt with a drum fitted gets its extra rounds back when the drum comes off', () => {
    const { p, v, acts, html, h } = view();
    const ar = gunWith('w_ar', { mag: 'a_mag_rd' });
    p.gear.belt[1] = ar;
    v.sel = ar.uid;
    v.custom = ar.uid;
    v.cslot = 'mag';
    html();
    const ammo = h.campaign.ammo;
    acts.get('c-remove')!(0);
    expect(ar.mag).toBe(30);
    expect(h.campaign.ammo).toBeGreaterThan(ammo + 30);
  });
});
