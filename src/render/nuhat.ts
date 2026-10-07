import * as THREE from 'three';
import { damp } from '../core/math';
import { MeshBuilder, S } from './builder';
import { shared } from './dispose';
import { kitMaterial } from './materials';
import { headField, portraitGeometry, portraitMaterial, warmPortrait, type HairMode } from './portrait';
import { NUHAT, NUHAT_SMILE, NUHAT_TALK, NUHAT_WONDER } from './nuhatLook';
import type { Humanoid } from './humanoid';

export type CharacterExpression = 'neutral' | 'talking' | 'smiling' | 'wondering';
export const CHARACTER_EXPRESSIONS: readonly CharacterExpression[] = ['neutral', 'talking', 'smiling', 'wondering'];
const TARGETS = [NUHAT_TALK, NUHAT_SMILE, NUHAT_WONDER];
const morphs = new Map<HairMode, THREE.BufferGeometry>();

/** All portrait surfaces use the same radial grid, so expressions share vertex correspondence. */
function expressionGeometry(mode: HairMode) {
  let geometry = morphs.get(mode);
  if (geometry) return geometry;
  geometry = portraitGeometry(NUHAT, mode).clone();
  geometry.morphAttributes.position = TARGETS.map(spec => portraitGeometry(spec, mode).getAttribute('position'));
  geometry.morphAttributes.normal = TARGETS.map(spec => portraitGeometry(spec, mode).getAttribute('normal'));
  geometry.morphTargetsRelative = false;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  morphs.set(mode, shared(geometry));
  return geometry;
}

const braidGeometry = new Map<HairMode, THREE.BufferGeometry[]>();
/** Six bundles move independently; each braid has three interwoven strands. */
function braidParts(mode: HairMode) {
  const cached = braidGeometry.get(mode);
  if (cached) return cached;
  const field = headField(NUHAT.shape);
  const center = new THREE.Vector3(0, 0.12, -0.012);
  const outward = new THREE.Vector3();
  const scalp = (p: THREE.Vector3) => {
    if (p.y < 0.065) return p;
    outward.copy(p).sub(center).normalize();
    for (let j = 0; j < 8; j++) {
      const d = field.at(p.x, p.y, p.z);
      if (d >= 0.010) break;
      p.addScaledVector(outward, 0.010 - d);
    }
    return p;
  };
  const parts = Array.from({ length: 6 }, (_, bundle) => {
    const b = new MeshBuilder();
    b.jitter = 0.008;
    for (let i = 0; i < 8; i++) {
      const n = bundle * 8 + i;
      const front = n < 32;
      const lane = front ? n / 31 : (n - 32) / 15;
      const z = front ? 0.075 - lane * 0.17 : -0.085 - Math.sin(lane * Math.PI) * 0.016;
      const side = front ? -1 : 1;
      const length = 0.53 + ((n * 0.618) % 1) * 0.17;
      const controlPoints = [
        new THREE.Vector3(0.048, 0.212 - Math.abs(z) * 0.22, z),
        new THREE.Vector3(front ? -0.015 : 0.078, 0.230 - Math.abs(z) * 0.1, z + 0.012),
        new THREE.Vector3(side * 0.087, 0.174, z + 0.020),
        new THREE.Vector3(side * 0.103, 0.065, z + 0.025),
        new THREE.Vector3(side * (0.108 + (n % 4) * 0.009), -0.10, front ? 0.112 + lane * 0.03 : -0.105),
        new THREE.Vector3(side * (0.105 + lane * 0.11), -0.30, front ? 0.17 + (n % 3) * 0.009 : -0.15),
        new THREE.Vector3(side * (0.10 + lane * 0.12 + Math.sin(n * 1.8) * 0.01), -length, front ? 0.163 + (n % 4) * 0.009 : -0.16),
      ];
      const path = new THREE.CatmullRomCurve3(mode === 'covered' ? controlPoints.slice(3) : controlPoints);
      const frames = path.computeFrenetFrames(72, false);
      for (let strand = 0; strand < 3; strand++) {
        const points = Array.from({ length: 73 }, (_, k) => {
          const t = k / 72;
          const angle = t * Math.PI * 2 * 34 + strand * Math.PI * 2 / 3;
          const radius = 0.0025 * (1 - t * 0.32);
          return scalp(path.getPointAt(t)).addScaledVector(frames.normals[k], Math.cos(angle) * radius)
            .addScaledVector(frames.binormals[k], Math.sin(angle) * radius);
        });
        const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 72, 0.0023, 4, false);
        b.geo(tube, 0, 0, 0, 1, 1, 1, { c: [0x171517, 0x262225, 0x1b181b][strand], r: 0.55, w: 0 });
        tube.dispose();
      }
    }
    return shared(b.build());
  });
  braidGeometry.set(mode, parts);
  return parts;
}

/** Speech includes rounded vowels, small consonants and a short breath between phrases. */
export function nuhatSpeechOpen(time: number) {
  const phrase = time % 3.8;
  if (phrase > 3.15) return 0.035;
  const syllable = Math.sin(time * 13.7) * 0.5 + 0.5;
  return 0.12 + 0.86 * syllable ** 1.5 * (0.65 + 0.35 * Math.sin(time * 5.3) ** 2);
}

/** Per-character expression weights and braid motion; geometry and painted portraits stay cached. */
export class NuhatRig {
  readonly hair = new THREE.Group();
  private bundles: THREE.Mesh[];
  private time = 0;
  private amount = [0, 0, 0];
  private gesture = 0;
  private material?: THREE.MeshStandardMaterial;
  private firstPerson = false;
  private target = new THREE.Vector3();
  private pole = new THREE.Vector3();

