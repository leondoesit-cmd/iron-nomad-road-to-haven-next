import { beforeAll, describe, expect, it } from 'vitest';
import { Btn, NAV } from '../src/input/intents';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Rng } from '../src/core/rng';
import { Campaign } from '../src/game/campaign';
import { findItem, itemAt, newGear, repairItem, repairPrice, rollGear, sanitizeLoadout, scrapOf, sortBag, starterLoadout, heldItem, gearDrop } from '../src/sim/gear';
import {
  BLEED,
  STAMINA,
  bind,
  canSprint,
  foundCondition,
  jamChance,
  newBleed,
  newStamina,
  openWound,
  repairCost,
  spendStamina,
  tickBleed,
  tickStamina,
  wearBy,
  wearDamage,
  wearSpread,
  woundChance,
} from '../src/sim/vitals';
import { RECIPES } from '../src/sim/resources';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

describe('stamina rules', () => {
  it('sprinting drains it and being winded locks sprinting until some has come back', () => {
    const s = newStamina();
    expect(canSprint(s)).toBe(true);
    for (let i = 0; i < 60 * 8; i++) tickStamina(s, DT, { sprinting: true });
    expect(s.value).toBe(0);
    expect(s.winded).toBe(true);
    expect(canSprint(s)).toBe(false);
    // Nothing comes back during the delay.
    tickStamina(s, 0.5, { sprinting: false });
    expect(s.value).toBe(0);
    for (let i = 0; i < 60 * 1.2; i++) tickStamina(s, DT, { sprinting: false });
    expect(s.value).toBeGreaterThan(0);
    for (let i = 0; i < 60 * 3; i++) tickStamina(s, DT, { sprinting: false });
    expect(s.winded).toBe(false);
    expect(canSprint(s)).toBe(true);
  });

  it('a lump cost (jump, swing) spends and restarts the recovery delay', () => {
    const s = newStamina();
    expect(spendStamina(s, STAMINA.jump)).toBe(true);
    expect(s.value).toBe(STAMINA.max - STAMINA.jump);
    tickStamina(s, STAMINA.delay * 0.5, { sprinting: false });
    expect(s.value).toBe(STAMINA.max - STAMINA.jump);
    s.value = 3;
    expect(spendStamina(s, STAMINA.swing)).toBe(false);
    expect(s.winded).toBe(true);
  });

  it('a stim-shortened drain lasts longer, and resting refills faster', () => {
    const a = newStamina();
    const b = newStamina();
    for (let i = 0; i < 120; i++) {
      tickStamina(a, DT, { sprinting: true });
      tickStamina(b, DT, { sprinting: true, drain: 0.6 });
    }
    expect(b.value).toBeGreaterThan(a.value);
    a.value = b.value = 10;
    a.idle = b.idle = 0;
    tickStamina(a, 1, { sprinting: false });
    tickStamina(b, 1, { sprinting: false, resting: true });
    expect(b.value).toBeGreaterThan(a.value);
  });
});

describe('bleeding rules', () => {
  it('bites and blades cut, bruises and falls do not, and armour helps', () => {
    expect(woundChance('bite', 14, 0)).toBeGreaterThan(woundChance('bullet', 14, 0));
    expect(woundChance('bite', 3, 0)).toBe(0);
    expect(woundChance('fall', 40, 0)).toBe(0);
    expect(woundChance('spore', 40, 0)).toBe(0);
    expect(woundChance('melee', 20, 0.5)).toBeLessThan(woundChance('melee', 20, 0));
    expect(woundChance('melee', 500, 0)).toBeLessThanOrEqual(0.85);
  });

  it('wounds stack to a cap, drain per wound, and clot oldest-first on their own', () => {
    const b = newBleed();
    expect(openWound(b)).toBe(true);
    expect(openWound(b)).toBe(true);
    expect(openWound(b)).toBe(true);
    expect(openWound(b)).toBe(false);
    expect(b.level).toBe(BLEED.maxLevel);
    expect(tickBleed(b, 1)).toBeCloseTo(BLEED.perLevel * 3, 5);
    let lost = 0;
    for (let i = 0; i < 60 * BLEED.clot; i++) lost += tickBleed(b, DT);
    expect(b.level).toBe(2);
    expect(lost).toBeGreaterThan(0);
    expect(bind(b)).toBe(2);
    expect(tickBleed(b, 5)).toBe(0);
  });
});

