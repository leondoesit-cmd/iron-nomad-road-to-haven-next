import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FAR_CUT_FRAG, FAR_CUT_FRAG_PARS } from './dissolve';

/**
 * Plain stand-ins for the world's parked cars while they are not live vehicles: a painted body and a dark cabin, one
 * instanced draw per kind of body, so a street of cars is there from as far as the haze lets anything be seen and not
 * only once each car has been built (a few at a time, and only within `SPAWN_R`). When the real car comes in it dissolves
 * in pixel for pixel as its stand-in dissolves out (`cut`, the real car's fade, see dissolve.ts), and the other way when
 * it is put away again.
 */

/** A body as boxes in the car's own frame (x across, y up from the ground, z forward), metres: [x, y0, y1, z0, z1]. */
type Box = [number, number, number, number, number];

/** Measured off the real models (2026-10-09): lower body full length and width, cabin set back over it. */
const BODIES: Record<string, { body: Box[]; glass: Box[] }> = {
  hatch: { body: [[0.91, 0.18, 1.0, -1.88, 1.9]], glass: [[0.78, 1.0, 1.52, -1.42, 0.45]] },
  sedan: { body: [[0.96, 0.18, 1.0, -2.34, 2.4]], glass: [[0.8, 1.0, 1.48, -1.0, 0.44]] },
  pickup: { body: [[1.03, 0.22, 1.15, -2.72, 2.7]], glass: [[0.9, 1.15, 1.8, -0.6, 1.0]] },
  van: { body: [[1.02, 0.2, 2.35, -2.62, 1.2], [1.02, 0.2, 1.1, 1.2, 2.66]], glass: [[0.94, 1.6, 2.2, 1.0, 1.25]] },
};

/** A burnt-out hulk's colour, whatever it was painted. */
const HULK = 0x3a3029;

function boxes(list: Box[], tone: number): THREE.BufferGeometry[] {
  return list.map(([hx, y0, y1, z0, z1]) => {
    const g = new THREE.BoxGeometry(hx * 2, y1 - y0, z1 - z0).toNonIndexed();
    g.translate(0, (y0 + y1) / 2, (z0 + z1) / 2);
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(tone), 3));
    return g;
  });
}

function bodyGeometry(chassis: string): THREE.BufferGeometry | null {
  const b = BODIES[chassis];
  if (!b) return null;
  // The paint is the instance colour; the glass stays dark whatever the paint.
  const g = mergeGeometries([...boxes(b.body, 1), ...boxes(b.glass, 0.12)])!;
  g.computeBoundingSphere();
  return g;
}

function standInMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aCut;\nvarying float vFarCut;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFarCut = aCut;\nif ( aCut >= 1.0 ) transformed = vec3( 0.0 );');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FAR_CUT_FRAG_PARS}`)
      .replace('#include <clipping_planes_fragment>', FAR_CUT_FRAG);
  };
  m.customProgramCacheKey = () => 'carStandIn';
  return m;
}

export interface StandInCar {
  chassis: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  paint: number;
  hulk: boolean;
}

interface Slot {
  im: THREE.InstancedMesh;
  cut: THREE.InstancedBufferAttribute;
  i: number;
}

export class CarStandIns {
  readonly group = new THREE.Group();
  private slots = new Map<string, Slot>();
  private material = standInMaterial();
  private dirty = new Set<THREE.InstancedBufferAttribute>();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private c = new THREE.Color();

  constructor(cars: Map<string, StandInCar>) {
    this.group.name = 'carStandIns';
    const byChassis = new Map<string, [string, StandInCar][]>();
    for (const e of cars) {
      if (!BODIES[e[1].chassis]) continue;
      let list = byChassis.get(e[1].chassis);
      if (!list) byChassis.set(e[1].chassis, (list = []));
      list.push(e);
    }
    for (const [chassis, list] of byChassis) {
      const geo = bodyGeometry(chassis)!;
      const cut = new THREE.InstancedBufferAttribute(new Float32Array(list.length), 1);
      cut.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aCut', cut);
      const im = new THREE.InstancedMesh(geo, this.material, list.length);
      im.castShadow = false;
      im.receiveShadow = true;
      im.name = `carStandIn:${chassis}`;
      list.forEach(([id, car], i) => {
        this.slots.set(id, { im, cut, i });
        this.place(id, car);
      });
      im.computeBoundingSphere();
      this.group.add(im);
    }
  }

  /** Stand the car's stand-in where (and as) the car is now. */
  place(id: string, car: StandInCar) {
    const s = this.slots.get(id);
    if (!s) return;
    this.q.setFromAxisAngle(this.up, car.yaw);
    s.im.setMatrixAt(s.i, this.m4.compose(this.v.set(car.x, car.y, car.z), this.q, this.one));
    s.im.setColorAt(s.i, this.c.setHex(car.hulk ? HULK : car.paint));
    s.im.instanceMatrix.needsUpdate = true;
    s.im.instanceColor!.needsUpdate = true;
    // A stand-in that moved can poke out of the bounds it was culled by; recomputing is a few hundred points.
    s.im.computeBoundingSphere();
  }

  /** How far the real car is in over its stand-in: 0 the stand-in alone, 1 the real car alone. */
  setCut(id: string, cut: number) {
    const s = this.slots.get(id);
    if (!s || s.cut.array[s.i] === cut) return;
    (s.cut.array as Float32Array)[s.i] = cut;
    this.dirty.add(s.cut);
  }

  /** Send the cuts that changed. */
  flush() {
    for (const a of this.dirty) a.needsUpdate = true;
    this.dirty.clear();
  }

  dispose() {
    for (const c of this.group.children) {
      const im = c as THREE.InstancedMesh;
      im.geometry.dispose();
      im.dispose();
    }
    this.material.dispose();
    this.group.removeFromParent();
  }
}
