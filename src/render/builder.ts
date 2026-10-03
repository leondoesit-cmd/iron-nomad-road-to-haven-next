import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { PartMeta, PartRange } from './bodyParts';

/**
 * A surface: albedo plus physically based parameters, written per vertex so one mesh can mix paint,
 * bare metal, rubber and glass. `w` is wear (grime and rust from the kit shader), `e` is emissive strength.
 */
export interface Surf {
  c: number | THREE.Color;
  r?: number;
  m?: number;
  w?: number;
  e?: number;
}
export type ColorIn = number | THREE.Color | Surf;

/** Surface presets. Numbers passed where a colour is expected get the default: rough, dielectric, mid wear. */
export const S = {
  paint: (c: number, w = 0.55): Surf => ({ c, r: 0.48, m: 0.12, w }),
  gloss: (c: number, w = 0.3): Surf => ({ c, r: 0.28, m: 0.1, w }),
  metal: (c = 0x8a9096, w = 0.45): Surf => ({ c, r: 0.4, m: 0.88, w }),
  steel: (c = 0x5c6266, w = 0.6): Surf => ({ c, r: 0.58, m: 0.78, w }),
  chrome: (c = 0xd9dde2): Surf => ({ c, r: 0.1, m: 1, w: 0.12 }),
  rust: (c = 0x7a3f22): Surf => ({ c, r: 0.92, m: 0.3, w: 1 }),
  rubber: (c = 0x1b1b1d): Surf => ({ c, r: 0.86, m: 0, w: 0.35 }),
  plastic: (c: number, w = 0.35): Surf => ({ c, r: 0.55, m: 0, w }),
  glass: (c = 0x0d141a): Surf => ({ c, r: 0.04, m: 0.15, w: 0.2 }),
  cloth: (c: number, w = 0.45): Surf => ({ c, r: 0.95, m: 0, w }),
  leather: (c: number, w = 0.4): Surf => ({ c, r: 0.6, m: 0, w }),
  skin: (c: number): Surf => ({ c, r: 0.55, m: 0, w: 0.08 }),
  wood: (c: number, w = 0.55): Surf => ({ c, r: 0.85, m: 0, w }),
  concrete: (c: number, w = 0.55): Surf => ({ c, r: 0.92, m: 0, w }),
  rock: (c: number): Surf => ({ c, r: 0.9, m: 0, w: 0.25 }),
  glow: (c: number, e = 4): Surf => ({ c, r: 0.4, m: 0, w: 0, e }),
};

const DEF_R = 0.82;
const DEF_M = 0;
const DEF_W = 0.5;

const _c = new THREE.Color();
function resolve(c: ColorIn): { col: THREE.Color; r: number; m: number; w: number; e: number } {
  if (typeof c === 'number') return { col: _c.set(c), r: DEF_R, m: DEF_M, w: DEF_W, e: 0 };
  if ((c as THREE.Color).isColor) return { col: _c.copy(c as THREE.Color), r: DEF_R, m: DEF_M, w: DEF_W, e: 0 };
  const s = c as Surf;
  if (typeof s.c === 'number') _c.set(s.c);
  else _c.copy(s.c);
  return { col: _c, r: s.r ?? DEF_R, m: s.m ?? DEF_M, w: s.w ?? DEF_W, e: s.e ?? 0 };
}

/** Shared primitive templates. Everything the builder emits is a transformed copy of one of these. */
const tpl = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1),
  cyl8: new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1),
  cyl10: new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1),
  cyl14: new THREE.CylinderGeometry(0.5, 0.5, 1, 14, 1),
  cyl20: new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1),
  cone6: new THREE.ConeGeometry(0.5, 1, 6, 1),
  cone12: new THREE.ConeGeometry(0.5, 1, 12, 1),
  ico: new THREE.IcosahedronGeometry(0.5, 0),
  ico1: new THREE.IcosahedronGeometry(0.5, 1),
  ico2: new THREE.IcosahedronGeometry(0.5, 2),
  sphere: new THREE.SphereGeometry(0.5, 8, 6),
  sphere16: new THREE.SphereGeometry(0.5, 16, 12),
  dome: new THREE.SphereGeometry(0.5, 16, 7, 0, Math.PI * 2, 0, Math.PI / 2),
};
export type Prim = keyof typeof tpl;

