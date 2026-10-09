import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { PARTS, legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { CampScene } from '../src/game/campScene';
import { WorldMemory } from '../src/game/worldMemory';
import { Campaign } from '../src/game/campaign';
import { Game } from '../src/game/game';
import { STOP_PROMPT } from '../src/game/nightfall';
import { grantNightHaul } from '../src/game/nightHaul';
import { DAWN_AT, DayClock, PREDAWN_AT, lightAt } from '../src/sim/dayclock';
import { KIT_SLOTS, haulPool, rollNightHaul, type HaulOpts } from '../src/sim/nightHaul';
import { newPart } from '../src/sim/parts';
import { loadCampaign } from '../src/save/save';
import { TUNING } from '../src/sim/tuning';
import type { SceneResult } from '../src/game/scene';
import { fakeServices, run } from './helpers/sim';

// Real open-world scenes in Node.
vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

afterEach(() => vi.unstubAllGlobals());

const W = legById('W');

function open(nightCamp = false) {
  const h = fakeServices();
  (h.svc as { nightCamp?: () => boolean }).nightCamp = () => nightCamp;
  const results: SceneResult[] = [];
  const sc = new LegScene(h.svc, W, { memory: new WorldMemory() });
  sc.onResult = (r) => results.push(r);
  return { h, sc, results };
}

/** Player 0 out of the car and on foot where they are. */
function onFoot(sc: LegScene) {
  const p = sc.players[0];
  p.exitVehicle(false);
  return p;
}

// ----------------------------------------------------------------------------------------------- the clock

describe('the clock through a night on the road', () => {
  it('greys toward the next morning, so the turnover at dawn does not jump', () => {
    for (const biome of ['wasteland', 'city'] as const) {
      const end = lightAt(DAWN_AT - 1e-6, biome);
      const next = lightAt(0, biome);
      expect(end.night).toBeCloseTo(next.night, 4);
      expect(end.sunIntensity).toBeCloseTo(next.sunIntensity, 3);
      for (let k = 0; k < 3; k++) expect(end.sky[k]).toBeCloseTo(next.sky[k], 3);
      // Full dark until the grey starts, and no step where it does.
      expect(lightAt(1.15, biome).night).toBeCloseTo(1, 3);
      expect(lightAt(PREDAWN_AT - 1e-6, biome).night).toBeCloseTo(lightAt(PREDAWN_AT + 1e-6, biome).night, 4);
    }
  });

  it('a new day starts at first light with the heads-up and the Bell still to come', () => {
    const c = new DayClock(720, 0.1);
    c.elapsed = 1.3 * 720;
    c.tick(0);
    expect(c.bellRung).toBe(true);
    expect(c.secondsToDawn).toBeCloseTo((DAWN_AT - 1.3) * 720, 3);
    c.newDay();
    expect(c.t).toBe(0);
    expect(c.bellRung).toBe(false);
    expect(c.warned).toBe(false);
  });
});

// ----------------------------------------------------------------------------------------------- the open world

describe('night camp off (the default)', () => {
  it('the Bell calls no camp, the night is played out, and the morning comes on the road', () => {
    const { h, sc, results } = open();
    expect(sc.freeNight).toBe(true);
    const L = sc.clock.dayLength;
    sc.clock.elapsed = 0.73 * L;
    run(sc, 1);
    expect(sc.clock.bellRung).toBe(true);
    expect(h.radio.some((r) => /push on with the lights/.test(r))).toBe(true);
    // Past the old forced camp (1.06) nothing happens by itself.
    sc.clock.elapsed = 1.08 * L;
    run(sc, 1.5);
    expect(results.some((r) => r.type === 'dusk')).toBe(false);
    expect(sc.night).toBeGreaterThan(0.9);
    // And at the end of the dark it is the next morning, in the same scene.
    sc.clock.elapsed = (DAWN_AT - 0.0005) * L;
    run(sc, 1);
    expect(results.map((r) => r.type)).toEqual(['dawn']);
    expect(sc.clock.t).toBeLessThan(0.01);
    expect(sc.clock.bellRung).toBe(false);
    expect(sc.campaign.day).toBe(2);
    expect(sc.campaign.stats.nights).toBe(1);
    expect(h.banners).toContain('DAWN | Day 2');
    expect(h.radio.some((r) => /First light\. Day 2/.test(r))).toBe(true);
    // The next day has its own Bell.
    sc.clock.elapsed = 0.73 * L;
    run(sc, 0.5);
    expect(sc.clock.bellRung).toBe(true);
    expect(results.some((r) => r.type === 'dusk')).toBe(false);
    sc.dispose();
  });

  it('a morning on the road writes where the convoy stands, without putting anything away', () => {
    const { sc } = open();
    run(sc, 1);
    const live = sc.vehicles.length;
    const m = new WorldMemory();
    sc.snapshot(m);
    const v = sc.players[0].vehicle!;
    expect(m.camp).not.toBeNull();
    expect(Math.hypot(m.camp!.x - v.position.x, m.camp!.z - v.position.z)).toBeLessThan(0.01);
    expect(sc.vehicles.length).toBe(live);
    sc.dispose();
  });

  it('the hold after the Bell is the night\'s choice, and it waits while something is hunting you', () => {
    const { sc, results } = open();
    sc.clock.elapsed = 0.73 * sc.clock.dayLength;
    run(sc, 0.5);
    const p = onFoot(sc);
    run(sc, 0.2);
    const prompt = sc.interact.list.find((i) => i.id === 'camp:0')!;
    expect(prompt.enabled(p)).toBe(true);
    expect(prompt.prompt).toBe(STOP_PROMPT.stop);
    // One of the dead after you, close by: no stopping here.
    const zb = sc.zombies.spawn('walker', p.pos.x + 9, p.pos.z, false);
    zb.state = 'chase';
    run(sc, 0.25);
    expect(prompt.prompt).toBe(STOP_PROMPT.hostile);
    expect(prompt.onTick!(p, 0)).toBe(false);
    zb.dead = true;
    run(sc, 0.25);
    expect(prompt.prompt).toBe(STOP_PROMPT.stop);
    expect(prompt.onTick!(p, 0)).toBe(true);
    prompt.run(p);
    expect(results).toEqual([{ type: 'dusk', free: true }]);
    expect(sc.campPose).not.toBeNull();
    // Carry on: back on the road, and the prompt is there again.
    sc.resumeAfterNight();
    expect(sc.pendingResult).toBe(false);
    expect(sc.campPose).toBeNull();
    expect(prompt.enabled(p)).toBe(true);
    sc.dispose();
  });

  it('training keeps its camp lesson whatever the setting', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, W, { memory: new WorldMemory(), training: true });
    expect(sc.freeNight).toBe(false);
    run(sc, 0.2);
    expect(sc.interact.list.find((i) => i.id === 'camp:0')!.prompt).toBe(STOP_PROMPT.camp);
    sc.dispose();
  });
});

