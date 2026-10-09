import * as THREE from 'three';
import { ZombieRenderer } from './zombieRender';
import { innardsGeometry } from './innards';
import { FLESH_HEAD, FLESH_W } from './fleshShader';
import { bakedModel } from './bakedModel';
import { CHAINS, WOUND, type FleshState } from '../sim/flesh';
import type { ZombieKind } from '../data';
import type { ZombieMotion } from '../sim/zombieAnimation';

/** Where and how a body is drawn this frame: the arguments `ZombieRenderer.push` takes. */
export interface BodyPose {
  kind: ZombieKind;
  scale: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  phase: number;
  stride: number;
  chase: number;
  fall: number;
  variant: number;
  /** What `ballistics.wound` has taken off (picks the crawl when both legs are gone). */
  mask: number;
  reel: number;
  lean: number;
  motion?: ZombieMotion;
}

/** Baked bone each mesh part rides (as the zombie shader maps them). */
const PART_BONE = [0, 3, 5, 4, 6, 7, 9, 8, 10, 2];

const _m = new THREE.Matrix4();
const _b = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * The wounded and the pieces of them: the zombie shader built with `flesh`, drawing both sides, with the anatomy
 * (`innards.ts`) as a second instanced mesh sharing every per-instance attribute. Each instance reads its own row of a float
 * texture: its cuts, breaks, dents and wounds (`fleshShader.ts`). Bodies nobody has hurt stay in the plain horde mesh.
 *
 * It also answers where a point of a body is in the world this frame (the root of a spilled gut, the place a severed arm
 * starts its flight), by running the same skinning as the shader on the CPU from the motion bank.
 */
export class FleshRenderer extends ZombieRenderer {
  readonly innards: THREE.InstancedMesh;
  private data: Float32Array;
  private tex: THREE.DataTexture;
  /** Half floats of the motion bank, read on the CPU for `boneMatrix`. */
  private bank = bakedModel('zombie-anims');
  /** The last instance index is kept free as scratch for working out poses. */
  private scratch: number;
  /** Bodies and pieces with nothing open to see into: drawn after the rest, so the anatomy is drawn only for the rest. */
  private later: (() => void)[] = [];

