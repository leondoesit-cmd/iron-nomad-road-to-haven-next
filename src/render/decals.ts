import * as THREE from 'three';
import { atmoUniforms } from './atmosphere';
import { GLOBALS } from './materials';
import { COPLANAR, DEPTH_UNIFORMS, PULL, coplanarOffset, depthPullGlsl } from './depth';

/**
 * Marks left on the world and kept: blood that sprays onto walls and pools on the road, and the holes bullets leave.
 * One instanced quad per mark in a ring buffer, so a long fight costs a single draw call and the oldest marks give way to
 * the newest. Blood is wet and bright when it lands and dries to a dark brown over the next minute.
 */

/** Cells of the atlas, 4 across and 5 down. */
export const CELL = { splat0: 0, splat1: 1, splat2: 2, splat3: 3, spray: 4, drops: 5, scar: 6, pool: 7, hole: 8, splinter: 9, scuff: 10, crack: 11, pit: 12, pit1: 13, pit2: 14, pit3: 15, spall: 16, spall1: 17, spall2: 18, spall3: 19, punch: 20, punch1: 21, punch2: 22, punch3: 23 } as const;

/** The spalls (concrete, asphalt), the pits (rock) and the punched holes (metal), to pick one at random: no two alike. */
export const SPALLS = [CELL.spall, CELL.spall1, CELL.spall2, CELL.spall3] as const;
export const PITS = [CELL.pit, CELL.pit1, CELL.pit2, CELL.pit3] as const;
export const PUNCHES = [CELL.punch, CELL.punch1, CELL.punch2, CELL.punch3] as const;
/** One of a family of marks, at random. */
export function anyOf(cells: readonly number[]): number {
  return cells[Math.floor(Math.random() * cells.length)];
}

const ATLAS_W = 4;
const ATLAS_H = 6;
const PX = 64;

const vert = /* glsl */ `
attribute vec4 aParam; // atlas cell, opacity, born (scene seconds), negative spread seconds / 1 for permanent marks
uniform float uSceneTime;
uniform float uPullStep;
attribute vec3 aTint;
varying vec2 vUv;
varying vec4 vParam;
varying vec3 vTint;
varying float vDepth;
varying vec3 vBX;
varying vec3 vBY;
varying vec3 vBN;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  // The mark's own frame in the world: along it, across it, out of the surface.
  mat3 B = mat3( modelMatrix * instanceMatrix );
  vBX = B[ 0 ];
  vBY = B[ 1 ];
  vBN = B[ 2 ];
  vParam = aParam;
  vTint = aTint;
  float spread = aParam.w < 0.0 ? mix( 0.22, 1.0, smoothstep( 0.0, -aParam.w, max( 0.0, uSceneTime - aParam.z ) ) ) : 1.0;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position.xy * spread, position.z, 1.0 );
  vDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  // Nearer the eye than any road layer under it, however far off (see depth.ts).
  ${depthPullGlsl(PULL.decal.toFixed(1))}
  #include <fog_vertex>
}`;

