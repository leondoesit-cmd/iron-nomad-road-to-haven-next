import * as THREE from 'three';
import { Sparks } from './sparks';
import { atmoUniforms } from './atmosphere';
import { GLOBALS } from './materials';
import { smokeTexture } from './proctex';
import { FIRE_PARS, fireUniforms } from './fireLight';
import type { MuzzleFx } from '../sim/weaponfx';

/** Accumulate ranges until WebGL consumes them; several simulation steps may precede one draw. */
function uploadRange(geo: THREE.BufferGeometry, name: string, first: number, last: number) {
  if (last < first) return;
  const attribute = geo.getAttribute(name) as THREE.BufferAttribute;
  attribute.addUpdateRange(first * attribute.itemSize, (last - first + 1) * attribute.itemSize);
  attribute.needsUpdate = true;
}

/** Dense CPU iteration over live slots; GPU slots keep their original order for alpha blending. */
class LiveSlots {
  readonly indices: Uint32Array;
  private positions: Int32Array;
  count = 0;
  first = Infinity;
  last = -1;
  private boundsDirty = false;
  constructor(n: number) {
    this.indices = new Uint32Array(n);
    this.positions = new Int32Array(n).fill(-1);
  }
  add(slot: number) {
    if (this.positions[slot] >= 0) return;
    this.positions[slot] = this.count;
    this.indices[this.count++] = slot;
    this.first = Math.min(this.first, slot);
    this.last = Math.max(this.last, slot);
  }
  removeAt(index: number) {
    const slot = this.indices[index], moved = this.indices[--this.count];
    this.indices[index] = moved;
    this.positions[moved] = index;
    this.positions[slot] = -1;
    if (slot === this.first || slot === this.last) this.boundsDirty = true;
  }
  refreshBounds() {
    if (!this.boundsDirty) return;
    this.first = Infinity;
    this.last = -1;
    for (let k = 0; k < this.count; k++) {
      const slot = this.indices[k];
      this.first = Math.min(this.first, slot);
      this.last = Math.max(this.last, slot);
    }
    this.boundsDirty = false;
  }
}

