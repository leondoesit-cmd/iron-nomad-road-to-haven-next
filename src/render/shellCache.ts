import type * as THREE from 'three';

export interface LampSpec {
  x: number;
  y: number;
  z: number;
  r: number;
  bucket: boolean;
}
export interface TailSpec {
  x: number;
  y: number;
  z: number;
  w?: number;
  h?: number;
  amber?: boolean;
}

/** A built car body: the merged geometry plus the lamps and muzzle that go with it. */
export interface Shell {
  geo: THREE.BufferGeometry;
  lamps: LampSpec[];
  tails: TailSpec[];
  muzzle: [number, number, number] | null;
}

interface Entry {
  shell: Shell;
  refs: number;
  last: number;
}

const cache = new Map<string, Entry>();
/** Unreferenced shells kept around so a car that drops out of range and comes back does not rebuild. */
const KEEP = 24;
let tick = 0;

/**
 * Cars are built from hundreds of primitives, so an abandoned car spawning as the convoy drives up must not cost
 * a frame. Identical cars (same chassis, paint, parts and details) share one geometry.
 */
export function acquireShell(key: string, make: () => Shell): Shell {
  let e = cache.get(key);
  if (!e) {
    e = { shell: make(), refs: 0, last: 0 };
    cache.set(key, e);
    trim();
  }
  e.refs++;
  e.last = ++tick;
  return e.shell;
}

/** Whether a shell is already built, so acquiring it costs nothing. */
export function hasShell(key: string): boolean {
  return cache.has(key);
}

export function releaseShell(key: string) {
  const e = cache.get(key);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  e.last = ++tick;
  trim();
}

function trim() {
  const idle = [...cache.entries()].filter(([, e]) => e.refs === 0);
  if (idle.length <= KEEP) return;
  idle.sort((a, b) => a[1].last - b[1].last);
  for (const [k, e] of idle.slice(0, idle.length - KEEP)) {
    e.shell.geo.dispose();
    cache.delete(k);
  }
}

/** Free everything (end of a scene). */
export function clearShells() {
  for (const e of cache.values()) e.shell.geo.dispose();
  cache.clear();
}

export function shellStats() {
  let refs = 0;
  for (const e of cache.values()) refs += e.refs;
  return { shells: cache.size, refs };
}