const frag = /* glsl */ `
uniform sampler2D tAtlas;
uniform sampler2D tRelief;
uniform vec3 uLight;
uniform vec3 uSunDir;
uniform float uSceneTime;
varying vec2 vUv;
varying vec4 vParam;
varying vec3 vTint;
varying float vDepth;
varying vec3 vBX;
varying vec3 vBY;
varying vec3 vBN;
#include <fog_pars_fragment>
void main() {
  float cell = floor( vParam.x + 0.5 );
  vec2 origin = vec2( mod( cell, ${ATLAS_W}.0 ), floor( cell / ${ATLAS_W}.0 ) );
  vec2 uv = ( origin + clamp( vUv, 0.01, 0.99 ) ) / vec2( ${ATLAS_W}.0, ${ATLAS_H}.0 );
  vec4 t = texture2D( tAtlas, uv );
  float age = max( 0.0, uSceneTime - vParam.z );
  // Fresh blood is bright red and glossy; over a minute it goes dark and dull. Holes do not dry.
  float dry = vParam.w > 0.5 ? 0.0 : smoothstep( 1.0, 70.0, age );
  vec3 col = mix( vTint, vTint * vec3( 0.34, 0.5, 0.52 ), dry );
  vec2 glintUv = vUv - vec2( 0.38, 0.61 );
  float sheen = exp( -dot( glintUv * vec2( 1.0, 2.8 ), glintUv * vec2( 1.0, 2.8 ) ) * 55.0 );
  float gloss = vParam.w > 0.5 ? 0.0 : ( 1.0 - dry ) * t.g * ( 0.025 + sheen * 0.14 );
  float a = t.a * vParam.y * ( 1.0 - smoothstep( 110.0, 170.0, vDepth ) );
  if ( a < 0.01 ) discard;
  // A hole's relief, lit by the sun against the face it is in: the wall of a pit facing the sun bright, the far wall in its
  // own shade, a torn petal of metal catching the light. A flat mark (blood) is lit as the face is.
  vec2 nt = texture2D( tRelief, uv ).rg * 2.0 - 1.0;
  vec3 N = normalize( vBN );
  vec3 nr = normalize( N * sqrt( max( 0.0, 1.0 - dot( nt, nt ) ) ) + normalize( vBX ) * nt.x + normalize( vBY ) * nt.y );
  float rel = clamp( ( 0.3 + 0.7 * max( dot( nr, uSunDir ), 0.0 ) ) / ( 0.3 + 0.7 * max( dot( N, uSunDir ), 0.0 ) ), 0.25, 2.0 );
  // The blue channel is the dark of a pit: a bullet hole's core, the black of a crack.
  vec3 lit = col * ( 0.55 + t.r * 0.5 ) * uLight * rel + gloss;
  gl_FragColor = vec4( mix( lit, vec3( 0.012, 0.011, 0.01 ) * uLight, t.b ), a );
  #include <fog_fragment>
}`;

/** A tiny seeded generator so the atlas is the same every run. */
function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Draw one blob with a ragged edge into a cell: alpha in `a`, a shading term in `r` and a glint in `g`. */
function blob(buf: Uint8Array, cx: number, cy: number, r: number, rnd: () => number, stretch = 1, angle = 0) {
  const lobes = 7;
  const ph: number[] = [];
  const am: number[] = [];
  for (let i = 0; i < lobes; i++) {
    ph.push(rnd() * 6.28);
    am.push(0.1 + rnd() * 0.22);
  }
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const reach = Math.ceil(r * Math.max(1, stretch) * 1.7) + 2;
  for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(PX, Math.ceil(cy + reach)); y++) {
    for (let x = Math.max(0, Math.floor(cx - reach)); x < Math.min(PX, Math.ceil(cx + reach)); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = (dx * ca + dy * sa) / stretch;
      const v = -dx * sa + dy * ca;
      const d = Math.hypot(u, v);
      const th = Math.atan2(v, u);
      let edge = r;
      for (let i = 0; i < lobes; i++) edge *= 1 + (am[i] / (1 + i * 0.6)) * Math.sin(th * (i + 2) + ph[i]);
      const k = 1 - d / Math.max(1, edge);
      if (k <= 0) continue;
      const a = Math.min(1, k * 4);
      const i4 = (y * PX + x) * 4;
      if (a * 255 > buf[i4 + 3]) {
        buf[i4 + 3] = Math.round(a * 255);
        buf[i4] = Math.round(120 + 135 * Math.min(1, k * 1.6));
        buf[i4 + 1] = Math.round(255 * Math.max(0, k - 0.55) * 1.8);
      }
    }
  }
}


/** Paint a pixel if it is more opaque than what is there: shade in r, glint in g, pit-dark in b. */
function px(buf: Uint8Array, x: number, y: number, shade: number, glint: number, dark: number, alpha: number) {
  if (x < 0 || y < 0 || x >= PX || y >= PX) return;
  const i = (y * PX + x) * 4;
  const a = Math.round(Math.min(1, alpha) * 255);
  if (a <= buf[i + 3]) return;
  buf[i] = shade;
  buf[i + 1] = glint;
  buf[i + 2] = dark;
  buf[i + 3] = a;
}

