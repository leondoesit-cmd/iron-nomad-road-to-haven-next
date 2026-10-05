import * as THREE from 'three';
import type { MeshBuilder } from './builder';
import { propProto } from './props';
import { landmarkProto, LANDMARK_KINDS } from './landmarks';
import type { PropKind, PropSpawn } from '../world/layout';

/**
 * Which props are solid. Every PropKind must be listed (the Record type enforces it): 'mesh' kinds get a triangle-mesh
 * collider built from the very geometry that is drawn, 'hull' kinds (compact lumps: drums, crates, rocks, trunks) get a
 * convex hull of it, which is solid inside and far cheaper, 'none' kinds are flat, hanging or ground-level decoration that
 * people and vehicles pass over or through.
 */
export const PROP_COLLISION: Record<PropKind, 'mesh' | 'hull' | 'dynamic' | 'none'> = {
  rock: 'hull',
  cairn: 'hull',
  deadTree: 'hull',
  wreck: 'hull',
  pole: 'mesh',
  barrel: 'dynamic',
  tires: 'dynamic',
  sign: 'mesh',
  bones: 'none',
  tarp: 'none',
  pylon: 'mesh',
  crateStack: 'hull',
  shelf: 'hull',
  locker: 'hull',
  canopy: 'mesh',
  dumpster: 'hull',
  streetlight: 'mesh',
  rubble: 'hull',
  banner: 'none',
  chain: 'none',
  pump: 'hull',
  // Always placed with its own exact box (a container is a box); a second collider would only double it.
  container: 'none',
  fence: 'mesh',
  waterTower: 'mesh',
  silo: 'hull',
  windTurbine: 'mesh',
  mast: 'mesh',
  billboard: 'mesh',
  gasSign: 'mesh',
  fuelTank: 'hull',
  windpump: 'mesh',
  powerTower: 'mesh',
  powerSpan: 'none',
  overpass: 'mesh',
  // The pier deck already has a walkable box (kind 'dock').
  dock: 'none',
  lighthouse: 'mesh',
  shipwreck: 'mesh',
  caveMouth: 'mesh',
  mineAdit: 'mesh',
  bunkerHatch: 'mesh',
  metroEntrance: 'mesh',
  fountain: 'hull',
  plaque: 'none',
  bench: 'hull',
  parkBays: 'none',
  cafeTable: 'hull',
  cafeChair: 'hull',
  tram: 'mesh',
  bus: 'hull',
  busShelter: 'hull',
  floodlight: 'mesh',
  campfire: 'none',
  tent: 'hull',
};

/**
 * Props that are loose rigid bodies instead of scenery: they sit still until something hits them, then roll, tumble and
 * bounce by how hard and how heavy the thing that hit them was. Mass is in kilograms at scale 1 (it grows with the cube of
 * the scale); restitution is how lively the bounce is (rubber against a drum).
 */
export const PROP_DYNAMIC: Partial<Record<PropKind, { mass: number; restitution: number; friction: number }>> = {
  // A stack of three tyres and one leaning on it.
  tires: { mass: 45, restitution: 0.55, friction: 0.9 },
  barrel: { mass: 28, restitution: 0.3, friction: 0.6 },
};

/** The prototype geometry of a placed prop (shared between all placements of the same variant). */
export function propBuilder(p: Pick<PropSpawn, 'kind' | 'seed' | 'tag'>): MeshBuilder | null {
  return protoOf(p as PropSpawn);
}

export interface CollisionMesh {
  /** 'trimesh' needs `indices`; 'hull' is the convex hull of the vertices. */
  shape: 'trimesh' | 'hull';
  vertices: Float32Array;
  indices?: Uint32Array;
}

/** A dead tree's branches reach far; only its trunk and low limbs (below this height, metres, unscaled) are solid. */
const TRUNK_TOP = 2.5;

function protoOf(p: PropSpawn): MeshBuilder | null {
  return LANDMARK_KINDS.has(p.kind) ? landmarkProto(p.kind, p.seed, p.tag ?? 0) : propProto(p.kind, p.seed, p.tag ?? 0);
}