describe('weapon wear', () => {
  it('plays like new above the line, then worsens, and jams only when nearly gone', () => {
    expect(wearSpread(undefined)).toBe(1);
    expect(wearSpread(0.8)).toBe(1);
    expect(wearSpread(0.1)).toBeGreaterThan(wearSpread(0.4));
    expect(wearDamage(0.05)).toBeLessThan(wearDamage(0.4));
    expect(wearDamage(0.05)).toBeGreaterThan(0.6);
    expect(jamChance(0.5)).toBe(0);
    expect(jamChance(0.3)).toBeGreaterThan(0);
    expect(jamChance(0)).toBeGreaterThan(jamChance(0.3));
    expect(jamChance(0)).toBeLessThan(0.5);
  });

  it('repair prices scale with damage and rarity, and a mint weapon costs nothing', () => {
    expect(repairCost(undefined, 3)).toBe(0);
    expect(repairCost(0.995, 3)).toBe(0);
    expect(repairCost(0.5, 3)).toBeGreaterThan(repairCost(0.5, 1));
    expect(repairCost(0.1, 2)).toBeGreaterThan(repairCost(0.8, 2));
    expect(wearBy(0.001, 1)).toBe(0);
  });

  it('finds come out worn, within bounds, and clothes never carry a condition', () => {
    const rng = new Rng(7);
    let weapons = 0;
    for (let i = 0; i < 400; i++) {
      const it = rollGear(rng, { maxR: 3 });
      const d = itemAt({ worn: {}, belt: [it], bag: [], sel: 0 }, { zone: 'belt', i: 0 })!;
      if (d.cond !== undefined) {
        weapons++;
        expect(d.cond).toBeGreaterThanOrEqual(0.3);
        expect(d.cond).toBeLessThanOrEqual(0.95);
      }
    }
    expect(weapons).toBeGreaterThan(20);
    expect(foundCondition(0, 1)).toBeLessThan(foundCondition(1, 1));
  });

  it('condition saves, loads, ignores junk, and a worn blade is worth less scrap', () => {
    const l = starterLoadout();
    const gun = heldItem(l)!;
    gun.cond = 0.42;
    const back = sanitizeLoadout(JSON.parse(JSON.stringify(l)));
    expect(heldItem(back)!.cond).toBeCloseTo(0.42, 5);
    const junk = JSON.parse(JSON.stringify(l));
    junk.belt[0].cond = 'lots';
    junk.worn.head = { ...junk.worn.head, cond: 0.2 };
    const clean = sanitizeLoadout(junk);
    expect(heldItem(clean)!.cond).toBeUndefined();
    expect(clean.worn.head!.cond).toBeUndefined();
    const mint = newGear('m_axe');
    const dull = { ...mint, cond: 0.1 };
    expect(scrapOf(dull)).toBeLessThan(scrapOf(mint));
    expect(scrapOf(dull)).toBeGreaterThan(0);
    expect(repairPrice(dull)).toBeGreaterThan(0);
    repairItem(dull);
    expect(repairPrice(dull)).toBe(0);
  });

  it('a seeded drop is stable and the same container always yields the same condition', () => {
    const a = gearDrop(new Rng(99), 'hoard', { tier: 2 });
    const b = gearDrop(new Rng(99), 'hoard', { tier: 2 });
    expect(a?.id).toBe(b?.id);
    expect(a?.cond).toBe(b?.cond);
  });
});

describe('bag sort and supplies', () => {
  it('sorts guns, blades, tools, then clothes by slot, rarest first, and loses nothing', () => {
    const l = starterLoadout();
    l.bag = ['h_cap', 'k_ruck', 'w_rifle', 'm_knife', 'w_pistol', 'h_riot', 'm_axe'].map(newGear);
    const ids = l.bag.map((b) => b.uid).sort();
    sortBag(l);
    expect(l.bag.map((b) => b.id)).toEqual(['w_rifle', 'w_pistol', 'm_axe', 'm_knife', 'h_riot', 'h_cap', 'k_ruck']);
    expect(l.bag.map((b) => b.uid).sort()).toEqual(ids);
    expect(findItem(l, l.bag[0].uid)).toEqual({ zone: 'bag', i: 0 });
  });

  it('bandages are cheap to craft and old saves gain a stock of them', () => {
    const r = RECIPES.find((x) => x.id === 'bandage')!;
    expect(r.yields.bandage).toBe(3);
    const c = new Campaign(undefined, false);
    const save = JSON.parse(JSON.stringify(c.serialize()));
    delete save.items.bandage;
    const back = Campaign.deserialize(save);
    expect(back.items.bandage).toBe(2);
  });
});

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  for (const p of sc.players) p.exitVehicle(false);
  run(sc, 0.6);
  return { sc, ...h };
}
type H = ReturnType<typeof leg>;