/** A thin ragged line out from a point, fading toward its end. */
function streak(buf: Uint8Array, cx: number, cy: number, angle: number, from: number, len: number, width: number, shade: number, dark: number, rnd: () => number) {
  let a = angle;
  let x = cx + Math.cos(a) * from;
  let y = cy + Math.sin(a) * from;
  const steps = Math.ceil(len);
  for (let s = 0; s < steps; s++) {
    a += (rnd() - 0.5) * 0.35;
    x += Math.cos(a);
    y += Math.sin(a);
    const f = 1 - s / steps;
    const r = width * (0.4 + 0.6 * f);
    for (let oy = -Math.ceil(r); oy <= Math.ceil(r); oy++) {
      for (let ox = -Math.ceil(r); ox <= Math.ceil(r); ox++) {
        if (Math.hypot(ox, oy) <= r) px(buf, Math.round(x) + ox, Math.round(y) + oy, shade, 0, dark, 0.35 + 0.65 * f);
      }
    }
  }
}

/**
 * A bullet hole seen square-on: a black pit, a ragged rim of exposed, paler material around it and splinters thrown out
 * along the grain. `big` is the exit side or a heavy round: a wider crater with longer splinters.
 */
function holeCell(buf: Uint8Array, seed: number, big: boolean) {
  const rnd = lcg(seed);
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const haloR = big ? 19 : 13;
  const coreR = big ? 8.5 : 6.4;
  const edge = (th: number, base: number) => base * (1 + 0.2 * Math.sin(th * 3 + ph[0]) + 0.14 * Math.sin(th * 5 + ph[1]) + 0.1 * Math.sin(th * 9 + ph[2]));
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const dx = x + 0.5 - 32;
      const dy = y + 0.5 - 32;
      const d = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      const h = edge(th, haloR);
      const c = edge(th + 1.7, coreR);
      if (d < c) px(buf, x, y, 20, 0, 255, 1);
      else if (d < c + 2) px(buf, x, y, 70, 0, 120, 1);
      else if (d < h) {
        const k = 1 - d / h;
        px(buf, x, y, Math.round(190 + 65 * k), k > 0.55 ? 160 : 0, 0, Math.min(1, k * 2.6) * 0.92);
      }
    }
  }
  // Splinters of the material, longer on the exit side.
  const n = big ? 11 : 7;
  for (let i = 0; i < n; i++) streak(buf, 32, 32, rnd() * 6.28, coreR + 1, haloR * (big ? 1.5 : 1.2) * (0.6 + rnd() * 0.7), big ? 1.5 : 1.1, 255, 0, rnd);
}

/** A round's mark in hard earth: a patch of broken soil darker than the face, a shallow hole at its heart, crumbs round it. */
function scuffCell(buf: Uint8Array, seed: number) {
  const rnd = lcg(seed);
  const edge = ragged(rnd, 11 + rnd() * 4, 6, 0.22);
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const dx = x + 0.5 - 32;
      const dy = y + 0.5 - 32;
      const d = Math.hypot(dx, dy) / edge(Math.atan2(dy, dx));
      if (d >= 1) continue;
      const g = grainAt(x, y, seed);
      // Broken, mottled soil, darker than the face; a shallow hole at its heart.
      relief[y * PX + x] = -2.5 * (1 - d * d);
      px(buf, x, y, Math.round(255 * (0.3 + 0.25 * g + 0.2 * d)), 0, d < 0.3 ? Math.round(255 * 0.75 * (1 - d / 0.3)) : 0, 0.75 * (1 - d * d));
    }
  }
  // Crumbs knocked out round it.
  const n = 6 + Math.floor(rnd() * 8);
  for (let i = 0; i < n; i++) {
    const a = rnd() * 6.28;
    const r = 11 + rnd() * 14;
    const cx = 32 + Math.cos(a) * r;
    const cy = 32 + Math.sin(a) * r;
    const s = 0.8 + rnd() * 1.4;
    for (let y = Math.floor(cy - s - 1); y <= Math.ceil(cy + s + 1); y++) {
      for (let x = Math.floor(cx - s - 1); x <= Math.ceil(cx + s + 1); x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= s) px(buf, x, y, 70, 0, 60, 0.75);
      }
    }
  }
}

