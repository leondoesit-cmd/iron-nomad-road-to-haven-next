import * as THREE from 'three';
import { GLOBALS } from './materials';

/**
 * Falling rain: thin streaks in a box of air that travels with each view's camera. Every drop is one instance of a quad
 * whose place is a fixed point in the box moved on by the wind and its own fall and wrapped back into the box round the
 * camera, so the rain never runs out and nothing moves on the CPU. How hard it rains is how many of the drops are drawn.
 *
 * The streaks are as long as a drop falls in a camera's shutter time and lean with the wind; they are faint near the eye
 * and fade out at the edge of the box, and lightning lights them all at once.
 */

const MAX_DROPS = 16000;
/** The box of air round the camera, metres. */
const BOX = new THREE.Vector3(40, 22, 40);

const VERT = /* glsl */ `
attribute vec2 corner;
attribute vec4 aDrop;
uniform vec3 uCam;
uniform vec3 uBox;
uniform float uT;
uniform vec3 uWind;
varying float vA;
varying float vSide;
varying float vAlong;
void main() {
  // Big drops fall faster than small ones.
  vec3 vel = vec3( uWind.x, - uWind.z * ( 0.8 + 0.4 * aDrop.w ), uWind.y );
  vec3 p = aDrop.xyz * uBox + vel * uT;
  vec3 rel = mod( p - uCam + uBox * 0.5, uBox ) - uBox * 0.5;
  vec3 head = uCam + rel;
  vec3 dir = normalize( vel );
  vec3 tail = head - dir * ( 0.028 * length( vel ) + 0.12 );
  vec3 toEye = cameraPosition - head;
  float dist = length( toEye );
  vec3 side = normalize( cross( dir, toEye / max( dist, 1e-3 ) ) + vec3( 1e-5 ) );
  // Wider with distance so far drops still cover a pixel and blur into a curtain.
  float w = 0.004 + dist * 0.0006;
  vec3 pos = mix( head, tail, corner.y ) + side * corner.x * w;
  vSide = corner.x;
  vAlong = corner.y;
  // Faint right at the eye, fading out toward the walls of the box.
  vec3 edge = abs( rel ) / ( uBox * 0.5 );
  float box = 1.0 - smoothstep( 0.65, 1.0, max( edge.x, max( edge.y, edge.z ) ) );
  // Beyond a score of metres a drop is lost in the grey: the fog draws the rest of the rain as a haze.
  vA = smoothstep( 0.6, 3.0, dist ) * box * ( 1.0 - smoothstep( 12.0, 20.0, dist ) );
  gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform vec3 uLight;
uniform float uRain;
uniform float uFlash;
varying float vA;
varying float vSide;
varying float vAlong;
void main() {
  // Brightest at the head, a fading smear behind it.
  float a = vA * ( 1.0 - vSide * vSide ) * ( 1.0 - vAlong * 0.7 ) * ( 0.09 + 0.13 * uRain ) * ( 1.0 + uFlash * 0.8 );
  if ( a < 0.003 ) discard;
  vec3 c = uLight * 0.38 + vec3( 0.05 ) + vec3( 0.8, 0.85, 1.0 ) * uFlash * 0.6;
  gl_FragColor = vec4( c, a );
}`;

export class RainFx {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private uniforms = {
    uCam: { value: new THREE.Vector3() },
    uBox: { value: BOX.clone() },
    uT: { value: 0 },
    /** Wind x, z and the fall speed, m/s. */
    uWind: { value: new THREE.Vector3(0, 0, 9) },
    uRain: { value: 0 },
    uFlash: { value: 0 },
    uLight: GLOBALS.uLight,
  };
  private t = 0;
  private level = 0;
  /** Per view: hidden for a camera under a roof. */
  sheltered: [boolean, boolean] = [false, false];

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, 0, 1, 0, -1, 1, 1, 1], 2));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    const drops = new Float32Array(MAX_DROPS * 4);
    let s = 0x9e3779b9;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < MAX_DROPS * 4; i++) drops[i] = rnd();
    g.setAttribute('aDrop', new THREE.InstancedBufferAttribute(drops, 4));
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.name = 'rain';
    this.mesh.visible = false;
  }

  /** How hard it rains (0..1), the wind (m/s), how hard lightning is lighting things, and the frame's time step. */
  update(rain: number, windX: number, windZ: number, flash: number, dt: number) {
    this.t = (this.t + dt) % 1000;
    this.level = rain;
    this.uniforms.uT.value = this.t;
    this.uniforms.uRain.value = rain;
    this.uniforms.uFlash.value = flash;
    this.uniforms.uWind.value.set(windX * 0.7, windZ * 0.7, 8.5 + 1.5 * rain);
    this.geo.instanceCount = Math.round(MAX_DROPS * Math.min(1, rain * 1.15));
    this.mesh.visible = rain > 0.01;
  }

  /** Before a view renders: the box of rain follows its camera (none for a camera under a roof). */
  beforeView(i: number, cam: THREE.Camera) {
    this.uniforms.uCam.value.copy(cam.position);
    this.mesh.visible = this.level > 0.01 && !this.sheltered[i];
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.removeFromParent();
  }
}
