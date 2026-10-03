import * as THREE from 'three';
import { valueNoise3 } from './builder';
import { groupParts, type PartGroup } from './bodyParts';

/**
 * Crumpling for a merged vehicle body.
 *
 * A free-form lattice (a coarse 3D grid of control points) is laid round the body. A crash pushes the control points
 * near the contact along the impact direction, and every vertex of the body follows the points around it, so a bumper
 * folds back, a fender caves in and a flank warps, whatever the model is made of. Normals are carried through the same
 * map (the inverse transpose of its Jacobian), and a little vertex noise on top turns smooth bulges into crumpled
 * metal and scrapes the paint off. Nothing is stored per vertex except what a crash changed.
 *
 * The geometry that is deformed belongs to one vehicle: the first dent copies the shared (cached) body, so a car nobody
 * has hit keeps sharing one mesh with its identical siblings.
 */

/** Target spacing of the control points, metres. */
const CELL = 0.42;

/** One crash, kept so the damage can be saved and laid down again on a rebuilt model. */
export interface DentEvent {
  /** Where, in the model's frame. */
  at: [number, number, number];
  /** Unit direction the surface was driven, into the car. */
  push: [number, number, number];
  depth: number;
  radius: number;
}

/** The map from a vertex to its place in the lattice, shared by every body that has the same rest geometry. */
interface Bind {
  nx: number;
  ny: number;
  nz: number;
  min: [number, number, number];
  step: [number, number, number];
  vcell: Int32Array;
  fu: Float32Array;
  fv: Float32Array;
  fw: Float32Array;
  cellStart: Int32Array;
  cellVerts: Int32Array;
}
const binds = new WeakMap<Float32Array, Bind>();

function bindFor(geo: THREE.BufferGeometry): Bind {
  const pos = geo.attributes.position.array as Float32Array;
  const hit = binds.get(pos);
  if (hit) return hit;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const min: [number, number, number] = [bb.min.x - 0.04, bb.min.y - 0.04, bb.min.z - 0.04];
  const ext = [bb.max.x - bb.min.x + 0.08, bb.max.y - bb.min.y + 0.08, bb.max.z - bb.min.z + 0.08];
  const n = ext.map((e) => Math.max(3, Math.ceil(e / CELL) + 1));
  const [nx, ny, nz] = n;
  const step: [number, number, number] = [ext[0] / (nx - 1), ext[1] / (ny - 1), ext[2] / (nz - 1)];
  const count = pos.length / 3;
  const vcell = new Int32Array(count);
  const fu = new Float32Array(count);
  const fv = new Float32Array(count);
  const fw = new Float32Array(count);
  const ncell = (nx - 1) * (ny - 1) * (nz - 1);
  const tally = new Int32Array(ncell + 1);
  for (let i = 0; i < count; i++) {
    const ux = (pos[i * 3] - min[0]) / step[0];
    const uy = (pos[i * 3 + 1] - min[1]) / step[1];
    const uz = (pos[i * 3 + 2] - min[2]) / step[2];
    const cx = Math.min(nx - 2, Math.max(0, Math.floor(ux)));
    const cy = Math.min(ny - 2, Math.max(0, Math.floor(uy)));
    const cz = Math.min(nz - 2, Math.max(0, Math.floor(uz)));
    const c = cx + (nx - 1) * (cy + (ny - 1) * cz);
    vcell[i] = c;
    fu[i] = Math.min(1, Math.max(0, ux - cx));
    fv[i] = Math.min(1, Math.max(0, uy - cy));
    fw[i] = Math.min(1, Math.max(0, uz - cz));
    tally[c + 1]++;
  }
  for (let c = 0; c < ncell; c++) tally[c + 1] += tally[c];
  const cellStart = tally.slice();
  const fill = tally.slice(0, ncell);
  const cellVerts = new Int32Array(count);
  for (let i = 0; i < count; i++) cellVerts[fill[vcell[i]]++] = i;
  const b: Bind = { nx, ny, nz, min, step, vcell, fu, fv, fw, cellStart, cellVerts };
  binds.set(pos, b);
  return b;
}

