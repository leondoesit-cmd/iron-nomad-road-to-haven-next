import * as THREE from 'three';
import { fbm } from './proctex';
import { shared } from './dispose';
import { GUN_POINTS } from '../sim/weaponanim';
import { MUZZLE } from '../sim/weaponfx';
import type { GunModel } from '../data/gear';

/**
 * The flash at a gun's muzzle, drawn as a real one looks: from in front a white-hot core with uneven petals of flame round
 * it, from the side a tongue of fire thrown out along the barrel with a bright bulb at the muzzle. Each shot has its own
 * shape (which petals, which tongue, turned about the barrel, a little bigger or smaller), and it is gone in a couple of
 * frames, fading and swelling as it goes. Sized per gun from `MUZZLE` (a pistol's is a hand across, a shotgun's a forearm).
 */

/** Cells across the texture: two front-on stars, then two side-on tongues. */
const CELL = 128;
const CELLS = 4;

const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Small seeded random numbers, so the petals come out the same every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let texture: THREE.DataTexture | null = null;

/** The flash texture, made once: brightness in alpha, colour running from white-hot through orange to deep red at the rim. */
function flashTexture(): THREE.DataTexture {
  if (texture) return texture;
  const W = CELL * CELLS;
  const out = new Uint8Array(W * CELL * 4);
  const grain = fbm(CELL, 8, { octaves: 4, seed: 61 });
  const streak = fbm(CELL, 4, { octaves: 3, px: 3, py: 16, seed: 62 });
  const put = (cell: number, x: number, y: number, i: number) => {
    const o = (y * W + cell * CELL + x) * 4;
    // Colour by brightness: a deep red rim, orange flame, a white-hot heart.
    const hot = smooth(0.5, 0.95, i);
    const mid = smooth(0.08, 0.5, i);
    const r = 0.85 + 0.15 * mid;
    const g = (0.22 + 0.45 * mid) * (1 - hot) + 0.95 * hot;
    const b = (0.05 + 0.18 * mid) * (1 - hot) + 0.8 * hot;
    out[o] = Math.round(sat(r) * 255);
    out[o + 1] = Math.round(sat(g) * 255);
    out[o + 2] = Math.round(sat(b) * 255);
    out[o + 3] = Math.round(sat(i) * 255);
  };
  // Front on: a core and five or seven petals of uneven length.
  for (let v = 0; v < 2; v++) {
    const petals = v === 0 ? 5 : 7;
    const rand = rng(17 + v * 31);
    const len = Array.from({ length: petals }, () => 0.5 + rand() * 0.45);
    const twist = rand();
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const dx = (x + 0.5) / CELL - 0.5;
        const dy = (y + 0.5) / CELL - 0.5;
        const r = Math.hypot(dx, dy) * 2;
        const a = ((Math.atan2(dy, dx) / (Math.PI * 2) + 1) * petals + twist) % petals;
        const k = Math.floor(a);
        const off = Math.abs(a - k - 0.5) * 2;
        const L = len[k];
        // A petal narrows to a point at its tip.
        const shape = Math.pow(sat(1 - r / L), 0.75) - off;
        const petal = smooth(0, 0.3, shape) * Math.pow(sat(1 - r / L), 0.45);
        const core = Math.exp(-((r / 0.2) ** 2));
        const haze = Math.exp(-((r / 0.5) ** 2)) * 0.22;
        const n = grain[y * CELL + x];
        const i = Math.max(core, petal * (0.6 + 0.7 * n), haze) * smooth(1, 0.85, r);
        put(v, x, y, i);
      }
    }
  }
  // Side on: x runs out from the muzzle along the barrel, y across it.
  for (let v = 0; v < 2; v++) {
    const rand = rng(91 + v * 13);
    const bulge = 0.4 + rand() * 0.15;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const u = (x + 0.5) / CELL;
        const w = (y + 0.5) / CELL - 0.5;
        const n = grain[y * CELL + x];
        const s = streak[y * CELL + x];
        // A tongue that swells out of the muzzle, ragged along its length, and burns out before the end of the cell.
        const width = (0.05 + 0.3 * Math.sin(Math.PI * Math.pow(u, 0.65)) * Math.pow(1 - u, 0.35)) * (v === 0 ? 0.85 : 1.05) * (0.75 + 0.5 * n);
        const body = Math.exp(-((w / width) ** 2) * 2.2) * smooth(0, 0.05, u) * (1 - smooth(0.5, 0.98, u));
        // The bright bulb at the muzzle, and a second one further out where the gas front stalls.
        const bulb = Math.exp(-(((u - 0.1) / 0.09) ** 2) - (w / 0.09) ** 2);
        const front = v === 1 ? 0.55 * Math.exp(-(((u - bulge) / 0.07) ** 2) - (w / 0.11) ** 2) : 0;
        const i = Math.max(bulb, body * (0.55 + 0.75 * s), front) * smooth(0.5, 0.42, Math.abs(w));
        put(2 + v, x, y, i);
      }
    }
  }
  const t = new THREE.DataTexture(out, W, CELL, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  texture = shared(t);
  return texture;
}

