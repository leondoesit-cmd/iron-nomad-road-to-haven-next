import * as THREE from 'three';
import { shared } from './dispose';
import type { GlassKind, PaneStage } from '../sim/glass';

/**
 * Panes of glass as scenery that can break. A `PaneSet` is the glass of one thing (a building, a block's shopfronts, a car):
 * whole panes are merged into a single clear mesh; a pane that has been hit leaves it and gets its own frosted one, with a
 * web of cracks round each hit; a pane that goes is removed and leaves a few teeth of glass in its frame.
 *
 * Panes are in the set's own frame: world coordinates for a building or a street, the chassis frame for a car (the set's
 * `group` is then a child of the car's visual and moves with it).
 */

type V3 = [number, number, number];

export interface PaneSpec {
  /** Unique within the set. */
  key: string;
  kind: GlassKind;
  /** Centre of the pane, and the unit normal of its face. */
  c: V3;
  n: V3;
  /** Half the width (along the glass, level) and half the height (up the glass). */
  hw: number;
  hh: number;
}

interface Entry {
  spec: PaneSpec;
  stage: PaneStage;
  u: V3;
  v: V3;
  /** A frosted copy of the pane once it is no longer whole. */
  own: THREE.Mesh | null;
  cracks: THREE.Mesh[];
  /** Teeth left in the frame after it has gone. */
  teeth: THREE.Mesh | null;
}

const MAX_CRACKS = 5;

// ------------------------------------------------------------------------------------------ look

let clearMat: THREE.MeshStandardMaterial | null = null;
let frostMat: THREE.MeshStandardMaterial | null = null;
let crazedMat: THREE.MeshStandardMaterial | null = null;
let crackMat: THREE.MeshStandardMaterial | null = null;
let crackTex: THREE.Texture | null = null;

function glassMaterial(opacity: number, color: number, rough: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, transparent: true, opacity, roughness: rough, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  m.userData.shared = true;
  return m;
}

export const paneMaterials = () => ({
  clear: (clearMat ??= glassMaterial(0.22, 0x86a8b6, 0.04)),
  frost: (frostMat ??= glassMaterial(0.34, 0xaec4cc, 0.12)),
  crazed: (crazedMat ??= glassMaterial(0.55, 0xd2dde0, 0.3)),
});

/** A web of cracks from the middle: jagged spokes, a ring or two, and a pit where the blow landed. */
function crackTexture(): THREE.Texture {
  if (crackTex) return crackTex;
  if (typeof document === 'undefined') {
    crackTex = shared(new THREE.Texture());
    return crackTex;
  }
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, S, S);
  let s = 90210;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const spokes = 11;
  const ends: { x: number; y: number; a: number }[][] = [];
  for (let i = 0; i < spokes; i++) {
    const a0 = (i / spokes) * Math.PI * 2 + (rnd() - 0.5) * 0.35;
    let x = S / 2;
    let y = S / 2;
    let a = a0;
    const reach = S * (0.3 + rnd() * 0.2);
    const pts: { x: number; y: number; a: number }[] = [];
    g.strokeStyle = 'rgba(245,250,252,0.95)';
    g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(x, y);
    for (let d = 0; d < reach; ) {
      const step = 9 + rnd() * 14;
      a += (rnd() - 0.5) * 0.5;
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      d += step;
      g.lineTo(x, y);
      pts.push({ x, y, a });
      // A short branch now and then.
      if (rnd() < 0.3) {
        g.stroke();
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a + (rnd() - 0.5) * 1.8) * (10 + rnd() * 22), y + Math.sin(a + (rnd() - 0.5) * 1.8) * (10 + rnd() * 22));
        g.stroke();
        g.lineWidth = 2.2;
        g.beginPath();
        g.moveTo(x, y);
      }
    }
    g.stroke();
    ends.push(pts);
  }
  // Rings joining neighbouring spokes at a couple of radii.
  g.lineWidth = 1.1;
  g.strokeStyle = 'rgba(235,244,248,0.8)';
  for (const ring of [2, 4]) {
    g.beginPath();
    for (let i = 0; i <= spokes; i++) {
      const p = ends[i % spokes][Math.min(ring, ends[i % spokes].length - 1)];
      if (!p) continue;
      if (i === 0) g.moveTo(p.x, p.y);
      else g.lineTo(p.x, p.y);
    }
    g.stroke();
  }
  // The pit, white and crushed.
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, 20);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(S / 2 - 20, S / 2 - 20, 40, 40);
  crackTex = shared(new THREE.CanvasTexture(c));
  crackTex.colorSpace = THREE.SRGBColorSpace;
  crackTex.anisotropy = 4;
  return crackTex;
}