/** The middle of a part's bounding box and its half-extents, from the positions of the model as built. */
export function boundsOf(pos: Float32Array | THREE.BufferGeometry, g: PartGroup): { centre: [number, number, number]; half: [number, number, number] } {
  const p = pos instanceof Float32Array ? pos : (pos.attributes.position.array as Float32Array);
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const r of g.ranges) {
    for (let i = r.v0; i < r.v1; i++) {
      const x = p[i * 3];
      const y = p[i * 3 + 1];
      const z = p[i * 3 + 2];
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (z < z0) z0 = z;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (z > z1) z1 = z;
    }
  }
  return { centre: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], half: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2] };
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const dsmooth = (t: number) => 6 * t * (1 - t);

/** A vehicle body that can be dented, scraped and have parts lifted out of it. */
export class BodyMesh {
  readonly geo: THREE.BufferGeometry;
  readonly parts: PartGroup[];
  /** Crashes so far, merged where they overlap. */
  events: DentEvent[] = [];
  private bind: Bind;
  private disp: Float32Array;
  private crush: Float32Array;
  private rest: { pos: Float32Array; nor: Float32Array; col: Float32Array; srf: Float32Array };
  private pos: Float32Array;
  private nor: Float32Array;
  private col: Float32Array;
  private srf: Float32Array;
  private hidden: Uint8Array;
  private queued: Uint8Array;
  private queue: number[] = [];
  private size: [number, number, number];

  constructor(restGeo: THREE.BufferGeometry) {
    const a = restGeo.attributes;
    this.rest = { pos: a.position.array as Float32Array, nor: a.normal.array as Float32Array, col: a.color.array as Float32Array, srf: a.surf.array as Float32Array };
    this.bind = bindFor(restGeo);
    const { nx, ny, nz, step } = this.bind;
    this.disp = new Float32Array(nx * ny * nz * 3);
    this.crush = new Float32Array(nx * ny * nz);
    this.pos = new Float32Array(this.rest.pos);
    this.nor = new Float32Array(this.rest.nor);
    this.col = new Float32Array(this.rest.col);
    this.srf = new Float32Array(this.rest.srf);
    this.hidden = new Uint8Array(this.pos.length / 3);
    this.queued = new Uint8Array((nx - 1) * (ny - 1) * (nz - 1));
    this.size = [(nx - 1) * step[0], (ny - 1) * step[1], (nz - 1) * step[2]];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('surf', new THREE.BufferAttribute(this.srf, 4));
    g.setAttribute('uv', a.uv);
    g.setIndex(restGeo.index);
    if (!restGeo.boundingSphere) restGeo.computeBoundingSphere();
    if (!restGeo.boundingBox) restGeo.computeBoundingBox();
    g.boundingSphere = restGeo.boundingSphere!.clone();
    g.boundingSphere.radius += 0.6;
    g.boundingBox = restGeo.boundingBox!.clone();
    g.userData.parts = restGeo.userData.parts;
    this.geo = g;
    this.parts = groupParts(restGeo.userData.parts);
  }

  get lattice() {
    const { nx, ny, nz, min, step } = this.bind;
    return { nx, ny, nz, min, step };
  }

  // ------------------------------------------------------------------ denting