  constructor(max = 96) {
    super({ flesh: true, max: max + 1 });
    this.scratch = max;
    this.data = new Float32Array(FLESH_W * (max + 1) * 4);
    this.tex = new THREE.DataTexture(this.data, FLESH_W, max + 1, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    this.uniforms.tFlesh.value = this.tex;
    const geo = innardsGeometry();
    geo.setAttribute('aMotion', this.motionAttr);
    geo.setAttribute('aGore', this.goreAttr);
    geo.setAttribute('aAnim', this.animAttr);
    geo.setAttribute('aKind', this.kindAttr);
    this.innards = new THREE.InstancedMesh(geo, this.mesh.material, max + 1);
    this.innards.instanceMatrix = this.mesh.instanceMatrix;
    this.innards.frustumCulled = false;
    this.innards.castShadow = false;
    this.innards.receiveShadow = true;
    this.innards.count = 0;
    this.innards.name = 'zombie:innards';
    this.mesh.name = 'zombie:flesh';
    // Drawn after the skin over it, so most of it fails the depth test early.
    this.innards.renderOrder = 1;
    this.mesh.add(this.innards);
  }

  /** Room for another body or piece this frame. */
  get room() {
    return this.count + this.later.length < this.scratch;
  }

  begin() {
    super.begin();
    this.later.length = 0;
  }

  /** A wound deep enough to see into: the anatomy under it has to be drawn. */
  private static open(f: FleshState): boolean {
    for (const w of f.wounds) if (w.depth > 0.12 && w.r >= 0.008 && w.k !== WOUND.bruise && w.k !== WOUND.burn) return true;
    return false;
  }

  /** A wounded body where it stands (or lies). */
  pushBody(p: BodyPose, alpha: number, f: FleshState) {
    if (!this.room) return;
    if (!FleshRenderer.open(f)) {
      this.later.push(() => this.drawBody(p, alpha, f));
      return;
    }
    this.drawBody(p, alpha, f);
  }

  private drawBody(p: BodyPose, alpha: number, f: FleshState) {
    this.push(p.kind, p.scale, p.x, p.y, p.z, p.yaw, p.phase, p.stride, p.chase, p.fall, p.variant, alpha, p.mask, p.reel, p.lean, p.motion);
    const i = this.count - 1;
    // The cuts draw what is gone; the old part mask would fold whole limbs away at the joint.
    this.gore[i * 4] = 0;
    this.write(i, f, 0);
  }

  /**
   * A piece that came off a body (`chain`'s side of its cut), in the rest pose, at a world position and rotation. `cx, cy, cz`
   * is the point of the rest pose it turns about.
   */
  pushPiece(kind: ZombieKind, scale: number, variant: number, chain: number, f: FleshState, pos: THREE.Vector3, quat: THREE.Quaternion, cx: number, cy: number, cz: number) {
    if (!this.room) return;
    if (!FleshRenderer.open(f)) {
      const at = pos.clone();
      const q = quat.clone();
      this.later.push(() => this.drawPiece(kind, scale, variant, chain, f, at, q, cx, cy, cz));
      return;
    }
    this.drawPiece(kind, scale, variant, chain, f, pos, quat, cx, cy, cz);
  }

  private drawPiece(kind: ZombieKind, scale: number, variant: number, chain: number, f: FleshState, pos: THREE.Vector3, quat: THREE.Quaternion, cx: number, cy: number, cz: number) {
    this.push(kind, scale, 0, 0, 0, 0, 0, 0, 0, 0, variant, 1, 0, 0, 0, undefined);
    const i = this.count - 1;
    _s.set(scale, scale, scale);
    _m.compose(pos, quat, _s);
    _b.makeTranslation(-cx, -cy, -cz);
    _m.multiply(_b);
    this.mesh.setMatrixAt(i, _m);
    this.write(i, f, chain + 1);
  }

  end(time: number) {
    const inside = this.count;
    for (const draw of this.later) draw();
    this.later.length = 0;
    super.end(time);
    this.innards.count = inside;
    this.uniforms.uFleshTime.value = time;
    if (this.count > 0) this.tex.needsUpdate = true;
  }

  /** One instance's row of the texture (see `fleshShader.ts` for the layout). */
  private write(i: number, f: FleshState, mode: number) {
    const d = this.data;
    const o = i * FLESH_W * 4;
    d.fill(0, o, o + FLESH_HEAD * 4);
    for (let k = 0; k < 4; k++) d[o + k] = f.cut[k];
    d[o + 4] = f.cut[4];
    d[o + 5] = f.cut[5];
    d[o + 6] = mode;
    let rag = 0;
    for (let k = 0; k < CHAINS.length; k++) if (f.rag[k]) rag |= 1 << k;
    d[o + 7] = rag;
    for (let k = 0; k < 8; k++) {
      d[o + 8 + k] = f.bend[k];
      d[o + 16 + k] = f.bendDir[k];
    }
    for (let j = 0; j < Math.min(2, f.dents.length); j++) {
      const t = f.dents[j];
      const q = o + 24 + j * 8;
      d[q] = t.x; d[q + 1] = t.y; d[q + 2] = t.z; d[q + 3] = t.r;
      d[q + 4] = t.nx; d[q + 5] = t.ny; d[q + 6] = t.nz; d[q + 7] = t.depth;
    }
    d[o + 40] = f.wounds.length;
    for (let k = 0; k < f.wounds.length; k++) {
      const w = f.wounds[k];
      const q = o + (FLESH_HEAD + k * 4) * 4;
      d[q] = w.x; d[q + 1] = w.y; d[q + 2] = w.z; d[q + 3] = w.r;
      d[q + 4] = w.nx; d[q + 5] = w.ny; d[q + 6] = w.nz; d[q + 7] = w.k;
      d[q + 8] = w.tx; d[q + 9] = w.ty; d[q + 10] = w.tz; d[q + 11] = w.len;
      d[q + 12] = w.depth; d[q + 13] = w.t; d[q + 14] = w.seed; d[q + 15] = 0;
    }
  }

  // ------------------------------------------------------------------ where a body's parts are

  private texel(line: number, x: number, out: number[]) {
    const bank = this.bank!;
    const w = bank.data.bones * 3;
    const o = (line * w + x) * 4;
    const a = bank.data.anim;
    for (let k = 0; k < 4; k++) out[k] = THREE.DataUtils.fromHalfFloat(a[o + k]);
  }

  private r0 = [0, 0, 0, 0];
  private r1 = [0, 0, 0, 0];
  private r2 = [0, 0, 0, 0];
  private acc = new Float32Array(12);

  /** Add `w` times one frame of one bone (rows of a 3x4 matrix) into `acc`. */
  private addBone(line: number, bone: number, w: number) {
    if (w <= 0) return;
    this.texel(line, bone * 3, this.r0);
    this.texel(line, bone * 3 + 1, this.r1);
    this.texel(line, bone * 3 + 2, this.r2);
    for (let k = 0; k < 4; k++) {
      this.acc[k] += this.r0[k] * w;
      this.acc[4 + k] += this.r1[k] * w;
      this.acc[8 + k] += this.r2[k] * w;
    }
  }

  private frames(start: number, frames: number, phase: number): [number, number, number] {
    const n = Math.max(Math.abs(frames), 1);
    const loop = frames > 0;
    const p = loop ? (phase - Math.floor(phase)) * n : Math.min(1, Math.max(0, phase)) * (n - 1);
    const i0 = Math.floor(p);
    const f = p - i0;
    const i1 = loop ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
    return [start + i0, start + i1, f];
  }

  /**
   * A body's bone this frame, as the shader blends it, into `out` (the body's own frame, before its position, turn and
   * scale). Identity when the motion bank is not loaded.
   */
  boneMatrix(p: BodyPose, bone: number, out: THREE.Matrix4, w = 1, add = false): THREE.Matrix4 {
    if (!this.clips || !this.bank) return add ? out : out.identity();
    const i = this.scratch;
    const keep = this.count;
    this.count = i;
    this.push(p.kind, p.scale, p.x, p.y, p.z, p.yaw, p.phase, p.stride, p.chase, p.fall, p.variant, 1, p.mask, p.reel, p.lean, p.motion);
    this.count = keep;
    const A = this.anim;
    const M = this.motion;
    this.acc.fill(0);
    const [a0, a1, af] = this.frames(A[i * 4], A[i * 4 + 1], A[i * 4 + 2]);
    const wb = A[i * 4 + 3];
    this.addBone(a0, bone, (1 - af) * (1 - wb));
    this.addBone(a1, bone, af * (1 - wb));
    if (wb > 0.001) {
      const [b0, b1, bf] = this.frames(M[i * 4], M[i * 4 + 1], M[i * 4 + 2]);
      this.addBone(b0, bone, (1 - bf) * wb);
      this.addBone(b1, bone, bf * wb);
    }
    const c = this.acc;
    _b.set(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], 0, 0, 0, 1);
    if (!add) return out.copy(_b);
    for (let k = 0; k < 16; k++) out.elements[k] += _b.elements[k] * w;
    return out;
  }