function crackMaterial(): THREE.MeshStandardMaterial {
  if (crackMat) return crackMat;
  crackMat = new THREE.MeshStandardMaterial({ map: crackTexture(), color: 0xe6eef0, transparent: true, depthWrite: false, roughness: 0.25, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  crackMat.userData.shared = true;
  return crackMat;
}

const unit = new THREE.PlaneGeometry(1, 1);
shared(unit);

// ------------------------------------------------------------------------------------------ geometry

/** The pane's own axes: `u` along the glass, level (or across the car for a windscreen), `v` up the glass. */
function basis(n: V3): { u: V3; v: V3 } {
  // u = up x n, falling back to x when the pane is flat.
  let ux = n[2];
  let uz = -n[0];
  let ul = Math.hypot(ux, uz);
  let u: V3;
  if (ul < 1e-4) u = [1, 0, 0];
  else {
    ux /= ul;
    uz /= ul;
    u = [ux, 0, uz];
  }
  // v = n x u.
  const v: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  ul = Math.hypot(v[0], v[1], v[2]) || 1;
  return { u, v: [v[0] / ul, v[1] / ul, v[2] / ul] };
}

function corners(e: Entry): V3[] {
  const { c, hw, hh } = e.spec;
  const pt = (a: number, b: number): V3 => [c[0] + e.u[0] * hw * a + e.v[0] * hh * b, c[1] + e.u[1] * hw * a + e.v[1] * hh * b, c[2] + e.u[2] * hw * a + e.v[2] * hh * b];
  return [pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)];
}

function quadsGeometry(es: Entry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const e of es) {
    const base = pos.length / 3;
    const cs = corners(e);
    const us: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) {
      pos.push(...cs[i]);
      nor.push(...e.spec.n);
      uv.push(...us[i]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** A few triangles of glass still standing round the edge of the frame. Deterministic from the pane's key. */
function teethGeometry(e: Entry): THREE.BufferGeometry {
  let s = 7;
  for (let i = 0; i < e.spec.key.length; i++) s = (Math.imul(s, 31) + e.spec.key.charCodeAt(i)) >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const { c, hw, hh, n } = e.spec;
  const pos: number[] = [];
  const nor: number[] = [];
  const push = (a: number, b: number) => {
    pos.push(c[0] + e.u[0] * hw * a + e.v[0] * hh * b, c[1] + e.u[1] * hw * a + e.v[1] * hh * b, c[2] + e.u[2] * hw * a + e.v[2] * hh * b);
    nor.push(...n);
  };
  const tooth = (edge: 0 | 1 | 2 | 3, at: number, w: number, d: number) => {
    // `at` runs -1..1 along the edge, `w` is the base in the same units, `d` how far in the tip reaches (0..1 of the span).
    const tip = (x: number, y: number) => push(x, y);
    if (edge === 0) {
      tip(at - w, -1);
      tip(at + w, -1);
      tip(at + (rnd() - 0.5) * w, -1 + d * 2);
    } else if (edge === 1) {
      tip(at - w, 1);
      tip(at + (rnd() - 0.5) * w, 1 - d * 2);
      tip(at + w, 1);
    } else if (edge === 2) {
      tip(-1, at - w);
      tip(-1 + d * 2, at + (rnd() - 0.5) * w);
      tip(-1, at + w);
    } else {
      tip(1, at - w);
      tip(1, at + w);
      tip(1 - d * 2, at + (rnd() - 0.5) * w);
    }
  };
  const nb = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < nb; i++) tooth(0, -0.9 + (i / nb) * 1.8 + rnd() * 0.2, 0.05 + rnd() * 0.1, 0.05 + rnd() * 0.12);
  for (let i = 0; i < 2; i++) tooth(1, -0.9 + rnd() * 1.8, 0.04 + rnd() * 0.06, 0.04 + rnd() * 0.08);
  tooth(2, -0.6 + rnd() * 1.2, 0.05 + rnd() * 0.06, 0.05 + rnd() * 0.08);
  tooth(3, -0.6 + rnd() * 1.2, 0.05 + rnd() * 0.06, 0.05 + rnd() * 0.08);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------------------------------ the set

export class PaneSet {
  readonly group = new THREE.Group();
  private entries = new Map<string, Entry>();
  private merged: THREE.Mesh | null = null;
  private dirty = false;

  constructor() {
    this.group.name = 'panes';
  }

  get size() {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  has(key: string) {
    return this.entries.has(key);
  }

  spec(key: string): PaneSpec | undefined {
    return this.entries.get(key)?.spec;
  }

  /** Stage the pane is showing: 0 whole, 1 cracked, 2 crazed, 3 gone. */
  stageOf(key: string): PaneStage {
    return this.entries.get(key)?.stage ?? 3;
  }

  /** Panes still standing in the set, and panes that have gone. */
  count(): { whole: number; hurt: number; gone: number } {
    const r = { whole: 0, hurt: 0, gone: 0 };
    for (const e of this.entries.values()) {
      if (e.stage === 0) r.whole++;
      else if (e.stage === 3) r.gone++;
      else r.hurt++;
    }
    return r;
  }

  add(spec: PaneSpec) {
    if (this.entries.has(spec.key)) return;
    const { u, v } = basis(spec.n);
    this.entries.set(spec.key, { spec, stage: 0, u, v, own: null, cracks: [], teeth: null });
    this.dirty = true;
    this.flush();
  }

  /**
   * The pane shows a stage (never going back down), with a web of cracks at `at` (a point in the set's frame, anywhere near
   * the glass: it is projected on to it) when the blow that did it landed on a known spot.
   */
  crack(key: string, stage: PaneStage, at?: V3) {
    const e = this.entries.get(key);
    if (!e || e.stage === 3) return;
    if (stage >= 3) return this.shatter(key);
    if (stage > e.stage) {
      const was = e.stage;
      e.stage = stage;
      if (was === 0) this.dirty = true;
      if (!e.own) {
        e.own = new THREE.Mesh(quadsGeometry([e]), paneMaterials().frost);
        e.own.renderOrder = 2;
        this.group.add(e.own);
      }
      e.own.material = stage >= 2 ? paneMaterials().crazed : paneMaterials().frost;
    }
    if (at && e.cracks.length < MAX_CRACKS) this.web(e, at, 0.35 + 0.28 * e.stage + Math.random() * 0.15);
    this.flush();
  }

  private web(e: Entry, at: V3, size: number) {
    const { c, n, hw, hh } = e.spec;
    // Project on to the pane and keep the web's centre inside it.
    const dx = at[0] - c[0];
    const dy = at[1] - c[1];
    const dz = at[2] - c[2];
    const a = Math.max(-hw, Math.min(hw, dx * e.u[0] + dy * e.u[1] + dz * e.u[2]));
    const b = Math.max(-hh, Math.min(hh, dx * e.v[0] + dy * e.v[1] + dz * e.v[2]));
    const off = 0.004 * (e.cracks.length + 1);
    const m = new THREE.Mesh(unit, crackMaterial());
    m.position.set(c[0] + e.u[0] * a + e.v[0] * b + n[0] * off, c[1] + e.u[1] * a + e.v[1] * b + n[1] * off, c[2] + e.u[2] * a + e.v[2] * b + n[2] * off);
    // The plane faces +z in its own frame: turn it so its x runs along `u` and its y up `v`.
    const mat = new THREE.Matrix4().makeBasis(new THREE.Vector3(...e.u), new THREE.Vector3(...e.v), new THREE.Vector3(...n));
    m.quaternion.setFromRotationMatrix(mat);
    m.rotateZ((Math.random() - 0.5) * 1.2);
    m.scale.set(size, size, 1);
    m.renderOrder = 3;
    this.group.add(m);
    e.cracks.push(m);
  }

  /** The pane goes: what was in the frame is gone, and a few teeth of glass are left in it. */
  shatter(key: string) {
    const e = this.entries.get(key);
    if (!e || e.stage === 3) return;
    const wasWhole = e.stage === 0;
    e.stage = 3;
    if (wasWhole) this.dirty = true;
    this.dropOwn(e);
    e.teeth = new THREE.Mesh(teethGeometry(e), paneMaterials().frost);
    e.teeth.renderOrder = 2;
    this.group.add(e.teeth);
    this.flush();
  }

  /** Take a pane away altogether, leaving no teeth. */
  remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.dropOwn(e);
    if (e.teeth) {
      this.group.remove(e.teeth);
      e.teeth.geometry.dispose();
    }
    this.entries.delete(key);
    this.dirty = true;
    this.flush();
  }

  /** Put a pane that has broken back whole (a car's windscreen fitted new). */
  mend(key: string) {
    const e = this.entries.get(key);
    if (!e || e.stage === 0) return;
    this.dropOwn(e);
    if (e.teeth) {
      this.group.remove(e.teeth);
      e.teeth.geometry.dispose();
      e.teeth = null;
    }
    e.stage = 0;
    this.dirty = true;
    this.flush();
  }

  private dropOwn(e: Entry) {
    if (e.own) {
      this.group.remove(e.own);
      e.own.geometry.dispose();
      e.own = null;
    }
    for (const m of e.cracks) this.group.remove(m);
    e.cracks.length = 0;
  }

  /** Rebuild the merged mesh of whole panes if the set of them changed. */
  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.merged) {
      this.group.remove(this.merged);
      this.merged.geometry.dispose();
      this.merged = null;
    }
    const whole = [...this.entries.values()].filter((e) => e.stage === 0);
    if (!whole.length) return;
    this.merged = new THREE.Mesh(quadsGeometry(whole), paneMaterials().clear);
    this.merged.renderOrder = 1;
    this.merged.frustumCulled = true;
    this.group.add(this.merged);
  }

  dispose() {
    for (const e of this.entries.values()) {
      e.own?.geometry.dispose();
      e.teeth?.geometry.dispose();
    }
    this.merged?.geometry.dispose();
    this.merged = null;
    this.entries.clear();
    this.group.removeFromParent();
    this.group.clear();
  }
}