describe('night camp on', () => {
  it('the Bell calls a camp vote, and past dark the convoy stops where it is, as before', () => {
    const { sc, results } = open(true);
    expect(sc.freeNight).toBe(false);
    sc.clock.elapsed = 1.07 * sc.clock.dayLength;
    run(sc, 0.5);
    expect(results).toEqual([{ type: 'dusk', free: false }]);
    sc.dispose();
  });
});

// ----------------------------------------------------------------------------------------------- the game's flow

/** A Game with the real flow (scenes, camp, Ledger, saves) and stand-ins for the screen. */
function flowGame(nightCamp = false) {
  const h = fakeServices();
  const ui = {
    choice: null as null | ((c: 'rest' | 'camp' | 'go') => void),
    camp: null as null | ((siteId: string, hot: boolean) => void),
    report: null as null | (() => void),
    ledger: null as null | ((next: string) => void),
  };
  const noop = () => {};
  const g = Object.create(Game.prototype) as Game;
  Object.assign(g, {
    R: Object.assign(h.R, { resize: noop, setSeats: noop }),
    audio: h.svc.audio,
    input: Object.assign(h.svc.input, { autoJoinKeyboard: noop, setSeats: noop }),
    campaign: h.campaign,
    hud: { showSub: noop, showTip: noop, showBanner: noop, setVisible: noop, setSeats: noop },
    storyVoice: { speak: noop, stop: noop, volume: 1 },
    focus: { active: false, seats: 2 },
    overlays: {
      hideAll: noop,
      pauseFocus: { seats: 2 },
      showNightChoice: (done: typeof ui.choice) => (ui.choice = done),
      showCampDecision: (_leg: unknown, done: typeof ui.camp) => (ui.camp = done),
      showReport: (_camp: unknown, done: typeof ui.report) => (ui.report = done),
      showLedger: (_camp: unknown, depart: typeof ui.ledger) => (ui.ledger = depart),
    },
    nightFade: { show: noop, hide: noop, clear: noop },
    world: new WorldMemory(),
    nightCamp,
    godMode: false,
    solo: false,
    phase: 'title',
    paused: false,
    scene: null,
    tutorial: null,
    delveParent: null,
    attract: false,
    resting: null,
    startLock: 0,
    resumeLock: 0,
    // The loading veil (async in the game: paint, prepare, build, compile) builds at once here, as tests and tooling expect.
    load: (_label: string, work: () => void) => (work(), true),
  });
  g.beginLeg('W');
  return { g, h, ui, tickRest: (s: number) => (g as unknown as { tickRest(s: number): void }).tickRest(s) };
}