/** The world-space collision shape of a placed prop, or null when the kind is not solid or has no geometry. */
export function propCollisionMesh(p: PropSpawn): CollisionMesh | null {
  const mode = PROP_COLLISION[p.kind];
  if (mode === 'none' || mode === 'dynamic') return null;
  const proto = protoOf(p);
  if (!proto || proto.idx.length < 3) return null;
  const cs = Math.cos(p.yaw);
  const sn = Math.sin(p.yaw);
  const n = proto.pos.length / 3;
  const out: number[] = [];
  const map = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const x = proto.pos[i * 3] * p.scale;
    const y = proto.pos[i * 3 + 1] * p.scale;
    const z = proto.pos[i * 3 + 2] * p.scale;
    if (p.kind === 'deadTree' && proto.pos[i * 3 + 1] > TRUNK_TOP) continue;
    map[i] = out.length / 3;
    out.push(x * cs + z * sn + p.x, y + p.y, -x * sn + z * cs + p.z);
  }
  if (out.length < 12) return null;
  const vertices = Float32Array.from(out);
  if (mode === 'hull') return { shape: 'hull', vertices };
  return { shape: 'trimesh', vertices, indices: Uint32Array.from(proto.idx) };
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const uniqueCache = new WeakMap<THREE.BufferGeometry, Float32Array>();

/** A geometry's positions with duplicates (shared corners of flat-shaded faces) merged, so a hull has fewer points to chew. */
function uniquePositions(g: THREE.BufferGeometry): Float32Array {
  let u = uniqueCache.get(g);
  if (u) return u;
  const a = g.getAttribute('position');
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i < a.count; i++) {
    const k = `${Math.round(a.getX(i) * 200)},${Math.round(a.getY(i) * 200)},${Math.round(a.getZ(i) * 200)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a.getX(i), a.getY(i), a.getZ(i));
  }
  uniqueCache.set(g, (u = Float32Array.from(out)));
  return u;
}

/** The world-space points of instance `i` of an instanced mesh (stones, boulders), for a convex hull. */
export function instanceHullPoints(im: THREE.InstancedMesh, i: number): Float32Array {
  const base = uniquePositions(im.geometry);
  im.getMatrixAt(i, _m);
  const out = new Float32Array(base.length);
  for (let j = 0; j < base.length; j += 3) {
    _v.set(base[j], base[j + 1], base[j + 2]).applyMatrix4(_m);
    out[j] = _v.x;
    out[j + 1] = _v.y;
    out[j + 2] = _v.z;
  }
  return out;
}

/** What each prop is made of, for bullets (default: stone). */
const PROP_SURFACE: Partial<Record<PropKind, string>> = {
  barrel: 'sheet',
  tires: 'wood',
  pole: 'wood',
  deadTree: 'wood',
  crateStack: 'wood',
  bench: 'wood',
  cafeTable: 'wood',
  cafeChair: 'wood',
  sign: 'sheet',
  wreck: 'sheet',
  container: 'sheet',
  dumpster: 'sheet',
  shelf: 'sheet',
  locker: 'sheet',
  pump: 'sheet',
  fuelTank: 'sheet',
  silo: 'sheet',
  bus: 'sheet',
  tram: 'sheet',
  busShelter: 'sheet',
  billboard: 'sheet',
  gasSign: 'sheet',
  canopy: 'sheet',
  streetlight: 'steel',
  floodlight: 'steel',
  pylon: 'steel',
  mast: 'steel',
  powerTower: 'steel',
  windTurbine: 'steel',
  windpump: 'steel',
  waterTower: 'steel',
  fence: 'steel',
  overpass: 'concrete',
  lighthouse: 'concrete',
  fountain: 'concrete',
  metroEntrance: 'concrete',
  bunkerHatch: 'concrete',
};
export const propSurface = (kind: PropKind): string => PROP_SURFACE[kind] ?? 'stone';