  /**
   * Drive the surface at `at` along `push` by up to `depth` metres, over about `radius` metres. Returns how crushed the
   * metal is there afterwards (0 untouched, 1 destroyed).
   */
  dent(at: [number, number, number], push: [number, number, number], depth: number, radius: number, record = true): number {
    const { nx, ny, nz, min, step } = this.bind;
    const sigma = Math.max(0.18, radius * 0.55);
    const inv2s = 1 / (2 * sigma * sigma);
    const [sx, sy, sz] = this.size;
    // A body can only fold so far: a quarter of its length along the car, a fifth across it.
    const capX = 0.2 * Math.min(sx, 2.2);
    const capY = 0.2 * Math.min(sy, 1.8);
    const capZ = 0.2 * Math.min(sz, 4.4);
    const sideHit = Math.abs(push[0]) > 0.6;
    const endHit = Math.abs(push[2]) > 0.6;
    const lowY = min[1] + sy * 0.4;
    const highY = min[1] + sy * 0.78;
    let atCrush = 0;
    let atD = 1e9;
    for (let iz = 0; iz < nz; iz++) {
      const pz = min[2] + iz * step[2];
      const dz = pz - at[2];
      for (let iy = 0; iy < ny; iy++) {
        const py = min[1] + iy * step[1];
        const dy = py - at[1];
        for (let ix = 0; ix < nx; ix++) {
          const dx = min[0] + ix * step[0] - at[0];
          const r2 = dx * dx + dy * dy + dz * dz;
          const w = Math.exp(-r2 * inv2s);
          if (w < 0.015) continue;
          const s = dx * push[0] + dy * push[1] + dz * push[2];
          // Metal in front of the contact is pushed in; metal far behind it hardly knows.
          const deep = s > 0 ? Math.exp(-s / (radius * 1.1)) : 1;
          const k = depth * w * deep;
          const c = ix + nx * (iy + ny * iz);
          const d = this.disp;
          d[c * 3] += push[0] * k;
          d[c * 3 + 1] += push[1] * k;
          d[c * 3 + 2] += push[2] * k;
          // A bonnet or boot folds up as the nose goes back; a flank is dragged along the panel as well as in.
          if (endHit) d[c * 3 + 1] += k * 0.42 * smooth(Math.min(1, Math.max(0, (py - lowY) / Math.max(0.1, highY - lowY))));
          if (sideHit) d[c * 3 + 2] += (dz / sigma) * k * 0.16;
          d[c * 3] = Math.max(-capX, Math.min(capX, d[c * 3]));
          d[c * 3 + 1] = Math.max(-capY, Math.min(capY, d[c * 3 + 1]));
          d[c * 3 + 2] = Math.max(-capZ, Math.min(capZ, d[c * 3 + 2]));
          this.crush[c] = Math.min(1, this.crush[c] + Math.min(1, depth / 0.2) * Math.pow(w, 0.6) * deep * 0.85);
          this.touch(ix, iy, iz);
          if (r2 < atD) {
            atD = r2;
            atCrush = this.crush[c];
          }
        }
      }
    }
    if (record && depth > 0.003) this.remember(at, push, depth, radius);
    return atCrush;
  }

  /** Merge a crash into the list: a second hit on the same spot makes the first one deeper. */
  private remember(at: [number, number, number], push: [number, number, number], depth: number, radius: number) {
    for (const e of this.events) {
      const d = Math.hypot(e.at[0] - at[0], e.at[1] - at[1], e.at[2] - at[2]);
      const dot = e.push[0] * push[0] + e.push[1] * push[1] + e.push[2] * push[2];
      if (d < Math.max(0.3, e.radius * 0.5) && dot > 0.7) {
        e.depth = Math.min(0.8, e.depth + depth);
        e.radius = Math.max(e.radius, radius);
        return;
      }
    }
    this.events.push({ at: [...at], push: [...push], depth, radius });
    if (this.events.length > 32) {
      // Too many: fold the two closest together.
      let bi = 0;
      let bj = 1;
      let bd = 1e9;
      for (let i = 0; i < this.events.length; i++) {
        for (let j = i + 1; j < this.events.length; j++) {
          const a = this.events[i].at;
          const b = this.events[j].at;
          const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          if (d < bd) {
            bd = d;
            bi = i;
            bj = j;
          }
        }
      }
      const a = this.events[bi];
      const b = this.events[bj];
      a.depth = Math.min(0.8, a.depth + b.depth * 0.7);
      a.radius = Math.max(a.radius, b.radius);
      this.events.splice(bj, 1);
    }
  }