/** Ring the Bell, step out, and hold the stop prompt. */
function stopForNight(g: Game) {
  const sc = g.scene as LegScene;
  sc.clock.elapsed = 0.73 * sc.clock.dayLength;
  run(sc, 0.5);
  const p = onFoot(sc);
  run(sc, 0.2);
  sc.interact.list.find((i) => i.id === 'camp:0')!.run(p);
  return sc;
}

describe('the night in the game', () => {
  it('Rest until dawn: a quiet dawn report, then the Ledger, then the next day from where the convoy rested', () => {
    const { g, ui, tickRest } = flowGame();
    const sc = stopForNight(g);
    const pose = { ...sc.campPose! };
    expect(ui.choice).toBeTruthy();
    ui.choice!('rest');
    expect(g.phase).toBe('vote');
    tickRest(0.5);
    expect(g.scene).toBe(sc);
    tickRest(1);
    const camp = g.scene as CampScene;
    expect(camp).toBeInstanceOf(CampScene);
    expect(g.phase).toBe('report');
    expect(camp.report.lines[0]).toMatch(/no raid came/);
    expect(camp.report.haul ?? []).toEqual([]);
    expect(camp.haul).toBeNull();
    expect(g.campaign.stats.nights).toBe(1);
    // Nobody looks through their own eyes at the dawn camp: it is a picture of the convoy.
    expect(camp.players.every((p) => !p.firstPerson)).toBe(true);
    ui.report!();
    expect(g.phase).toBe('ledger');
    expect(ui.ledger).toBeTruthy();
    expect(loadCampaign()?.flags.savedOnRoad).toBeFalsy();
    ui.ledger!('W');
    expect(g.campaign.day).toBe(2);
    const next = g.scene as LegScene;
    expect(next).toBeInstanceOf(LegScene);
    expect(next).not.toBe(sc);
    const v = next.players[0].vehicle ?? next.players[0].ownVehicle!;
    expect(Math.hypot(v.position.x - pose.x, v.position.z - pose.z)).toBeLessThan(100);
    next.dispose();
  });

  it('Keep moving: back on the road with nothing changed', () => {
    const { g, ui } = flowGame();
    const sc = stopForNight(g);
    ui.choice!('go');
    expect(g.phase).toBe('leg');
    expect(g.scene).toBe(sc);
    expect(sc.paused).toBe(false);
    expect(sc.pendingResult).toBe(false);
    sc.dispose();
  });

  it('a night played out on the road is saved at dawn, and Continue carries on from the road', () => {
    const { g } = flowGame();
    const sc = g.scene as LegScene;
    run(sc, 0.5);
    sc.clock.elapsed = (DAWN_AT - 0.0005) * sc.clock.dayLength;
    run(sc, 1);
    expect(g.campaign.day).toBe(2);
    const saved = loadCampaign()!;
    expect(saved.day).toBe(2);
    expect(saved.flags.savedOnRoad).toBe(true);
    const v = sc.players[0].vehicle!;
    expect(Math.hypot(saved.worldSave!.camp!.x - v.position.x, saved.worldSave!.camp!.z - v.position.z)).toBeLessThan(1);
    // Continue: straight back onto the road, the same day, not the Ledger.
    g.continueGame();
    expect(g.phase).toBe('leg');
    expect(g.scene).toBeInstanceOf(LegScene);
    expect(g.campaign.day).toBe(2);
    (g.scene as LegScene).dispose();
  });

  it('Make camp still works end to end: site vote, build, the raid, dawn with the night\'s haul, the Ledger', () => {
    const { g, ui } = flowGame();
    stopForNight(g);
    ui.choice!('camp');
    expect(ui.camp).toBeTruthy();
    const ammo0 = g.campaign.ammo;
    const inv0 = g.campaign.inventory.length;
    ui.camp!('flats', true);
    const camp = g.scene as CampScene;
    expect(camp).toBeInstanceOf(CampScene);
    expect(camp.phase).toBe('build');
    expect(camp.players[0].buildMode).toBe(true);
    // Everyone ready: night falls.
    camp.ready = [true, true];
    run(camp, 0.2);
    expect(camp.phase).toBe('night');
    // The third wave is down and the camp is quiet: dawn follows by itself.
    const c = camp as unknown as { waveIdx: number; waveActive: boolean; waveT: number; waveCleared: number };
    c.waveIdx = 2;
    c.waveActive = true;
    c.waveT = 30;
    c.waveCleared = 2;
    for (const z of camp.zombies.list) z.dead = true;
    camp.zombies.list.length = 0;
    camp.raiders.clearAll();
    run(camp, 0.2);
    expect(g.phase).toBe('report');
    expect(camp.haul).not.toBeNull();
    const haul = camp.haul!;
    expect(haul.roll.grade).toBe('full');
    expect(camp.report.haul!.length).toBeGreaterThanOrEqual(3);
    expect(g.campaign.ammo).toBe(ammo0 + haul.roll.ammo);
    expect(haul.part).not.toBeNull();
    expect(g.campaign.inventory.length).toBe(inv0 + 1);
    expect(camp.report.haul!.some((l) => l.includes(PARTS.parts.find((p) => p.id === haul.part!.id)!.name))).toBe(true);
    ui.report!();
    expect(g.phase).toBe('ledger');
    ui.ledger!('W');
    expect(g.campaign.day).toBe(2);
    (g.scene as LegScene).dispose();
  });

  it('Haven is a rest when night camp is off', () => {
    const { g, tickRest } = flowGame();
    const sc = g.scene as LegScene;
    const end = sc.src.layout.end;
    for (const p of sc.players) p.vehicle!.body.setPose(end.x, sc.groundAt(end.x, end.z) + 1.2, end.z, 0);
    run(sc, 3);
    expect(g.phase).toBe('vote');
    tickRest(2);
    expect(g.scene).toBeInstanceOf(CampScene);
    expect((g.scene as CampScene).report.lines[0]).toMatch(/no raid came/);
    (g.scene as CampScene).dispose();
  });
});