function hold(h: H, i: 0 | 1, btn: number, secs: number) {
  const it = h.intents[i];
  it.pressed |= 1 << btn;
  it.held |= 1 << btn;
  h.sc.tick(DT);
  it.pressed &= ~(1 << btn);
  run(h.sc, secs);
  it.held &= ~(1 << btn);
  it.released |= 1 << btn;
  h.sc.tick(DT);
  it.released &= ~(1 << btn);
}

describe('survival on foot', () => {
  it('sprinting spends stamina, and running dry slows you to a walk until you recover', () => {
    const h = leg();
    const p = h.sc.players[0];
    const it = h.intents[0];
    it.move = [0, 1];
    it.sprint = true;
    let top = 0;
    run(h.sc, 2, () => (top = Math.max(top, p.moveSpeed)));
    expect(p.stamina.value).toBeLessThan(STAMINA.max - 10);
    expect(top).toBeGreaterThan(4.5);
    run(h.sc, 4);
    expect(p.stamina.winded).toBe(true);
    run(h.sc, 0.5);
    expect(p.moveSpeed).toBeLessThan(3.3);
    it.sprint = false;
    it.move = [0, 0];
    run(h.sc, 5);
    expect(p.stamina.winded).toBe(false);
    h.sc.dispose();
  }, 60000);

  it('a bandage on the quick belt stops a bleed and mends a little, and is spent', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.items.bandage = 2;
    p.hp = 60;
    openWound(p.bleed);
    openWound(p.bleed);
    // The belt opens on the drug; step left from the painkiller to land on the medkit, then once more to the bandage.
    p.drugs.selected = 'painkiller';
    const it = h.intents[0];
    it.pressed |= 1 << Btn.Down;
    it.held |= 1 << Btn.Down;
    h.sc.tick(DT);
    it.pressed = 0;
    run(h.sc, 0.5);
    expect(p.beltOpen).toBe(true);
    for (let k = 0; k < 2; k++) {
      it.nav = NAV.left;
      h.sc.tick(DT);
      it.nav = 0;
      h.sc.tick(DT);
    }
    expect(p.quickSel).toBe('bandage');
    it.held = 0;
    it.released |= 1 << Btn.Down;
    h.sc.tick(DT);
    it.released = 0;
    // Closing the belt took nothing; a tap uses what it rests on.
    expect(p.bleed.level).toBe(2);
    hold(h, 0, Btn.Down, 0.05);
    expect(p.bleed.level).toBe(0);
    expect(h.campaign.items.bandage).toBe(1);
    expect(p.hp).toBeGreaterThan(60);
    h.sc.dispose();
  }, 60000);

  it('wounds drain health but never land the killing blow by themselves', () => {
    const h = leg();
    const p = h.sc.players[0];
    p.hp = 5;
    openWound(p.bleed);
    openWound(p.bleed);
    openWound(p.bleed);
    run(h.sc, 12);
    expect(p.hp).toBeGreaterThanOrEqual(1);
    expect(p.state).toBe('foot');
    h.sc.dispose();
  }, 60000);

  it('a medkit with nothing wrong with you is not wasted', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.items.medkit = 1;
    expect(p.useDressing('medkit')).toBe(false);
    expect(h.campaign.items.medkit).toBe(1);
    p.hp = 30;
    expect(p.useDressing('medkit')).toBe(true);
    expect(p.hp).toBe(90);
    h.sc.dispose();
  }, 60000);

  it('firing and swinging wear the weapon in hand', () => {
    const h = leg();
    const p = h.sc.players[0];
    const gun = heldItem(p.gear)!;
    expect(gun.cond).toBeUndefined();
    h.campaign.ammo = 90;
    const it = h.intents[0];
    it.rt = 1;
    run(h.sc, 1.5);
    it.rt = 0;
    expect(gun.cond).toBeLessThan(1);
    expect(gun.cond).toBeGreaterThan(0.9);
    h.sc.dispose();
  }, 60000);

  it('a worn-out gun can jam, and clears itself with the reload time', () => {
    const h = leg();
    const p = h.sc.players[0];
    const gun = heldItem(p.gear)!;
    gun.cond = 0;
    h.campaign.ammo = 200;
    const it = h.intents[0];
    it.rt = 1;
    let jammed = false;
    run(h.sc, 20, () => {
      if (p.notes.some((n) => /Jammed/.test(n.text))) jammed = true;
    });
    it.rt = 0;
    expect(jammed).toBe(true);
    // It still fires: a jam costs time, not the gun.
    expect(p.mag).toBeLessThan(gearMag(p));
    h.sc.dispose();
  }, 60000);
});

function gearMag(p: { gun(): { mag: number } }) {
  return p.gun().mag;
}