  /** Scrape: paint comes off and the metal wrinkles a little, with no real change of shape. */
  scrape(at: [number, number, number], radius: number, amount: number) {
    const { nx, ny, nz, min, step } = this.bind;
    const inv2s = 1 / (2 * radius * radius);
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const dx = min[0] + ix * step[0] - at[0];
          const dy = min[1] + iy * step[1] - at[1];
          const dz = min[2] + iz * step[2] - at[2];
          const w = Math.exp(-(dx * dx + dy * dy + dz * dz) * inv2s);
          if (w < 0.05) continue;
          const c = ix + nx * (iy + ny * iz);
          this.crush[c] = Math.min(1, this.crush[c] + amount * w);
          this.touch(ix, iy, iz);
        }
      }
    }
  }

  /** The lattice's pull on a point of the model, and how crushed the metal is there. Used to carry lamps along with the body. */
  sample(p: [number, number, number], out: { x: number; y: number; z: number; crush: number }) {
    const { nx, ny, nz, min, step } = this.bind;
    const ux = (p[0] - min[0]) / step[0];
    const uy = (p[1] - min[1]) / step[1];
    const uz = (p[2] - min[2]) / step[2];
    const cx = Math.min(nx - 2, Math.max(0, Math.floor(ux)));
    const cy = Math.min(ny - 2, Math.max(0, Math.floor(uy)));
    const cz = Math.min(nz - 2, Math.max(0, Math.floor(uz)));
    const u = smooth(Math.min(1, Math.max(0, ux - cx)));
    const v = smooth(Math.min(1, Math.max(0, uy - cy)));
    const w = smooth(Math.min(1, Math.max(0, uz - cz)));
    out.x = out.y = out.z = out.crush = 0;
    for (let c = 0; c < 2; c++) {
      for (let b = 0; b < 2; b++) {
        for (let a = 0; a < 2; a++) {
          const wt = (a ? u : 1 - u) * (b ? v : 1 - v) * (c ? w : 1 - w);
          const i = cx + a + nx * (cy + b + ny * (cz + c));
          out.x += this.disp[i * 3] * wt;
          out.y += this.disp[i * 3 + 1] * wt;
          out.z += this.disp[i * 3 + 2] * wt;
          out.crush += this.crush[i] * wt;
        }
      }
    }
    return out;
  }

  /** How badly bent the body is overall, 0 to 1: the bodywork repair job reads this. */
  level(): number {
    let sum = 0;
    for (let i = 0; i < this.crush.length; i++) sum += this.crush[i];
    return 1 - Math.exp(-sum / 9);
  }

  /** Hammer it out: take a share of every dent away. */
  straighten(frac: number) {
    const { nx, ny, nz } = this.bind;
    const keep = Math.max(0, 1 - frac);
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const c = ix + nx * (iy + ny * iz);
          if (this.crush[c] === 0 && this.disp[c * 3] === 0 && this.disp[c * 3 + 1] === 0 && this.disp[c * 3 + 2] === 0) continue;
          this.touch(ix, iy, iz);
          this.crush[c] *= keep;
          this.disp[c * 3] *= keep;
          this.disp[c * 3 + 1] *= keep;
          this.disp[c * 3 + 2] *= keep;
          if (this.crush[c] < 0.015) this.crush[c] = 0;
          if (Math.abs(this.disp[c * 3]) + Math.abs(this.disp[c * 3 + 1]) + Math.abs(this.disp[c * 3 + 2]) < 0.004) this.disp[c * 3] = this.disp[c * 3 + 1] = this.disp[c * 3 + 2] = 0;
        }
      }
    }
    for (const e of this.events) e.depth *= keep;
    this.events = this.events.filter((e) => e.depth > 0.012);
  }

  // ------------------------------------------------------------------ parts

  /** Collapse a part's vertices to its joint so it no longer draws. */
  hide(g: PartGroup, at: [number, number, number]) {
    for (const r of g.ranges) {
      for (let i = r.v0; i < r.v1; i++) {
        this.hidden[i] = 1;
        this.pos[i * 3] = at[0];
        this.pos[i * 3 + 1] = at[1];
        this.pos[i * 3 + 2] = at[2];
      }
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  /** Put a part back (repaired): its vertices are skinned again from where the lattice has them. */
  show(g: PartGroup) {
    for (const r of g.ranges) {
      for (let i = r.v0; i < r.v1; i++) {
        this.hidden[i] = 0;
        this.skinVertex(i);
      }
    }
    this.flag();
  }

  /** A part's current (dented) mesh with its origin at `pivot`, ready to hang from the car or to become debris. */
  extract(g: PartGroup, pivot: [number, number, number]): THREE.BufferGeometry {
    let nv = 0;
    let ni = 0;
    for (const r of g.ranges) {
      nv += r.v1 - r.v0;
      ni += r.i1 - r.i0;
    }
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const srf = new Float32Array(nv * 4);
    const uvs = new Float32Array(nv * 2);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    const uvAttr = this.geo.attributes.uv;
    const index = this.geo.index!;
    let vo = 0;
    let io = 0;
    for (const r of g.ranges) {
      const n = r.v1 - r.v0;
      for (let i = 0; i < n; i++) {
        const s = (r.v0 + i) * 3;
        const d = (vo + i) * 3;
        pos[d] = this.pos[s] - pivot[0];
        pos[d + 1] = this.pos[s + 1] - pivot[1];
        pos[d + 2] = this.pos[s + 2] - pivot[2];
        nor[d] = this.nor[s];
        nor[d + 1] = this.nor[s + 1];
        nor[d + 2] = this.nor[s + 2];
        col[d] = this.col[s];
        col[d + 1] = this.col[s + 1];
        col[d + 2] = this.col[s + 2];
        const q = (r.v0 + i) * 4;
        const e = (vo + i) * 4;
        srf[e] = this.srf[q];
        srf[e + 1] = this.srf[q + 1];
        srf[e + 2] = this.srf[q + 2];
        srf[e + 3] = this.srf[q + 3];
        uvs[(vo + i) * 2] = uvAttr.getX(r.v0 + i);
        uvs[(vo + i) * 2 + 1] = uvAttr.getY(r.v0 + i);
      }
      for (let k = r.i0; k < r.i1; k++) idx[io++] = index.getX(k) - r.v0 + vo;
      vo += n;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setAttribute('surf', new THREE.BufferAttribute(srf, 4));
    out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
  }

  /** The middle of a part's bounding box (as built, before any dent) and its half-extents. */
  bounds(g: PartGroup) {
    return boundsOf(this.rest.pos, g);
  }

  // ------------------------------------------------------------------ skinning

  private touch(ix: number, iy: number, iz: number) {
    const { nx, ny, nz } = this.bind;
    for (let c = iz - 1; c <= iz; c++) {
      if (c < 0 || c > nz - 2) continue;
      for (let b = iy - 1; b <= iy; b++) {
        if (b < 0 || b > ny - 2) continue;
        for (let a = ix - 1; a <= ix; a++) {
          if (a < 0 || a > nx - 2) continue;
          const cell = a + (nx - 1) * (b + (ny - 1) * c);
          if (!this.queued[cell]) {
            this.queued[cell] = 1;
            this.queue.push(cell);
          }
        }
      }
    }
  }

  /** Cells still waiting to be re-skinned. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Re-skin the vertices whose lattice cell changed, a few thousand at a time, so a crash that touches the whole body
   * costs a couple of frames of work rather than one long one. Returns the cells still waiting.
   */
  update(budget = 20000): number {
    if (!this.queue.length) return 0;
    const { cellStart, cellVerts } = this.bind;
    let spent = 0;
    let head = 0;
    while (head < this.queue.length && spent < budget) {
      const cell = this.queue[head++];
      this.queued[cell] = 0;
      for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) {
        const i = cellVerts[k];
        if (!this.hidden[i]) this.skinVertex(i);
      }
      spent += cellStart[cell + 1] - cellStart[cell];
    }
    this.queue.splice(0, head);
    this.flag();
    return this.queue.length;
  }

  private flag() {
    const a = this.geo.attributes;
    a.position.needsUpdate = true;
    a.normal.needsUpdate = true;
    a.color.needsUpdate = true;
    a.surf.needsUpdate = true;
  }

  private skinVertex(i: number) {
    const { nx, ny, step, vcell, fu, fv, fw } = this.bind;
    const cell = vcell[i];
    const ncx = this.bind.nx - 1;
    const ncy = this.bind.ny - 1;
    const cx = cell % ncx;
    const cy = Math.floor(cell / ncx) % ncy;
    const cz = Math.floor(cell / (ncx * ncy));
    const u = fu[i];
    const v = fv[i];
    const w = fw[i];
    const su = smooth(u);
    const sv = smooth(v);
    const sw = smooth(w);
    const du = dsmooth(u) / step[0];
    const dv = dsmooth(v) / step[1];
    const dw = dsmooth(w) / step[2];
    let dx = 0;
    let dy = 0;
    let dz = 0;
    let cr = 0;
    // Jacobian columns of the displacement.
    let ax = 0;
    let ay = 0;
    let az = 0;
    let bx = 0;
    let by = 0;
    let bz = 0;
    let ex = 0;
    let ey = 0;
    let ez = 0;
    const d = this.disp;
    for (let c = 0; c < 2; c++) {
      const wz = c ? sw : 1 - sw;
      const dwz = c ? dw : -dw;
      for (let b = 0; b < 2; b++) {
        const wy = b ? sv : 1 - sv;
        const dwy = b ? dv : -dv;
        for (let a = 0; a < 2; a++) {
          const wx = a ? su : 1 - su;
          const dwx = a ? du : -du;
          const k = cx + a + nx * (cy + b + ny * (cz + c));
          const px = d[k * 3];
          const py = d[k * 3 + 1];
          const pz = d[k * 3 + 2];
          const wt = wx * wy * wz;
          dx += px * wt;
          dy += py * wt;
          dz += pz * wt;
          cr += this.crush[k] * wt;
          const wa = dwx * wy * wz;
          const wb = wx * dwy * wz;
          const wc = wx * wy * dwz;
          ax += px * wa;
          ay += py * wa;
          az += pz * wa;
          bx += px * wb;
          by += py * wb;
          bz += pz * wb;
          ex += px * wc;
          ey += py * wc;
          ez += pz * wc;
        }
      }
    }
    const r = this.rest;
    const i3 = i * 3;
    let x = r.pos[i3] + dx;
    let y = r.pos[i3 + 1] + dy;
    let z = r.pos[i3 + 2] + dz;
    // Inverse transpose of J = I + [a b e]: the normal follows the surface it sits on.
    const Ax = 1 + ax;
    const By = 1 + by;
    const Ez = 1 + ez;
    const rnx = r.nor[i3];
    const rny = r.nor[i3 + 1];
    const rnz = r.nor[i3 + 2];
    // b x e, e x a, a x b with a = (Ax, ay, az), b = (bx, By, bz), e = (ex, ey, Ez)
    const bexX = By * Ez - bz * ey;
    const bexY = bz * ex - bx * Ez;
    const bexZ = bx * ey - By * ex;
    const eaxX = ey * az - Ez * ay;
    const eaxY = Ez * Ax - ex * az;
    const eaxZ = ex * ay - ey * Ax;
    const abxX = ay * bz - az * By;
    const abxY = az * bx - Ax * bz;
    const abxZ = Ax * By - ay * bx;
    let nx2 = bexX * rnx + eaxX * rny + abxX * rnz;
    let ny2 = bexY * rnx + eaxY * rny + abxY * rnz;
    let nz2 = bexZ * rnx + eaxZ * rny + abxZ * rnz;
    if (cr > 0.03) {
      // Crumple: a fine vector noise moves the metal a little and roughens the shading, scaled by how crushed it is.
      const amp = Math.min(1, cr * 1.3);
      const px = r.pos[i3];
      const py = r.pos[i3 + 1];
      const pz = r.pos[i3 + 2];
      const n1 = valueNoise3(px * 6.5, py * 6.5, pz * 6.5, 31) - 0.5;
      const n2 = valueNoise3(px * 6.5 + 9, py * 6.5, pz * 6.5, 37) - 0.5;
      const n3 = valueNoise3(px * 6.5, py * 6.5 + 9, pz * 6.5, 41) - 0.5;
      const f1 = valueNoise3(px * 17, py * 17, pz * 17, 53) - 0.5;
      const f2 = valueNoise3(px * 17 + 5, py * 17, pz * 17, 59) - 0.5;
      const f3 = valueNoise3(px * 17, py * 17 + 5, pz * 17, 61) - 0.5;
      x += (n1 + f1 * 0.4) * amp * 0.07;
      y += (n2 + f2 * 0.4) * amp * 0.07;
      z += (n3 + f3 * 0.4) * amp * 0.07;
      const len = Math.hypot(nx2, ny2, nz2) || 1;
      nx2 = nx2 / len + (n1 * 1.4 + f1 * 1.6) * amp * 1.5;
      ny2 = ny2 / len + (n2 * 1.4 + f2 * 1.6) * amp * 1.5;
      nz2 = nz2 / len + (n3 * 1.4 + f3 * 1.6) * amp * 1.5;
      // Paint scraped back to bare, darkened steel where the metal is worst.
      const rough = r.srf[i * 4];
      if (rough > 0.12 && rough < 0.75) {
        const k = Math.min(1, cr * 1.1);
        const bare = r.srf[i * 4 + 1] > 0.6 ? 0 : 0.5 * k;
        this.col[i3] = r.col[i3] * (1 - 0.35 * k) * (1 - bare) + 0.3 * bare;
        this.col[i3 + 1] = r.col[i3 + 1] * (1 - 0.35 * k) * (1 - bare) + 0.3 * bare;
        this.col[i3 + 2] = r.col[i3 + 2] * (1 - 0.35 * k) * (1 - bare) + 0.29 * bare;
        this.srf[i * 4] = Math.min(1, rough + 0.2 * k);
        this.srf[i * 4 + 1] = Math.min(1, r.srf[i * 4 + 1] + 0.55 * bare);
        this.srf[i * 4 + 2] = Math.min(1.5, r.srf[i * 4 + 2] + 0.5 * k);
      }
    } else {
      this.col[i3] = r.col[i3];
      this.col[i3 + 1] = r.col[i3 + 1];
      this.col[i3 + 2] = r.col[i3 + 2];
      this.srf[i * 4] = r.srf[i * 4];
      this.srf[i * 4 + 1] = r.srf[i * 4 + 1];
      this.srf[i * 4 + 2] = r.srf[i * 4 + 2];
    }
    const nl = Math.hypot(nx2, ny2, nz2) || 1;
    this.nor[i3] = nx2 / nl;
    this.nor[i3 + 1] = ny2 / nl;
    this.nor[i3 + 2] = nz2 / nl;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
  }

  /** Re-apply a saved list of crashes (after a rebuild or a load) and skin everything at once. */
  replay(events: DentEvent[]) {
    for (const e of events) this.dent(e.at, e.push, e.depth, e.radius, true);
    this.update(Infinity);
  }

  dispose() {
    this.geo.dispose();
  }
}
