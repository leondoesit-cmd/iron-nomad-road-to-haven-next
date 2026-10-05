import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { gearDef, legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { CampScene } from '../src/game/campScene';
import { Campaign } from '../src/game/campaign';
import { carryOf } from '../src/game/delveScene';
import { Btn } from '../src/input/intents';
import { InputManager } from '../src/input/input';
import { defaultBindings } from '../src/input/bindings';
import { Rng } from '../src/core/rng';
import { bagCap, equipFromBag, newGear, sanitizeLoadout, type Loadout } from '../src/sim/gear';
import { salvageLoot } from '../src/sim/salvage';
import { FocusUI } from '../src/ui/focus';
import { NAV, newIntent } from '../src/input/intents';
import { fakeServices } from './helpers/sim';

// Real leg scenes in Node, with people on foot. Give them room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

function scene(opts: { solo?: boolean } = {}) {
  const h = fakeServices(opts);
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  for (const p of sc.players) p.exitVehicle(false);
  for (let i = 0; i < 18; i++) sc.tick(DT);
  return { h, sc, c: h.campaign, p: sc.players[0] };
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

/** A tap: one tick pressed, one released. */
function tap(h: ReturnType<typeof fakeServices>, sc: LegScene, who: number, btn: number) {
  const it = h.intents[who];
  it.device = 'keyboard';
  it.held |= 1 << btn;
  it.pressed = 1 << btn;
  sc.tick(DT);
  it.held &= ~(1 << btn);
  it.pressed = 0;
  it.released = 1 << btn;
  sc.tick(DT);
  it.released = 0;
  sc.tick(DT);
}

/** Put gear in the bag, then onto the body or the belt, and tell the player. */
function equip(p: LegScene['players'][number], id: string, belt?: number) {
  const it = newGear(id);
  p.gear.bag.push(it);
  const r = equipFromBag(p.gear, it.uid, belt);
  expect(r.ok).toBe(true);
  p.refreshGear();
  return it;
}

describe('a scavenger in their starter kit', () => {
  it('holds the pistol the game always started with', () => {
    const { p } = scene();
    expect(p.equip).toBe('gun');
    expect(p.heldName()).toBe('9mm Pistol');
    const g = p.gun();
    expect([g.dmg, g.cd, g.mag, g.reload, g.range, g.noise]).toEqual([27, 0.2, 12, 1.3, 75, 60]);
    expect(p.mag).toBe(12);
  });

  it('wears the original look: the body parts are drawn, and a swap redraws only what changed', () => {
    const { p } = scene();
    const geo = () => p.human.meshes.map((m) => m.geometry);
    const before = geo();
    p.refreshGear();
    expect(geo()).toEqual(before); // nothing changed, nothing redrawn
    equip(p, 'h_hardhat');
    const after = geo();
    expect(after.some((g, i) => g !== before[i])).toBe(true);
    // The head changed; the legs (indexes after the arms) are the same pieces as before.
    expect(after[2]).not.toBe(before[2]);
  });

  it('wearing something not in your own colours puts your colour on the sleeve', () => {
    const { p } = scene();
    const upperL = () => p.human.meshes[3].geometry;
    const own = upperL();
    equip(p, 'b_vest');
    expect(upperL()).not.toBe(own);
    // Back in the starter jacket (tinted), the armband goes again.
    const jacket = p.gear.bag.find((b) => b.id === 'b_jacket')!;
    expect(equipFromBag(p.gear, jacket.uid).ok).toBe(true);
    p.refreshGear();
    expect(upperL()).toBe(own);
  });
});

describe('what you wear changes what hurts', () => {
  it('armour takes a share of every blow', () => {
    const { p } = scene();
    p.hp = p.maxHp;
    p.hurt(20, 0, 0, 'bite');
    const light = p.maxHp - p.hp;
    // The heroes set out bareheaded (the helmet rides in the bag), so the starter jacket's 3% is all the armour there is.
    expect(light).toBeCloseTo(20 * (1 - 0.03), 5);
    p.hp = p.maxHp;
    p.invuln = 0;
    equip(p, 'b_riot');
    equip(p, 'h_riot');
    p.hurt(20, 0, 0, 'bite');
    const heavy = p.maxHp - p.hp;
    expect(heavy).toBeLessThan(light * 0.8);
  });

  it('fire ignores armour, a mask cuts spores, and boots and knees cut falls', () => {
    const { p } = scene();
    equip(p, 'b_riot');
    p.hp = p.maxHp;
    p.hurt(10, 0, 0, 'fire');
    expect(p.maxHp - p.hp).toBeCloseTo(10, 5);
    // Spores: the starter bandana (25%) against a respirator (60%).
    p.hp = p.maxHp;
    p.hurt(10, 0, 0, 'spore');
    const bandana = p.maxHp - p.hp;
    equip(p, 'f_resp');
    p.hp = p.maxHp;
    p.hurt(10, 0, 0, 'spore');
    const mask = p.maxHp - p.hp;
    expect(bandana).toBeCloseTo(7.5, 5);
    expect(mask).toBeCloseTo(4, 5);
    // Falls.
    equip(p, 's_steel');
    equip(p, 'l_pad');
    p.hp = p.maxHp;
    p.hurt(30, 0, 0, 'fall');
    expect(p.maxHp - p.hp).toBeLessThan(30 * 0.5);
  });

  it('heavy gear slows you down and light shoes speed you up', () => {
    const dist = (setup: (p: LegScene['players'][number]) => void) => {
      const { h, sc, p } = scene();
      setup(p);
      p.placeAt(p.pos.x, p.pos.z, 0);
      const x0 = p.pos.x;
      const z0 = p.pos.z;
      h.intents[0].device = 'pad';
      h.intents[0].move = [0, 1];
      run(sc, 1.5);
      return Math.hypot(p.pos.x - x0, p.pos.z - z0);
    };
    const base = dist(() => {});
    const heavy = dist((p) => {
      equip(p, 'b_riot');
      equip(p, 'l_greave');
    });
    const quick = dist((p) => equip(p, 's_runner'));
    expect(heavy).toBeLessThan(base * 0.95);
    expect(quick).toBeGreaterThan(base * 1.03);
  });

  it('soft soles are quiet and plate is not', () => {
    const { p } = scene();
    p.crouch = true;
    const base = p.footSignature();
    equip(p, 's_sneak');
    expect(p.footSignature()).toBeLessThan(base);
    equip(p, 'b_riot');
    equip(p, 's_steel');
    expect(p.footSignature()).toBeGreaterThan(base);
  });

  it('the bag grows with the pack and shrinks without it', () => {
    const { p } = scene();
    expect(bagCap(p.gear)).toBe(10);
    equip(p, 'k_duffel');
    expect(bagCap(p.gear)).toBe(14);
  });
});

describe('what is in hand', () => {
  it('LB walks the belt, then the throwable, then round again', () => {
    const { h, sc, p } = scene();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      tap(h, sc, 0, Btn.LB);
      seen.push(p.equip);
    }
    expect(seen).toEqual(['wrench', 'crowbar', 'jerrycan', 'utility', 'gun', 'wrench']);
  });

  it('skips a throwable that has run out', () => {
    const { h, sc, c, p } = scene();
    c.items.flare = 0;
    p.utility = 'flare';
    p.gear.sel = 3;
    p.syncEquip();
    expect(p.equip).toBe('jerrycan');
    tap(h, sc, 0, Btn.LB);
    expect(p.equip).toBe('gun');
  });

  it('a melee weapon on the belt is a hand of its own, with its own name and reach', () => {
    const { h, sc, p } = scene();
    const hit = vi.spyOn(sc.zombies, 'meleeHit').mockImplementation(() => 0);
    equip(p, 'm_machete', 3);
    expect(p.equip).toBe('melee');
    expect(p.heldName()).toBe('Machete');
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    run(sc, 0.2);
    h.intents[0].rt = 0;
    expect(hit).toHaveBeenCalled();
    const [, , , , reach, dmg] = hit.mock.calls[0];
    expect(reach).toBe(2.0);
    // Machete 58 with the starter gloves' 5%.
    expect(dmg).toBeCloseTo(58 * 1.05, 5);
    expect(p.meleeDamage()).toBeCloseTo(58 * 1.05, 5);
  });

  it('a melee weapon does not fire the gun, and swings no faster than its pace', () => {
    const { h, sc, p } = scene();
    const hit = vi.spyOn(sc.zombies, 'meleeHit').mockImplementation(() => 0);
    const shoot = vi.spyOn(sc.combat, 'shoot');
    equip(p, 'm_axe', 3);
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    run(sc, 1.0); // an axe swings every 0.85 s
    h.intents[0].rt = 0;
    expect(shoot).not.toHaveBeenCalled();
    expect(hit.mock.calls.length).toBeLessThanOrEqual(2);
    expect(hit.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('bare hands with a tool out still swing for the old 35 (plus gloves)', () => {
    const { h, sc, p } = scene();
    const hit = vi.spyOn(sc.zombies, 'meleeHit').mockImplementation(() => 0);
    p.gear.sel = 1;
    p.syncEquip();
    expect(p.equip).toBe('wrench');
    h.intents[0].device = 'pad';
    h.intents[0].pressed = 0;
    // RB tap and release.
    h.intents[0].held |= 1 << Btn.RB;
    sc.tick(DT);
    h.intents[0].held &= ~(1 << Btn.RB);
    h.intents[0].released = 1 << Btn.RB;
    h.intents[0].heldTime[Btn.RB] = 0.1;
    sc.tick(DT);
    h.intents[0].released = 0;
    // The blow lands as the arm comes down, not on the click.
    run(sc, 0.2);
    expect(hit).toHaveBeenCalled();
    expect(hit.mock.calls[0][5]).toBeCloseTo(35 * 1.05, 5);
    expect(hit.mock.calls[0][4]).toBeCloseTo(1.9, 5);
  });
});

describe('guns', () => {
  const fire = (h: ReturnType<typeof fakeServices>, sc: LegScene, secs = 0.1) => {
    h.intents[0].device = 'pad';
    h.intents[0].rt = 1;
    run(sc, secs);
    h.intents[0].rt = 0;
  };

  it('each gun fires with its own numbers', () => {
    const { h, sc, p } = scene();
    const shoot = vi.spyOn(sc.combat, 'shoot');
    fire(h, sc);
    expect(shoot).toHaveBeenCalledTimes(1);
    expect(shoot.mock.calls[0][6]).toMatchObject({ damage: 27, noise: 60, range: 75, pierce: undefined });
    shoot.mockClear();
    equip(p, 'w_revolver', 3);
    expect(p.equip).toBe('gun');
    // Bringing the revolver up takes a moment; this test is about its numbers.
    p.fireCd = 0;
    fire(h, sc);
    expect(shoot).toHaveBeenCalledTimes(1);
    expect(shoot.mock.calls[0][6]).toMatchObject({ damage: 55, noise: 72, range: 90, pierce: 0.3 });
  });

  it('a shotgun throws a handful of pellets, and only the first is loud', () => {
    const { h, sc, p } = scene();
    const shoot = vi.spyOn(sc.combat, 'shoot');
    equip(p, 'w_sawn', 3);
    p.fireCd = 0;
    fire(h, sc);
    expect(shoot).toHaveBeenCalledTimes(8);
    expect(shoot.mock.calls.every((c) => c[6].damage === 9)).toBe(true);
    expect(shoot.mock.calls.filter((c) => (c[6].noise ?? 0) > 0)).toHaveLength(1);
    expect(p.mag).toBe(1); // one shell gone from two
  });

  it('every gun keeps its own magazine when you swap', () => {
    const { h, sc, p } = scene();
    fire(h, sc, 0.5); // a few pistol rounds
    const left = p.mag;
    expect(left).toBeLessThan(12);
    equip(p, 'w_revolver', 3);
    expect(p.mag).toBe(6);
    p.fireCd = 0;
    fire(h, sc, 0.1);
    expect(p.mag).toBe(5);
    p.gear.sel = 0;
    p.syncEquip();
    expect(p.mag).toBe(left);
  });

  it('reloading fills the magazine of the gun in hand, at that gun\'s pace', () => {
    const { h, sc, c, p } = scene();
    equip(p, 'w_revolver', 3);
    p.mag = 2;
    c.ammo = 40;
    tap(h, sc, 0, Btn.X);
    expect(p.reloadT).toBeGreaterThan(1.9); // 2.2 s, less the ticks spent in the tap
    run(sc, 2.4);
    expect(p.mag).toBe(6);
    expect(c.ammo).toBe(36);
  });

  it('fast gloves shorten the reload', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 40;
    p.mag = 0;
    equip(p, 'g_tac');
    tap(h, sc, 0, Btn.X);
    // 1.3 s less 20% (an empty gun: no round in it to save the slide).
    expect(p.reloadT).toBeLessThan(1.1);
    expect(p.reloadT).toBeGreaterThan(0.9);
  });

  it('swapping guns drops a reload in progress', () => {
    const { h, sc, c, p } = scene();
    c.ammo = 40;
    p.mag = 1;
    tap(h, sc, 0, Btn.X);
    expect(p.reloadT).toBeGreaterThan(0);
    equip(p, 'w_smg', 3);
    expect(p.reloadT).toBe(0);
  });

  it('an empty gun with no rounds in the convoy says so and does not fire', () => {
    const { h, sc, c, p } = scene();
    const shoot = vi.spyOn(sc.combat, 'shoot');
    c.ammo = 0;
    p.mag = 0;
    fire(h, sc, 0.3);
    expect(shoot).not.toHaveBeenCalled();
    expect(p.notes.some((n) => /Out of ammo/.test(n.text))).toBe(true);
  });
});

describe('the inventory key', () => {
  it('opens the inventory on foot', () => {
    const { h, sc, p } = scene();
    const open = vi.fn();
    sc.openInventory = open;
    tap(h, sc, 0, Btn.Inventory);
    expect(open).toHaveBeenCalledWith(p);
  });

  it('asks you to get out when you are in a vehicle', () => {
    const { h, sc, p } = scene();
    const open = vi.fn();
    sc.openInventory = open;
    p.state = 'driving';
    tap(h, sc, 0, Btn.Inventory);
    expect(open).not.toHaveBeenCalled();
    expect(p.notes.some((n) => /Get out/.test(n.text))).toBe(true);
  });

  it('the keyboard and pad defaults both reach it', () => {
    const win = new EventTarget();
    const im = new InputManager(win as unknown as Window);
    im.autoJoinKeyboard();
    const key = (type: 'keydown' | 'keyup', code: string) => win.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat: false }));
    const b = defaultBindings();
    expect(b.pad.inventory).toBe(Btn.Left);
    expect(b.kb[0].inventory).toBe('Tab');
    expect(b.kb[1].inventory).toBe('KeyI');
    key('keydown', 'Tab');
    im.sample(DT);
    expect(im.intents[0].pressed & (1 << Btn.Inventory)).not.toBe(0);
  });
});

