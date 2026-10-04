import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { Btn } from '../src/input/intents';
import { InputManager } from '../src/input/input';
import { Campaign } from '../src/game/campaign';
import { LegScene } from '../src/game/legScene';
import { CampScene } from '../src/game/campScene';
import { DelveScene, carryOf, newDelveRecord } from '../src/game/delveScene';
import type { DelveSite } from '../src/world/delveSites';
import type { SceneResult } from '../src/game/scene';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

describe('solo campaign', () => {
  it('has one seat, one starting moped and one active build', () => {
    const c = new Campaign(undefined, true);
    expect(c.solo).toBe(true);
    expect(c.count).toBe(1);
    expect(c.garage).toHaveLength(1);
    expect(c.activeBuilds()).toEqual([c.garage[0]]);
    expect(c.inventoryCap).toBeGreaterThan(0);
  });

  it('keeps two seats by default', () => {
    const c = new Campaign();
    expect(c.solo).toBe(false);
    expect(c.count).toBe(2);
    expect(c.garage).toHaveLength(2);
    expect(c.activeBuilds()).toHaveLength(2);
  });

  it('survives a save and load, and old saves without the flag load as two players', () => {
    const c = new Campaign(undefined, true);
    c.day = 3;
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    expect(back.solo).toBe(true);
    expect(back.count).toBe(1);
    expect(back.day).toBe(3);
    expect(back.garage).toHaveLength(1);
    expect(back.buildOf(0).uid).toBe(c.garage[0].uid);

    const old = JSON.parse(JSON.stringify(new Campaign().serialize()));
    delete old.solo;
    const two = Campaign.deserialize(old);
    expect(two.solo).toBe(false);
    expect(two.activeBuilds()).toHaveLength(2);
  });

  it('does not make the garage assign a second vehicle or trim the only one', () => {
    const c = new Campaign(undefined, true);
    c.settleActives();
    expect(c.garage).toHaveLength(1);
    expect(c.trimGarage()).toEqual([]);
    expect(c.garage).toHaveLength(1);
  });
});

describe('solo input seats', () => {
  const kb = () => {
    const win = new EventTarget();
    const im = new InputManager(win as unknown as Window);
    const down = (code: string) => win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code }));
    return { im, down };
  };

  it('seats the first keyboard layout pressed, either one, and nobody after', () => {
    const { im, down } = kb();
    im.setSeats(1);
    down('ShiftRight');
    im.pollJoin();
    expect(im.slots).toEqual([{ kind: 'kb', set: 2 }, null]);
    down('KeyT');
    im.pollJoin();
    expect(im.slots).toEqual([{ kind: 'kb', set: 2 }, null]);
    expect(im.joined).toBe(1);
  });

  it('seats a gamepad in the first seat and refuses a second pad', () => {
    const { im } = kb();
    im.setSeats(1);
    const pad = (index: number) => ({ index, connected: true, mapping: 'standard', buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === Btn.A, value: 0 })), axes: [0, 0, 0, 0] }) as unknown as Gamepad;
    im.mockPads = [pad(0), pad(1)];
    im.pollJoin();
    expect(im.slots[0]).toEqual({ kind: 'pad', index: 0 });
    expect(im.slots[1]).toBeNull();
  });

  it('going solo keeps the first device and frees the second', () => {
    const { im } = kb();
    im.autoJoinKeyboard();
    im.setSeats(1);
    expect(im.slots).toEqual([{ kind: 'kb', set: 1 }, null]);
    const b = kb().im;
    b.slots[1] = { kind: 'kb', set: 2 };
    b.setSeats(1);
    expect(b.slots).toEqual([{ kind: 'kb', set: 2 }, null]);
    b.setSeats(2);
    b.autoJoinKeyboard();
    expect(b.joined).toBe(2);
  });

  it('autoJoinKeyboard fills one seat when solo', () => {
    const { im } = kb();
    im.setSeats(1);
    im.autoJoinKeyboard();
    expect(im.joined).toBe(1);
  });
});

function soloLeg() {
  const h = fakeServices({ solo: true });
  const results: SceneResult[] = [];
  const sc = new LegScene(h.svc, legById('L1'));
  sc.onResult = (r) => results.push(r);
  return { sc, results, ...h };
}