// ----------------------------------------------------------------------------------------------- the haul

const opts = (o: Partial<HaulOpts> = {}): HaulOpts => ({ seed: 4242, day: 3, grade: 'full', waves: 3, mags: 40, bow: false, have: new Set(), ...o });

describe("the night's haul", () => {
  it('is the same for the same night, and a full night brings ammunition, a part and medicine', () => {
    const a = rollNightHaul(opts());
    const b = rollNightHaul(opts());
    expect(a).toEqual(b);
    expect(a.ammo).toBeGreaterThan(40);
    expect(a.part).not.toBeNull();
    expect(a.extra).not.toBeNull();
    expect(a.arrows).toBe(0);
    expect(rollNightHaul(opts({ bow: true })).arrows).toBeGreaterThan(0);
    // Another night, another haul.
    const days = new Set(Array.from({ length: 12 }, (_, d) => rollNightHaul(opts({ day: d + 1 })).part!.id));
    expect(days.size).toBeGreaterThan(4);
  });

  it('a night skipped part way gives a share and no part; one skipped before the raid, or a rest, nothing', () => {
    const full = rollNightHaul(opts());
    const part = rollNightHaul(opts({ grade: 'partial', waves: 1 }));
    expect(part.part).toBeNull();
    expect(part.ammo).toBeLessThan(full.ammo);
    expect(part.ammo).toBeGreaterThan(0);
    expect(part.extra).toEqual(full.extra);
    const none = rollNightHaul(opts({ grade: 'none' }));
    expect(none).toEqual({ grade: 'none', ammo: 0, arrows: 0, part: null, extra: null });
  });

  it('is mostly Mk2, a quarter Mk3 and some bolt-on kit, never a common part', () => {
    const n = { mk2: 0, mk3: 0, kit: 0 };
    for (let s = 0; s < 1500; s++) {
      const r = rollNightHaul(opts({ seed: s, day: 1 }));
      n[r.part!.tier]++;
      const d = PARTS.parts.find((p) => p.id === r.part!.id)!;
      expect(d.mk).toBeGreaterThanOrEqual(2);
      expect(!!d.stock).toBe(false);
      if (r.part!.tier === 'kit') expect(KIT_SLOTS.includes(d.slot)).toBe(true);
    }
    expect(n.mk2 / 1500).toBeGreaterThan(0.53);
    expect(n.mk2 / 1500).toBeLessThan(0.67);
    expect(n.mk3 / 1500).toBeGreaterThan(0.19);
    expect(n.mk3 / 1500).toBeLessThan(0.31);
    expect(n.kit / 1500).toBeGreaterThan(0.1);
    expect(n.kit / 1500).toBeLessThan(0.2);
  });

  it('does not hand out a part the convoy already has while there is another to give', () => {
    for (let s = 0; s < 200; s++) {
      // Everything but the last of each pool is already in the trucks.
      const have = new Set<string>();
      for (const t of ['mk2', 'mk3', 'kit'] as const) haulPool(t).slice(0, -1).forEach((p) => have.add(p.id));
      const r = rollNightHaul(opts({ seed: s, have }));
      expect(have.has(r.part!.id)).toBe(false);
    }
  });

  it('is handed over once, into the trucks, or a crate at camp when they are full, or Scrap where there is none', () => {
    const c = new Campaign();
    c.seed = 77;
    c.day = 2;
    const ammo = c.ammo;
    const g1 = grantNightHaul(c, 'full', 3);
    expect(c.ammo).toBe(ammo + g1.roll.ammo);
    expect(g1.stowed).toBe('trucks');
    expect(c.inventory.map((p) => p.id)).toContain(g1.part!.id);
    expect(g1.models).toContain('ammo');
    expect(g1.models.length).toBe(3);
    // Full trucks: the crate takes it, and nothing goes in the trucks.
    while (c.inventoryRoom > 0) c.inventory.push(newPart('eng_i4', 1));
    const crated: string[] = [];
    const n = c.inventory.length;
    const g2 = grantNightHaul(c, 'full', 3, { crate: (it) => (crated.push(it.id), true) });
    expect(g2.stowed).toBe('crate');
    expect(crated).toEqual([g2.part!.id]);
    expect(c.inventory.length).toBe(n);
    expect(g2.lines.some((l) => /waits in a crate/.test(l))).toBe(true);
    // No crate offered (a single road, no world to leave it in): broken down for Scrap, and said so.
    const scrap = c.stocks.scrap;
    const g3 = grantNightHaul(c, 'full', 3);
    expect(g3.stowed).toBe('scrap');
    expect(c.stocks.scrap).toBeGreaterThan(scrap);
    expect(g3.lines.some((l) => /broken down for \d+ Scrap/.test(l))).toBe(true);
  });

  it('is granted only once even if dawn is asked for twice', () => {
    const h = fakeServices();
    const leg = legById('L1');
    const camp = new CampScene(h.svc, leg, leg.campSites[0], true);
    const res: string[] = [];
    camp.onResult = (r) => res.push(r.type);
    const c = camp as unknown as { waveIdx: number; phase: string; dawn(): void };
    c.waveIdx = 2;
    c.phase = 'night';
    const ammo = h.campaign.ammo;
    c.dawn();
    const got = h.campaign.ammo - ammo;
    expect(got).toBeGreaterThan(0);
    c.dawn();
    expect(h.campaign.ammo - ammo).toBe(got);
    expect(res).toEqual(['campDone']);
    camp.dispose();
  });
});

