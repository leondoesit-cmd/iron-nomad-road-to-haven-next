import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn, BTN_COUNT } from '../src/input/intents';
import { ACTIONS, defaultBindings, exportBindings, importBindings } from '../src/input/bindings';
import { InputManager } from '../src/input/input';
import { bagCap, newGear } from '../src/sim/gear';
import { newMod } from '../src/sim/gunmods';
import { DRUGS, DRUG_IDS, DrugState } from '../src/sim/drugs';
import { InventoryView, type InventoryHost } from '../src/ui/inventory';
import { canTakeOut, defaultAction, menuFor, type InvTarget, type MenuHost, type MenuItem } from '../src/ui/invMenu';
import { drugFacts, effectLines, supplyIds, timelineText } from '../src/ui/supplies';
import { DRESS_REACH } from '../src/game/consumables';
import { PICK_IDLE, closeDrugPick, openDrugPick } from '../src/game/drugPick';
import { quickLine } from '../src/ui/drugStrip';
import { fakeServices } from './helpers/sim';

vi.setConfig({ testTimeout: 120000 });

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics();
});

/** A short leg with both survivors on foot and nothing around to interrupt. */
function scene(solo = false) {
  const h = fakeServices({ solo });
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  for (const p of sc.players) p.exitVehicle(false);
  for (let i = 0; i < 18; i++) sc.tick(DT);
  sc.zombies.list.length = 0;
  sc.wildlife.list.length = 0;
  for (const it of h.intents) it.device = 'keyboard';
  return { h, sc, p: sc.players[0] };
}

/** An inventory view over a scene, with a host that records the buttons it is asked for, as the real screen does for focus. */
function view(s: ReturnType<typeof scene>, field = true) {
  const acts = new Map<string, (pl: number) => void>();
  const host: InventoryHost = {
    c: s.h.campaign,
    audio: { play: () => {} },
    slot: () => ({ kind: 'kb', set: 1 }),
    btn: (id, inner, act, enabled = true) => {
      acts.set(id, act);
      return `<button data-fid="${id}" ${enabled ? '' : 'disabled'}>${inner}</button>`;
    },
    rerender: () => {},
    field,
  };
  const v = new InventoryView(host);
  v.reset(s.p);
  const menu = (t: InvTarget): MenuItem[] => menuFor(v as unknown as MenuHost, t);
  return { v, acts, menu };
}

const ids = (m: MenuItem[]) => m.map((i) => i.id);
const row = (m: MenuItem[], id: string) => m.find((i) => i.id === id)!;

