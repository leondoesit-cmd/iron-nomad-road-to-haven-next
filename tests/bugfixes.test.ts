import { describe, expect, it, vi } from 'vitest';
import { Game } from '../src/game/game';
import { InputManager } from '../src/input/input';
import { defaultBindings, importBindings, isReservedKey } from '../src/input/bindings';
import { Btn, wasPressed } from '../src/input/intents';
import { SpatialAudioEngine } from '../src/audio/spatial';
import { Campaign } from '../src/game/campaign';
import { loadCampaign, saveCampaign } from '../src/save/save';

/**
 * Regression tests for bugs found in the 2026-10-08 audit, each one small enough not to deserve a file of its own.
 */

const DT = 1 / 60;

function padInput() {
  const win = new EventTarget();
  const im = new InputManager(win as unknown as Window);
  const down = new Set<number>();
  const pad = {
    index: 0,
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    get buttons() {
      return Array.from({ length: 17 }, (_, i) => ({ pressed: down.has(i), value: down.has(i) ? 1 : 0 }));
    },
  } as unknown as Gamepad;
  im.mockPads = [pad];
  im.slots[0] = { kind: 'pad', index: 0 };
  return { im, down };
}

function kbMouseInput() {
  const win = new EventTarget();
  const im = new InputManager(win as unknown as Window);
  im.autoJoinKeyboard();
  im.attachMouse({ ownerDocument: new EventTarget(), requestPointerLock: () => {} } as unknown as HTMLElement);
  const fire = (type: string, extra: Record<string, unknown>) => win.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), extra));
  return { im, win, fire };
}

describe('input', () => {
  it('a pad Start press reaches the game, so it can pause and start a run', () => {
    const { im, down } = padInput();
    im.sample(DT);
    down.add(Btn.Start);
    im.sample(DT);
    expect(wasPressed(im.intents[0], Btn.Start)).toBe(true);
  });

  it('a key tapped down and up between two ticks still counts once', () => {
    const { im, fire } = kbMouseInput();
    im.sample(DT);
    fire('keydown', { code: 'KeyR', repeat: false });
    fire('keyup', { code: 'KeyR' });
    im.sample(DT);
    expect(wasPressed(im.intents[0], Btn.X)).toBe(true);
    im.sample(DT);
    expect(im.intents[0].held & (1 << Btn.X)).toBe(0);
  });

  it('a trackpad click (down and up within a tick) still fires', () => {
    const { im, fire } = kbMouseInput();
    im.mouseLocked = true;
    im.sample(DT);
    fire('mousedown', { button: 0 });
    fire('mouseup', { button: 0 });
    im.sample(DT);
    expect(im.intents[0].rt).toBeGreaterThan(0.5);
  });

  it('one wheel notch steps the belt once whether the browser counts lines or pixels', () => {
    for (const [mode, dy] of [[1, 3], [0, 100], [0, 120]] as const) {
      const { im, fire } = kbMouseInput();
      im.mouseLocked = true;
      fire('wheel', { deltaMode: mode, deltaY: dy });
      let steps = 0;
      for (let i = 0; i < 10; i++) {
        im.sample(DT);
        steps += Math.abs(im.intents[0].toolStep);
      }
      expect(steps).toBe(1);
    }
  });

  it('Cmd coming up drops keys macOS never sent a keyup for', () => {
    const { im, fire } = kbMouseInput();
    fire('keydown', { code: 'KeyW', repeat: false });
    fire('keydown', { code: 'MetaLeft', repeat: false });
    fire('keyup', { code: 'MetaLeft' });
    for (let i = 0; i < 6; i++) im.sample(DT);
    expect(im.intents[0].move[1]).toBe(0);
  });

  it('no default key is a Ctrl, and an old saved Ctrl binding falls back to the default', () => {
    const d = defaultBindings();
    for (const map of d.kb) for (const code of Object.values(map)) expect(isReservedKey(code!)).toBe(false);
    const saved = defaultBindings();
    saved.kb[1].sprint = 'ControlRight';
    expect(importBindings(JSON.parse(JSON.stringify(saved))).kb[1].sprint).toBe(d.kb[1].sprint);
  });
});