// ----------------------------------------------------------------------------------------------- the setting

describe('the night camp setting', () => {
  function settingsGame() {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const noop = () => {};
    const make = () => {
      const g = Object.create(Game.prototype) as Game;
      Object.assign(g, {
        benchmark: null,
        godMode: false,
        nightCamp: false,
        solo: false,
        R: { quality: 'medium', layout: 'vertical', setQuality: noop, setLayout: noop },
        hud: { uiScale: 1, setScale: noop, setReticle: noop },
        audio: { volume: 1, musicVolume: 1, gameMusicEnabled: true, userMusicEnabled: true, userMusicVolume: 1, ttsEnabled: false, setVolume: noop, setMusicVolume: noop, setGameMusicEnabled: noop, setUserMusicEnabled: noop, setUserMusicVolume: noop, setTtsEnabled: noop },
        storyVoice: { enabled: true },
        input: { settings: { mouseSens: 1 }, exportSettings: () => ({}), importSettings: noop },
        setGodMode(on: boolean) { (this as { godMode: boolean }).godMode = on; },
        setSolo: noop,
      });
      return g;
    };
    return { store, make };
  }

  it('day length: half an hour by default, saved and loaded, clamped, and a change keeps the time of day', () => {
    const { store, make } = settingsGame();
    const was = TUNING.dayLength;
    try {
      expect(was).toBe(1800);
      const a = make();
      const clock = new DayClock(TUNING.dayLength, 0.5);
      Object.assign(a, { scene: { clock } });
      a.setDayLength(45 * 60);
      expect(clock.dayLength).toBe(2700);
      expect(clock.t).toBeCloseTo(0.5, 6);
      a.saveSettings();
      expect(JSON.parse(store.get('ironnomad.settings')!).dayMin).toBe(45);
      TUNING.dayLength = 1800;
      make().applySettings();
      expect(TUNING.dayLength).toBe(2700);
      store.set('ironnomad.settings', JSON.stringify({ dayMin: 9999 }));
      make().applySettings();
      expect(TUNING.dayLength).toBe(120 * 60);
    } finally {
      TUNING.dayLength = was;
    }
  });

  it('is off by default, saves and loads, and settings from before it load as off', () => {
    const { store, make } = settingsGame();
    const a = make();
    a.applySettings();
    expect(a.nightCamp).toBe(false);
    a.nightCamp = true;
    a.saveSettings();
    expect(JSON.parse(store.get('ironnomad.settings')!).nightCamp).toBe(true);
    const b = make();
    b.applySettings();
    expect(b.nightCamp).toBe(true);
    store.set('ironnomad.settings', JSON.stringify({ quality: 'low', god: true }));
    const c = make();
    c.applySettings();
    expect(c.nightCamp).toBe(false);
    store.set('ironnomad.settings', JSON.stringify({ nightCamp: 'yes' }));
    const d = make();
    d.applySettings();
    expect(d.nightCamp).toBe(false);
  });
});