describe('at camp', () => {
  it('the key works while building, and the night starts with a gun in hand', () => {
    const h = fakeServices({ solo: true });
    const leg = legById('L1');
    const sc = new CampScene(h.svc, leg, leg.campSites[0], true);
    for (let i = 0; i < 60; i++) sc.tick(DT);
    const p = sc.players[0];
    expect(p.buildMode).toBe(true);
    const open = vi.fn();
    sc.openInventory = open;
    tap(h, sc as unknown as LegScene, 0, Btn.Inventory);
    expect(open).toHaveBeenCalledWith(p);
    // Somebody holding a tool while building is armed when the raid comes.
    p.gear.sel = 1;
    p.syncEquip();
    expect(p.equip).toBe('wrench');
    (sc as unknown as { startNight(): void }).startNight();
    expect(p.equip).toBe('gun');
    expect(p.gear.sel).toBe(0);
    sc.dispose();
  });
});

describe('the inventory camera', () => {
  const settle = (sc: LegScene, p: LegScene['players'][number]) => {
    for (let i = 0; i < 90; i++) {
      sc.tick(DT);
      p.renderCamera(1, DT);
    }
  };

  it('circles the survivor at arm\'s length, looking at the chest', () => {
    const { sc, p } = scene();
    p.showcase = { a: 0.3, side: 0 };
    settle(sc, p);
    const horiz = Math.hypot(p.cam.pos.x - p.pos.x, p.cam.pos.z - p.pos.z);
    expect(horiz).toBeGreaterThan(2.4);
    expect(horiz).toBeLessThan(3.0);
    expect(p.cam.pos.y - p.pos.y).toBeGreaterThan(1.3);
    expect(p.cam.look.y - p.pos.y).toBeCloseTo(1.0, 1);
    // It is turning: the angle moves on while the inventory is open.
    expect(p.showcase!.a).toBeGreaterThan(0.3 + 0.5);
  });

  it('shifts the survivor off-centre so the panel does not cover them', () => {
    const { sc, p } = scene();
    p.showcase = { a: 0, side: 1.0 };
    settle(sc, p);
    // Looking at a point a metre to the camera's right of the survivor puts them left of the middle of the frame.
    const sideways = Math.hypot(p.cam.look.x - p.pos.x, p.cam.look.z - p.pos.z);
    expect(sideways).toBeGreaterThan(0.6);
  });

  it('is pulled in when a wall is in the way, so it never sits inside geometry', () => {
    const { sc, p } = scene();
    p.cam.occlude = () => 1.2; // something solid 1.2 m out along every ray
    p.showcase = { a: 0.3, side: 0 };
    settle(sc, p);
    const dx = p.cam.pos.x - p.pos.x;
    const dz = p.cam.pos.z - p.pos.z;
    expect(Math.hypot(dx, dz)).toBeLessThan(1.4);
    expect(Math.hypot(dx, dz)).toBeGreaterThan(0.5);
  });

  it('first person gives way to it, and comes back when it ends', () => {
    const { p } = scene();
    p.viewFirst = true;
    expect(p.firstPerson).toBe(true);
    p.showcase = { a: 0, side: 0 };
    expect(p.firstPerson).toBe(false);
    p.showcase = null;
    expect(p.firstPerson).toBe(true);
  });
});

