import * as THREE from 'three';
import { MeshBuilder } from './builder';
import { crate, jerryCan, oilCan } from './parts';
import { buildPartModel } from './partModels';
import { drawFood } from './foodModels';
import type { FoodId } from '../sim/carry';
import { C } from './palette';
import { bodyMat } from './vehicleKit';
import type { Mounts } from './attachments';
import type { Carried } from '../sim/carry';
import type { Zone } from '../sim/cargo';

/**
 * Cargo you can see on a car: what was put on the roof, in the bed or in the rear cage (`sim/cargo.ts` says what each place
 * holds and whether it is secure). Each item is drawn as itself, at a spot in that place's deck, in the chassis frame. What
 * is stowed INSIDE (a boot, a cab) is drawn smaller on its own spot of the boot floor (`buildStowedMesh`, spots from
 * `bootDeck.ts`); a bike's panniers are closed bags. The jerrycan rack and the spare-wheel carrier draw their own cans and
 * tyre as part of the fitted model.
 */

/** A flat area cargo can sit on, in the chassis frame. */
export interface Deck {
  y: number;
  z0: number;
  z1: number;
  hw: number;
}

/** How high a holder's floor stands above the bare roof. */
const HOLDER_LIFT = 0.16;

/** The deck of a zone on this chassis. Null where nothing is drawn (the rack and the spare carrier show their own load) or the chassis has no such surface. */
export function deckOfZone(m: Mounts, g0: number, zone: Zone, holder: boolean): Deck | null {
  switch (zone) {
    case 'roof':
      return m.roof ? { y: m.roof.y - g0 + 0.02 + (holder ? HOLDER_LIFT : 0), z0: m.roof.z0 + 0.1, z1: m.roof.z1 - 0.1, hw: m.roof.hw * 0.8 } : null;
    case 'bed':
      return m.trunk ? { y: m.trunk.y - g0 + 0.02, z0: m.trunk.z0 + 0.1, z1: m.trunk.z1 - 0.1, hw: m.trunk.hw * 0.85 } : null;
    case 'carrier':
      return { y: m.rear.y - g0 + 0.18, z0: m.rear.z - 0.62, z1: m.rear.z - 0.08, hw: Math.max(0.1, m.rear.hw * 0.75) };
    default:
      return null;
  }
}

/** One thing in a deck, in the chassis frame. */
export interface Placed {
  /** The cargo entry it is. */
  id: string;
  kind: 'part' | 'fuel' | 'diesel' | 'oil' | 'water' | 'food';
  food?: FoodId;
  /** Drawn at full size: put there by hand, where it was put (`CargoEntry.at`). */
  full?: boolean;
  partId?: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

const kindOf = (c: Carried): Placed['kind'] => (c.kind === 'part' ? 'part' : c.kind === 'fuel' ? (c.fuel === 'diesel' ? 'diesel' : 'fuel') : c.kind === 'oil' ? 'oil' : c.kind === 'food' ? 'food' : 'water');

/** Where each entry sits on its deck: a grid of spots, stacking up when it is full. */
export function layoutEntries(deck: Deck, entries: { id: string; c: Carried; at?: [number, number, number]; yaw?: number }[]): Placed[] {
  const cols = Math.max(1, Math.floor((deck.hw * 2) / 0.34));
  const rows = Math.max(1, Math.floor((deck.z1 - deck.z0) / 0.36));
  const cells = cols * rows;
  const zc = (deck.z0 + deck.z1) / 2;
  // Things set down by hand keep the very spot and heading they were given; the rest are dealt into the grid.
  let k = 0;
  return entries.map((e) => {
    const food = e.c.kind === 'food' ? e.c.food : undefined;
    if (e.at) return { id: e.id, kind: kindOf(e.c), partId: e.c.kind === 'part' ? e.c.item.id : undefined, food, x: e.at[0], y: e.at[1], z: e.at[2], yaw: e.yaw ?? 0, full: true };
    const i = k++;
    const cell = i % cells;
    const layer = Math.floor(i / cells);
    const col = cell % cols;
    const row = Math.floor(cell / cols);
    const x = cols === 1 ? 0 : (col / (cols - 1) - 0.5) * (deck.hw * 2 - 0.3);
    const z = rows === 1 ? zc : deck.z1 - 0.18 - row * 0.36;
    const yaw = ((i * 53) % 17) * 0.05 - 0.4;
    return { id: e.id, kind: kindOf(e.c), partId: e.c.kind === 'part' ? e.c.item.id : undefined, food, x, y: deck.y + layer * 0.3, z, yaw };
  });
}

/** Spare parts are drawn at this fraction of their full size so a few fit side by side. */
const PART_SCALE = 0.5;

/** The model of one carried thing on a deck. */
function drawThing(b: MeshBuilder, t: Placed) {
  if (t.kind === 'part') {
    const pm = new MeshBuilder();
    buildPartModel(pm, t.partId!);
    const k = t.full ? 1 : PART_SCALE;
    b.appendMatrix(pm, new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.yaw), new THREE.Vector3(k, k, k)));
  } else if (t.kind === 'food') {
    const fm = new MeshBuilder();
    drawFood(fm, t.food ?? 'dogfood');
    b.appendMatrix(fm, new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.yaw), new THREE.Vector3(1, 1, 1)));
  } else if (t.kind === 'fuel' || t.kind === 'diesel') jerryCan(b, t.x, t.y, t.z, t.kind === 'diesel' ? C.diesel : C.fuel, t.yaw);
  else if (t.kind === 'water') jerryCan(b, t.x, t.y, t.z, 0x3a6ea5, t.yaw);
  else oilCan(b, t.x, t.y, t.z, t.yaw);
}

