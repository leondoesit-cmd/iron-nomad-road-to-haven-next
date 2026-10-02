import * as THREE from 'three';
import { DEG, lerp } from '../core/math';
import type { LightState } from '../sim/dayclock';
import { installAtmosphere, setAtmosphere } from './atmosphere';
import { GLOBALS, KIT } from './materials';
import { PostFX } from './post';
import { SkyDome } from './sky';

// Fog chunks must be replaced before the first material compiles.
installAtmosphere();

export type QualityPreset = 'low' | 'medium' | 'high';
export interface QualitySpec {
  scale: number;
  shadow: number;
  zombies: number;
  draw: number;
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
  low: { scale: 0.7, shadow: 1024, zombies: 40, draw: 240, particles: 0.5, post: false, msaa: 0, scatter: 0.3, envEvery: 4 },
  medium: { scale: 0.85, shadow: 2048, zombies: 60, draw: 330, particles: 1, post: true, msaa: 4, scatter: 0.65, envEvery: 1 },
  high: { scale: 1.0, shadow: 4096, zombies: 80, draw: 420, particles: 1, post: true, msaa: 4, scatter: 1, envEvery: 0.5 },
};

export type SplitLayout = 'horizontal' | 'vertical';

export interface PlayerView {
  camera: THREE.PerspectiveCamera;
  /** Pixels in CSS space, origin top-left. */
  rect: { x: number; y: number; w: number; h: number };
  /** Point the shadow frustum and sky follow. */
  focus: THREE.Vector3;
  active: boolean;
  /** This view is a first-person camera: a taller field of view than the chase strip. */
  first?: boolean;
}

/** Horizontal FOV is fixed at 100 degrees; vertical is derived with a floor of 32 degrees. */
export function fovFor(aspect: number, hfovDeg = 100, vfovMinDeg = 32) {
  const v = 2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) / aspect) / DEG;
  return Math.max(vfovMinDeg, v);
}

/** Vertical FOV used in the left/right layout, where a fixed 100 degree horizontal FOV would be a fisheye on a tall half. */
export const VERTICAL_SPLIT_VFOV = 66;

/** FOV for a view: fixed horizontal FOV for the wide strips, a fixed vertical FOV for the left/right halves. */
export function viewFov(aspect: number, layout: SplitLayout) {
  const strip = fovFor(aspect);
  return layout === 'vertical' ? Math.min(VERTICAL_SPLIT_VFOV, strip) : strip;
}