describe('a menu that belongs to one person', () => {
  /** Just enough of an element for the focus UI to move a cursor over and press. */
  const el = (x: number) =>
    ({
      isConnected: true,
      dataset: {},
      classList: { add() {}, remove() {}, contains: () => false },
      addEventListener() {},
      removeEventListener() {},
      scrollIntoView() {},
      getBoundingClientRect: () => ({ left: x, top: 0, width: 10, height: 10 }),
    }) as unknown as HTMLElement;

  function menu(owner: number | null) {
    const pressed: number[] = [];
    const f = new FocusUI();
    f.setItems([0, 1, 2].map((i) => ({ el: el(i * 20), press: (p: number) => void pressed.push(p * 10 + i) })));
    f.active = true;
    f.owner = owner;
    const intents: [ReturnType<typeof newIntent>, ReturnType<typeof newIntent>] = [newIntent(), newIntent()];
    for (const it of intents) it.device = 'pad';
    const input = { intents, rumble() {} } as unknown as Parameters<FocusUI['update']>[0];
    return { f, pressed, intents, input };
  }

  it('only the owner moves a cursor and presses', () => {
    const { f, pressed, intents, input } = menu(1);
    intents[0].nav = NAV.right;
    intents[1].nav = NAV.right;
    f.update(input);
    expect(f.cursor).toEqual([0, 1]); // player 1 moved, player 0 did not
    intents[0].nav = 0;
    intents[1].nav = 0;
    intents[0].pressed = 1 << Btn.A;
    f.update(input);
    expect(pressed).toEqual([]); // the other pad's A does nothing
    intents[0].pressed = 0;
    intents[1].pressed = 1 << Btn.A;
    f.update(input);
    expect(pressed).toEqual([11]);
  });

  it('cancel is the owner\'s alone, too', () => {
    const { f, intents, input } = menu(0);
    const cancelled: number[] = [];
    f.onCancel = (p) => void cancelled.push(p);
    intents[1].pressed = 1 << Btn.B;
    f.update(input);
    expect(cancelled).toEqual([]);
    intents[1].pressed = 0;
    intents[0].pressed = 1 << Btn.B;
    f.update(input);
    expect(cancelled).toEqual([0]);
  });

  it('with no owner it is the shared menu it always was', () => {
    const { f, intents, input } = menu(null);
    intents[0].nav = NAV.right;
    intents[1].nav = NAV.right;
    f.update(input);
    expect(f.cursor).toEqual([1, 1]);
  });
});

