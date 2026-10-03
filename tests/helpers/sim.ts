import * as THREE from 'three';
import { Campaign } from '../../src/game/campaign';
import { newIntent, type PlayerIntent } from '../../src/input/intents';
import { defaultSettings } from '../../src/input/input';
import type { SceneServices } from '../../src/game/scene';

/** A canvas that swallows every 2D call, so textures drawn at load time work without a DOM. */
function installFakeDocument() {
  const g = globalThis as unknown as { document?: unknown };
  if (g.document) return;
  const ctx = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : ctx()),
      set: () => true,
      apply: () => ctx(),
    });
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx(), style: {} }) };
}
installFakeDocument();

/**
 * Headless services for running a real Scene in Node: a renderer with just a THREE scene and two cameras, silent audio,
 * and input that tests drive by writing into `intents`. No WebGL, no DOM.
 */
export function fakeServices(opts: { onRadio?: (t: string) => void; solo?: boolean } = {}) {
  const intents: [PlayerIntent, PlayerIntent] = [newIntent(), newIntent()];
  const cam = () => new THREE.PerspectiveCamera(60, 1.6, 0.2, 2600);
  const R = {
    scene: new THREE.Scene(),
    views: [
      { camera: cam(), rect: { x: 0, y: 0, w: 100, h: 100 }, focus: new THREE.Vector3(), active: true },
      { camera: cam(), rect: { x: 0, y: 0, w: 100, h: 100 }, focus: new THREE.Vector3(), active: true },
    ],
    quality: 'low' as const,
    onBeforeView: [] as unknown[],
    onAfterView: [] as unknown[],
    setViewMode(i: number, first: boolean) {
      (this.views[i] as { first?: boolean }).first = first;
    },
    interior: false,
    sky: { mesh: { visible: true } },
    setLight() {
      this.sky.mesh.visible = true;
    },
    setInterior() {
      this.sky.mesh.visible = false;
    },
    renderPixelRatio: () => 1,
    /** What the real renderer keeps per player for a trip. The headless one only needs the clock. */
    trip: [{ phase: 0 }, { phase: 0 }],
    setTrip() {},
    applyTripCamera() {},
  };
  const sounds: string[] = [];
  const audio = {
    play: (id: string) => void sounds.push(id),
    setMusic: () => {},
    silenceEngines: () => {},
    updateEngines: () => {},
    updateMusic: () => {},
    setListeners: () => {},
    setTrip: () => {},
    setWind: () => {},
    setOcclusionTester: () => {},
    playRadioChatter: (text: string) => void sounds.push(`radio:${text}`),
    setIndoor: () => {},
    setSolo: () => {},
  };
  const input = {
    intents,
    slots: [null, null],
    settings: defaultSettings(),
    onChange: () => {},
    vehicleIsHold: () => false,
    mouseLocked: false,
    rumble: () => {},
    pendingLook: () => [0, 0] as [number, number],
    mouseSeat: () => -1,
  };
  const campaign = new Campaign(['Ash', 'Rook'], !!opts.solo);
  campaign.seed = 4242;
  const radio: string[] = [];
  const banners: string[] = [];
  const svc = {
    R,
    audio,
    input,
    campaign,
    onRadio: (t: string) => {
      radio.push(t);
      opts.onRadio?.(t);
    },
    onTip: () => {},
    onBanner: (t: string, s: string) => banners.push(`${t} | ${s}`),
  } as unknown as SceneServices;
  return { svc, R, intents, input, campaign, radio, banners, sounds };
}

/** Step a scene by whole seconds of game time. */
export function run(scene: { tick(dt: number): void }, seconds: number, each?: (i: number) => void) {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    each?.(i);
    scene.tick(1 / 60);
  }
}
