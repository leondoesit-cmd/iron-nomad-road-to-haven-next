import { beforeAll, describe, expect, it } from 'vitest';
import { Btn, NAV, type PlayerIntent } from '../src/input/intents';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { newGear, UTILITY_SLOT } from '../src/sim/gear';
import { openQuickWheel, takeWheel, wheelRows, wheelSel } from '../src/game/quickWheel';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  for (const p of sc.players) p.exitVehicle(false);
  run(sc, 0.6);
  return { sc, ...h };
}
type H = ReturnType<typeof leg>;

/** Buttons the test keeps down: the sim strips what it uses from the intent, the input manager rebuilds it every tick. */
const down = new Map<PlayerIntent, number>();
function tick(h: H, it: PlayerIntent) {
  it.held |= down.get(it) ?? 0;
  h.sc.tick(DT);
}
/** Press a button down, keep it down for `secs`, and (unless `keep`) let it go. */
function hold(h: H, it: PlayerIntent, btn: number, secs: number, keep = false) {
  it.pressed |= 1 << btn;
  down.set(it, (down.get(it) ?? 0) | (1 << btn));
  tick(h, it);
  it.pressed &= ~(1 << btn);
  for (let t = 0; t < secs; t += DT) tick(h, it);
  if (!keep) release(h, it, btn);
}
function release(h: H, it: PlayerIntent, btn: number) {
  down.set(it, (down.get(it) ?? 0) & ~(1 << btn));
  it.held &= ~(1 << btn);
  it.released |= 1 << btn;
  h.sc.tick(DT);
  it.released &= ~(1 << btn);
}
function tap(h: H, it: PlayerIntent, btn: number) {
  hold(h, it, btn, 0.05);
}
function nav(h: H, it: PlayerIntent, dir: number) {
  it.nav = dir;
  tick(h, it);
  it.nav = 0;
  tick(h, it);
}

