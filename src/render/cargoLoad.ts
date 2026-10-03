import * as THREE from 'three';
import { MeshBuilder } from './builder';
import { crate, jerryCan, oilCan } from './parts';
import { C } from './palette';
import { shared } from './dispose';
import { bodyMat } from './vehicleKit';
import type { Mounts } from './attachments';

/**
 * Stowed cargo you can see: the convoy's spare fuel cans, oil cans and crates of spare parts, strapped to whichever
 * flat surface a chassis has (boot lid, pickup bed, roof, or the carrier on a bike).
 */
export interface Load {
  fuel: number;
  diesel: number;
  oil: number;
  crates: number;
}

export const noLoad = (): Load => ({ fuel: 0, diesel: 0, oil: 0, crates: 0 });
export const loadKey = (l: Load) => `${l.fuel}.${l.diesel}.${l.oil}.${l.crates}`;
export const loadCount = (l: Load) => l.fuel + l.diesel + l.oil + l.crates;

/** A flat area cargo can sit on, in the chassis frame. */
export interface Deck {
  y: number;
  z0: number;
  z1: number;
  hw: number;
  /** A bike's carrier: items stack up rather than spread out. */
  stack: boolean;
}

export function deckOf(m: Mounts, g0: number): Deck {
  if (m.trunk) return { y: m.trunk.y - g0 + 0.02, z0: m.trunk.z0 + 0.1, z1: m.trunk.z1 - 0.1, hw: m.trunk.hw * 0.85, stack: false };
  if (m.roof) return { y: m.roof.y - g0 + 0.02, z0: m.roof.z0 + 0.1, z1: m.roof.z1 - 0.1, hw: m.roof.hw * 0.8, stack: false };
  return { y: m.rear.y + 0.3, z0: m.rear.z + 0.15, z1: m.rear.z + 0.75, hw: Math.max(0.1, m.rear.hw * 0.7), stack: true };
}

/** How many things a deck can hold at once. */
export function deckRoom(d: Deck): number {
  if (d.stack) return 2;
  const cols = Math.max(1, Math.floor((d.hw * 2) / 0.34));
  const rows = Math.max(1, Math.floor((d.z1 - d.z0) / 0.36));
  return Math.min(6, cols * rows);
}

const cache = new Map<string, THREE.BufferGeometry>();

/** A mesh of the load on its deck. Geometry is cached per layout, so rebuilding is cheap. */
export function buildLoad(deck: Deck, load: Load, key: string): THREE.Mesh | null {
  if (loadCount(load) <= 0) return null;
  const ck = `${key}|${deck.y.toFixed(2)}|${deck.z0.toFixed(2)}|${deck.z1.toFixed(2)}|${deck.hw.toFixed(2)}|${loadKey(load)}`;
  let geo = cache.get(ck);
  if (!geo) {
    const b = new MeshBuilder();
    b.jitter = 0.02;
    const things: ('crate' | 'fuel' | 'diesel' | 'oil')[] = [];
    for (let i = 0; i < load.crates; i++) things.push('crate');
    for (let i = 0; i < load.fuel; i++) things.push('fuel');
    for (let i = 0; i < load.diesel; i++) things.push('diesel');
    for (let i = 0; i < load.oil; i++) things.push('oil');
    const cols = deck.stack ? 1 : Math.max(1, Math.floor((deck.hw * 2) / 0.34));
    const zc = (deck.z0 + deck.z1) / 2;
    let stackY = 0;
    things.forEach((kind, i) => {
      const yaw = ((i * 53) % 17) * 0.05 - 0.4;
      if (deck.stack) {
        // On a carrier: one thing on the rack, the next on top of it.
        if (kind === 'crate') crate(b, 0, deck.y + stackY + 0.1, zc, 0.34, 0.22, 0.3, yaw);
        else if (kind === 'fuel' || kind === 'diesel') jerryCan(b, 0, deck.y + stackY, zc, kind === 'diesel' ? C.diesel : C.fuel, yaw);
        else oilCan(b, 0, deck.y + stackY, zc, yaw);
        stackY += kind === 'crate' ? 0.22 : 0.34;
        return;
      }
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = cols === 1 ? 0 : (col / (cols - 1) - 0.5) * (deck.hw * 2 - 0.3);
      const z = deck.z1 - 0.18 - row * 0.36;
      if (z < deck.z0 - 0.05) return;
      if (kind === 'crate') crate(b, x, deck.y + 0.11, z, 0.32, 0.22, 0.3, yaw);
      else if (kind === 'fuel' || kind === 'diesel') jerryCan(b, x, deck.y, z, kind === 'diesel' ? C.diesel : C.fuel, yaw);
      else oilCan(b, x, deck.y, z, yaw);
    });
    geo = shared(b.build());
    cache.set(ck, geo);
  }
  const mesh = new THREE.Mesh(geo, bodyMat);
  mesh.castShadow = true;
  return mesh;
}