/** A mesh of everything on the decks. Null when there is nothing to draw. */
export function buildCargoMesh(decks: { deck: Deck; entries: { id: string; c: Carried; at?: [number, number, number]; yaw?: number }[] }[]): THREE.Mesh | null {
  const b = new MeshBuilder();
  b.jitter = 0.02;
  let n = 0;
  for (const { deck, entries } of decks) {
    for (const t of layoutEntries(deck, entries)) {
      drawThing(b, t);
      n++;
    }
  }
  if (!n) return null;
  const mesh = new THREE.Mesh(b.build(), bodyMat);
  mesh.castShadow = true;
  return mesh;
}

/** Stowed things are drawn smaller still: a boot holds a handful side by side. */
const STOW_SCALE = 0.42;

/**
 * The things stowed inside a vehicle, each on its spot of the boot floor (chassis frame), small: what you see through the glass
 * and when the lid comes up. Null when there is nothing to draw.
 */
export function buildStowedMesh(items: { kind: 'part' | 'fuel' | 'diesel' | 'oil' | 'water' | 'crate'; partId?: string; x: number; y: number; z: number; yaw: number }[]): THREE.Mesh | null {
  const b = new MeshBuilder();
  b.jitter = 0.02;
  let n = 0;
  for (const it of items) {
    if (it.kind === 'part' && it.partId) {
      const pm = new MeshBuilder();
      buildPartModel(pm, it.partId);
      b.appendMatrix(pm, new THREE.Matrix4().compose(new THREE.Vector3(it.x, it.y, it.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.yaw), new THREE.Vector3(STOW_SCALE, STOW_SCALE, STOW_SCALE)));
    } else if (it.kind === 'fuel' || it.kind === 'diesel' || it.kind === 'water' || it.kind === 'oil') {
      // A reserve can, a little smaller than the one in your hands.
      const cm = new MeshBuilder();
      if (it.kind === 'oil') oilCan(cm, 0, 0, 0, 0);
      else jerryCan(cm, 0, 0, 0, it.kind === 'diesel' ? C.diesel : it.kind === 'water' ? 0x3a6ea5 : C.fuel, 0);
      b.appendMatrix(cm, new THREE.Matrix4().compose(new THREE.Vector3(it.x, it.y, it.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.yaw), new THREE.Vector3(0.62, 0.62, 0.62)));
    } else continue;
    n++;
  }
  if (!n) return null;
  const mesh = new THREE.Mesh(b.build(), bodyMat);
  mesh.castShadow = false;
  return mesh;
}

/** The geometry of one carried thing at a size to tumble down the road. */
export function pieceGeometry(c: Carried): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.02;
  if (c.kind === 'part') {
    const pm = new MeshBuilder();
    buildPartModel(pm, c.item.id);
    b.appendMatrix(pm, new THREE.Matrix4().makeScale(0.8, 0.8, 0.8));
  } else if (c.kind === 'fuel') jerryCan(b, 0, 0, 0, c.fuel === 'diesel' ? C.diesel : C.fuel, 0);
  else if (c.kind === 'water') jerryCan(b, 0, 0, 0, 0x3a6ea5, 0);
  else if (c.kind === 'oil') oilCan(b, 0, 0, 0, 0);
  else if (c.kind === 'food') drawFood(b, c.food);
  else crate(b, 0, 0.11, 0, 0.32, 0.22, 0.3, 0);
  return b.build();
}