/**
 * Where a round tore the bark off a tree: a ragged patch of pale wood stretched along the grain (the cell's x, laid along the
 * trunk), torn fibres running out along it, a dark lip of curled bark round its edge and a dark hole in the middle.
 */
function scarCell(buf: Uint8Array, seed: number) {
  const rnd = lcg(seed);
  blob(buf, 32, 32, 12, rnd, 1.75, (rnd() - 0.5) * 0.15);
  // The torn lip: the outer rim of the patch goes dark.
  for (let i = 0; i < PX * PX; i++) {
    const a = buf[i * 4 + 3];
    if (a > 0 && a < 150) {
      buf[i * 4] = 80;
      buf[i * 4 + 2] = 120;
    }
  }
  for (let i = 0; i < 9; i++) {
    const side = rnd() < 0.5 ? 0 : Math.PI;
    streak(buf, 32, 32 + (rnd() - 0.5) * 10, side + (rnd() - 0.5) * 0.25, 6, 12 + rnd() * 16, 0.8 + rnd() * 0.6, 245, 0, rnd);
  }
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const d = Math.hypot((x + 0.5 - 32) / 1.6, y + 0.5 - 32);
      if (d < 3.6) px(buf, x, y, 30, 0, 255, 1);
      else if (d < 5.5) px(buf, x, y, 110, 0, 150, 1);
    }
  }
}

/** A web of cracks from a point: what a wall looks like before it gives. */
function crackCell(buf: Uint8Array, seed: number) {
  const rnd = lcg(seed);
  const rays = 6 + Math.floor(rnd() * 3);
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * 6.28 + (rnd() - 0.5) * 0.5;
    const len = 18 + rnd() * 12;
    streak(buf, 32, 32, a, 2, len, 1.1, 50, 255, rnd);
    // A branch off partway along.
    if (rnd() < 0.7) {
      const from = 6 + rnd() * 10;
      streak(buf, 32 + Math.cos(a) * from, 32 + Math.sin(a) * from, a + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.5), 0, 8 + rnd() * 8, 0.9, 50, 255, rnd);
    }
  }
  // Crushed in the middle.
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) if (Math.hypot(x + 0.5 - 32, y + 0.5 - 32) < 3.4) px(buf, x, y, 30, 0, 255, 1);
}

/** A ragged outline: the radius at an angle, `R` pushed in and out by `lobes` waves. */
function ragged(rnd: () => number, R: number, lobes: number, depth: number): (th: number) => number {
  const ph: number[] = [];
  const am: number[] = [];
  for (let i = 0; i < lobes; i++) {
    ph.push(rnd() * 6.28);
    am.push(depth * (0.4 + 0.6 * rnd()));
  }
  return (th) => {
    let e = R;
    for (let i = 0; i < lobes; i++) e *= 1 + (am[i] / (1 + i * 0.5)) * Math.sin(th * (i + 2) + ph[i]);
    return e;
  };
}