/** A unit quad facing +z (the barrel), showing star cell `cell`. */
function starGeometry(cell: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, (cell + uv.getX(i)) / CELLS);
  return shared(g);
}

/** A unit quad lying along the barrel (z from 0 to 1, x across), showing tongue cell `cell`. */
function tongueGeometry(cell: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 1, -0.5, 0, 1], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([cell / CELLS, 0, cell / CELLS, 1, (cell + 1) / CELLS, 1, (cell + 1) / CELLS, 0], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return shared(g);
}

let geos: { star: THREE.BufferGeometry[]; tongue: THREE.BufferGeometry[] } | null = null;
const geometries = () => (geos ??= { star: [starGeometry(0), starGeometry(1)], tongue: [tongueGeometry(2), tongueGeometry(3)] });

/** Brightness of the flash material at the instant of the shot, before the picture's exposure (it feeds the bloom). */
const HEAT = 4.5;

// Each quad fades as it turns edge-on to the eye, so a flat card never shows as a bright line.
const VERT = /* glsl */ `
varying vec2 vUv;
varying float vFace;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vFace = abs( dot( normalize( normalMatrix * normal ), normalize( -mv.xyz ) ) );
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec3 color;
varying vec2 vUv;
varying float vFace;
void main() {
  vec4 t = texture2D( map, vUv );
  float a = t.a * smoothstep( 0.1, 0.5, vFace );
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( t.rgb * color, a );
}`;

export class MuzzleFlash {
  /** Put this at the muzzle with +z down the barrel; `setGun` does that for a gun held in the hand. */
  readonly group = new THREE.Group();
  private star: THREE.Mesh;
  private tongues: THREE.Mesh[];
  private mat: THREE.ShaderMaterial;
  private size = { star: 0.1, tongue: 0.14 };
  private tint = new THREE.Color(1, 0.85, 0.55);
  private k = 0;
  /** This shot's own size and length. */
  private jitter = { s: 1, l: 1 };

  constructor() {
    const g = geometries();
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: flashTexture() }, color: { value: new THREE.Color() } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.star = new THREE.Mesh(g.star[0], this.mat);
    this.tongues = [0, 1].map((i) => {
      const m = new THREE.Mesh(g.tongue[0], this.mat);
      m.rotation.z = (i * Math.PI) / 2;
      return m;
    });
    for (const m of [this.star, ...this.tongues]) {
      m.frustumCulled = false;
      m.renderOrder = 6;
      this.group.add(m);
    }
    this.group.visible = false;
  }

  /** Fit the flash to a gun: at its muzzle, its size and colour. Null for something that does not flash. */
  setGun(model: GunModel | null) {
    if (!model) {
      this.set(0);
      return;
    }
    const mz = GUN_POINTS[model].muzzle;
    this.group.position.set(mz[0], mz[1], mz[2] + 0.005);
    const m = MUZZLE[model];
    this.size.star = m.star;
    this.size.tongue = m.tongue;
    this.tint.setRGB(m.tint[0], m.tint[1], m.tint[2]);
  }

  /**
   * How much of the flash is left this frame: 1 at the instant of the shot, falling to 0 a couple of frames later. A rise
   * means a new shot, and a new shape.
   */
  set(k: number) {
    if (k <= 0) {
      this.k = 0;
      this.group.visible = false;
      return;
    }
    if (this.k === 0 || k > this.k + 1e-3) this.shape();
    this.k = k;
    this.group.visible = true;
    // It fades as the gas cools and spreads a little as it goes.
    const grow = 1.15 - 0.15 * k;
    const s = this.size.star * this.jitter.s * grow;
    this.star.scale.set(s, s, 1);
    const l = this.size.tongue * this.jitter.l * grow;
    for (const t of this.tongues) t.scale.set(l * 0.55, 1, l);
    (this.mat.uniforms.color.value as THREE.Color).copy(this.tint).multiplyScalar(HEAT * Math.pow(k, 0.8));
  }

  /** A new shape for a new shot. */
  private shape() {
    const g = geometries();
    this.star.geometry = g.star[Math.random() < 0.5 ? 0 : 1];
    const tongue = g.tongue[Math.random() < 0.5 ? 0 : 1];
    for (const t of this.tongues) t.geometry = tongue;
    this.group.rotation.z = Math.random() * Math.PI * 2;
    this.star.rotation.z = Math.random() * Math.PI * 2;
    this.jitter.s = 0.8 + Math.random() * 0.4;
    this.jitter.l = 0.75 + Math.random() * 0.5;
  }

  get visible() {
    return this.group.visible;
  }

  /** Left this frame, 0 to 1 (0 when out). */
  get amount() {
    return this.k;
  }
}