const vert = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
attribute float aRot;
attribute float aBlood;
attribute vec3 aVelocity;
varying vec4 vColor;
varying float vRot;
varying float vDepth;
varying float vBlood;
varying float vStretch;
varying vec3 vFire;
uniform float uScale;
uniform float uLit;
${FIRE_PARS}
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vRot = aRot;
  vBlood = aBlood;
  vec3 motion = ( modelViewMatrix * vec4( aVelocity, 0.0 ) ).xyz;
  vStretch = aBlood * clamp( length( motion.xy ) * 0.12, 0.0, 1.8 );
  if ( aBlood > 0.5 && length( motion.xy ) > 0.1 ) vRot = atan( motion.y, motion.x );
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * ( 1.0 + vStretch ) * uScale / max( 0.1, -mvPosition.z );
  vDepth = -mvPosition.z;
  // Smoke and dust over a fire glow with it from below.
  vFire = vec3( 0.0 );
  if ( uLit > 0.5 && fireLightInfo.x > 0.5 ) {
    for ( int i = 0; i < FIRE_MAX; i ++ ) {
      if ( float( i ) >= fireLightInfo.x ) break;
      vFire += fireIrradiance( i, position );
    }
  }
  #include <fog_vertex>
}`;
const frag = /* glsl */ `
uniform sampler2D tPuff;
uniform vec3 uLight;
uniform float uLit;
varying vec4 vColor;
varying float vRot;
varying float vDepth;
varying float vBlood;
varying float vStretch;
varying vec3 vFire;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float s = sin( vRot );
  float k = cos( vRot );
  vec2 uv = vec2( c.x * k - c.y * s, c.x * s + c.y * k ) + 0.5;
  if ( vBlood > 0.5 ) {
    // Dense liquid drops stretch along their motion, with a small wet highlight.
    vec2 drop = uv - 0.5;
    drop.y *= 1.0 + vStretch;
    float radius = length( drop );
    float edge = 1.0 - smoothstep( 0.32, 0.47, radius );
    float a = edge * vColor.a * smoothstep( 0.18, 0.9, vDepth );
    if ( a < 0.004 ) discard;
    float glint = exp( -dot( drop - vec2( -0.10, -0.12 ), drop - vec2( -0.10, -0.12 ) ) * 160.0 );
    vec3 col = vColor.rgb * uLight * ( 0.55 + 0.45 * edge ) + uLight * glint * 0.16;
    gl_FragColor = vec4( col, a );
    #include <fog_fragment>
    return;
  }
  vec4 t = texture2D( tPuff, uv );
  // Fade sprites that get right up to the lens instead of filling the screen.
  float a = mix( smoothstep( 1.0, 0.25, length( c ) * 2.0 ), t.a, uLit ) * vColor.a * smoothstep( 0.18, 0.9, vDepth );
  if ( a < 0.004 ) discard;
  vec3 col = vColor.rgb * mix( vec3( 1.0 ), uLight * ( 0.7 + t.r * 0.45 ) + min( vFire, vec3( 3.0 ) ) * ( 0.14 + t.r * 0.12 ), uLit );
  gl_FragColor = vec4( col, a );
  #include <fog_fragment>
}`;

/** One pool of CPU-simulated sprites. Two instances exist: alpha for smoke and dust, additive for fire and flashes. */
export class ParticleLayer {
  points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private a0: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private rot: Float32Array;
  private spin: Float32Array;
  private blood: Float32Array;
  /** How far each sprite's drift settles to the wind instead of to still air (0 = still air, 1 = the full wind). */
  private carry: Float32Array;
  private next = 0;
  private active: LiveSlots;
  private bloodFirst = Infinity;
  private bloodLast = -1;
  private uniforms: Record<string, THREE.IUniform>;
  private geo: THREE.BufferGeometry;
  budget = 1;
  /** The wind at ground level, m/s along x and z, that carried sprites drift with. */
  wind: [number, number] = [0, 0];

  constructor(n: number, additive: boolean) {
    this.n = n;
    this.active = new LiveSlots(n);
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.size = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n).fill(1);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.blood = new Float32Array(n);
    this.carry = new Float32Array(n);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aBlood', new THREE.BufferAttribute(this.blood, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aVelocity', new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    // Smoke and dust are lit by the scene and fade into the haze; additive glow stays self-lit.
    this.uniforms = {
      ...atmoUniforms(),
      ...fireUniforms(),
      uScale: { value: 800 },
      tPuff: { value: smokeTexture() },
      uLight: GLOBALS.uLight,
      uLit: { value: additive ? 0 : 1 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      fog: !additive,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.visible = false;
    this.geo.setDrawRange(0, 0);
  }

  setViewScale(viewHeightPx: number, fovDeg: number) {
    // Size in world metres projected: pixels = size * scale / depth, scale = H / (2 tan(fov/2)).
    this.uniforms.uScale.value = viewHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, a: number, gravity = 0, drag = 0.5, blood = false, carry = 0) {
    if (this.budget < 1 && Math.random() > this.budget) return;
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.a0[i] = a;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.spin[i] = (Math.random() - 0.5) * 1.2;
    this.blood[i] = blood ? 1 : 0;
    this.carry[i] = carry;
    this.active.add(i);
    this.bloodFirst = Math.min(this.bloodFirst, i);
    this.bloodLast = Math.max(this.bloodLast, i);
  }

  update(dt: number) {
    this.active.refreshBounds();
    const first = this.active.first, last = this.active.last;
    for (let k = 0; k < this.active.count;) {
      const i = this.active.indices[k];
      if (this.life[i] <= 0) {
        this.col[i * 4 + 3] = 0;
        this.size[i] = 0;
        this.active.removeAt(k);
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const damping = Math.exp(-this.drag[i] * dt);
      const cx = this.wind[0] * this.carry[i], cz = this.wind[1] * this.carry[i];
      this.vel[i * 3] = cx + (this.vel[i * 3] - cx) * damping;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * damping - this.grav[i] * dt;
      this.vel[i * 3 + 2] = cz + (this.vel[i * 3 + 2] - cz) * damping;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.rot[i] += this.spin[i] * dt;
      this.col[i * 4 + 3] = this.blood[i]
        ? this.a0[i] * (1 - THREE.MathUtils.smoothstep(t, 0.55, 1))
        : this.a0[i] * (1 - t) * (t < 0.08 ? t / 0.08 : 1);
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        this.active.removeAt(k);
      } else k++;
    }
    if (last >= first) for (const name of ['position', 'aColor', 'aSize', 'aRot', 'aVelocity']) uploadRange(this.geo, name, first, last);
    uploadRange(this.geo, 'aBlood', this.bloodFirst, this.bloodLast);
    this.bloodFirst = Infinity;
    this.bloodLast = -1;
    this.active.refreshBounds();
    const drawFirst = this.active.first, drawLast = this.active.last;
    // Keep the original slot order for alpha blending; holes stay invisible instead of swapping sprites.
    this.geo.setDrawRange(drawLast < 0 ? 0 : drawFirst, drawLast < 0 ? 0 : drawLast - drawFirst + 1);
    this.points.visible = drawLast >= 0;
  }
}

/** Seconds for the powder smoke hanging where a gun went off to clear enough that a fresh shot there reads at full strength. */
const HAZE_TAU = 1.6;
/** How close (m) a shot has to be to earlier ones to be fired into their smoke. */
const HAZE_REACH = 2.5;
/** A spot where guns have gone off lately and how much of their smoke still hangs there (one shot = 1, fading over `HAZE_TAU`). */
type Haze = { x: number; y: number; z: number; load: number };

export class Particles {
  smoke = new ParticleLayer(3000, false);
  glow = new ParticleLayer(1500, true);
  /** Sparks: hot streaks a pixel wide (`render/sparks.ts`). */
  sparks = new Sparks();
  /** The wind at ground level, m/s along x and z, that carries powder smoke off. Set every frame by the scene. */
  wind: [number, number] = [0, 0];
  private haze: Haze[] = [];

  setBudget(b: number) {
    this.smoke.budget = b;
    this.glow.budget = b;
    this.sparks.budget = b;
  }

  update(dt: number) {
    this.smoke.wind = this.wind;
    this.smoke.update(dt);
    this.glow.update(dt);
    this.sparks.update(dt);
    const fade = Math.exp(-dt / HAZE_TAU);
    for (let i = this.haze.length - 1; i >= 0; i--) {
      this.haze[i].load *= fade;
      if (this.haze[i].load < 0.05) this.haze.splice(i, 1);
    }
  }

  /**
   * How much of a shot's smoke to put out here: all of it into clean air, less and less into air its own earlier shots
   * have already fogged. However fast a gun fires, the smoke round it builds to about what two shots a second would leave.
   */
  private hazeThin(x: number, y: number, z: number): number {
    let spot: Haze | null = null;
    let best = HAZE_REACH * HAZE_REACH;
    for (const h of this.haze) {
      const d = (h.x - x) ** 2 + (h.y - y) ** 2 + (h.z - z) ** 2;
      if (d < best) {
        best = d;
        spot = h;
      }
    }
    if (!spot) {
      if (this.haze.length >= 16) this.haze.sort((a, b) => b.load - a.load).pop();
      spot = { x, y, z, load: 0 };
      this.haze.push(spot);
    }
    const thin = 1 / (1 + 0.3 * spot.load);
    spot.load += 1;
    spot.x = x;
    spot.y = y;
    spot.z = z;
    return thin;
  }

  setViewScale(h: number, fov: number) {
    this.smoke.setViewScale(h, fov);
    this.glow.setViewScale(h, fov);
  }

  // ---- ready-made effects ------------------------------------------------

  dust(x: number, y: number, z: number, vx: number, vz: number, strength = 1, tint: [number, number, number] = [0.72, 0.6, 0.42]) {
    this.smoke.emit(x + (Math.random() - 0.5) * 0.4, y + 0.1, z + (Math.random() - 0.5) * 0.4, vx * 0.15 + (Math.random() - 0.5) * 0.8, 0.8 + Math.random() * 0.8, vz * 0.15 + (Math.random() - 0.5) * 0.8, 1.2 + Math.random() * 1.2, 0.9 * strength, 3.4 * strength, tint[0], tint[1], tint[2], 0.42, -0.2, 1.4);
  }

  puff(x: number, y: number, z: number, r = 0.7, g = 0.7, b = 0.7, size = 1.5, life = 0.9) {
    this.smoke.emit(x, y, z, (Math.random() - 0.5) * 1.5, 0.8 + Math.random(), (Math.random() - 0.5) * 1.5, life, size * 0.5, size * 2, r, g, b, 0.5, -0.4, 1.2);
  }

  /**
   * Rubber smoke off a tyre scrubbing the tarmac: low, pale and spreading, a little of the car's way carried into it, so a
   * slide trails a hanging cloud rather than a row of puffs. `strength` 0..1 is how hard the tyre is scrubbing.
   */
  tyreSmoke(x: number, y: number, z: number, vx: number, vz: number, strength = 1) {
    const k = Math.min(1, Math.max(0, strength));
    this.smoke.emit(
      x + (Math.random() - 0.5) * 0.3, y + 0.08, z + (Math.random() - 0.5) * 0.3,
      vx * 0.25 + (Math.random() - 0.5) * 0.7, 0.3 + Math.random() * 0.45, vz * 0.25 + (Math.random() - 0.5) * 0.7,
      1.1 + Math.random() * 1.5 * k, 0.3 + 0.25 * k, 2.4 + 2.4 * k, 0.86, 0.86, 0.88, 0.22 + 0.2 * k, -0.12, 1.7,
    );
  }

  blackSmoke(x: number, y: number, z: number) {
    this.smoke.emit(x + (Math.random() - 0.5) * 0.3, y, z + (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.6, 1.8 + Math.random(), (Math.random() - 0.5) * 0.6, 1.8, 0.4, 2.2, 0.08, 0.08, 0.08, 0.6, -0.5, 0.6);
  }

  /** A flame sprite. `deep` makes it a darker red-orange, for the body of a fire that would otherwise wash out pale against a bright sky. */
  fire(x: number, y: number, z: number, scale = 1, deep = false) {
    this.glow.emit(x + (Math.random() - 0.5) * 0.4 * scale, y, z + (Math.random() - 0.5) * 0.4 * scale, (Math.random() - 0.5) * 0.8, 1.6 + Math.random() * 1.4, (Math.random() - 0.5) * 0.8, 0.55 + Math.random() * 0.3, 0.8 * scale, 0.1, 1.0, deep ? 0.3 : 0.55, deep ? 0.05 : 0.15, deep ? 0.7 : 0.9, -1, 1.0);
  }

  /** A spray of sparks up and out of a point (a grinder, a scrape, a blow with no one face to it). Always small: `n` is how many. */
  spark(x: number, y: number, z: number, n = 6, speed = 6) {
    this.sparks.shower(x, y, z, 0, 1, 0, n, speed, 1.35);
    // The pinpoint flash where they came from.
    if (n > 0) this.glow.emit(x, y, z, 0, 0, 0, 0.05, 0.05, 0.015, 1, 0.85, 0.5, 0.9, 0, 0);
  }

  /**
   * Sparks off a surface (normal n) struck along (dx, dy, dz): they leave along the glance, the blow's direction turned off
   * the surface, a tight fan when it came in low and a wide splash back off it when it came in square. Only how many and
   * which way change with the blow, never how big they look.
   */
  sparkOff(x: number, y: number, z: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, n: number, speed: number) {
    if (n <= 0) return;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    const dn = dx * nx + dy * ny + dz * nz;
    // The glance: the blow's direction with its part into the surface turned back out, less (the surface takes most of it).
    const rx = dx - 1.6 * dn * nx;
    const ry = dy - 1.6 * dn * ny;
    const rz = dz - 1.6 * dn * nz;
    const square = Math.min(1, Math.abs(dn));
    this.sparks.shower(x + nx * 0.01, y + ny * 0.01, z + nz * 0.01, rx, ry, rz, n, speed * (1.15 - 0.4 * square), 0.25 + 1.0 * square);
    this.glow.emit(x + nx * 0.01, y + ny * 0.01, z + nz * 0.01, 0, 0, 0, 0.04, 0.05, 0.015, 1, 0.85, 0.5, 0.9, 0, 0);
  }

  blood(x: number, y: number, z: number, n = 6, color: [number, number, number] = [0.55, 0.06, 0.06]) {
    for (let i = 0; i < n; i++) {
      const size = 0.045 + Math.random() * 0.095;
      const shade = 0.7 + Math.random() * 0.4;
      this.smoke.emit(x, y, z, (Math.random() - 0.5) * 4, Math.random() * 3.5, (Math.random() - 0.5) * 4, 0.5 + Math.random() * 0.4, size, size * 0.55, color[0] * shade, color[1] * shade, color[2] * shade, 0.95, 9.81, 0.6, true);
    }
  }

  /**
   * A directional burst of blood: thrown along (dx, dy, dz), widening as it goes. An exit wound sprays forward with
   * speed; the entry side gets a short fine mist back toward the shooter.
   */
  bloodSpray(x: number, y: number, z: number, dx: number, dy: number, dz: number, n = 6, speed = 6, spread = 0.45, color: [number, number, number] = [0.55, 0.05, 0.05]) {
    for (let i = 0; i < n; i++) {
      const k = speed * (0.35 + Math.random() * 0.95);
      const size = 0.035 + Math.random() * 0.09;
      const shade = 0.65 + Math.random() * 0.55;
      this.smoke.emit(
        x,
        y,
        z,
        dx * k + (Math.random() - 0.5) * spread * speed,
        dy * k + (Math.random() - 0.3) * spread * speed,
        dz * k + (Math.random() - 0.5) * spread * speed,
        0.4 + Math.random() * 0.45,
        size,
        size * 0.6,
        color[0] * shade,
        color[1] * shade,
        color[2] * shade,
        0.95,
        9.81,
        0.5,
        true,
      );
    }
    // A fine pink mist hangs for a moment where the round went in.
    if (n > 2) this.smoke.emit(x, y, z, dx * 0.6, 0.3, dz * 0.6, 0.28, 0.16, 0.6, color[0], color[1], color[2], 0.22, 0, 2);
  }

  flash(x: number, y: number, z: number, size = 1.6) {
    this.glow.emit(x, y, z, 0, 0, 0, 0.07, size, size * 0.4, 1, 0.85, 0.4, 1, 0, 0);
  }

  /**
   * A gun going off, thrown down the line of the barrel. The flame itself is drawn on the gun (`MuzzleFlash`); here are the
   * soft glow round it, hot gas strung out along the muzzle's heading, burning grains flung out of it and the smoke that
   * stays behind. A shotgun is a bigger, longer, smokier version.
   */
  muzzle(x: number, y: number, z: number, dx: number, dy: number, dz: number, m: MuzzleFx) {
    const [r, g, b] = m.tint;
    this.glow.emit(x + dx * 0.04, y + dy * 0.04, z + dz * 0.04, dx * 1.5, dy * 1.5, dz * 1.5, 0.045, m.flash * 0.3, m.flash * 0.12, 1, 0.9, 0.65, 0.7, 0, 0);
    this.glow.emit(x + dx * 0.08, y + dy * 0.08, z + dz * 0.08, 0, 0, 0, 0.06, m.flash * 0.45, m.flash * 0.25, r, g * 0.8, b * 0.6, 0.13, 0, 0);
    for (let i = 0; i < m.cone; i++) {
      const t = (i + 0.5) / m.cone;
      const d = m.reach * t * 0.7;
      const w = (1 - t * 0.6) * m.flash * 0.16;
      this.glow.emit(x + dx * d + (Math.random() - 0.5) * 0.03, y + dy * d + (Math.random() - 0.5) * 0.03, z + dz * d + (Math.random() - 0.5) * 0.03, dx * 6, dy * 6, dz * 6, 0.035 + Math.random() * 0.03, w, w * 0.3, r, g * (1 - t * 0.35), b * (1 - t * 0.6), 0.45 - t * 0.2, 0, 0);
    }
    for (let i = 0; i < m.sparks; i++) {
      const k = 6 + Math.random() * 12;
      this.glow.emit(x + dx * 0.1, y + dy * 0.1, z + dz * 0.1, dx * k + (Math.random() - 0.5) * 5, dy * k + (Math.random() - 0.2) * 4, dz * k + (Math.random() - 0.5) * 5, 0.18 + Math.random() * 0.2, 0.07, 0.015, 1, 0.78, 0.35, 1, 12, 1.2);
    }
    // Powder smoke. Smokeless powder leaves little of it: a faint, ragged puff thrown out along the barrel that the air pulls
    // apart in a second or two. It is a few knots of thicker smoke in a thin veil, each its own size, shade and thickness, all
    // leaning the same way off a shared curl and then drifting off on the wind. Fired again into the same air a shot adds
    // less (`hazeThin`), so a long burst leaves a thin uneven haze rather than a grey wall.
    const thin = this.hazeThin(x, y, z);
    const ca = Math.random() * Math.PI * 2;
    const curl = 0.15 + Math.random() * 0.35;
    const cx = Math.cos(ca) * curl, cz = Math.sin(ca) * curl;
    const thick = 0.8 + 0.2 * m.flash;
    const knots = m.smoke * 0.9 * thin;
    for (let i = 0, n = Math.floor(knots + Math.random()); i < n; i++) {
      const k = 0.4 + Math.random() * 2.2;
      const d = 0.12 + Math.random() * (0.15 + m.reach * 0.4);
      const shade = 0.4 + Math.random() * 0.14;
      const a = (0.07 + 0.24 * Math.random() ** 2) * thick;
      const grow = 0.55 + Math.random() * 0.9;
      this.smoke.emit(x + dx * d, y + dy * d, z + dz * d, dx * k + cx + (Math.random() - 0.5) * 0.5, dy * k + 0.12 + Math.random() * 0.3, dz * k + cz + (Math.random() - 0.5) * 0.5, 0.8 + Math.random() * 1.4, (0.08 + m.flash * 0.06) * grow, (0.45 + m.flash * 0.35) * grow, shade, shade, shade + 0.03, a, -0.12, 1.6, false, 0.8);
    }
    // The thin veil round the muzzle, there only some of the time once the air is already fogged.
    if (Math.random() < thin) {
      const s = 0.7 + Math.random() * 0.6;
      this.smoke.emit(x + dx * 0.2, y + dy * 0.2, z + dz * 0.2, dx * 0.4 + cx * 0.5, 0.1 + Math.random() * 0.15, dz * 0.4 + cz * 0.5, 1.4 + Math.random() * 1.0, (0.2 + m.flash * 0.15) * s, (0.8 + m.flash * 0.55) * s, 0.48, 0.48, 0.5, (0.05 + 0.08 * Math.random()) * thick, -0.1, 1.2, false, 0.9);
    }
  }

  /** A thin wisp curling off a hot barrel or an open breech in the seconds after a shot. */
  wisp(x: number, y: number, z: number, strength = 1) {
    // Each wisp its own thickness, so the thread comes in strands and gaps, and the breeze bends it off the barrel.
    const a = (0.06 + 0.12 * strength) * (0.35 + Math.random() * 0.9);
    this.smoke.emit(x + (Math.random() - 0.5) * 0.02, y, z + (Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.12, 0.3 + Math.random() * 0.25, (Math.random() - 0.5) * 0.12, 0.9 + Math.random() * 0.9, 0.04 + 0.03 * strength, 0.2 + 0.12 * strength, 0.62, 0.62, 0.64, a, -0.15, 1.1, false, 0.5);
  }

  /** Embers and a lick of flame thrown out along the ground from where a burning bottle bursts. */
  fireSplash(x: number, y: number, z: number, radius: number) {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (1.5 + Math.random() * 4.5) * (radius / 3.6);
      this.glow.emit(x, y + 0.2, z, Math.cos(a) * s, 0.8 + Math.random() * 2.2, Math.sin(a) * s, 0.45 + Math.random() * 0.45, 0.9 + Math.random() * 0.6, 0.15, 1, 0.45 + Math.random() * 0.25, 0.1, 0.95, 2, 1.4);
    }
    for (let i = 0; i < 8; i++) this.blackSmoke(x + (Math.random() - 0.5) * radius, y + 0.3, z + (Math.random() - 0.5) * radius);
    this.flash(x, y + 0.5, z, radius * 1.1);
  }

  explosion(x: number, y: number, z: number, size = 1) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (2 + Math.random() * 7) * size;
      this.glow.emit(x, y + 0.4, z, Math.cos(a) * s, 2 + Math.random() * 6 * size, Math.sin(a) * s, 0.5 + Math.random() * 0.5, 2.2 * size, 0.2, 1, 0.5 + Math.random() * 0.3, 0.1, 1, 6, 1.2);
    }
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (1 + Math.random() * 4) * size;
      this.smoke.emit(x, y + 0.5, z, Math.cos(a) * s, 1.5 + Math.random() * 4, Math.sin(a) * s, 1.4 + Math.random(), 1.2 * size, 5 * size, 0.18, 0.16, 0.15, 0.7, -0.5, 1.0);
    }
    this.flash(x, y + 0.6, z, 6 * size);
  }
}

/** Short-lived bullet tracers: a hot head and a tail that dims, and the whole streak fades out over its life. */
export class Tracers {
  mesh: THREE.LineSegments;
  private pos: Float32Array;
  private col: Float32Array;
  private base: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private n: number;
  private next = 0;
  private active: LiveSlots;
  private positionFirst = Infinity;
  private positionLast = -1;
  private geo: THREE.BufferGeometry;

  constructor(n = 420) {
    this.n = n;
    this.active = new LiveSlots(n);
    this.pos = new Float32Array(n * 6);
    this.col = new Float32Array(n * 6);
    this.base = new Float32Array(n * 6);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n).fill(0.09);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.LineSegments(this.geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    this.geo.setDrawRange(0, 0);
  }

  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r = 1, g = 0.85, b = 0.45, life = 0.09) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos.set([ax, ay, az, bx, by, bz], i * 6);
    this.base.set([r * 0.25, g * 0.25, b * 0.25, r, g, b], i * 6);
    this.col.set(this.base.subarray(i * 6, i * 6 + 6), i * 6);
    this.life[i] = life;
    this.max[i] = life;
    this.active.add(i);
    this.positionFirst = Math.min(this.positionFirst, i);
    this.positionLast = Math.max(this.positionLast, i);
  }

  update(dt: number) {
    this.active.refreshBounds();
    const first = this.active.first, last = this.active.last;
    for (let k = 0; k < this.active.count;) {
      const i = this.active.indices[k];
      if (this.life[i] > 0) {
        this.life[i] -= dt;
        if (this.life[i] <= 0) {
          this.pos.fill(0, i * 6, i * 6 + 6);
          this.col.fill(0, i * 6, i * 6 + 6);
          this.positionFirst = Math.min(this.positionFirst, i);
          this.positionLast = Math.max(this.positionLast, i);
          this.active.removeAt(k);
        } else {
          const f = this.life[i] / this.max[i];
          for (let k = 0; k < 6; k++) this.col[i * 6 + k] = this.base[i * 6 + k] * f;
          k++;
        }
      } else {
        this.pos.fill(0, i * 6, i * 6 + 6);
        this.col.fill(0, i * 6, i * 6 + 6);
        this.positionFirst = Math.min(this.positionFirst, i);
        this.positionLast = Math.max(this.positionLast, i);
        this.active.removeAt(k);
      }
    }
    uploadRange(this.geo, 'position', this.positionFirst * 2, this.positionLast < 0 ? -1 : this.positionLast * 2 + 1);
    uploadRange(this.geo, 'color', first * 2, last < 0 ? -1 : last * 2 + 1);
    this.positionFirst = Infinity;
    this.positionLast = -1;
    this.active.refreshBounds();
    const drawFirst = this.active.first, drawLast = this.active.last;
    this.geo.setDrawRange(drawLast < 0 ? 0 : drawFirst * 2, drawLast < 0 ? 0 : (drawLast - drawFirst + 1) * 2);
    this.mesh.visible = drawLast >= 0;
  }
}