/** A repeatable random in [0, 1) for a pixel. */
function grainAt(x: number, y: number, seed: number): number {
  const h = Math.sin(x * 12.9898 + y * 78.233 + seed * 3.71) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * A pit in stone: what a round leaves in sandstone or rock. A small, rounded cone with smooth walls, darkening to its
 * bottom the way a hollow shades itself, and a soft rounded lip; no cracks, no splash. It darkens the face it is on rather
 * than painting over it, so it sits right in sun and in shade alike.
 */
function pitCell(buf: Uint8Array, seed: number) {
  const rnd = lcg(seed);
  const edge = ragged(rnd, 15 + rnd() * 6, 5, 0.1);
  const sq = 0.85 + rnd() * 0.3;
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const dx = (x + 0.5 - 32) * sq;
      const dy = (y + 0.5 - 32) / sq;
      const d = Math.hypot(dx, dy) / edge(Math.atan2(dy, dx));
      if (d >= 1) continue;
      const g = grainAt(x, y, seed);
      // Deep in the cone it is dark; up its smooth wall it comes back to the face's own colour; the lip is a touch lighter.
      relief[y * PX + x] = -edge(Math.atan2(dy, dx)) * 0.45 * (1 - d * d) + (d > 0.8 ? 0.6 * Math.sin((d - 0.8) * 15.7) : 0);
      const shade = 0.12 + 0.8 * d * d + (d > 0.78 && d < 0.95 ? 0.1 : 0) + (g - 0.5) * 0.1;
      const a = d < 0.7 ? 0.95 : 0.95 * (1 - (d - 0.7) / 0.3);
      px(buf, x, y, Math.round(255 * Math.min(1, Math.max(0, shade))), 0, Math.round(255 * Math.max(0, 0.7 * (1 - d / 0.45))), a);
    }
  }
}

/**
 * A spall: what a round blows out of concrete or asphalt. A deep, ragged hole, dark inside, in a wide broken crater of
 * fresh material paler than the weathered face, its facets each catching the light their own way, grains of aggregate in
 * it, its lip jagged.
 */
function spallCell(buf: Uint8Array, seed: number) {
  const rnd = lcg(seed);
  const outer = ragged(rnd, 18 + rnd() * 6, 9, 0.22);
  const hole = ragged(rnd, 9 + rnd() * 4, 7, 0.3);
  const facets = 7 + Math.floor(rnd() * 5);
  const fb: number[] = [];
  const fa: number[] = [0];
  for (let i = 0; i < facets; i++) fb.push(rnd());
  for (let i = 1; i < facets; i++) fa.push(fa[i - 1] + (6.28 / facets) * (0.6 + 0.8 * rnd()));
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const dx = x + 0.5 - 32;
      const dy = y + 0.5 - 32;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      const o = r / outer(th);
      if (o >= 1.04) continue;
      const hr = r / hole(th);
      let f = 0;
      const tt = (th + 6.28) % 6.28;
      for (let i = 0; i < facets; i++) if (tt >= fa[i]) f = i;
      const g = grainAt(x, y, seed);
      // The crater wall: deep and shaded near the hole, lighter up to its broken lip, each facet its own tilt, specks of
      // aggregate light and dark.
      const up = Math.min(1, Math.max(0, (o - 0.35) / 0.6));
      let shade = 0.3 + 0.55 * up + (fb[f] - 0.5) * 0.35;
      if (g > 0.86) shade += 0.25;
      else if (g < 0.1) shade -= 0.25;
      // The hole: black at its heart, its own wall shading into it.
      const dark = hr < 1 ? Math.min(1, 0.7 + 0.3 * (1 - hr)) : hr < 1.5 ? 0.55 * (1.5 - hr) / 0.5 : 0;
      // A broad cone down to the hole, its facets each tilted, grit on it; the hole drops away inside.
      relief[y * PX + x] = -7 * Math.max(0, 1 - o) ** 1.2 - (hr < 1 ? 10 * (1 - hr * hr) : 0) + (fb[f] - 0.5) * 2.5 * Math.max(0, 1 - o) + (g - 0.5) * 0.5;
      const a = o < 0.92 ? 1 : Math.max(0, 1 - (o - 0.92) / 0.12);
      px(buf, x, y, Math.round(255 * Math.min(1, Math.max(0, shade))), 0, Math.round(255 * dark), a);
    }
  }
}

