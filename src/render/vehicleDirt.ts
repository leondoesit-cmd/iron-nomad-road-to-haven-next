import * as THREE from 'three';
import { applyKit } from './materials';

/**
 * The paint of one vehicle: the shared "kit" material plus three coats the vehicle's own state drives, mud, dust and
 * blood. Each coat is a mask worked out in the fragment shader from where the pixel is on the car (its height above the
 * ground, its distance from the axles, which way it faces) and the grunge texture the kit already samples, so there are
 * no per-vertex attributes to rewrite as the dirt builds up: the controller moves three numbers and the mud climbs
 * the wheel arches and rocker panels, the dust settles on the bonnet and roof, and the blood spatters the nose.
 *
 * Every vehicle has its own material instance (so its own three numbers) but they all share one compiled program.
 */

export interface SkinUniforms {
  /** x mud, y dust, z blood: each 0..1. */
  uDirt: { value: THREE.Vector3 };
  /** World to vehicle frame. */
  uVehInv: { value: THREE.Matrix4 };
  /** x: ground height in the vehicle frame (negative), y: front axle z, z: rear axle z. */
  uDirtGeom: { value: THREE.Vector4 };
}

export function newSkinUniforms(groundY: number, frontZ: number, rearZ: number): SkinUniforms {
  return {
    uDirt: { value: new THREE.Vector3() },
    uVehInv: { value: new THREE.Matrix4() },
    uDirtGeom: { value: new THREE.Vector4(groundY, frontZ, rearZ, 0) },
  };
}

const VERT_PARS = 'varying vec3 vKitPos;\nvarying vec3 vDirtP;\nuniform mat4 uVehInv;';
const VERT_MAIN = 'vKitPos = transformed;\nvDirtP = ( uVehInv * modelMatrix * vec4( transformed, 1.0 ) ).xyz;';
const FRAG_PARS = 'varying vec3 vKitPos;\nvarying vec3 vDirtP;\nuniform vec3 uDirt;\nuniform vec4 uDirtGeom;';

const FRAG_COLOR = /* glsl */ `
diffuseColor.rgb *= 0.9 + kitG.g * 0.2;
float dirtCover = 0.0;
float dirtRough = 0.0;
{
  float gH = vDirtP.y - uDirtGeom.x;
  vec3 dn = normalize( vKitNrm );
  float skyFacing = dn.y;
  float nose = dn.z;
  float axle = min( abs( vDirtP.z - uDirtGeom.y ), abs( vDirtP.z - uDirtGeom.z ) );
  float splash = exp( -axle * axle / 0.9 );
  float grain = kitG.r * 0.55 + kitG.g * 0.45;
  float fleck = smoothstep( 0.55, 0.8, kitG.g * 0.6 + kitG.a * 0.5 + kitG.b * 0.3 );
  // Mud: thrown up from the wheels, so it climbs highest round the arches, and it clings to flanks and the underside, not the roof.
  float mudEdge = uDirt.x * ( 0.55 + 0.75 * splash ) * ( 0.6 + 0.8 * grain ) * 1.25;
  float mud = smoothstep( mudEdge, mudEdge - 0.14, gH ) * step( 0.02, uDirt.x ) * ( 1.0 - 0.75 * smoothstep( 0.4, 0.95, skyFacing ) );
  mud = max( mud, fleck * smoothstep( mudEdge * 1.8 + 0.12, mudEdge * 0.5, gH ) * uDirt.x );
  // Dust: settles on everything that faces up, and powders the lower flanks.
  float dust = uDirt.y * ( 0.35 * smoothstep( 1.7, 0.0, gH ) + 0.7 * smoothstep( 0.2, 0.95, skyFacing ) ) * ( 0.4 + 0.8 * grain ) * ( 1.0 - 0.5 * kitG.a );
  // Blood: the nose and the lower front, speckled.
  float blood = uDirt.z * ( smoothstep( -0.1, 0.8, nose ) * smoothstep( 1.5, 0.25, gH ) * 1.25 + 0.5 * smoothstep( 0.7, 0.0, gH ) ) * ( 0.3 + fleck * 0.95 + grain * 0.45 );
  vec3 mudCol = mix( vec3( 0.075, 0.052, 0.034 ), vec3( 0.19, 0.13, 0.08 ), kitG.g );
  vec3 dustCol = vec3( 0.55, 0.43, 0.28 ) * ( 0.8 + 0.4 * kitG.g );
  vec3 bloodCol = mix( vec3( 0.13, 0.012, 0.01 ), vec3( 0.32, 0.03, 0.02 ), kitG.g );
  float dustA = clamp( dust * 0.8, 0.0, 0.6 );
  float bloodA = clamp( blood, 0.0, 0.9 );
  float mudA = clamp( mud, 0.0, 0.95 );
  diffuseColor.rgb = mix( diffuseColor.rgb, dustCol, dustA );
  diffuseColor.rgb = mix( diffuseColor.rgb, bloodCol, bloodA );
  diffuseColor.rgb = mix( diffuseColor.rgb, mudCol, mudA );
  dirtCover = max( max( dustA * 0.9, mudA ), bloodA * 0.4 );
  dirtRough = dustA * 0.5 + mudA * 0.6 - bloodA * 0.35;
}`;

/**
 * Splice the dirt coats into a shader that `applyKit` has already prepared. Returns false if any of the places it
 * hooks into have moved (the kit shader was edited), so the test that calls this notices rather than the paint going plain.
 */
export function patchSkin(shader: { vertexShader: string; fragmentShader: string }): boolean {
  let ok = true;
  const swap = (src: string, from: string, to: string) => {
    if (!src.includes(from)) {
      ok = false;
      return src;
    }
    return src.replace(from, to);
  };
  let v = shader.vertexShader;
  v = swap(v, 'varying vec3 vKitPos;', VERT_PARS);
  v = swap(v, 'vKitPos = transformed;', VERT_MAIN);
  let f = shader.fragmentShader;
  f = swap(f, 'varying vec3 vKitPos;', FRAG_PARS);
  f = swap(f, 'diffuseColor.rgb *= 0.9 + kitG.g * 0.2;', FRAG_COLOR);
  f = swap(f, 'float roughnessFactor = clamp( vSurf.x +', 'float roughnessFactor = clamp( vSurf.x + dirtRough +');
  f = swap(f, '( 1.0 - kitDirt * 0.6 )', '( 1.0 - kitDirt * 0.6 ) * ( 1.0 - dirtCover )');
  shader.vertexShader = v;
  shader.fragmentShader = f;
  return ok;
}

/** A vehicle's own paint material. */
export function skinMaterial(u: SkinUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    applyKit(shader, true);
    shader.uniforms.uDirt = u.uDirt;
    shader.uniforms.uVehInv = u.uVehInv;
    shader.uniforms.uDirtGeom = u.uDirtGeom;
    patchSkin(shader);
  };
  m.customProgramCacheKey = () => 'kit:true:skin';
  return m;
}