describe('the inventory menu', () => {
  it('a gun in the bag: hold it, a belt slot, load, customise, give, drop and break down, in that order', () => {
    const s = scene();
    const { menu } = view(s);
    const ar = newGear('w_ar');
    ar.mag = 3;
    s.p.gear.bag.push(ar);
    const m = menu({ kind: 'gear', uid: ar.uid });
    expect(ids(m)).toEqual(['a-equip', 'a-slot0', 'a-slot1', 'a-slot2', 'a-slot3', 'a-load', 'a-cust', 'a-give', 'a-drop', 'a-scrap']);
    expect(row(m, 'a-load').enabled).toBe(true);
    expect(row(m, 'a-load').note).toMatch(/^3\//);
    expect(row(m, 'a-scrap').danger).toBe(true);
    // The obvious thing is never breaking it down.
    expect(defaultAction(m)!.id).toBe('a-equip');
    s.sc.dispose();
  });

  it('the gun in hand: already held, nothing to load into a full magazine, and the last weapon stays on the belt', () => {
    const s = scene();
    const { menu } = view(s);
    const L = s.p.gear;
    // Only the pistol on the belt is a weapon (the rest are tools).
    const pistol = L.belt[0]!;
    L.sel = 0;
    const m = menu({ kind: 'gear', uid: pistol.uid });
    expect(row(m, 'a-hold')).toMatchObject({ enabled: false, reason: 'Already in hand' });
    expect(row(m, 'a-load')).toMatchObject({ enabled: false, reason: 'Already full' });
    expect(row(m, 'a-stow')).toMatchObject({ enabled: false, reason: 'Keep a weapon on your belt' });
    expect(row(m, 'a-drop')).toMatchObject({ enabled: false, reason: 'Keep a weapon on your belt' });
    expect(row(m, 'a-scrap').enabled).toBe(false);
    // Three other belt slots to move it to.
    expect(m.filter((i) => i.chip).map((i) => i.id)).toEqual(['a-mv1', 'a-mv2', 'a-mv3']);
    s.sc.dispose();
  });

  it('loading a gun from the pack tops it up from the stores', () => {
    const s = scene();
    const { menu } = view(s);
    const pistol = s.p.gear.belt[0]!;
    pistol.mag = 2;
    const ammo = s.h.campaign.ammo;
    row(menu({ kind: 'gear', uid: pistol.uid }), 'a-load').run();
    expect(pistol.mag).toBeGreaterThan(2);
    expect(s.h.campaign.ammo).toBe(ammo - (pistol.mag! - 2));
    s.sc.dispose();
  });

  it('a worn piece comes off into the bag, or says why not when the bag is full', () => {
    const s = scene();
    const { menu } = view(s);
    const L = s.p.gear;
    const body = L.worn.body!;
    expect(row(menu({ kind: 'gear', uid: body.uid }), 'a-off').enabled).toBe(true);
    while (L.bag.length < bagCap(L)) L.bag.push(newGear('h_cap'));
    const m = menu({ kind: 'gear', uid: body.uid });
    expect(row(m, 'a-off')).toMatchObject({ enabled: false, reason: 'Your bag has no room for that' });
    // It can still leave the kit another way: it is not holding the bag's contents.
    expect(row(m, 'a-drop').enabled).toBe(true);
    s.sc.dispose();
  });

  it('an add-on with nothing to fit says so; with a gun that takes it, it offers that gun', () => {
    const s = scene();
    const { menu } = view(s);
    const sup = newMod('a_sup_r');
    s.p.gear.bag.push(sup);
    let m = menu({ kind: 'gear', uid: sup.uid });
    expect(row(m, 'a-fit').enabled).toBe(false);
    expect(row(m, 'a-fit').reason).toMatch(/slot for it/);
    const ar = newGear('w_ar');
    s.p.gear.bag.push(ar);
    m = menu({ kind: 'gear', uid: sup.uid });
    const fit = m.find((i) => i.id === `a-fit${ar.uid}`)!;
    expect(fit.enabled).toBe(true);
    fit.run();
    expect(ar.att).toEqual({ muzzle: 'a_sup_r' });
    s.sc.dispose();
  });

  it('the Dawn Ledger has no ground to drop things on', () => {
    const s = scene();
    const { menu } = view(s, false);
    const knife = newGear('m_knife');
    s.p.gear.bag.push(knife);
    expect(ids(menu({ kind: 'gear', uid: knife.uid }))).not.toContain('a-drop');
    s.sc.dispose();
  });

  it('dropping puts the item on the ground as a find, out of the kit', () => {
    const s = scene();
    const { menu } = view(s);
    const knife = newGear('m_knife');
    s.p.gear.bag.push(knife);
    row(menu({ kind: 'gear', uid: knife.uid }), 'a-drop').run();
    expect(s.p.gear.bag.includes(knife)).toBe(false);
    expect(s.sc.groundGear?.list().some((d) => d.item.uid === knife.uid)).toBe(true);
    s.sc.dispose();
  });

  it('giving from the belt hands it straight to the partner, and a full partner bag greys it out', () => {
    const s = scene();
    const { menu } = view(s);
    const L = s.p.gear;
    const wrench = L.belt[1]!;
    row(menu({ kind: 'gear', uid: wrench.uid }), 'a-give').run();
    expect(L.belt[1]).toBeNull();
    expect(s.h.campaign.players[1].gear.bag.some((b) => b.uid === wrench.uid)).toBe(true);
    const them = s.h.campaign.players[1].gear;
    while (them.bag.length < bagCap(them)) them.bag.push(newGear('h_cap'));
    expect(row(menu({ kind: 'gear', uid: L.belt[2]!.uid }), 'a-give')).toMatchObject({ enabled: false, reason: 'Their bag is full' });
    s.sc.dispose();
  });

  it('a worn pack cannot leave while its pockets hold the bag', () => {
    const s = scene();
    const L = s.p.gear;
    const pack = L.worn.back!;
    L.bag.length = 0;
    expect(canTakeOut(L, pack.uid)).toMatchObject({ ok: true });
    while (L.bag.length < bagCap(L)) L.bag.push(newGear('h_cap'));
    expect(canTakeOut(L, pack.uid)).toMatchObject({ ok: false, reason: 'Its pockets hold your bag: empty the bag first' });
    s.sc.dispose();
  });

  it('throwables: hold one, unless it is in hand already or there are none', () => {
    const s = scene();
    const { menu } = view(s);
    s.h.campaign.items.flare = 1;
    row(menu({ kind: 'util', id: 'flare' }), 'a-util').run();
    expect(s.p.utility).toBe('flare');
    expect(row(menu({ kind: 'util', id: 'flare' }), 'a-util')).toMatchObject({ enabled: false, reason: 'Already in hand' });
    s.h.campaign.items.molotov = 0;
    expect(row(menu({ kind: 'util', id: 'molotov' }), 'a-util').reason).toMatch(/No molotovs/);
    s.sc.dispose();
  });
});

describe('supplies from the pack', () => {
  it('a bandage on yourself stops the bleeding; unhurt, it says so', () => {
    const s = scene();
    const { menu } = view(s);
    const p = s.p;
    expect(row(menu({ kind: 'supply', id: 'bandage' }), 'a-use')).toMatchObject({ enabled: false, reason: 'You are not hurt' });
    p.bleed.level = 2;
    p.hp = 60;
    const n = s.h.campaign.items.bandage;
    row(menu({ kind: 'supply', id: 'bandage' }), 'a-use').run();
    expect(p.bleed.level).toBe(0);
    expect(p.hp).toBeGreaterThan(60);
    expect(s.h.campaign.items.bandage).toBe(n - 1);
    // Nobody is shooting at you in the pack: the hands are free when it closes.
    expect(p.fireCd).toBe(0);
    s.sc.dispose();
  });

  it('a bandage on the partner needs them close and hurt', () => {
    const s = scene();
    const { menu } = view(s);
    const [p, q] = s.sc.players;
    q.placeAt(p.pos.x + DRESS_REACH + 5, p.pos.z);
    q.bleed.level = 1;
    expect(row(menu({ kind: 'supply', id: 'bandage' }), 'a-other').reason).toMatch(/Too far/);
    q.placeAt(p.pos.x + 1, p.pos.z);
    q.bleed.level = 0;
    q.hp = q.maxHp;
    expect(row(menu({ kind: 'supply', id: 'bandage' }), 'a-other').reason).toMatch(/not hurt/);
    q.bleed.level = 2;
    q.hp = 50;
    const m = menu({ kind: 'supply', id: 'bandage' });
    expect(row(m, 'a-other').label).toBe(`Bandage ${q.name}`);
    row(m, 'a-other').run();
    expect(q.bleed.level).toBe(0);
    expect(q.hp).toBeGreaterThan(50);
    expect(p.bleed.level).toBe(0);
    s.sc.dispose();
  });

  it('solo there is nobody to bandage', () => {
    const s = scene(true);
    const { menu } = view(s);
    expect(ids(menu({ kind: 'supply', id: 'medkit' }))).toEqual(['a-use', 'a-quick']);
    s.sc.dispose();
  });

  it('taking a drug from the pack spends a dose; it comes on once the game runs again', () => {
    const s = scene();
    const { menu, v } = view(s);
    const p = s.p;
    s.h.campaign.items.stim = 2;
    row(menu({ kind: 'supply', id: 'stim' }), 'a-take').run();
    expect(s.h.campaign.items.stim).toBe(1);
    expect(p.drugs.active.map((a) => a.id)).toEqual(['stim']);
    expect(v.msg).toMatch(/Kicks in over ~4 s once you close the pack/);
    expect(p.drugs.intensity('stim')).toBe(0);
    for (let i = 0; i < Math.ceil(DRUGS.stim.onset / DT) + 5; i++) s.sc.tick(DT);
    expect(p.drugs.intensity('stim')).toBeGreaterThan(0.5);
    s.sc.dispose();
  });

  it('a drug with none left is greyed out with why', () => {
    const s = scene();
    const { menu } = view(s);
    s.h.campaign.items.lsd = 0;
    expect(row(menu({ kind: 'supply', id: 'lsd' }), 'a-take')).toMatchObject({ enabled: false, reason: 'No lsd left' });
    s.sc.dispose();
  });

  it('put on quick belt makes it what the use button takes, and then says it is there', () => {
    const s = scene();
    const { menu } = view(s);
    const p = s.p;
    row(menu({ kind: 'supply', id: 'weed' }), 'a-quick').run();
    expect(p.quickSel).toBe('weed');
    expect(row(menu({ kind: 'supply', id: 'weed' }), 'a-quick').enabled).toBe(false);
    row(menu({ kind: 'supply', id: 'medkit' }), 'a-quick').run();
    expect(p.quickSel).toBe('medkit');
    row(menu({ kind: 'supply', id: 'water' }), 'a-quick').run();
    expect(p.quickSel).toBe('drink');
    s.sc.dispose();
  });

  it('eat and drink follow the same rules as the chore keys', () => {
    const s = scene();
    const { menu } = view(s);
    const n = s.p.needs;
    n.food = 1;
    expect(row(menu({ kind: 'supply', id: 'ration' }), 'a-eat')).toMatchObject({ enabled: false, reason: 'You are not hungry' });
    n.food = 0.3;
    const rations = s.h.campaign.stocks.rations;
    row(menu({ kind: 'supply', id: 'ration' }), 'a-eat').run();
    expect(n.food).toBeGreaterThan(0.3);
    expect(s.h.campaign.stocks.rations).toBe(rations - 1);
    s.sc.dispose();
  });

  it('the view draws every supply and the menu for the open target, each button registered', () => {
    const s = scene();
    const { v, acts } = view(s);
    s.h.campaign.items.mushrooms = 1;
    const html = v.columnsHtml();
    for (const id of supplyIds()) {
      if (DRUG_IDS.includes(id as never) && (s.h.campaign.items[id as keyof typeof s.h.campaign.items] ?? 0) <= 0) continue;
      expect(acts.has(`sup:${id}`), id).toBe(true);
    }
    expect(html).toMatch(/In your system/);
    v.openMenu({ kind: 'supply', id: 'mushrooms' });
    const out = v.columnsHtml();
    expect(out).toMatch(/class="invmenu"/);
    expect(acts.has('a-take')).toBe(true);
    // The detail column reads out the drug's timeline and what it does.
    expect(out).toMatch(/Comes on over 30 s/);
    expect(out).toMatch(/What it does/);
    s.sc.dispose();
  });
});

describe('what a drug does, in words', () => {
  it('every drug has a timeline, at least one effect and its risks', () => {
    for (const id of DRUG_IDS) {
      const f = drugFacts(id, null);
      expect(timelineText(DRUGS[id]), id).toMatch(/Comes on over/);
      expect(f.effects.length, id).toBeGreaterThan(0);
      expect(f.risks.some((r) => /Toxicity/.test(r.text)), id).toBe(true);
    }
  });

  it('reads tolerance, interactions and blends off the body it would land on', () => {
    const s = new DrugState(() => 0.99);
    s.dose('alcohol');
    s.dose('stim');
    const f = drugFacts('stim', s);
    expect(f.now.some((l) => /tolerance/i.test(l.text))).toBe(true);
    expect(f.now.some((l) => /The stim is hiding how drunk you are/.test(l.text))).toBe(true);
    const w = drugFacts('weed', s);
    expect(w.now.some((l) => /Couchlock/.test(l.text))).toBe(true);
    expect(quickLine('stim', s)).toMatch(/weaker \(tolerance\)/);
  });

  it('effects come out in words with the right sign', () => {
    const l = effectLines({ speed: 1.25, damage: 0.5, nausea: 1 });
    expect(l.map((x) => x.text)).toEqual(['+25% speed', 'takes 50% less damage', 'nausea: you may throw up']);
    expect(l.map((x) => x.tone)).toEqual(['good', 'good', 'bad']);
  });
});

describe('the drugs quick pick', () => {
  /** Press a button for one tick, as the input would deliver it. */
  function press(s: ReturnType<typeof scene>, b: number, who = 0) {
    const it = s.h.intents[who];
    it.pressed = 1 << b;
    it.held = 1 << b;
    s.sc.tick(DT);
    it.pressed = 0;
    it.held = 0;
  }
  /** Keys the next tick sees as freshly pressed, for the number row. */
  function keys(s: ReturnType<typeof scene>, codes: string[]) {
    (s.h.input as unknown as { wasKeyPressed: (c: string) => boolean }).wasKeyPressed = (c) => codes.includes(c);
    s.sc.tick(DT);
    (s.h.input as unknown as { wasKeyPressed: (c: string) => boolean }).wasKeyPressed = () => false;
  }

  it('opens on its key, picks with the number row, takes with interact, and spends the dose', () => {
    const s = scene();
    (s.h.input as unknown as { slots: unknown[] }).slots = [{ kind: 'kb', set: 1 }, null];
    const c = s.h.campaign;
    c.items.painkiller = 1;
    c.items.stim = 2;
    c.items.weed = 1;
    press(s, Btn.Drugs);
    const pk = s.p.drugPick;
    expect(pk.open).toBe(true);
    expect(pk.rows).toEqual(DRUG_IDS.filter((d) => c.items[d] > 0));
    keys(s, [`Digit${pk.rows.indexOf('weed') + 1}`]);
    expect(pk.sel).toBe('weed');
    const action = s.p.action;
    press(s, Btn.A);
    expect(pk.open).toBe(false);
    expect(c.items.weed).toBe(0);
    expect(s.p.drugs.active.some((a) => a.id === 'weed')).toBe(true);
    // The press that took it did nothing else.
    expect(s.p.action).toBe(action);
    s.sc.dispose();
  });

  it('only the picking keys are taken: forward is a pick, strafing still walks', () => {
    const s = scene();
    s.h.campaign.items.stim = 1;
    s.h.campaign.items.painkiller = 1;
    const it = s.h.intents[0];
    openDrugPick(s.p);
    const z0 = s.p.pos.z;
    const x0 = s.p.pos.x;
    for (let i = 0; i < 30; i++) {
      it.move[0] = 0;
      it.move[1] = 1;
      s.sc.tick(DT);
    }
    expect(Math.hypot(s.p.pos.x - x0, s.p.pos.z - z0)).toBeLessThan(0.05);
    expect(s.p.drugPick.open).toBe(true);
    for (let i = 0; i < 30; i++) {
      it.move[0] = 1;
      it.move[1] = 0;
      s.sc.tick(DT);
    }
    it.move[0] = 0;
    expect(Math.hypot(s.p.pos.x - x0, s.p.pos.z - z0)).toBeGreaterThan(0.3);
    s.sc.dispose();
  });

  it('crouch puts it away without crouching; it folds itself away when left alone', () => {
    const s = scene();
    s.h.campaign.items.stim = 1;
    openDrugPick(s.p);
    const crouch = s.p.crouch;
    press(s, Btn.B);
    expect(s.p.drugPick.open).toBe(false);
    expect(s.p.crouch).toBe(crouch);
    openDrugPick(s.p);
    for (let i = 0; i < Math.ceil(PICK_IDLE / DT) + 2; i++) s.sc.tick(DT);
    expect(s.p.drugPick.open).toBe(false);
    s.sc.dispose();
  });

  it('with nothing to take it does not open, and says so', () => {
    const s = scene();
    for (const d of DRUG_IDS) s.h.campaign.items[d] = 0;
    press(s, Btn.Drugs);
    expect(s.p.drugPick.open).toBe(false);
    expect(s.p.notes.some((n) => /no drugs/i.test(n.text))).toBe(true);
    expect(closeDrugPick(s.p)).toBe(false);
    s.sc.dispose();
  });

  it('the mouse wheel steps the pick instead of the tool in hand', () => {
    const s = scene();
    s.h.campaign.items.painkiller = 1;
    s.h.campaign.items.stim = 1;
    openDrugPick(s.p);
    const sel = s.p.gear.sel;
    const first = s.p.drugPick.sel;
    s.h.intents[0].toolStep = 1;
    s.sc.tick(DT);
    s.h.intents[0].toolStep = 0;
    expect(s.p.drugPick.sel).not.toBe(first);
    expect(s.p.gear.sel).toBe(sel);
    s.sc.dispose();
  });
});

describe('the drugs key', () => {
  it('is bound by default on both keyboards, unique within and across the two layouts', () => {
    const b = defaultBindings();
    expect(b.kb[0].drugs).toBe('Digit0');
    expect(b.kb[1].drugs).toBe('PageDown');
    for (const m of b.kb) {
      const codes = Object.values(m);
      expect(new Set(codes).size).toBe(codes.length);
    }
    const both = [...Object.values(b.kb[0]), ...Object.values(b.kb[1])];
    expect(new Set(both).size).toBe(both.length);
    expect(Btn.Drugs).toBeLessThan(BTN_COUNT);
    expect(ACTIONS.find((a) => a.id === 'drugs')).toMatchObject({ group: 'combat', optional: true });
  });

  it('survives a save and load, and an unbound one stays unbound', () => {
    const b = defaultBindings();
    expect(importBindings(exportBindings(b)).kb[0].drugs).toBe('Digit0');
    delete b.kb[0].drugs;
    expect(importBindings(exportBindings(b)).kb[0].drugs).toBeUndefined();
    // A save from before the key existed gets the default.
    const old = exportBindings(defaultBindings()) as { kb: Record<string, unknown>[] };
    delete old.kb[0].drugs;
    expect(importBindings(old).kb[0].drugs).toBe('Digit0');
  });

  it('a key press reaches the Drugs button, and the raw key reads as pressed for the whole tick', () => {
    const win = new EventTarget();
    const im = new InputManager(win as unknown as Window);
    im.autoJoinKeyboard();
    const key = (type: 'keydown' | 'keyup', code: string) => win.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat: false }));
    key('keydown', 'Digit0');
    im.sample(DT);
    expect(im.intents[0].pressed & (1 << Btn.Drugs)).not.toBe(0);
    expect(im.wasKeyPressed('Digit0')).toBe(true);
    key('keyup', 'Digit0');
    im.sample(DT);
    expect(im.wasKeyPressed('Digit0')).toBe(false);
  });
});