/**
 * A round punched through sheet metal: a dark, nearly round hole, its edge torn into bright jagged petals of bare metal, in
 * a ring where the paint is scorched and scuffed off.
 */
function punchCell(buf: Uint8Array, seed: number) {
  const rnd = lcg(seed);
  const H = 7 + rnd() * 3;
  const petals = 7 + Math.floor(rnd() * 5);
  const pl: number[] = [];
  for (let i = 0; i < petals; i++) pl.push(0.35 + rnd() * 0.65);
  const ring = 18 + rnd() * 5;
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const dx = x + 0.5 - 32;
      const dy = y + 0.5 - 32;
      const r = Math.hypot(dx, dy);
      if (r >= ring * 1.1) continue;
      const th = (Math.atan2(dy, dx) + 6.28) % 6.28;
      const k = (th / 6.28) * petals;
      const i = Math.floor(k);
      const u = k - i;
      // Each petal a tooth: longest at its middle, its own length.
      const tooth = H + H * 0.75 * pl[i % petals] * (1 - Math.abs(u - 0.5) * 2);
      const g = grainAt(x, y, seed);
      if (r < H * (0.92 + 0.08 * Math.sin(th * 5 + seed))) {
        relief[y * PX + x] = -8;
        px(buf, x, y, 30, 0, 255, 1);
      } else if (r < tooth) {
        // Bent: each petal curls up out of the sheet, most at its tip.
        relief[y * PX + x] = 3 * (1 - (tooth - r) / Math.max(1, tooth - H)) + 1.2 * Math.sin(u * Math.PI);
        // Bare metal, bright where it bent toward the light, a thin dark seam between petals.
        const seam = Math.abs(u - 0.5) > 0.42 ? 0.5 : 0;
        px(buf, x, y, Math.round(255 * Math.min(1, 0.85 + 0.15 * g)), 200, Math.round(255 * seam), 1);
      } else {
        // The scorched ring: the paint darkened, fading out.
        const f = (r - tooth) / (ring - tooth);
        px(buf, x, y, Math.round(255 * 0.25), 0, Math.round(255 * 0.3 * (1 - f)), Math.max(0, 0.55 * (1 - f)));
      }
    }
  }
}

/** Heights (in pixels) of the cell being painted, for its relief: the painters of holes write them. Zero is flat. */
const relief = new Float32Array(PX * PX);

