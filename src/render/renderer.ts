import * as THREE from 'three';
import { staticTransform } from './staticTransform';
import { AdaptiveResolution } from './adaptiveResolution';
import { DEG, clamp01, lerp, smoothstep as smooth } from '../core/math';
import type { LightState } from '../sim/dayclock';
import { ATMO, installAtmosphere, setAtmosphere } from './atmosphere';
import { installGloss } from './gloss';
import { installFireLight } from './fireLight';
import { GLOBALS, KIT } from './materials';
import { PostFX } from './post';
import { SkyDome } from './sky';
import { BREATH, installBreath, newTripView, resetCamera, shiftHue, tripCamera, tripTempo, lookActive, type TripView } from './trip';
import type { Look } from '../sim/drugs';
import { FACE_TRIP, faceStrength } from './faceGums';

// Fog chunks must be replaced before the first material compiles.
installAtmosphere();
installBreath();
installGloss();
installFireLight();

export type QualityPreset = 'low' | 'medium' | 'high';
export interface QualitySpec {
  scale: number;
  shadow: number;
  zombies: number;
  /** View range in metres: sets the fog and thins the haze. 330 is the reference the day haze was tuned at. */
  draw: number;
  /** Chunks streamed in full detail around each player, in each direction (beyond them the far landscape takes over). */
  stream: number;
  particles: number;
  /** HDR target with bloom and grading. Low draws straight to the canvas. */
  post: boolean;
  msaa: number;
  /** Fraction of ground scatter (grass, shrubs, pebbles) to draw. */
  scatter: number;
  /** Seconds between environment-map captures. */
  envEvery: number;
}
export const QUALITY: Record<QualityPreset, QualitySpec> = {
  low: { scale: 0.7, shadow: 1024, zombies: 40, draw: 300, stream: 2, particles: 0.5, post: false, msaa: 0, scatter: 0.3, envEvery: 4 },
  medium: { scale: 0.85, shadow: 2048, zombies: 60, draw: 440, stream: 2, particles: 1, post: true, msaa: 4, scatter: 0.65, envEvery: 1 },
  high: { scale: 1.0, shadow: 4096, zombies: 80, draw: 560, stream: 3, particles: 1, post: true, msaa: 4, scatter: 1, envEvery: 0.5 },
};

export type SplitLayout = 'horizontal' | 'vertical';

/**
 * What the weather does to the look of the world this frame (`sim/climate.ts` decides it; the scene fills it in before the
 * light is set). All zero is a fair day.
 */
export interface WeatherLook {
  /** Cloud over the convoy, and how dark and heavy its base is. */
  cover: number;
  dark: number;
  /** Rain falling, 0..1. */
  rain: number;
  /** Lightning lighting the world now, 0..1 (a flash dies in a fraction of a second), and flickering in a far thunderhead. */
  flash: number;
  farFlash: number;
  /** A thunderhead on the horizon: its bearing (atan2 of x and z) and how much of the sky it fills. */
  towerDir: number;
  tower: number;
  /** A rainbow, 0..1. */
  bow: number;
  /** Heat coming off the ground round each view's player, 0..1: the air shimmers and the far ground turns to water. */
  heat: [number, number];
}

export function calmWeather(): WeatherLook {
  return { cover: 0, dark: 0, rain: 0, flash: 0, farFlash: 0, towerDir: 0, tower: 0, bow: 0, heat: [0, 0] };
}

const _rainFog = new THREE.Color();

export interface PlayerView {
  camera: THREE.PerspectiveCamera;
  /** Pixels in CSS space, origin top-left. */
  rect: { x: number; y: number; w: number; h: number };
  /** Point the shadow frustum and sky follow. */
  focus: THREE.Vector3;
  active: boolean;
  /** This view is a first-person camera: a taller field of view than the chase strip. */
  first?: boolean;
  /** Magnification from a scope while aiming: the field of view is divided by it. 1 (or missing) is none. */
  zoom?: number;
  /** How strongly this view is drawn through a body camera's lens (first person only), 0 to 1. */
  lens?: number;
}

/** How much the body-camera lens swells the middle of the picture at full strength (the composite's barrel uses the same). */
export const LENS_K = 0.32;

/** Horizontal FOV is fixed at 100 degrees; vertical is derived with a floor of 32 degrees. */
export function fovFor(aspect: number, hfovDeg = 100, vfovMinDeg = 32) {
  const v = 2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) / aspect) / DEG;
  return Math.max(vfovMinDeg, v);
}

/** Vertical FOV used in the left/right layout, where a fixed 100 degree horizontal FOV would be a fisheye on a tall half. */
export const VERTICAL_SPLIT_VFOV = 66;