describe('spatial audio', () => {
  /** The smallest Web Audio stand-in a StereoPanner route needs. */
  const ctx = () => {
    const param = () => ({ value: 0, setTargetAtTime(v: number) { this.value = v; }, setValueAtTime(v: number) { this.value = v; } });
    const node = () => ({ connect(n: unknown) { return n; }, disconnect() {} });
    return {
      currentTime: 0,
      createBiquadFilter: () => ({ ...node(), frequency: param(), Q: param(), type: 'lowpass' }),
      createGain: () => ({ ...node(), gain: param() }),
      createPanner: () => { throw new Error('no HRTF here'); },
      createStereoPanner: () => ({ ...node(), pan: param() }),
    } as unknown as AudioContext;
  };

  it('a sound on the screen-right is heard on the right', () => {
    const s = new SpatialAudioEngine(ctx());
    // Facing +z the screen's right hand is -x (camera right = (-cos yaw, sin yaw)).
    const r = s.createSpatialRoute(-10, 0, { x: 0, z: 0, yaw: 0 }, 0, {} as AudioNode)!;
    expect((r.panner as StereoPannerNode).pan.value).toBeGreaterThan(0.9);
    // Facing +x (yaw pi/2) the right hand is +z.
    s.updateSpatialRoute(r, 0, 10, { x: 0, z: 0, yaw: Math.PI / 2 });
    expect((r.panner as StereoPannerNode).pan.value).toBeGreaterThan(0.9);
  });
});

describe('saves', () => {
  it('the saved snapshot does not follow play after the save', () => {
    const c = new Campaign();
    c.stocks.scrap = 10;
    saveCampaign(c);
    c.stocks.scrap = 999;
    c.history.push('after-the-save');
    const back = loadCampaign()!;
    expect(back.stocks.scrap).toBe(10);
    expect(back.history).not.toContain('after-the-save');
    expect(back.stocks).not.toBe(c.stocks);
    // And loading twice never hands out the same objects either.
    expect(loadCampaign()!.stocks).not.toBe(back.stocks);
  });
});

describe('settings', () => {
  it('difficulty set in Settings is kept on the game and in the saved settings, and new runs start with it', () => {
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
        difficulty: { drain: 1, aggro: 1, damage: 1 },
        campaign: new Campaign(),
        R: { quality: 'medium', layout: 'vertical', setQuality: noop, setLayout: noop },
        hud: { uiScale: 1, setScale: noop },
        audio: { volume: 1, musicVolume: 1, gameMusicEnabled: true, userMusicEnabled: true, userMusicVolume: 1, ttsEnabled: false, setVolume: noop, setMusicVolume: noop, setGameMusicEnabled: noop, setUserMusicEnabled: noop, setUserMusicVolume: noop, setTtsEnabled: noop },
        storyVoice: { enabled: true },
        input: { settings: { mouseSens: 1 }, exportSettings: () => ({}), importSettings: noop },
        setGodMode(on: boolean) { (this as { godMode: boolean }).godMode = on; },
        setSolo: noop,
      });
      return g;
    };
    const a = make();
    a.difficulty = { drain: 0.5, aggro: 1.75, damage: 0.25 };
    a.saveSettings();
    const b = make();
    b.applySettings();
    expect(b.difficulty).toEqual({ drain: 0.5, aggro: 1.75, damage: 0.25 });
    expect(b.campaign.difficulty).toEqual(b.difficulty);
    // Junk in the saved file is clamped or dropped, never trusted.
    store.set('ironnomad.settings', JSON.stringify({ difficulty: { drain: 99, aggro: 'x', damage: -3 } }));
    const c = make();
    c.applySettings();
    expect(c.difficulty).toEqual({ drain: 2, aggro: 1, damage: 0.25 });
    vi.unstubAllGlobals();
  });
});
