import * as THREE from 'three';
import { clamp } from '../core/math';
import { LOOK_KEYS, NO_LOOK, type Look } from '../sim/drugs';

/**
 * How a trip reaches the screen, beyond the post-process pass:
 *  - the world breathes: every lit surface swells and sinks along its normal, driven by one shared uniform that is set
 *    per view (so one player's ground can be heaving while the other's is still);
 *  - the camera rolls and its field of view pulses;
 *  - the sky, fog and light change colour (applied per view by the renderer, using the helpers here).
 */

/**
 * x: swell amplitude in metres, y: phase in seconds. A plain object, not a Vector4, so every material gets the same
 * reference through `UniformsUtils.clone` and one write per view updates them all.
 */
export const BREATH = { x: 0, y: 0, z: 0, w: 0 };

const COMMON = /* glsl */ `
uniform vec4 uBreath;
`;

/** Swell along the normal by a slow world-space wave. Skipped entirely (one compare) when nobody is tripping. */
const BEGIN = /* glsl */ `
if ( uBreath.x > 0.0 ) {
  vec4 breathP = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    breathP = instanceMatrix * breathP;
  #endif
  breathP = modelMatrix * breathP;
  float breathW = sin( breathP.x * 0.31 + uBreath.y * 1.7 ) * sin( breathP.z * 0.27 - uBreath.y * 1.3 ) + 0.5 * sin( ( breathP.x + breathP.z ) * 0.83 + uBreath.y * 2.9 );
  transformed += normal * ( breathW * uBreath.x );
}
`;

let installed = false;

/** Patch the shader chunks and register the uniform. Idempotent; call before any material compiles. */
export function installBreath() {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.common = THREE.ShaderChunk.common + COMMON;
  THREE.ShaderChunk.begin_vertex = THREE.ShaderChunk.begin_vertex + BEGIN;
  const lib = THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, THREE.IUniform> }>;
  for (const k of Object.keys(lib)) lib[k].uniforms.uBreath = { value: BREATH };
}

// ------------------------------------------------------------------------------------------------ per-view state

/** What the renderer remembers for one player's view. */
export interface TripView {
  look: Look;
  /** Seconds of tripping time, running at the drugs' tempo. */
  phase: number;
  active: boolean;
}

export function newTripView(): TripView {
  return { look: { ...NO_LOOK }, phase: 0, active: false };
}

/** Anything on screen to speak of? (Tempo alone is not a visual.) */
export function lookActive(l: Look): boolean {
  let s = 0;
  for (const k of LOOK_KEYS) if (k !== 'tempo') s += Math.abs(l[k]);
  return s > 0.002;
}

/** Visual time runs slow or fast with the drugs. */
export function tripTempo(l: Look): number {
  return clamp(1 + l.tempo, 0.3, 2);
}

// ------------------------------------------------------------------------------------------------ camera

/**
 * Roll the camera (the drunk tilt) and breathe its field of view. Called after the camera has been aimed for the frame,
 * so it never changes where a shot goes: roll turns about the line of sight and zoom only scales the picture.
 */
export function tripCamera(cam: THREE.PerspectiveCamera, l: Look, phase: number) {
  let zoom = 1;
  if (l.pulse > 0.01 || l.warp > 0.05 || l.dbl > 0.05) {
    const beat = Math.pow(Math.max(0, Math.sin(phase * 5.4)), 6) * 0.6 + 0.4 * Math.sin(phase * 1.7);
    zoom += l.pulse * 0.03 * beat + l.warp * 0.015 * Math.sin(phase * 0.9) + l.dbl * 0.01 * Math.sin(phase * 0.6);
  }
  if (cam.zoom !== zoom) {
    cam.zoom = zoom;
    cam.updateProjectionMatrix();
  }
  if (l.roll > 0.01) cam.rotateZ((Math.sin(phase * 0.7) * 0.07 + Math.sin(phase * 1.9 + 1.3) * 0.025) * l.roll);
}

/** Put the zoom back after a trip so the next view starts square. */
export function resetCamera(cam: THREE.PerspectiveCamera) {
  if (cam.zoom !== 1) {
    cam.zoom = 1;
    cam.updateProjectionMatrix();
  }
}

// ------------------------------------------------------------------------------------------------ colour

const _hsl = { h: 0, s: 0, l: 0 };

/** Rotate a colour's hue (turns, 1 is a full circle) and nudge its saturation. */
export function shiftHue(c: THREE.Color, turns: number, sat = 0): THREE.Color {
  c.getHSL(_hsl);
  c.setHSL((((_hsl.h + turns) % 1) + 1) % 1, clamp(_hsl.s + sat, 0, 1), _hsl.l);
  return c;
}