/** FOV for a view: fixed horizontal FOV for the wide strips, a fixed vertical FOV for the left/right halves. */
export function viewFov(aspect: number, layout: SplitLayout, hfovDeg = 100) {
  const strip = fovFor(aspect, hfovDeg);
  return layout === 'vertical' ? Math.min(VERTICAL_SPLIT_VFOV, strip) : strip;
}

/** First person needs more height than the chase strip's 32 degree floor, so the vertical FOV has a higher floor and a cap. */
export function firstPersonFov(aspect: number, layout: SplitLayout, hfovDeg: number) {
  const v = fovFor(aspect, hfovDeg, 50);
  return layout === 'vertical' ? Math.min(v, 85) : v;
}

/** Longest view any preset gets, metres; each view's far plane follows the fog inside it (see fitFar). */
const VIEW_FAR = 3400;

/** Shadow box half-size in metres, and how far ahead of the player its centre sits. */
const SHADOW_HALF = 60;
const SHADOW_AHEAD = 30;

const _fwd = new THREE.Vector3();
const _c = new THREE.Vector3();
const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _z = new THREE.Color();
const _z2 = new THREE.Color();
const _storm = new THREE.Color();

export class GameRenderer {
  gl: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  views: [PlayerView, PlayerView];
  sun = new THREE.DirectionalLight(0xffffff, 2);
  hemi = new THREE.HemisphereLight(0xffffff, 0x886644, 0.4);
  fog = new THREE.Fog(0xcfc4aa, 60, 340);
  sky = new SkyDome();
  post: PostFX | null = null;
  /** Left/right is the default; top/bottom (the blueprint's strips) is a setting. */
  layout: SplitLayout = 'vertical';
  /** 1 gives the whole canvas to the first view (solo play); 2 splits it. */
  seats: 1 | 2 = 2;
  quality: QualityPreset = 'medium';
  renderScale = 1;
  private baseDpr = 1;
  /**
   * The canvas's own pixels per CSS pixel: the screen's, so the browser never stretches the finished picture (a stretch of a
   * few percent blurs some rows of pixels and not others, and fine detail shows faint regular lines). With the post chain
   * the scene itself is drawn at `baseDpr * quality * renderScale` and the composite scales it up with a sharp filter.
   */
  private outDpr = 1;
  private resolution = new AdaptiveResolution();
  private lastRender = 0;
  night = 0;
  width = 1;
  height = 1;
  sunDir = new THREE.Vector3(0.4, 0.8, 0.3);
  /** Overlay hook: extra callbacks called with each view before it renders (particles, billboards). */
  onBeforeView: ((i: number, cam: THREE.PerspectiveCamera) => void)[] = [];
  /** Same, called after each view has drawn, to put back whatever a before-hook hid. */
  onAfterView: ((i: number) => void)[] = [];
  /** Horizontal field of view of first-person views, degrees. */
  fpHfov = 110;
  /** Horizontal FOV of the chase camera, degrees. */
  chaseHfov = 110;
  contextLost = false;
  onContextRestored: () => void = () => {};
  /** 0..1 fade to black applied in the composite (scene transitions). */
  fade = 1;
  private floatOk = true;
  /** Each player's trip, as the renderer sees it: what to bend in their view, and the clock it runs on. */
  trip: [TripView, TripView] = [newTripView(), newTripView()];
  /** The weather's look this frame. The scene writes it; `setLight` reads it. */
  wx: WeatherLook = calmWeather();
  /** Baseline sky, fog and light, put back after a view that bent them. */
  private tripSaved = {
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    sunColor: new THREE.Color(),
    ground: new THREE.Color(),
    fog: new THREE.Color(),
    fogNear: 0,
    fogFar: 0,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    sun: new THREE.Color(),
    atmo: { x: 0, y: 0, z: 0 },
  };