  constructor(private h: Humanoid, private face: THREE.Mesh, private mode: HairMode) {
    this.hair.name = 'nuhat-box-braids';
    this.bundles = braidParts(mode).map((geometry, i) => {
      const mesh = new THREE.Mesh(geometry, kitMaterial({ detail: false }));
      mesh.name = `nuhat-braid-bundle-${i}`;
      mesh.castShadow = true;
      this.hair.add(mesh);
      return mesh;
    });
    const jewelry = new MeshBuilder();
    for (const side of [-1, 1]) jewelry.torus(side * 0.077, 0.074, 0.009, 0.007, 0.0014, S.metal(0xd6b35f, 0), 0, side * 0.6, 0, 5, 16);
    const earrings = new THREE.Mesh(shared(jewelry.build()), kitMaterial({ detail: false }));
    earrings.name = 'nuhat-gold-earrings';
    this.hair.add(earrings);
    h.head.add(this.hair);
  }

  private prepareExpressions() {
    if (this.material) {
      if (this.face.material !== this.material) {
        this.face.geometry = expressionGeometry(this.mode);
        this.face.material = this.material;
        this.face.updateMorphTargets();
      }
      return;
    }
    const base = portraitMaterial(NUHAT) as THREE.MeshStandardMaterial;
    const material = this.material = base.clone();
    const textures = TARGETS.map(spec => ({ value: (portraitMaterial(spec) as THREE.MeshStandardMaterial).map }));
    material.onBeforeCompile = (shader, renderer) => {
      base.onBeforeCompile(shader, renderer);
      shader.uniforms.nuhatWeights = { value: this.amount };
      textures.forEach((texture, i) => shader.uniforms[`nuhatMap${i}`] = texture);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
        uniform vec3 nuhatWeights;
        uniform sampler2D nuhatMap0;
        uniform sampler2D nuhatMap1;
        uniform sampler2D nuhatMap2;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        vec4 sampledDiffuseColor = texture2D(map, vMapUv) * (1.0 - dot(nuhatWeights, vec3(1.0)));
        sampledDiffuseColor += texture2D(nuhatMap0, vMapUv) * nuhatWeights.x;
        sampledDiffuseColor += texture2D(nuhatMap1, vMapUv) * nuhatWeights.y;
        sampledDiffuseColor += texture2D(nuhatMap2, vMapUv) * nuhatWeights.z;
        diffuseColor *= sampledDiffuseColor;`);
    };
    material.customProgramCacheKey = () => 'nuhat-expressions-v1';
    material.onBeforeRender = () => {
      [NUHAT, ...TARGETS].forEach(warmPortrait);
      // The painter replaces its temporary low-resolution map after the worker finishes.
      material.map = (portraitMaterial(NUHAT) as THREE.MeshStandardMaterial).map;
      TARGETS.forEach((spec, i) => textures[i].value = (portraitMaterial(spec) as THREE.MeshStandardMaterial).map);
    };
    this.face.geometry = expressionGeometry(this.mode);
    this.face.material = material;
    this.face.updateMorphTargets();
  }

  setFirstPerson(on: boolean) {
    this.firstPerson = on;
    this.hair.visible = !on;
  }

  update(dt: number, expression: CharacterExpression, speed: number, gestureAllowed: boolean) {
    this.time += dt;
    const t = this.time;
    if (expression !== 'neutral') this.prepareExpressions();
    const targets = [expression === 'talking' ? nuhatSpeechOpen(t) : 0, expression === 'smiling' ? 1 : 0, expression === 'wondering' ? 1 : 0];
    for (let i = 0; i < 3; i++) {
      this.amount[i] = damp(this.amount[i], targets[i], i === 0 ? 22 : 8, dt);
    }
    const total = Math.max(1, this.amount.reduce((a, b) => a + b, 0));
    for (let i = 0; i < 3; i++) {
      this.amount[i] /= total;
      if (this.face.morphTargetInfluences) this.face.morphTargetInfluences[i] = this.amount[i];
    }
    this.hair.visible = !this.firstPerson;
    this.bundles.forEach((bundle, i) => {
      // Keep the ends near the shoulders when the head nods, with restrained secondary motion during a stride.
      bundle.rotation.x = -this.h.head.rotation.x * 0.72 + Math.sin(t * (speed > 0.1 ? 6 : 1.6) + i * 0.6) * (0.006 + Math.min(speed, 2) * 0.009);
      bundle.rotation.z = -this.h.head.rotation.z * 0.72 + Math.sin(t * 1.9 + i) * 0.008;
    });
    this.gesture = damp(this.gesture, gestureAllowed && (expression === 'talking' || expression === 'wondering') ? 1 : 0, 8, dt);
    const k = this.gesture;
    if (k > 0.001) {
      if (expression === 'wondering') {
        this.h.head.rotation.z += 0.12 * k;
        this.h.head.rotation.y += Math.sin(t * 0.7) * 0.09 * k;
        this.h.head.rotation.x -= 0.04 * k;
        this.target.set(-0.032, 0.55, 0.16);
        this.pole.set(-0.4, -0.6, 0.1);
        this.h.reach('R', this.target, this.pole, k);
      } else if (expression === 'talking') {
        this.h.head.rotation.x += Math.sin(t * 3.1) * 0.035 * k;
        this.h.head.rotation.y += Math.sin(t * 1.3) * 0.05 * k;
        this.target.set(-0.24 - Math.sin(t * 1.8) * 0.055, 0.28 + Math.sin(t * 2.6) * 0.07, 0.27);
        this.pole.set(-0.42, -0.4, 0.05);
        this.h.reach('R', this.target, this.pole, k * 0.65);
        this.h.hand.rotation.z -= 0.25 * k;
      }
    }
  }

  dispose() {
    this.hair.removeFromParent();
    this.material?.dispose();
  }
}