function atlas(): { col: THREE.DataTexture; relief: THREE.DataTexture } {
  const W = PX * ATLAS_W;
  const H = PX * ATLAS_H;
  const out = new Uint8Array(W * H * 4);
  const cell = new Uint8Array(PX * PX * 4);
  // The relief: each texel's slope as a tangent-space normal's x and y, 0.5 flat.
  const nrm = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    nrm[i * 4] = 128;
    nrm[i * 4 + 1] = 128;
    nrm[i * 4 + 2] = 255;
    nrm[i * 4 + 3] = 255;
  }
  const put = (index: number) => {
    const ox = (index % ATLAS_W) * PX;
    const oy = Math.floor(index / ATLAS_W) * PX;
    for (let y = 0; y < PX; y++) {
      const src = y * PX * 4;
      const dst = ((oy + y) * W + ox) * 4;
      out.set(cell.subarray(src, src + PX * 4), dst);
      for (let x = 0; x < PX; x++) {
        const hx = relief[y * PX + Math.min(PX - 1, x + 1)] - relief[y * PX + Math.max(0, x - 1)];
        const hy = relief[Math.min(PX - 1, y + 1) * PX + x] - relief[Math.max(0, y - 1) * PX + x];
        if (hx === 0 && hy === 0) continue;
        const nx = -hx * 0.5;
        const ny = -hy * 0.5;
        const l = Math.hypot(nx, ny, 1);
        const o = ((oy + y) * W + ox + x) * 4;
        nrm[o] = Math.round((nx / l) * 127 + 128);
        nrm[o + 1] = Math.round((ny / l) * 127 + 128);
      }
    }
    cell.fill(0);
    relief.fill(0);
  };
  // Four splats: a main mass with a ring of drops thrown off it.
  for (let s = 0; s < 4; s++) {
    const rnd = lcg(900 + s * 31);
    blob(cell, 32, 32, 11 + rnd() * 5, rnd);
    for (let i = 0; i < 7; i++) streak(cell, 32, 32, rnd() * Math.PI * 2, 7, 11 + rnd() * 12, 0.7 + rnd() * 0.8, 165, 0, rnd);
    const n = 9 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.28;
      const d = 17 + rnd() * 13;
      blob(cell, 32 + Math.cos(a) * d, 32 + Math.sin(a) * d, 1.2 + rnd() * 3.2 * (1 - (d - 17) / 26), rnd);
    }
    put(s);
  }
  // A directional spray: a fat head at one end trailing off into a streak of drops (the long axis is x).
  {
    const rnd = lcg(77);
    blob(cell, 14, 32, 9, rnd, 1.5, 0);
    for (let i = 0; i < 22; i++) {
      const d = 12 + rnd() * 48;
      const spread = (rnd() - 0.5) * (4 + d * 0.28);
      blob(cell, 14 + d, 32 + spread, Math.max(0.9, (3.4 - d * 0.045) * (0.5 + rnd())), rnd, 1.4, 0);
    }
    put(4);
  }
  // A scatter of fine drops.
  {
    const rnd = lcg(55);
    for (let i = 0; i < 34; i++) {
      const a = rnd() * 6.28;
      const d = rnd() * 28;
      blob(cell, 32 + Math.cos(a) * d, 32 + Math.sin(a) * d, 0.9 + rnd() * 2.1, rnd);
    }
    put(5);
  }
  // Bullet holes: a clean one, a heavy splintered one, and a pit for earth and stone.
  holeCell(cell, 33, false);
  put(CELL.hole);
  holeCell(cell, 34, true);
  put(CELL.splinter);
  scuffCell(cell, 35);
  put(CELL.scuff);
  crackCell(cell, 36);
  put(CELL.crack);
  scarCell(cell, 37);
  put(CELL.scar);
  for (let k = 0; k < 4; k++) {
    spallCell(cell, 73 + k * 19);
    put(SPALLS[k]);
    pitCell(cell, 151 + k * 23);
    put(PITS[k]);
    punchCell(cell, 211 + k * 29);
    put(PUNCHES[k]);
  }
  // A pool: one broad, smooth, slightly irregular puddle.
  {
    const rnd = lcg(21);
    blob(cell, 32, 32, 25, rnd);
    for (let i = 0; i < 5; i++) {
      const a = rnd() * 6.28;
      blob(cell, 32 + Math.cos(a) * 14, 32 + Math.sin(a) * 14, 8 + rnd() * 6, rnd);
    }
    put(7);
  }
  const make = (data: Uint8Array) => {
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  };
  return { col: make(out), relief: make(nrm) };
}

let atlasTex: { col: THREE.DataTexture; relief: THREE.DataTexture } | null = null;

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

export interface DecalOpts {
  /** Atlas cell. */
  cell: number;
  /** Width and height in metres. */
  w: number;
  h: number;
  /** Surface normal the mark lies on. */
  nx: number;
  ny: number;
  nz: number;
  /** Direction the long axis runs, projected onto the surface (x, y, z). Random when absent. */
  dx?: number;
  dy?: number;
  dz?: number;
  r?: number;
  g?: number;
  b?: number;
  opacity?: number;
  /** Holes stay as they are; blood dries. */
  hole?: boolean;
  /** Seconds to spread from a small puddle to full width. Zero keeps an immediate mark. */
  grow?: number;
}