  constructor(public canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.baseDpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.outDpr = Math.min(window.devicePixelRatio || 1, 2);
    this.floatOk = this.gl.extensions.has('EXT_color_buffer_float') || this.gl.extensions.has('EXT_color_buffer_half_float');
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.autoClear = true;
    // Count the whole frame (scene, shadows, both views and post passes), rather than only the last composite.
    this.gl.info.autoReset = false;
    staticTransform(this.scene);
    this.scene.fog = this.fog;
    this.scene.add(this.hemi);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.add(this.sky.mesh);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_HALF;
    sc.right = SHADOW_HALF;
    sc.top = SHADOW_HALF;
    sc.bottom = -SHADOW_HALF;
    sc.near = 1;
    sc.far = 320;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.35;
    this.applyQuality();

    const mkView = (): PlayerView => ({ camera: new THREE.PerspectiveCamera(37, 3.56, 0.2, VIEW_FAR), rect: { x: 0, y: 0, w: 1, h: 1 }, focus: new THREE.Vector3(), active: true });
    this.views = [mkView(), mkView()];

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.onContextRestored();
    });
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Set one player's trip for this frame. Their half of the picture gets the post effects, their sky, fog and light get
   * recoloured and their ground starts to breathe, all in their own view only.
   */
  setTrip(i: number, look: Look, dt: number) {
    const t = this.trip[i];
    t.look = look;
    t.active = lookActive(look);
    t.phase += dt * tripTempo(look);
    this.post?.setTrip(i, t, dt);
  }

  /** Roll and breathe this player's camera for the view about to be drawn (or put it square again). */
  applyTripCamera(i: number) {
    const t = this.trip[i];
    const cam = this.views[i].camera;
    if (t.active) tripCamera(cam, t.look, t.phase);
    else resetCamera(cam);
  }

  /** Bend the sky, fog, light and ground for a view that is tripping. Returns whether it did, so `endTripView` knows to undo. */
  private beginTripView(i: number): boolean {
    const t = this.trip[i];
    if (!t.active) return false;
    const l = t.look;
    const ph = t.phase;
    const s = this.tripSaved;
    const u = this.sky.uniforms;
    s.zenith.copy(u.uZenith.value);
    s.horizon.copy(u.uHorizon.value);
    s.sunColor.copy(u.uSunColor.value);
    s.ground.copy(u.uGround.value);
    s.fog.copy(this.fog.color);
    s.fogNear = this.fog.near;
    s.fogFar = this.fog.far;
    s.hemiSky.copy(this.hemi.color);
    s.hemiGround.copy(this.hemi.groundColor);
    s.sun.copy(this.sun.color);
    s.atmo.x = ATMO.sunCol.x;
    s.atmo.y = ATMO.sunCol.y;
    s.atmo.z = ATMO.sunCol.z;
    // The world heaves, and the sky grows an aurora, rings and (for the vine) an eye.
    BREATH.x = l.breathe * 0.16;
    BREATH.y = ph;
    // The faces in the old gums' bark come forward.
    FACE_TRIP.k.value = faceStrength(l);
    FACE_TRIP.ph.value = ph;
    u.uTrip.value.set(l.sky, l.eye, ph, l.sky > 0.15 ? Math.min(1, l.sky) : 0);
    // The light drifts round the colour wheel, so everything it touches does too.
    const turn = l.hue * 0.3 * Math.sin(ph * 0.21);
    const sat = l.sat * 0.25;
    shiftHue(u.uZenith.value, turn, sat);
    shiftHue(u.uHorizon.value, turn * 1.1, sat);
    shiftHue(u.uSunColor.value, turn * 1.5, sat);
    shiftHue(u.uGround.value, turn, sat);
    for (const c of [u.uZenith.value, u.uHorizon.value, u.uSunColor.value]) {
      c.r *= 1 + l.tintR;
      c.g *= 1 + l.tintG;
      c.b *= 1 + l.tintB;
    }
    this.fog.color.copy(u.uHorizon.value);
    // Tunnel vision closes the fog in.
    this.fog.near *= 1 - 0.4 * l.tunnel;
    this.fog.far *= 1 - 0.45 * l.tunnel;
    shiftHue(this.hemi.color, turn * 1.2, sat);
    shiftHue(this.hemi.groundColor, turn * 1.2, sat);
    shiftHue(this.sun.color, turn * 1.5, sat);
    ATMO.sunCol.x = this.sun.color.r;
    ATMO.sunCol.y = this.sun.color.g;
    ATMO.sunCol.z = this.sun.color.b;
    return true;
  }

  private endTripView() {
    const s = this.tripSaved;
    const u = this.sky.uniforms;
    u.uZenith.value.copy(s.zenith);
    u.uHorizon.value.copy(s.horizon);
    u.uSunColor.value.copy(s.sunColor);
    u.uGround.value.copy(s.ground);
    this.fog.color.copy(s.fog);
    this.fog.near = s.fogNear;
    this.fog.far = s.fogFar;
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.sun.color.copy(s.sun);
    ATMO.sunCol.x = s.atmo.x;
    ATMO.sunCol.y = s.atmo.y;
    ATMO.sunCol.z = s.atmo.z;
    BREATH.x = 0;
    FACE_TRIP.k.value = 0;
    u.uTrip.value.set(0, 0, 0, 0);
  }

  get usePost() {
    return QUALITY[this.quality].post && this.floatOk;
  }

  private applyQuality() {
    const q = QUALITY[this.quality];
    this.setShadowSize(q.shadow);
    if (this.usePost) {
      if (!this.post) this.post = new PostFX(q.msaa);
      this.post.fx.setTier(this.quality === 'high' ? 1 : 0);
      this.gl.setPixelRatio(this.outDpr);
    } else {
      this.post?.dispose();
      this.post = null;
      this.gl.setPixelRatio(this.baseDpr * q.scale * this.renderScale);
    }
  }

  setShadowSize(n: number) {
    this.sun.shadow.mapSize.set(n, n);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
  }

  setQuality(q: QualityPreset) {
    this.quality = q;
    this.renderScale = 1;
    this.resolution.reset();
    this.applyQuality();
    this.resize();
  }

  setLayout(l: SplitLayout) {
    this.layout = l;
    this.resize();
  }

  setSeats(n: 1 | 2) {
    if (this.seats === n) return;
    this.seats = n;
    this.resize();
  }

  /** Per the blueprint: 4 px divider between halves. */
  static DIVIDER = 4;

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    this.gl.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const d = GameRenderer.DIVIDER;
    const [a, b] = this.views;
    if (this.seats === 1) {
      // Solo: the whole canvas is one wide view. The second view is parked on the same rect (it is never drawn).
      a.rect = { x: 0, y: 0, w, h };
      b.rect = { x: 0, y: 0, w, h };
    } else if (this.layout === 'horizontal') {
      const hh = Math.floor((h - d) / 2);
      a.rect = { x: 0, y: 0, w, h: hh };
      b.rect = { x: 0, y: hh + d, w, h: h - hh - d };
    } else {
      const ww = Math.floor((w - d) / 2);
      a.rect = { x: 0, y: 0, w: ww, h };
      b.rect = { x: ww + d, y: 0, w: w - ww - d, h };
    }
    const layout = this.seats === 1 ? 'horizontal' : this.layout;
    for (const v of this.views) {
      v.camera.aspect = v.rect.w / v.rect.h;
      this.applyFov(v);
    }
  }

  private applyFov(v: PlayerView) {
    const layout = this.seats === 1 ? 'horizontal' : this.layout;
    let fov = v.first ? firstPersonFov(v.camera.aspect, layout, this.fpHfov) : viewFov(v.camera.aspect, layout, this.chaseHfov);
    // Through the body-camera lens the middle keeps its size and the rim takes in more: drawn wider by what the lens's
    // barrel swells the middle by (see the composite in post.ts).
    const lens = v.first ? (v.lens ?? 0) : 0;
    if (lens > 0) fov = (2 * Math.atan(Math.tan((fov * DEG) / 2) * (1 + LENS_K * lens))) / DEG;
    // Magnifying narrows the view by the tangent, as a real optic does, rather than the angle.
    const z = v.zoom ?? 1;
    v.camera.fov = z > 1.001 ? (2 * Math.atan(Math.tan((fov * DEG) / 2) / z)) / DEG : fov;
    v.camera.updateProjectionMatrix();
  }

  /** Scope zoom for one view. Cheap to call every frame: the projection is rebuilt only when it has moved. */
  setZoom(i: number, zoom: number) {
    const v = this.views[i];
    const z = Math.max(1, Math.round(zoom * 50) / 50);
    if ((v.zoom ?? 1) === z) return;
    v.zoom = z;
    this.applyFov(v);
  }

  /** Switch a view between the chase strip and first person. Cheap to call every frame: it only rebuilds the projection on a change. */
  setViewMode(i: number, first: boolean, hfov = this.fpHfov, chaseHfov = this.chaseHfov, lens = 0) {
    const v = this.views[i];
    const l = first ? lens : 0;
    if (!!v.first === first && this.fpHfov === hfov && this.chaseHfov === chaseHfov && (v.lens ?? 0) === l) return;
    v.lens = l;
    v.first = first;
    this.fpHfov = hfov;
    this.chaseHfov = chaseHfov;
    for (const o of this.views) this.applyFov(o);
  }

  /**
   * Garage preview: each player's view shrinks to a tall strip at their side of the screen, leaving the middle
   * for a panel. Pass null to return to the normal split.
   */
  setPreviewRects(frac: number | null) {
    if (frac === null) {
      this.resize();
      return;
    }
    const w = this.width;
    const h = this.height;
    const sw = Math.floor(w * frac);
    const [a, b] = this.views;
    a.rect = { x: 0, y: 0, w: sw, h };
    b.rect = this.seats === 1 ? { ...a.rect } : { x: w - sw, y: 0, w: sw, h };
    for (const v of this.views) {
      v.camera.aspect = v.rect.w / v.rect.h;
      v.camera.fov = 60;
      v.camera.updateProjectionMatrix();
    }
  }

  /** Render-target pixels per CSS pixel (particle sizes are in render pixels). */
  renderPixelRatio() {
    return this.usePost ? this.baseDpr * QUALITY[this.quality].scale * this.postScale() : this.gl.getPixelRatio();
  }

  private postScale() {
    return Math.round(this.renderScale * 20) / 20;
  }

  /** Apply time-of-day lighting. `wet` is how wet the hard ground is and `puddle` how full its puddles are (see `GLOBALS`). */
  setLight(l: LightState, biome: 'wasteland' | 'city', cityMix = biome === 'city' ? 1 : 0, storm = 0, wet = 0, puddle = 0) {
    this.sky.mesh.visible = true;
    this.night = l.night;
    const wx = this.wx;
    const e = l.elevation;
    const az = l.azimuth;
    const hz = Math.sqrt(Math.max(0.05, 1 - e * e));
    this.sunDir.set(Math.cos(az) * hz, e, Math.sin(az) * hz).normalize();
    this.sun.color.setRGB(...l.sunColor);
    // A dust storm browns the whole sky over and takes the edge off the sun; cloud shades it, a thunderhead all but hides it.
    const dim = 1 - l.night * 0.85;
    const shade = wx.cover * (0.3 + 0.6 * wx.dark);
    this.sun.intensity = l.sunIntensity * 1.05 * (1 - 0.5 * storm) * (1 - shade);
    // The day-clock palette is authored as display (sRGB) colours.
    this.hemi.color.setRGB(...l.hemiSky, THREE.SRGBColorSpace);
    this.hemi.groundColor.setRGB(...l.hemiGround, THREE.SRGBColorSpace);
    this.hemi.intensity = l.hemiIntensity * 0.3;
    this.fog.color.setRGB(...l.fog, THREE.SRGBColorSpace);
    if (storm > 0) {
      _storm.setRGB(0.66 * dim, 0.5 * dim, 0.32 * dim, THREE.SRGBColorSpace);
      this.fog.color.lerp(_storm, storm * 0.92);
    }
    // Under a lid of cloud the light goes flat and grey; rain greys the air itself. Lightning lights everything at once.
    const grey = clamp01(wx.cover * (0.35 + 0.5 * wx.dark) + wx.rain * 0.4);
    if (grey > 0) {
      // A shower's grey is pale; a thunderhead's is slate, with a cold blue in it.
      const slate = lerp(1, 0.62, wx.dark * wx.cover);
      _rainFog.setRGB(0.5 * dim * slate, 0.53 * dim * slate, 0.58 * dim * slate, THREE.SRGBColorSpace);
      this.fog.color.lerp(_rainFog, grey * 0.8);
      this.hemi.color.lerp(_rainFog.setRGB(0.62 * dim, 0.65 * dim, 0.7 * dim, THREE.SRGBColorSpace), grey * 0.6);
      this.hemi.groundColor.lerp(_rainFog.setRGB(0.28 * dim, 0.27 * dim, 0.26 * dim, THREE.SRGBColorSpace), grey * 0.4);
      this.hemi.intensity *= 1 + 0.35 * grey - 0.35 * wx.dark * wx.cover;
    }
    if (wx.flash > 0) {
      this.hemi.color.lerp(_rainFog.setRGB(0.85, 0.9, 1.0), Math.min(1, wx.flash));
      this.hemi.intensity += wx.flash * 6;
      this.fog.color.lerp(_rainFog.setRGB(0.7, 0.74, 0.85), wx.flash * 0.6);
    }
    const dist = QUALITY[this.quality].draw;
    const city = cityMix > 0.5;
    // The wasteland has far scenery out to the mountains, so its fog is mostly height haze; the city's
    // skyline sits close behind the corridor. Past the streamed chunks the far landscape carries roads and
    // standout props, so a longer view still has things in it.
    const reach = dist / 330;
    this.fog.near = lerp(lerp(160, 60, cityMix) * reach, 22, l.night);
    this.fog.far = lerp(lerp(dist * 3.2, Math.min(dist * 1.8, 900), cityMix), 150 + dist * 0.1, l.night);
    if (storm > 0) {
      this.fog.near *= Math.pow(0.1, storm);
      this.fog.far *= Math.pow(0.12, storm);
    }
    if (wx.rain > 0) {
      // Heavy rain closes the view to a few hundred metres.
      this.fog.near *= 1 - 0.75 * wx.rain;
      this.fog.far *= 1 - 0.62 * wx.rain;
    }
    const u = this.sky.uniforms;
    u.uSunDir.value.copy(this.sunDir);
    u.uSunColor.value.setRGB(...l.sunColor);
    u.uHorizon.value.copy(this.fog.color);
    // Zenith: deep blue by day (greyer over the city), violet at dusk, near black at night.
    const dusk = Math.min(1, Math.max(0, (l.sky[0] - l.sky[2] - 0.12) / 0.48));
    // ACES pulls saturated blue toward violet, so the authored zenith leans cyan.
    const zd = [lerp(0.2, 0.4, cityMix), lerp(0.47, 0.52, cityMix), lerp(0.76, 0.62, cityMix)];
    _z.setRGB(zd[0], zd[1], zd[2], THREE.SRGBColorSpace);
    _z2.setRGB(0.3, 0.29, 0.5, THREE.SRGBColorSpace);
    _z.lerp(_z2, dusk);
    _z2.setRGB(0.012, 0.018, 0.045, THREE.SRGBColorSpace);
    u.uZenith.value.copy(_z.lerp(_z2, l.night));
    if (storm > 0) u.uZenith.value.lerp(_storm.setRGB(0.52 * dim, 0.38 * dim, 0.24 * dim, THREE.SRGBColorSpace), storm * 0.85);
    if (grey > 0) u.uZenith.value.lerp(_rainFog.setRGB(0.4 * dim, 0.43 * dim, 0.48 * dim, THREE.SRGBColorSpace).multiplyScalar(lerp(1, 0.55, wx.dark * wx.cover)), grey * 0.85);
    u.uWx.value.set(wx.dark * wx.cover, wx.rain, wx.flash, wx.bow);
    u.uTower.value.set(Math.sin(wx.towerDir), Math.cos(wx.towerDir), wx.tower, wx.farFlash);
    u.uGround.value.setRGB(l.hemiGround[0] * 0.8, l.hemiGround[1] * 0.75, l.hemiGround[2] * 0.7, THREE.SRGBColorSpace);
    u.uNight.value = l.night;
    // Fair-weather cumulus; above 1 the shader closes the cloud into an overcast lid.
    u.uCloud.value = Math.max(city ? 0.55 : 0.4, 0.3 + wx.cover * 1.25);
    u.uMoonDir.value.set(-this.sunDir.x, Math.max(0.35, this.sunDir.y), -this.sunDir.z).normalize();
    const scatter = lerp(0.55, 0.12, l.night);
    u.uScatter.value = scatter;
    setAtmosphere(
      this.sunDir,
      this.sun.color,
      scatter,
      lerp((city ? 0.0035 : 0.0016) / Math.max(1, reach), 0.006, l.night) + 0.011 * storm + 0.005 * wx.rain,
      lerp(city ? 0.03 : 0.045, 0.012, storm),
      city ? 2 : 0,
    );
    this.scene.environmentIntensity = lerp(0.85, 0.35, l.night);
    GLOBALS.uLight.value
      .copy(this.sun.color)
      .multiplyScalar(this.sun.intensity * 0.22)
      .add(_z.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 0.9 + 0.12));
    KIT.uGlow.value = 1 + l.night * 0.9;
    GLOBALS.uWet.value = wet;
    GLOBALS.uPuddle.value = puddle;
    if (this.post) this.setScreenFx(l, city, storm, wet);
    // Exposure opens up a little at night so headlights read without crushing everything else, and under a dark sky as an
    // eye would; a hot day bleaches the colour a touch.
    if (this.post) {
      const p = this.post.params;
      const hot = Math.max(wx.heat[0], wx.heat[1]);
      p.exposure = lerp(1.0, 1.7, l.night) * (1 - 0.1 * storm) * (1 + 0.3 * shade) * (1 + 0.05 * hot);
      p.saturation = lerp(city ? 0.92 : 1.04, 0.85, l.night) * (1 - 0.22 * storm) * (1 - 0.25 * grey) * (1 - 0.06 * hot);
      this.post.heat.set(wx.heat[0], wx.heat[1]);
      p.bloom = lerp(0.018, 0.028, l.night);
      if (city) {
        p.shadowTint.setRGB(0.95, 0.99, 1.04);
        p.highTint.setRGB(1.01, 1.0, 0.97);
      } else {
        p.shadowTint.setRGB(0.97, 0.97, 1.03);
        p.highTint.setRGB(1.04, 1.0, 0.93);
      }
    }
  }

  /**
   * Tune the screen-space lighting to the hour and the weather. Dust hangs thicker as the sun sinks (and a storm fills the
   * air with it), so the low sun of the evening throws long shafts through whatever stands between it and the camera.
   */
  private setScreenFx(l: LightState, city: boolean, storm: number, wet: number) {
    const fx = this.post!.fx.params;
    const e = l.elevation;
    const low = 1 - smooth(0.12, 0.62, e);
    const day = 1 - l.night;
    fx.aoStrength = 1;
    fx.aoRadius = city ? 1.9 : 1.6;
    fx.dust = (lerp(0.0008, 0.0022, low) * (city ? 1.3 : 1) + 0.0075 * storm) * day;
    fx.dustFall = lerp(0.07, 0.035, storm);
    fx.shafts = (lerp(0.42, 0.72, low) * (1 - 0.2 * storm) + 0.28 * storm) * day;
    fx.sunLight.copy(this.sun.color).multiplyScalar(this.sun.intensity * 0.85 * day);
    fx.reflect = 1 + 0.5 * wet;
  }

  /**
   * Underground lighting: no sun, no sky, a dim cool ambient, short fog and a lifted exposure, so the only real light
   * is what the scene puts there (lamps and flashlights). Called every frame by a delve; setLight undoes it.
   */
  setInterior(o: { fog: number; near: number; far: number; sky: number; ground: number; ambient: number; exposure: number }) {
    this.night = 1;
    this.sky.mesh.visible = false;
    this.sun.intensity = 0;
    this.hemi.color.set(o.sky);
    this.hemi.groundColor.set(o.ground);
    this.hemi.intensity = o.ambient;
    this.fog.color.set(o.fog);
    this.fog.near = o.near;
    this.fog.far = o.far;
    this.scene.environmentIntensity = 0.05;
    _z.set(0x000000);
    setAtmosphere(this.sunDir, _z, 0, 0, 0.1, 0);
    if (this.post) {
      // No sun to scatter, but occlusion matters most here: the ambient light is all there is.
      const fx = this.post.fx.params;
      fx.aoStrength = 1;
      fx.aoRadius = 2.2;
      fx.dust = 0;
      fx.shafts = 0;
      fx.sunLight.setRGB(0, 0, 0);
      fx.reflect = 1;
    }
    GLOBALS.uWet.value = 0.15;
    GLOBALS.uLight.value.copy(this.hemi.color).multiplyScalar(o.ambient * 0.6 + 0.12);
    KIT.uGlow.value = 1.6;
    if (this.post) {
      const p = this.post.params;
      p.exposure = o.exposure;
      p.saturation = 0.9;
      p.bloom = 0.07;
      p.shadowTint.setRGB(0.92, 0.98, 1.06);
      p.highTint.setRGB(1.04, 1.0, 0.94);
    }
  }

  /** Adaptive resolution: one shared scale so the two halves always match. */
  adapt(frameMs: number) {
    this.setRenderScale(this.resolution.update(frameMs, this.renderScale));
  }

  /** Also used to pin benchmark resolution and restore the user's current scale afterwards. */
  setRenderScale(scale: number) {
    const previous = this.renderScale;
    this.renderScale = Math.max(0.6, Math.min(1, scale));
    const q = QUALITY[this.quality];
    if (!this.usePost && previous !== this.renderScale) this.gl.setPixelRatio(this.baseDpr * q.scale * this.renderScale);
  }

  /** Point the single shadow map at a view: centred ahead of the player and snapped to whole texels. */
  private aimShadow(v: PlayerView) {
    v.camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    _c.copy(v.focus).addScaledVector(_fwd, SHADOW_AHEAD);
    // Light-space basis matching the shadow camera's lookAt (z toward the sun, y up-ish).
    _lx.crossVectors(UP, this.sunDir).normalize();
    _ly.crossVectors(this.sunDir, _lx);
    const texel = (SHADOW_HALF * 2) / this.sun.shadow.mapSize.x;
    const px = _c.dot(_lx);
    const py = _c.dot(_ly);
    _c.addScaledVector(_lx, Math.round(px / texel) * texel - px).addScaledVector(_ly, Math.round(py / texel) * texel - py);
    this.sun.target.position.copy(_c);
    this.sun.position.copy(_c).addScaledVector(this.sunDir, 160);
    this.sun.target.updateMatrixWorld();
  }

  render(time: number) {
    if (this.contextLost) return;
    const now = performance.now();
    const dtReal = this.lastRender ? Math.min(0.25, (now - this.lastRender) / 1000) : 1 / 60;
    this.lastRender = now;
    const gl = this.gl;
    gl.info.reset();
    const q = QUALITY[this.quality];
    this.sky.uniforms.uTime.value = time;
    GLOBALS.uTime.value = time;
    this.scene.environment = this.sky.updateEnv(gl, dtReal, q.envEvery);
    const post = this.usePost ? this.post : null;
    if (post) {
      // The scene at its own resolution; the canvas (and the composite) at the screen's.
      const pr = gl.getPixelRatio();
      const rs = this.renderPixelRatio();
      post.setSize(this.width * rs, this.height * rs);
      const sx = post.width / this.width;
      const sy = post.height / this.height;
      const uv: [number, number, number, number][] = [];
      for (let i = 0; i < 2; i++) {
        const v = this.views[i];
        const r = v.rect;
        uv.push([r.x / this.width, 1 - (r.y + r.h) / this.height, (r.x + r.w) / this.width, 1 - r.y / this.height]);
        if (!v.active) continue;
        const x = Math.round(r.x * sx);
        const y = Math.round((this.height - r.y - r.h) * sy);
        const w = Math.round((r.x + r.w) * sx) - x;
        const h = Math.round((this.height - r.y) * sy) - y;
        post.hdr.viewport.set(x, y, w, h);
        post.hdr.scissor.set(x, y, w, h);
        post.hdr.scissorTest = true;
        gl.setRenderTarget(post.hdr);
        this.renderView(i);
        // Straight after the view, while the sun's shadow map and this camera are still the ones it was drawn with.
        post.screenFx(gl, { camera: v.camera, rect: { x, y, w, h }, sunDir: this.sunDir, shadow: this.sun.shadow, time });
      }
      post.hdr.scissorTest = false;
      const a = this.views[0].active ? uv[0] : uv[1];
      const b = this.views[1].active ? uv[1] : uv[0];
      post.setRects(a, b);
      const la = (this.views[0].active ? this.views[0] : this.views[1]).lens ?? 0;
      const lb = (this.views[1].active ? this.views[1] : this.views[0]).lens ?? 0;
      post.lens.set(la, lb);
      // Where each half's horizon crosses it, for the mirage: the level line straight ahead of the camera, projected.
      for (let i = 0; i < 2; i++) {
        const k = this.views[i].active ? i : 1 - i;
        const cam = this.views[k].camera;
        cam.getWorldDirection(_fwd);
        _fwd.y = 0;
        if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
        _c.copy(cam.position).addScaledVector(_fwd.normalize(), 900).project(cam);
        const r = uv[k];
        post.horizon.setComponent(i, r[1] + (r[3] - r[1]) * (_c.y * 0.5 + 0.5));
      }
      if (!this.views[0].active) post.heat.set(post.heat.y, post.heat.y);
      else if (!this.views[1].active) post.heat.set(post.heat.x, post.heat.x);
      gl.setRenderTarget(null);
      gl.setViewport(0, 0, this.width, this.height);
      gl.setScissorTest(false);
      post.finish(gl, time, this.width * pr, this.height * pr, this.fade);
      return;
    }
    gl.setRenderTarget(null);
    gl.setScissorTest(true);
    for (let i = 0; i < 2; i++) {
      const v = this.views[i];
      if (!v.active) continue;
      const r = v.rect;
      // three's setViewport/setScissor take CSS pixels with y from the bottom.
      const y = this.height - (r.y + r.h);
      gl.setViewport(r.x, y, r.w, r.h);
      gl.setScissor(r.x, y, r.w, r.h);
      this.renderView(i);
    }
    gl.setScissorTest(false);
  }

  /**
   * Past the fog's far end everything is fog colour, the same as the sky's horizon, so the view stops there and
   * nothing beyond it is culled, sorted or drawn. Never inside the sky dome (radius 1000).
   */
  private fitFar(cam: THREE.PerspectiveCamera) {
    const far = Math.min(VIEW_FAR, Math.max(1150, this.fog.far * 1.05 + 60));
    if (Math.abs(cam.far - far) < 1) return;
    cam.far = far;
    cam.updateProjectionMatrix();
  }

  private renderView(i: number) {
    const v = this.views[i];
    // World markers size themselves in screen pixels of this view (a split-screen half is half as tall).
    v.camera.userData.viewH = v.rect.h;
    this.fitFar(v.camera);
    this.sky.mesh.position.copy(v.camera.position);
    this.aimShadow(v);
    for (const cb of this.onBeforeView) cb(i, v.camera);
    const bent = this.beginTripView(i);
    this.gl.render(this.scene, v.camera);
    if (bent) this.endTripView();
    for (const cb of this.onAfterView) cb(i);
  }
}
