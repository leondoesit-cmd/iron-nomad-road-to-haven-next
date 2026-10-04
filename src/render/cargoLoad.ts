import * as THREE from 'three';
import { MeshBuilder } from './builder';
import { crate, jerryCan, oilCan } from './parts';
import { buildPartModel } from './partModels';
import { C } from './palette';
import { bodyMat } from './vehicleKit';
import type { Mounts } from './attachments';
import type { Carried } from '../sim/carry';
import type { Zone } from '../sim/cargo';

/**
 * Cargo you can see on a car: what was put on the roof, in the bed or in the rear cage (`sim/cargo.ts` says what each place
 * holds and whether it is secure). Each item is drawn as itself, at a spot in that place's deck, in the chassis frame. What
 * is stowed INSIDE (boot, cab, panniers) is not drawn at all, and the jerrycan rack and the spare-wheel carrier draw their own
 * cans and tyre as part of the fitted model.
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
  kind: 'part' | 'fuel' | 'diesel' | 'oil' | 'water';
  partId?: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

const kindOf = (c: Carried): Placed['kind'] => (c.kind === 'part' ? 'part' : c.kind === 'fuel' ? (c.fuel === 'diesel' ? 'diesel' : 'fuel') : c.kind === 'oil' ? 'oil' : 'water');

/** Where each entry sits on its deck: a grid of spots, stacking up when it is full. */
export function layoutEntries(deck: Deck, entries: { id: string; c: Carried }[]): Placed[] {
  const cols = Math.max(1, Math.floor((deck.hw * 2) / 0.34));
  const rows = Math.max(1, Math.floor((deck.z1 - deck.z0) / 0.36));
  const cells = cols * rows;
  const zc = (deck.z0 + deck.z1) / 2;
  return entries.map((e, i) => {
    const cell = i % cells;
    const layer = Math.floor(i / cells);
    const col = cell % cols;
    const row = Math.floor(cell / cols);
    const x = cols === 1 ? 0 : (col / (cols - 1) - 0.5) * (deck.hw * 2 - 0.3);
    const z = rows === 1 ? zc : deck.z1 - 0.18 - row * 0.36;
    const yaw = ((i * 53) % 17) * 0.05 - 0.4;
    return { id: e.id, kind: kindOf(e.c), partId: e.c.kind === 'part' ? e.c.item.id : undefined, x, y: deck.y + layer * 0.3, z, yaw };
  });
}

/** Spare parts are drawn at this fraction of their full size so a few fit side by side. */
const PART_SCALE = 0.5;

/** The model of one carried thing on a deck. */
function drawThing(b: MeshBuilder, t: Placed) {
  if (t.kind === 'part') {
    const pm = new MeshBuilder();
    buildPartModel(pm, t.partId!);
    b.appendMatrix(pm, new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.yaw), new THREE.Vector3(PART_SCALE, PART_SCALE, PART_SCALE)));
  } else if (t.kind === 'fuel' || t.kind === 'diesel') jerryCan(b, t.x, t.y, t.z, t.kind === 'diesel' ? C.diesel : C.fuel, t.yaw);
  else if (t.kind === 'water') jerryCan(b, t.x, t.y, t.z, 0x3a6ea5, t.yaw);
  else oilCan(b, t.x, t.y, t.z, t.yaw);
}

/** A mesh of everything on the decks. Null when there is nothing to draw. */
export function buildCargoMesh(decks: { deck: Deck; entries: { id: string; c: Carried }[] }[]): THREE.Mesh | null {
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
  else crate(b, 0, 0.11, 0, 0.32, 0.22, 0.3, 0);
  return b.build();
}