describe('a solo leg, run headless', () => {
  it('has one player in one vehicle, centred, with no partner and no tether gap', () => {
    const { sc } = soloLeg();
    expect(sc.players).toHaveLength(1);
    expect(sc.vehicles.filter((v) => v.faction === 'convoy' && v.kind === 'player')).toHaveLength(1);
    const p = sc.players[0];
    expect(p.partner).toBeUndefined();
    expect(p.vehicle).not.toBeNull();
    run(sc, 3);
    expect(sc.gap).toBe(0);
    expect(p.vehicle!.tetherPower).toBe(1);
    expect(p.vehicle!.tetherTop).toBe(1);
    expect(sc.visibleToAnyView(p.pos.x, p.pos.y, p.pos.z)).toBeTypeOf('boolean');
    sc.dispose();
  }, 60000);

  it('does not end the run just because the lone player is downed: a medkit gets them up', () => {
    const { sc, results, campaign, intents } = soloLeg();
    const p = sc.players[0];
    p.exitVehicle(false);
    run(sc, 0.5);
    campaign.items.medkit = 1;
    p.hurt(1000, p.pos.x + 1, p.pos.z, 'bite');
    run(sc, 0.2);
    expect(p.state).toBe('downed');
    // Past the point where a partner-less "everyone down" check would have failed the run.
    run(sc, 3);
    expect(results.filter((r) => r.type === 'fail')).toHaveLength(0);
    expect(p.state).toBe('downed');
    // Hold A: the medkit is used.
    intents[0].held |= 1 << Btn.A;
    run(sc, 4);
    intents[0].held &= ~(1 << Btn.A);
    expect(p.state).toBe('foot');
    expect(campaign.items.medkit).toBe(0);
    expect(campaign.stats.revives[0]).toBe(1);
    expect(results.filter((r) => r.type === 'fail')).toHaveLength(0);
    sc.dispose();
  }, 60000);

  it('fails the run when the lone player bleeds out with no medkit', () => {
    const { sc, results, campaign } = soloLeg();
    const p = sc.players[0];
    p.exitVehicle(false);
    run(sc, 0.5);
    campaign.items.medkit = 0;
    p.hurt(1000, p.pos.x + 1, p.pos.z, 'bite');
    run(sc, 2);
    expect(results.filter((r) => r.type === 'fail')).toHaveLength(0);
    run(sc, 40);
    const fails = results.filter((r): r is Extract<SceneResult, { type: 'fail' }> => r.type === 'fail');
    expect(fails).toHaveLength(1);
    expect(fails[0].reason).toMatch(/bled out/i);
    sc.dispose();
  }, 60000);
});

describe('a solo camp, run headless', () => {
  it('has one player, who can be ready alone, and does not fail while merely downed', () => {
    const h = fakeServices({ solo: true });
    const results: SceneResult[] = [];
    const leg = legById('L1');
    const sc = new CampScene(h.svc, leg, leg.campSites[0], true);
    sc.onResult = (r) => results.push(r);
    expect(sc.players).toHaveLength(1);
    run(sc, 2);
    sc.players[0].hurt(1000, 0, 0, 'bite');
    run(sc, 3);
    expect(sc.players[0].state).toBe('downed');
    expect(results.filter((r) => r.type === 'fail')).toHaveLength(0);
    sc.dispose();
  }, 60000);
});

describe('a solo delve, run headless', () => {
  it('goes down with one person, and being carried out follows from bleeding out alone', () => {
    const h = fakeServices({ solo: true });
    const parent = new LegScene(h.svc, legById('L1'));
    parent.suspend();
    const site: DelveSite = { id: 'T:solo', theme: 'bunker', x: 0, z: 0, yaw: 0, seed: 123, name: 'Test Bunker', tier: 2, island: false };
    const d = new DelveScene(h.svc, parent.leg, site, newDelveRecord(), parent.players.map(carryOf));
    const exits: string[] = [];
    d.onResult = (r) => exits.push(r.type === 'delveExit' ? r.reason : r.type);
    run(d, 2);
    expect(d.players).toHaveLength(1);
    // Merely downed: not carried out yet.
    d.players[0].hurt(1000, 0, 0, 'bite');
    run(d, 3);
    expect(d.players[0].state).toBe('downed');
    expect(exits).toEqual([]);
    // Bled out: carried out.
    h.campaign.items.medkit = 0;
    run(d, 40);
    expect(exits).toEqual(['rescue']);
    d.dispose();
    parent.dispose();
  }, 90000);
});