const dyn = new Map<string, THREE.BufferGeometry>();
function cachedGeo(key: string, make: () => THREE.BufferGeometry) {
  let g = dyn.get(key);
  if (!g) {
    g = make();
    dyn.set(key, g);
  }
  return g;
}
const k3 = (v: number) => Math.round(v * 1000);
/** Unit cylinder (diameter 1, height 1) with `seg` sides. */
function cylGeo(seg: number): THREE.BufferGeometry {
  const t = (tpl as Record<string, THREE.BufferGeometry>)[`cyl${seg}`];
  return t ?? cachedGeo(`cyl:${seg}`, () => new THREE.CylinderGeometry(0.5, 0.5, 1, seg, 1));
}

const Y = new THREE.Vector3(0, 1, 0);

/**
 * Accumulates transformed primitives into one BufferGeometry with per-vertex colour and surface.
 * Used for chunk props, buildings, characters and vehicle bodies so each becomes a single draw call.
 */
export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  srf: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** Runs of vertices that belong to parts which can come off the finished model (see bodyParts.ts). */
  parts: PartRange[] = [];
  private open: { tag: string; v0: number; i0: number; meta: PartMeta }[] = [];
  private m = new THREE.Matrix4();
  private nm = new THREE.Matrix3();
  private v = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  /** Per-vertex colour jitter, makes flat surfaces look weathered. */
  jitter = 0.04;
  /** Bevel segments for rounded boxes: 1 is a chamfer (props), 2 a soft round (hero models). */
  roundSeg = 1;
  private rnd = 1;

  seed(n: number) {
    this.rnd = (n | 0) || 1;
  }

  /**
   * Everything added until the matching `end()` is one part that can come off the model later: its vertices stay
   * a contiguous run in the merged mesh. The same tag may be marked more than once; the runs are joined up afterwards.
   */
  mark(tag: string, meta: PartMeta) {
    this.open.push({ tag, v0: this.pos.length / 3, i0: this.idx.length, meta });
    return this;
  }

  end() {
    const o = this.open.pop();
    if (!o) return this;
    const v1 = this.pos.length / 3;
    if (v1 > o.v0) this.parts.push({ tag: o.tag, v0: o.v0, v1, i0: o.i0, i1: this.idx.length, meta: o.meta });
    return this;
  }
  private rand() {
    this.rnd = (Math.imul(this.rnd, 1664525) + 1013904223) | 0;
    return ((this.rnd >>> 0) / 4294967296) * 2 - 1;
  }

  /** Core: append geometry `g` under matrix `this.m`. */
  private push(g: THREE.BufferGeometry, color: ColorIn, uvOverride?: UvFn) {
    this.nm.getNormalMatrix(this.m);
    const base = this.pos.length / 3;
    const pa = g.attributes.position;
    const na = g.attributes.normal;
    const ua = g.attributes.uv;
    const s = resolve(color);
    const cr = s.col.r;
    const cg = s.col.g;
    const cb = s.col.b;
    for (let i = 0; i < pa.count; i++) {
      this.v.fromBufferAttribute(pa, i).applyMatrix4(this.m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      const px = this.v.x;
      const py = this.v.y;
      const pz = this.v.z;
      this.v.fromBufferAttribute(na, i).applyMatrix3(this.nm).normalize();
      this.nor.push(this.v.x, this.v.y, this.v.z);
      const j = 1 + this.rand() * this.jitter;
      this.col.push(cr * j, cg * j, cb * j);
      this.srf.push(s.r, s.m, s.w, s.e);
      if (uvOverride && ua) {
        const r = uvOverride(ua.getX(i), ua.getY(i), this.v.x, this.v.y, this.v.z, px, py, pz);
        this.uv.push(r[0], r[1]);
      } else if (ua) this.uv.push(ua.getX(i), ua.getY(i));
      else this.uv.push(0, 0);
    }
    const ia = g.index;
    if (ia) for (let i = 0; i < ia.count; i++) this.idx.push(base + ia.getX(i));
    else for (let i = 0; i < pa.count; i++) this.idx.push(base + i);
    return this;
  }

  private compose(px: number, py: number, pz: number, sx: number, sy: number, sz: number, rx: number, ry: number, rz: number) {
    this.p.set(px, py, pz);
    this.s.set(sx, sy, sz);
    this.e.set(rx, ry, rz, 'YXZ');
    this.q.setFromEuler(this.e);
    this.m.compose(this.p, this.q, this.s);
  }

  /** Adds a primitive with position, size, euler rotation (radians, YXZ order) and surface. */
  add(prim: Prim, px: number, py: number, pz: number, sx: number, sy: number, sz: number, color: ColorIn, rx = 0, ry = 0, rz = 0, uvOverride?: UvFn) {
    this.compose(px, py, pz, sx, sy, sz, rx, ry, rz);
    return this.push(tpl[prim], color, uvOverride);
  }

  /** Any geometry, transformed. */
  geo(g: THREE.BufferGeometry, px: number, py: number, pz: number, sx: number, sy: number, sz: number, color: ColorIn, rx = 0, ry = 0, rz = 0) {
    this.compose(px, py, pz, sx, sy, sz, rx, ry, rz);
    return this.push(g, color);
  }

  /** Any geometry with its local +Y axis laid along a -> b (scaled to the segment length when `stretch`). */
  private along(g: THREE.BufferGeometry, ax: number, ay: number, az: number, bx: number, by: number, bz: number, sxz: number, stretch: boolean, color: ColorIn, spin = 0) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1e-4;
    this.v.set(dx / len, dy / len, dz / len);
    this.q.setFromUnitVectors(Y, this.v);
    if (spin) this.q.multiply(new THREE.Quaternion().setFromAxisAngle(Y, spin));
    this.p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    this.s.set(sxz, stretch ? len : 1, sxz);
    this.m.compose(this.p, this.q, this.s);
    return this.push(g, color);
  }

  box(px: number, py: number, pz: number, sx: number, sy: number, sz: number, color: ColorIn, rx = 0, ry = 0, rz = 0) {
    return this.add('box', px, py, pz, sx, sy, sz, color, rx, ry, rz);
  }

  /** Box with rounded edges (radius in metres): edges catch highlights the way welded and pressed parts do. */
  rbox(px: number, py: number, pz: number, sx: number, sy: number, sz: number, radius: number, color: ColorIn, rx = 0, ry = 0, rz = 0, seg = this.roundSeg) {
    sx = Math.abs(sx);
    sy = Math.abs(sy);
    sz = Math.abs(sz);
    const r = Math.min(radius, sx / 2, sy / 2, sz / 2);
    const g = cachedGeo(`rb:${k3(sx)}:${k3(sy)}:${k3(sz)}:${k3(r)}:${seg}`, () => new RoundedBoxGeometry(sx, sy, sz, seg, r));
    return this.geo(g, px, py, pz, 1, 1, 1, color, rx, ry, rz);
  }

  /** Cylinder along Y by default; pass rotations to lay it down. Diameter is dx/dz. */
  cyl(px: number, py: number, pz: number, dx: number, h: number, dz: number, color: ColorIn, rx = 0, ry = 0, rz = 0, seg = 10) {
    return this.geo(cylGeo(seg), px, py, pz, dx, h, dz, color, rx, ry, rz);
  }

  /** Tapered cylinder (radii in metres), along Y. */
  frustum(px: number, py: number, pz: number, rTop: number, rBot: number, h: number, color: ColorIn, rx = 0, ry = 0, rz = 0, seg = 12) {
    const g = cachedGeo(`fr:${k3(rTop)}:${k3(rBot)}:${seg}`, () => new THREE.CylinderGeometry(rTop, rBot, 1, seg, 1));
    return this.geo(g, px, py, pz, 1, h, 1, color, rx, ry, rz);
  }

  /** Capsule between two points: limbs, hoses, rolled bedding. */
  capsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, color: ColorIn, radial = 10) {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const g = cachedGeo(`cap:${k3(r)}:${k3(len)}:${radial}`, () => new THREE.CapsuleGeometry(r, Math.max(0.001, len), 3, radial, 1));
    return this.along(g, ax, ay, az, bx, by, bz, 1, false, color);
  }

  /** Tapered limb: a frustum between two points with spheres at both ends (`low` for cheap joints). */
  limb(ax: number, ay: number, az: number, bx: number, by: number, bz: number, ra: number, rb: number, color: ColorIn, radial = 10, low = false) {
    const g = cachedGeo(`limb:${k3(rb)}:${k3(ra)}:${radial}`, () => new THREE.CylinderGeometry(rb, ra, 1, radial, 1, true));
    this.along(g, ax, ay, az, bx, by, bz, 1, true, color);
    this.sphereAt(ax, ay, az, ra, color, !low);
    this.sphereAt(bx, by, bz, rb, color, !low);
    return this;
  }

  sphereAt(x: number, y: number, z: number, r: number, color: ColorIn, smooth = true) {
    return this.add(smooth ? 'sphere16' : 'sphere', x, y, z, r * 2, r * 2, r * 2, color);
  }

  /** A cylinder between two points (radius in metres). */
  rod(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, color: ColorIn, seg = 10) {
    return this.along(cylGeo(seg), ax, ay, az, bx, by, bz, r * 2, true, color);
  }

  /** Welded tube through a list of points, with a ball at each joint so bends read as one piece. */
  pipe(pts: [number, number, number][], r: number, color: ColorIn, seg = 8) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      this.rod(a[0], a[1], a[2], b[0], b[1], b[2], r, color, seg);
      if (i > 0) this.add('sphere', a[0], a[1], a[2], r * 2.04, r * 2.04, r * 2.04, color);
    }
    return this;
  }

  /** A tube between two points (legacy: thickness is the diameter). */
  tube(ax: number, ay: number, az: number, bx: number, by: number, bz: number, thick: number, color: ColorIn) {
    return this.along(tpl.cyl8, ax, ay, az, bx, by, bz, thick, true, color);
  }

  /** Torus in the XY plane by default (a tyre lies on its side after rotating about Y). */
  torus(px: number, py: number, pz: number, R: number, r: number, color: ColorIn, rx = 0, ry = 0, rz = 0, radial = 8, tubular = 20) {
    const g = cachedGeo(`tor:${k3(R)}:${k3(r)}:${radial}:${tubular}`, () => new THREE.TorusGeometry(R, r, radial, tubular));
    return this.geo(g, px, py, pz, 1, 1, 1, color, rx, ry, rz);
  }

  /** Surface of revolution around Y from (radius, y) points. `key` names the profile for caching. */
  lathe(key: string, pts: [number, number][], px: number, py: number, pz: number, color: ColorIn, rx = 0, ry = 0, rz = 0, seg = 16, scale = 1) {
    const g = cachedGeo(`lathe:${key}:${seg}`, () => {
      const lg = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
      lg.computeVertexNormals();
      return lg;
    });
    return this.geo(g, px, py, pz, scale, scale, scale, color, rx, ry, rz);
  }

  /** Extruded 2D outline (in the XY plane, extruded along +Z by `depth`, centred), with an optional bevel. */
  extrude(key: string, shape: () => THREE.Shape, depth: number, bevel: number, px: number, py: number, pz: number, color: ColorIn, rx = 0, ry = 0, rz = 0) {
    const g = cachedGeo(`ext:${key}:${k3(depth)}:${k3(bevel)}`, () => {
      const eg = new THREE.ExtrudeGeometry(shape(), {
        depth: Math.max(0.001, depth - bevel * 2),
        bevelEnabled: bevel > 0,
        bevelThickness: bevel,
        bevelSize: bevel,
        bevelSegments: 2,
        curveSegments: 8,
      });
      eg.translate(0, 0, -(depth - bevel * 2) / 2);
      eg.computeVertexNormals();
      return eg;
    });
    return this.geo(g, px, py, pz, 1, 1, 1, color, rx, ry, rz);
  }

  /** Append another builder, applying an extra yaw and offset. */
  append(other: MeshBuilder, ox = 0, oy = 0, oz = 0, yaw = 0, scale = 1) {
    const base = this.pos.length / 3;
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    for (let i = 0; i < other.pos.length; i += 3) {
      const x = other.pos[i] * scale;
      const y = other.pos[i + 1] * scale;
      const z = other.pos[i + 2] * scale;
      this.pos.push(x * cs + z * sn + ox, y + oy, -x * sn + z * cs + oz);
      const nx = other.nor[i];
      const nz = other.nor[i + 2];
      this.nor.push(nx * cs + nz * sn, other.nor[i + 1], -nx * sn + nz * cs);
      this.col.push(other.col[i], other.col[i + 1], other.col[i + 2]);
    }
    for (let i = 0; i < other.srf.length; i++) this.srf.push(other.srf[i]);
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(base + other.idx[i]);
    return this;
  }

  /** Append another builder under an arbitrary matrix. */
  appendMatrix(other: MeshBuilder, m: THREE.Matrix4) {
    const base = this.pos.length / 3;
    this.nm.getNormalMatrix(m);
    for (let i = 0; i < other.pos.length; i += 3) {
      this.v.set(other.pos[i], other.pos[i + 1], other.pos[i + 2]).applyMatrix4(m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      this.v.set(other.nor[i], other.nor[i + 1], other.nor[i + 2]).applyMatrix3(this.nm).normalize();
      this.nor.push(this.v.x, this.v.y, this.v.z);
      this.col.push(other.col[i], other.col[i + 1], other.col[i + 2]);
    }
    for (let i = 0; i < other.srf.length; i++) this.srf.push(other.srf[i]);
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(base + other.idx[i]);
    return this;
  }

  /** Raw quad (counter-clockwise seen from the normal side) with a flat normal. */
  quad(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], color: ColorIn, uv: [number, number, number, number] = [0, 0, 1, 1]) {
    const base = this.pos.length / 3;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const m = Math.hypot(nx, ny, nz) || 1;
    nx /= m;
    ny /= m;
    nz /= m;
    const s = resolve(color);
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(s.col.r, s.col.g, s.col.b);
      this.srf.push(s.r, s.m, s.w, s.e);
    }
    this.uv.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }

  /**
   * Push vertices from index `from` along their normals by smooth noise (rocks, foliage, crumpled metal).
   * Normals are left as they were, which keeps lumps soft; call `renormal` on the built geometry for hard rock.
   */
  displace(amp: number, freq: number, seed: number, from = 0) {
    for (let i = from * 3; i < this.pos.length; i += 3) {
      const x = this.pos[i];
      const y = this.pos[i + 1];
      const z = this.pos[i + 2];
      const n = valueNoise3(x * freq, y * freq, z * freq, seed) - 0.5;
      const n2 = valueNoise3(x * freq * 2.9 + 7, y * freq * 2.9, z * freq * 2.9, seed + 1) - 0.5;
      const k = n * amp + n2 * amp * 0.35;
      this.pos[i] += this.nor[i] * k;
      this.pos[i + 1] += this.nor[i + 1] * k;
      this.pos[i + 2] += this.nor[i + 2] * k;
    }
    return this;
  }

  /** Faceted normals for triangles whose vertices are all at or after `from` (non-indexed parts only). */
  flatNormals(fromVertex = 0) {
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    for (let t = 0; t < this.idx.length; t += 3) {
      const a = this.idx[t];
      const b = this.idx[t + 1];
      const c = this.idx[t + 2];
      if (a < fromVertex || b < fromVertex || c < fromVertex) continue;
      ab.set(this.pos[b * 3] - this.pos[a * 3], this.pos[b * 3 + 1] - this.pos[a * 3 + 1], this.pos[b * 3 + 2] - this.pos[a * 3 + 2]);
      ac.set(this.pos[c * 3] - this.pos[a * 3], this.pos[c * 3 + 1] - this.pos[a * 3 + 1], this.pos[c * 3 + 2] - this.pos[a * 3 + 2]);
      ab.cross(ac).normalize();
      for (const v of [a, b, c]) {
        this.nor[v * 3] = ab.x;
        this.nor[v * 3 + 1] = ab.y;
        this.nor[v * 3 + 2] = ab.z;
      }
    }
    return this;
  }

  /** Flatten vertices from `from` into horizontal ledges of height `step` (bedded sandstone). */
  terrace(step: number, sharp = 1.6, from = 0) {
    for (let i = from * 3 + 1; i < this.pos.length; i += 3) {
      const t = this.pos[i] / step;
      const f = Math.floor(t);
      this.pos[i] = (f + Math.min(1, (t - f) * sharp)) * step;
    }
    return this;
  }

  /** Darken vertex colours below `y` (cheap contact occlusion for things standing on the ground). */
  groundShade(y0: number, y1: number, amount = 0.45) {
    for (let i = 0; i < this.pos.length; i += 3) {
      const y = this.pos[i + 1];
      if (y >= y1) continue;
      const t = y <= y0 ? 1 : 1 - (y - y0) / (y1 - y0);
      const k = 1 - amount * t;
      this.col[i] *= k;
      this.col[i + 1] *= k;
      this.col[i + 2] *= k;
    }
    return this;
  }

  get empty() {
    return this.pos.length === 0;
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('surf', new THREE.Float32BufferAttribute(this.srf, 4));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    if (this.parts.length) g.userData.parts = this.parts.slice();
    return g;
  }
}

type UvFn = (u: number, v: number, nx: number, ny: number, nz: number, vx: number, vy: number, vz: number) => [number, number];

function h3(x: number, y: number, z: number, s: number) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1442695041) + Math.imul(s | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 3D value noise in [0, 1). */
export function valueNoise3(x: number, y: number, z: number, seed: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => h3(ix + dx, iy + dy, iz + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

export const lin = (hex: number) => new THREE.Color(hex);