export class Decals {
  readonly mesh: THREE.InstancedMesh;
  private param: Float32Array;
  private tint: Float32Array;
  /** Where each mark is, so marks on a wall that has come down can be taken off it. */
  private at: Float32Array;
  private paramAttr: THREE.InstancedBufferAttribute;
  private tintAttr: THREE.InstancedBufferAttribute;
  private next = 0;
  /** Marks placed since the last clear, capped at the pool size. */
  count = 0;
  /** Scene seconds, set by the scene each frame so blood can dry. */
  time = 0;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(readonly capacity = 720) {
    atlasTex ??= atlas();
    const geo = new THREE.PlaneGeometry(1, 1);
    this.param = new Float32Array(capacity * 4);
    this.tint = new Float32Array(capacity * 3);
    this.at = new Float32Array(capacity * 3);
    this.paramAttr = new THREE.InstancedBufferAttribute(this.param, 4).setUsage(THREE.DynamicDrawUsage);
    this.tintAttr = new THREE.InstancedBufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aParam', this.paramAttr);
    geo.setAttribute('aTint', this.tintAttr);
    this.uniforms = {
      ...atmoUniforms(),
      tAtlas: { value: atlasTex.col },
      tRelief: { value: atlasTex.relief },
      uLight: GLOBALS.uLight,
      uSunDir: GLOBALS.uSunDir,
      uSceneTime: { value: 0 },
      uPullStep: DEPTH_UNIFORMS.uPullStep,
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    coplanarOffset(mat, COPLANAR.decal);
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  /** Put a mark on a surface. Returns its slot. */
  add(x: number, y: number, z: number, o: DecalOpts): number {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    const z3 = _z.set(o.nx, o.ny, o.nz);
    if (z3.lengthSq() < 1e-8) z3.set(0, 1, 0);
    z3.normalize();
    // Long axis along the given direction flattened onto the surface, else a random one.
    const x3 = _x;
    if (o.dx !== undefined && o.dy !== undefined && o.dz !== undefined) x3.set(o.dx, o.dy, o.dz);
    else x3.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    x3.addScaledVector(z3, -x3.dot(z3));
    if (x3.lengthSq() < 1e-8) {
      x3.set(Math.abs(z3.y) < 0.9 ? 0 : 1, Math.abs(z3.y) < 0.9 ? 1 : 0, 0);
      x3.addScaledVector(z3, -x3.dot(z3));
    }
    x3.normalize();
    const y3 = _y.crossVectors(z3, x3);
    _m.makeBasis(x3.multiplyScalar(o.w), y3.multiplyScalar(o.h), z3);
    // Lifted off the surface a hair, on top of the depth bias, so it never sinks into curved ground.
    _m.setPosition(x + z3.x * 0.014, y + z3.y * 0.014, z + z3.z * 0.014);
    this.mesh.setMatrixAt(i, _m);
    this.at[i * 3] = x;
    this.at[i * 3 + 1] = y;
    this.at[i * 3 + 2] = z;
    this.param[i * 4] = o.cell;
    this.param[i * 4 + 1] = o.opacity ?? 0.85;
    this.param[i * 4 + 2] = this.time;
    const grow = o.grow ?? (o.cell === CELL.pool ? 3.5 : 0);
    this.param[i * 4 + 3] = o.hole ? 1 : -Math.max(0, grow);
    this.tint[i * 3] = o.r ?? 0.5;
    this.tint[i * 3 + 1] = o.g ?? 0.03;
    this.tint[i * 3 + 2] = o.b ?? 0.03;
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.paramAttr.needsUpdate = true;
    this.tintAttr.needsUpdate = true;
    return i;
  }

  /** Take off every mark whose centre lies in a box (the wall it was on has gone). Returns how many. */
  removeInBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const x = this.at[i * 3];
      const y = this.at[i * 3 + 1];
      const z = this.at[i * 3 + 2];
      if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1 || this.param[i * 4 + 1] === 0) continue;
      this.param[i * 4 + 1] = 0;
      _m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _m);
      n++;
    }
    if (n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.paramAttr.needsUpdate = true;
    }
    return n;
  }

  update(time: number) {
    this.time = time;
    this.uniforms.uSceneTime.value = time;
  }

  clear() {
    this.count = 0;
    this.next = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