describe('quick select wheel', () => {
  it('sorts what you carry into weapons, tools, health and drugs', () => {
    const h = leg();
    const p = h.sc.players[0];
    p.gear.bag.push(newGear('w_rifle'), newGear('m_axe'));
    h.campaign.items.painkiller = 2;
    h.campaign.items.stim = 0;
    h.campaign.items.molotov = 1;
    h.campaign.items.flare = 0;
    const [weapons, tools, health, drugs] = wheelRows(p).map((r) => r.map((e) => e.id));
    // The belt first, then the throwables, then the bag.
    expect(weapons.slice(0, 2)).toEqual(['w_pistol', 'molotov']);
    expect(weapons.slice(-2)).toEqual(['w_rifle', 'm_axe']);
    expect(tools).toEqual(['t_wrench', 't_crowbar', 't_jerrycan', 'horn']);
    expect(health).toEqual(['bandage', 'medkit', 'eat', 'drink', 'piss', 'shit']);
    expect(drugs).toContain('painkiller');
    expect(drugs).not.toContain('stim');
    h.sc.dispose();
  }, 60000);

  it('a pad: hold a D-pad direction to open that arm, steer with the D-pad, A takes', () => {
    const h = leg();
    const p = h.sc.players[0];
    const it = h.intents[0];
    it.device = 'pad';
    h.campaign.items.bandage = 3;
    // Hold down: the health arm. Let go without choosing and it stays open for the D-pad, having used nothing.
    hold(h, it, Btn.Down, 0.4, true);
    expect(p.quickWheel.open).toBe(true);
    expect(p.quickWheel.arm).toBe(2);
    expect(p.beltOpen).toBe(false);
    release(h, it, Btn.Down);
    expect(p.quickWheel.open).toBe(true);
    expect(h.campaign.items.bandage).toBe(3);
    // Up: the weapons arm, resting on the gun in hand.
    tap(h, it, Btn.Up);
    expect(p.quickWheel.arm).toBe(0);
    // Right: the tools, then right again steps to the next tool. A takes it.
    tap(h, it, Btn.Map);
    expect(p.quickWheel.arm).toBe(1);
    expect(wheelSel(p.quickWheel)!.id).toBe('t_wrench');
    tap(h, it, Btn.Map);
    expect(wheelSel(p.quickWheel)!.id).toBe('t_crowbar');
    tap(h, it, Btn.A);
    expect(p.quickWheel.open).toBe(false);
    expect(p.equip).toBe('crowbar');
    // The A that took it did not also jump or interact, and B closes without taking.
    hold(h, it, Btn.Inventory, 0.4);
    expect(p.quickWheel.arm).toBe(3);
    tap(h, it, Btn.B);
    expect(p.quickWheel.open).toBe(false);
    expect(p.crouch).toBe(false);
    h.sc.dispose();
  }, 60000);

  it('a pad: taps keep their jobs, and land on the release', () => {
    const h = leg();
    const p = h.sc.players[0];
    const it = h.intents[0];
    it.device = 'pad';
    h.campaign.items.bandage = 2;
    p.hp = 50;
    p.setQuick('bandage');
    tap(h, it, Btn.Down);
    expect(p.quickWheel.open).toBe(false);
    expect(h.campaign.items.bandage).toBe(1);
    // LB swaps when it is let go, so a hold can be the crew orders instead.
    const sel = p.gear.sel;
    hold(h, it, Btn.LB, 0.05, true);
    expect(p.gear.sel).toBe(sel);
    release(h, it, Btn.LB);
    expect(p.gear.sel).not.toBe(sel);
    const after = p.gear.sel;
    hold(h, it, Btn.LB, 0.6);
    expect(p.gear.sel).toBe(after);
    h.sc.dispose();
  }, 60000);

  it('keys: hold Q for the wheel, move keys to choose, let go of Q to take; a tap still swaps', () => {
    const h = leg();
    const p = h.sc.players[0];
    const it = h.intents[0];
    it.device = 'keyboard';
    p.gear.sel = 0;
    p.syncEquip();
    expect(p.equip).toBe('gun');
    tap(h, it, Btn.LB);
    expect(p.gear.sel).toBe(1);
    p.gear.sel = 0;
    p.syncEquip();
    hold(h, it, Btn.LB, 0.35, true);
    expect(p.quickWheel.open).toBe(true);
    expect(p.quickWheel.arm).toBe(0);
    // The move keys choose instead of walking.
    it.move = [0, 1];
    nav(h, it, NAV.right);
    expect(p.quickWheel.arm).toBe(1);
    nav(h, it, NAV.right);
    nav(h, it, NAV.right);
    expect(wheelSel(p.quickWheel)!.id).toBe('t_jerrycan');
    expect(p.moveSpeed).toBeLessThan(0.5);
    it.move = [0, 0];
    release(h, it, Btn.LB);
    expect(p.quickWheel.open).toBe(false);
    expect(p.equip).toBe('jerrycan');
    // Letting go without choosing changes nothing.
    hold(h, it, Btn.LB, 0.35);
    expect(p.quickWheel.open).toBe(false);
    expect(p.equip).toBe('jerrycan');
    h.sc.dispose();
  }, 60000);

  it('takes from the bag onto the belt, throwables into the hand, and doses straight away', () => {
    const h = leg();
    const p = h.sc.players[0];
    p.gear.sel = 0;
    p.syncEquip();
    p.gear.bag.push(newGear('w_rifle'));
    h.campaign.items.molotov = 2;
    h.campaign.items.painkiller = 1;
    expect(openQuickWheel(p, 0)).toBe(true);
    const rifle = p.quickWheel.rows[0].find((e) => e.id === 'w_rifle')!;
    takeWheel(p, rifle);
    // The rifle takes the pistol's place in hand; the pistol goes in the bag.
    expect(p.gear.belt[0]!.id).toBe('w_rifle');
    expect(p.gear.bag.some((b) => b.id === 'w_pistol')).toBe(true);
    expect(p.equip).toBe('gun');
    // A tool from the bag never pushes the last weapon off the belt.
    p.gear.bag.push(newGear('t_wrench'));
    const wrench2 = wheelRows(p)[1].find((e) => e.kind === 'bag')!;
    takeWheel(p, wrench2);
    expect(p.gear.belt.some((b) => b && b.id === 'w_rifle')).toBe(true);
    takeWheel(p, wheelRows(p)[0].find((e) => e.id === 'molotov')!);
    expect(p.gear.sel).toBe(UTILITY_SLOT);
    expect(p.utility).toBe('molotov');
    takeWheel(p, wheelRows(p)[3].find((e) => e.id === 'painkiller')!);
    expect(h.campaign.items.painkiller).toBe(0);
    h.sc.dispose();
  }, 60000);
});