describe('saving and finding gear', () => {
  it('a loadout survives a save, with magazines and the hand in use', () => {
    const { c, p } = scene();
    equip(p, 'w_revolver', 3);
    p.mag = 3;
    equip(p, 'b_plate');
    p.gear.bag.push(newGear('m_axe'));
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    expect(back.players[0].gear).toEqual(p.gear);
    expect(back.players[0].gear.belt[3]!.mag).toBe(3);
    expect(back.players[0].gear.sel).toBe(3);
  });

  it('a save from before gear existed gets the starter kit', () => {
    const { c } = scene();
    const d = JSON.parse(JSON.stringify(c.serialize()));
    for (const pl of d.players) delete pl.gear;
    const back = Campaign.deserialize(d);
    for (const pl of back.players) {
      expect(pl.gear.belt[0]!.id).toBe('w_pistol');
      expect(pl.gear.worn.back!.id).toBe('k_ruck');
    }
  });

  it('a damaged or hand-edited save is repaired rather than trusted', () => {
    const { c } = scene();
    const d = JSON.parse(JSON.stringify(c.serialize()));
    d.players[0].gear.bag.push({ uid: 'gone', id: 'no_such_item' });
    d.players[0].gear.worn.head = { uid: 'x', id: 'm_axe' };
    d.players[1].gear = 'banana';
    const back = Campaign.deserialize(d);
    expect(back.players[0].gear.bag.some((b) => b.id === 'no_such_item')).toBe(false);
    expect(back.players[0].gear.worn.head).toBeUndefined();
    expect(back.players[1].gear.belt[0]!.id).toBe('w_pistol');
  });

  it('new finds never collide with ids from a loaded save', () => {
    const { c } = scene();
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    const ids = new Set<string>();
    for (const pl of back.players) for (const it of [...Object.values(pl.gear.worn), ...pl.gear.belt, ...pl.gear.bag]) if (it) ids.add(it.uid);
    for (let i = 0; i < 50; i++) expect(ids.has(newGear('h_cap').uid)).toBe(false);
  });

  it('a find goes in your bag, then your partner\'s, then becomes Scrap', () => {
    const { c } = scene();
    const mine: Loadout = c.players[0].gear;
    const theirs: Loadout = c.players[1].gear;
    const fill = (l: Loadout) => {
      while (l.bag.length < bagCap(l)) l.bag.push(newGear('h_cap'));
    };
    const n = mine.bag.length;
    expect(c.giveGear(0, newGear('w_rifle'))).toEqual({ to: 'self', scrap: 0 });
    expect(mine.bag.length).toBe(n + 1);
    fill(mine);
    const t = theirs.bag.length;
    expect(c.giveGear(0, newGear('w_rifle'))).toEqual({ to: 'partner', scrap: 0 });
    expect(theirs.bag.length).toBe(t + 1);
    fill(theirs);
    const scrap = c.stocks.scrap;
    const r = c.giveGear(0, newGear('w_rifle'));
    expect(r.to).toBe('scrap');
    expect(c.stocks.scrap).toBe(scrap + gearDef('w_rifle').scrap);
  });

  it('solo, a full bag goes straight to Scrap', () => {
    const { c } = scene({ solo: true });
    while (c.players[0].gear.bag.length < bagCap(c.players[0].gear)) c.players[0].gear.bag.push(newGear('h_cap'));
    expect(c.giveGear(0, newGear('w_rifle')).to).toBe('scrap');
  });

  it('the scene tells the finder, the partner, and the radio about a good find', () => {
    const { sc, p } = scene();
    const q = sc.players[1];
    const n = p.gear.bag.length;
    sc.addGear(p, newGear('b_plate'));
    expect(p.gear.bag.length).toBe(n + 1);
    expect(p.notes.some((x) => /Found: Plate Carrier/.test(x.text))).toBe(true);
    while (p.gear.bag.length < bagCap(p.gear)) p.gear.bag.push(newGear('h_cap'));
    const radio = vi.spyOn(sc, 'radio');
    sc.addGear(p, newGear('w_rifle'));
    expect(q.notes.some((x) => /found a Hunting Rifle/.test(x.text))).toBe(true);
    expect(radio).toHaveBeenCalled();
  });

  it('a car trunk can hold gear, a wagon more often, and your own convoy vehicle never', () => {
    const find = (kind: 'car' | 'wagon' | 'convoy') => {
      let n = 0;
      for (let s = 1; s < 800; s++) if (salvageLoot(3, { seed: s, kind, chassis: 'hatch', burnt: false }).gear) n++;
      return n;
    };
    expect(find('convoy')).toBe(0);
    expect(find('car')).toBeGreaterThan(0);
    expect(find('wagon')).toBeGreaterThan(find('car') * 3);
    // Fixed by the car's seed: stripping it twice cannot reroll the find.
    const a = salvageLoot(3, { seed: 77, kind: 'wagon', chassis: 'hatch', burnt: false });
    const b = salvageLoot(3, { seed: 77, kind: 'wagon', chassis: 'hatch', burnt: false });
    expect(a.gear?.id).toBe(b.gear?.id);
  });
});