/** First person needs more height than the chase strip's 32 degree floor, so the vertical FOV has a higher floor and a cap. */
export function firstPersonFov(aspect: number, layout: SplitLayout, hfovDeg: number) {
  const v = fovFor(aspect, hfovDeg, 50);
  return layout === 'vertical' ? Math.min(v, 85) : v;
}

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
  private frameEma = 16;
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
  fpHfov = 100;
  contextLost = false;
  onContextRestored: () => void = () => {};
  /** 0..1 fade to black applied in the composite (scene transitions). */
  fade = 1;
  private floatOk = true;

  constructor(public canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.baseDpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.floatOk = this.gl.extensions.has('EXT_color_buffer_float') || this.gl.extensions.has('EXT_color_buffer_half_float');
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.autoClear = true;
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

    const mkView = (): PlayerView => ({ camera: new THREE.PerspectiveCamera(37, 3.56, 0.2, 2600), rect: { x: 0, y: 0, w: 1, h: 1 }, focus: new THREE.Vector3(), active: true });
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

  get usePost() {
    return QUALITY[this.quality].post && this.floatOk;
  }

  private applyQuality() {
    const q = QUALITY[this.quality];
    this.setShadowSize(q.shadow);
    if (this.usePost) {
      if (!this.post) this.post = new PostFX(q.msaa);
      this.gl.setPixelRatio(this.baseDpr * q.scale);
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
    v.camera.fov = v.first ? firstPersonFov(v.camera.aspect, layout, this.fpHfov) : viewFov(v.camera.aspect, layout);
    v.camera.updateProjectionMatrix();
  }

  /** Switch a view between the chase strip and first person. Cheap to call every frame: it only rebuilds the projection on a change. */
  setViewMode(i: number, first: boolean, hfov = this.fpHfov) {
    const v = this.views[i];
    if (!!v.first === first && this.fpHfov === hfov) return;
    v.first = first;
    this.fpHfov = hfov;
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
    return this.gl.getPixelRatio() * (this.usePost ? this.postScale() : 1);
  }

  private postScale() {
    return Math.round(this.renderScale * 20) / 20;
  }

  /** Apply time-of-day lighting. */
  setLight(l: LightState, biome: 'wasteland' | 'city') {
    this.sky.mesh.visible = true;
    this.night = l.night;
    const e = l.elevation;
    const az = l.azimuth;
    const hz = Math.sqrt(Math.max(0.05, 1 - e * e));
    this.sunDir.set(Math.cos(az) * hz, e, Math.sin(az) * hz).normalize();
    this.sun.color.setRGB(...l.sunColor);
    this.sun.intensity = l.sunIntensity * 1.05;
    // The day-clock palette is authored as display (sRGB) colours.
    this.hemi.color.setRGB(...l.hemiSky, THREE.SRGBColorSpace);
    this.hemi.groundColor.setRGB(...l.hemiGround, THREE.SRGBColorSpace);
    this.hemi.intensity = l.hemiIntensity * 0.3;
    this.fog.color.setRGB(...l.fog, THREE.SRGBColorSpace);
    const dist = QUALITY[this.quality].draw;
    const city = biome === 'city';
    // The wasteland has far scenery out to the mountains, so its fog is mostly height haze; the city's
    // skyline sits close behind the corridor.
    this.fog.near = lerp(city ? 60 : 160, 22, l.night);
    this.fog.far = lerp(city ? Math.min(dist * 1.6, 520) : dist * 3.2, 170, l.night);
    const u = this.sky.uniforms;
    u.uSunDir.value.copy(this.sunDir);
    u.uSunColor.value.setRGB(...l.sunColor);
    u.uHorizon.value.copy(this.fog.color);
    // Zenith: deep blue by day (greyer over the city), violet at dusk, near black at night.
    const dusk = Math.min(1, Math.max(0, (l.sky[0] - l.sky[2] - 0.12) / 0.48));
    // ACES pulls saturated blue toward violet, so the authored zenith leans cyan.
    const zd = city ? [0.4, 0.52, 0.62] : [0.2, 0.47, 0.76];
    _z.setRGB(zd[0], zd[1], zd[2], THREE.SRGBColorSpace);
    _z2.setRGB(0.3, 0.29, 0.5, THREE.SRGBColorSpace);
    _z.lerp(_z2, dusk);
    _z2.setRGB(0.012, 0.018, 0.045, THREE.SRGBColorSpace);
    u.uZenith.value.copy(_z.lerp(_z2, l.night));
    u.uGround.value.setRGB(l.hemiGround[0] * 0.8, l.hemiGround[1] * 0.75, l.hemiGround[2] * 0.7, THREE.SRGBColorSpace);
    u.uNight.value = l.night;
    u.uCloud.value = city ? 0.55 : 0.4;
    u.uMoonDir.value.set(-this.sunDir.x, Math.max(0.35, this.sunDir.y), -this.sunDir.z).normalize();
    const scatter = lerp(0.55, 0.12, l.night);
    u.uScatter.value = scatter;
    setAtmosphere(this.sunDir, this.sun.color, scatter, lerp(city ? 0.0035 : 0.0016, 0.006, l.night), city ? 0.03 : 0.045, city ? 2 : 0);
    this.scene.environmentIntensity = lerp(0.85, 0.35, l.night);
    GLOBALS.uLight.value
      .copy(this.sun.color)
      .multiplyScalar(this.sun.intensity * 0.22)
      .add(_z.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 0.9 + 0.12));
    KIT.uGlow.value = 1 + l.night * 0.9;
    // Exposure opens up a little at night so headlights read without crushing everything else.
    if (this.post) {
      const p = this.post.params;
      p.exposure = lerp(1.0, 1.7, l.night);
      p.saturation = lerp(city ? 0.92 : 1.04, 0.85, l.night);
      p.bloom = lerp(0.025, 0.035, l.night);
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
    this.frameEma = lerp(this.frameEma, frameMs, 0.06);
    const q = QUALITY[this.quality];
    if (this.frameEma > 21 && this.renderScale > 0.6) this.renderScale -= 0.01;
    else if (this.frameEma < 15.5 && this.renderScale < 1) this.renderScale = Math.min(1, this.renderScale + 0.005);
    if (!this.usePost) this.gl.setPixelRatio(this.baseDpr * q.scale * this.renderScale);
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
    const q = QUALITY[this.quality];
    this.sky.uniforms.uTime.value = time;
    GLOBALS.uTime.value = time;
    this.scene.environment = this.sky.updateEnv(gl, dtReal, q.envEvery);
    const post = this.usePost ? this.post : null;
    if (post) {
      const pr = gl.getPixelRatio();
      const s = this.postScale();
      post.setSize(this.width * pr * s, this.height * pr * s);
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
      }
      post.hdr.scissorTest = false;
      const a = this.views[0].active ? uv[0] : uv[1];
      const b = this.views[1].active ? uv[1] : uv[0];
      post.setRects(a, b);
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

  private renderView(i: number) {
    const v = this.views[i];
    this.sky.mesh.position.copy(v.camera.position);
    this.aimShadow(v);
    for (const cb of this.onBeforeView) cb(i, v.camera);
    this.gl.render(this.scene, v.camera);
    for (const cb of this.onAfterView) cb(i);
  }
}