  /** The body's placement in the world: position, turn (a dead body's tipped to the slope it lies on, or the topple of the
   * old procedural death), scale. */
  private placement(p: BodyPose, out: THREE.Matrix4) {
    const baked = !!this.clips;
    _p.set(p.x, p.y - (baked && p.fall > 0 ? 0.1 : 0), p.z);
    _e.set(baked ? (p.motion?.pitch ?? 0) : -p.fall * (Math.PI / 2) * 0.95, p.yaw, baked ? (p.motion?.roll ?? 0) : 0, 'YXZ');
    _q.setFromEuler(_e);
    _s.set(p.scale, p.scale, p.scale);
    return out.compose(_p, _q, _s);
  }

  /** The skin transform of a mesh part at a rest-pose height (the torso blends pelvis, chest and head up the spine). */
  partMatrix(p: BodyPose, part: number, y: number, out: THREE.Matrix4): THREE.Matrix4 {
    if (!this.clips || !this.bank) return out.identity();
    if (part !== 0) return this.boneMatrix(p, PART_BONE[part], out);
    const wc = smooth(1.02, 1.28, y);
    const wh = smooth(1.5, 1.6, y);
    out.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    if (1 - wc > 0) this.boneMatrix(p, 0, out, 1 - wc, true);
    if (wc * (1 - wh) > 0) this.boneMatrix(p, 1, out, wc * (1 - wh), true);
    if (wc * wh > 0) this.boneMatrix(p, 2, out, wc * wh, true);
    out.elements[15] = 1;
    return out;
  }

  /** Where a rest-pose point of a part of the body is in the world this frame. */
  worldPoint(p: BodyPose, part: number, rx: number, ry: number, rz: number, out: THREE.Vector3): THREE.Vector3 {
    // The heavy infected's torso is swollen or barrel-chested in the rest pose, as the shader shapes it.
    if (part === 0) {
      const belly = Math.exp(-(((ry - 1.12) / 0.23) ** 2));
      const chest = smooth(1.04, 1.4, ry) * (1 - smooth(1.44, 1.55, ry));
      const k = p.kind;
      rx *= 1 + (k === 'bloater' ? belly * 1.45 : 0) + (k === 'brute' ? chest * 0.48 : 0) - (k === 'stalker' ? chest * 0.12 : 0);
      rz = -0.015 + (rz + 0.015) * (1 + (k === 'bloater' ? belly * 2 : 0) + (k === 'brute' ? chest * 0.4 : 0));
    }
    const m = this.partMatrix(p, part, ry, new THREE.Matrix4());
    out.set(rx, ry, rz).applyMatrix4(m);
    if (this.clips) {
      // The game's own lean and a hit's reel ride on the clip (as `pushBaked` set them), then the body's build.
      const i = this.scratch;
      const zl = smooth(0.9, 1.5, out.y);
      out.z += (this.gore[i * 4 + 2] - this.gore[i * 4 + 1] * 0.9) * zl * (out.y - 0.9);
      const hash = (salt: number) => {
        const v = Math.sin(this.kind[i * 4 + 1] * 173.31 + salt * 31.17) * 43758.5453;
        return v - Math.floor(v);
      };
      out.x *= 0.9 + hash(6) * 0.2 + (p.kind === 'brute' ? 0.08 : 0) - (p.kind === 'stalker' ? 0.1 : 0) - (p.kind === 'runner' ? 0.04 : 0);
      out.z *= 0.9 + hash(7) * 0.2;
    }
    return out.applyMatrix4(this.placement(p, _m));
  }

  /** The whole transform of a part (rest pose to world), for starting a piece where the body had it. */
  partWorld(p: BodyPose, part: number, y: number, out: THREE.Matrix4): THREE.Matrix4 {
    this.partMatrix(p, part, y, out);
    return out.premultiply(this.placement(p, _m));
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