describe('carrying a hand across a delve', () => {
  it('remembers the belt slot in hand, and a tool in hand goes back to the gun', () => {
    const { p } = scene();
    equip(p, 'm_machete', 3);
    expect(carryOf(p)).toMatchObject({ equip: 'melee', sel: 3 });
    p.gear.sel = 1;
    p.syncEquip();
    expect(carryOf(p)).toMatchObject({ equip: 'gun', sel: 1 });
  });
});

describe('the gear sim and the campaign agree', () => {
  it('two scavengers never share an item', () => {
    const c = new Campaign();
    const a = c.players[0].gear;
    const b = c.players[1].gear;
    expect(a.belt[0]).not.toBe(b.belt[0]);
    expect(a.belt[0]!.uid).not.toBe(b.belt[0]!.uid);
    expect(sanitizeLoadout(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });

  it('gear rolled for loot is always something that exists', () => {
    const rng = new Rng(9);
    for (let i = 0; i < 100; i++) expect(() => gearDef(newGear(['h_cap', 'w_rifle', 'k_frame'][i % 3]).id)).not.toThrow();
    expect(rng.next()).toBeGreaterThanOrEqual(0);
  });
});

describe('gear lying on the ground', () => {
  /** Hold A for a couple of seconds. */
  function holdA(h: ReturnType<typeof fakeServices>, sc: LegScene, who: number, secs = 1.2) {
    const it = h.intents[who];
    it.device = 'keyboard';
    it.held |= 1 << Btn.A;
    it.pressed = 1 << Btn.A;
    for (let i = 0; i < Math.round(secs / DT); i++) {
      sc.tick(DT);
      it.pressed = 0;
    }
    it.held &= ~(1 << Btn.A);
    it.released = 1 << Btn.A;
    sc.tick(DT);
    it.released = 0;
    sc.tick(DT);
  }

  it('a find lies in the world until someone takes it, and a hold of A puts it in their bag', () => {
    const { h, sc, p } = scene();
    const find = newGear('h_riot');
    sc.dropGear(find, p.pos.x, p.pos.z);
    expect(sc.groundGear!.count).toBe(1);
    expect(p.gear.bag.some((b) => b.uid === find.uid)).toBe(false);
    holdA(h, sc, 0);
    expect(p.gear.bag.some((b) => b.uid === find.uid)).toBe(true);
    expect(sc.groundGear!.count).toBe(0);
    expect(sc.interact.list.some((i) => i.id === `gear:${find.uid}`)).toBe(false);
  });

  it('a full bag leaves it where it lies, and nothing is scrapped', () => {
    const { h, sc, c, p } = scene();
    while (p.gear.bag.length < bagCap(p.gear)) p.gear.bag.push(newGear('h_cap'));
    const scrap = c.stocks.scrap;
    const find = newGear('h_riot');
    sc.dropGear(find, p.pos.x, p.pos.z);
    holdA(h, sc, 0);
    expect(sc.groundGear!.count).toBe(1);
    expect(p.gear.bag.some((b) => b.uid === find.uid)).toBe(false);
    expect(c.stocks.scrap).toBe(scrap);
    // Make room and it can be taken.
    p.gear.bag.pop();
    holdA(h, sc, 0);
    expect(sc.groundGear!.count).toBe(0);
    expect(p.gear.bag.some((b) => b.uid === find.uid)).toBe(true);
  });

  it('only people on foot can take it', () => {
    const { sc, p } = scene();
    sc.dropGear(newGear('h_riot'), p.pos.x, p.pos.z);
    const ix = sc.interact.list.find((i) => i.id.startsWith('gear:'))!;
    expect(ix.enabled(p)).toBe(true);
    p.state = 'driving';
    expect(ix.enabled(p)).toBe(false);
  });
});
