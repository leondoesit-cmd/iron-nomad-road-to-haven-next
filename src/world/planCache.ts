import { LEGS, type LegDef } from '../data';
import { CITY_PLANS } from './plans';
import { ChunkSource } from './chunkgen';

/**
 * World plans, made once per leg and handed out as copies.
 *
 * A leg's plan (`ChunkSource`: the terrain, the layout of everything on it, the chunks made so far) depends on the leg
 * definition alone, never on the run's seed, and costs about a second to make. The title demo, a new run, training, a
 * reload and the benchmark all used to make it again. Now the first is kept as a master that no scene ever touches, and
 * each scene gets its own copy of it, made in a few tens of milliseconds:
 *
 * - The layout is copied whole (deep, with shared references kept shared), because play changes it: containers are
 *   searched, barricades lose their hp, walls are breached. A copy starts pristine, exactly as a fresh build would.
 * - The terrain definition is shared by every copy. Play never writes to it (a test holds that), and render caches are
 *   keyed by its objects (far forest plans, lake depth textures, river ribbons), so sharing it keeps them warm too.
 * - The data the plan points into (the leg definitions, the city plans) stays the same objects, as in a fresh build.
 *
 * A run's copy lives on in its `WorldMemory` (`memory.src`) from one night to the next; this cache only matters when a
 * scene starts without one.
 */

interface Master {
  leg: LegDef;
  src: ChunkSource;
  /** Every object reachable from the terrain definition: shared by the copies, never copied. */
  terrain: WeakSet<object>;
}

/** The most recent masters, oldest first. The open world's plan is the one that matters; a second leg may ride along. */
const masters = new Map<LegDef, Master>();
const KEEP = 2;
let constants: WeakSet<object> | null = null;

/** Objects of the game's data that plans refer to: kept by reference in a copy, as a fresh build would. */
function dataObjects(): WeakSet<object> {
  if (constants) return constants;
  const set = new WeakSet<object>();
  reach(LEGS, set);
  reach(CITY_PLANS, set);
  return (constants = set);
}

/** Add everything reachable from `root` (objects, arrays, maps and sets; typed arrays as leaves) to `set`. */
function reach(root: unknown, set: WeakSet<object>, stop?: WeakSet<object>) {
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object' || set.has(v) || stop?.has(v)) continue;
    set.add(v);
    if (ArrayBuffer.isView(v)) continue;
    if (v instanceof Map) {
      for (const [k, x] of v) stack.push(k, x);
    } else if (v instanceof Set) {
      for (const x of v) stack.push(x);
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push(v[i]);
    } else {
      for (const k of Object.keys(v)) stack.push((v as Record<string, unknown>)[k]);
    }
  }
}

const isGenerator = (v: object) => Object.prototype.toString.call(v) === '[object Generator]';

/**
 * A deep copy of an object graph: shared references stay shared within the copy, class instances keep their class,
 * arrays, maps, sets and typed arrays are copied, and anything in `keep` is referenced rather than copied.
 * Iterative, so a long linked structure cannot overflow the stack.
 */
export function copyGraph<T>(root: T, keep: (o: object) => boolean): T {
  const copies = new Map<object, object>();
  const todo: object[] = [];
  const copy = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (keep(v)) return v;
    let c = copies.get(v);
    if (c) return c;
    if (ArrayBuffer.isView(v)) {
      c = (v as unknown as { slice(): object }).slice();
      copies.set(v, c);
      return c;
    }
    if (isGenerator(v)) throw new Error('copyGraph: a half-made generator cannot be copied');
    if (Array.isArray(v)) c = new Array(v.length);
    else if (v instanceof Map) c = new Map();
    else if (v instanceof Set) c = new Set();
    else {
      const proto = Object.getPrototypeOf(v);
      c = proto === Object.prototype ? {} : Object.create(proto);
    }
    copies.set(v, c!);
    todo.push(v);
    return c;
  };
  const out = copy(root) as T;
  while (todo.length) {
    const v = todo.pop()!;
    const c = copies.get(v)!;
    if (Array.isArray(v)) {
      const a = c as unknown[];
      for (let i = 0; i < v.length; i++) a[i] = copy(v[i]);
    } else if (v instanceof Map) {
      const m = c as Map<unknown, unknown>;
      for (const [k, x] of v) m.set(copy(k), copy(x));
    } else if (v instanceof Set) {
      const s = c as Set<unknown>;
      for (const x of v) s.add(copy(x));
    } else {
      const o = c as Record<string, unknown>;
      for (const k of Object.keys(v)) o[k] = copy((v as Record<string, unknown>)[k]);
    }
  }
  return out;
}

function remember(m: Master) {
  masters.delete(m.leg);
  masters.set(m.leg, m);
  while (masters.size > KEEP) masters.delete(masters.keys().next().value!);
}

function masterOf(leg: LegDef): Master {
  const known = masters.get(leg);
  if (known) {
    remember(known);
    return known;
  }
  const src = new ChunkSource(leg);
  const terrain = new WeakSet<object>();
  reach(src.layout.terrain, terrain, dataObjects());
  const m: Master = { leg, src, terrain };
  remember(m);
  return m;
}

/** Whether a leg's plan is made already, so `takePlan` costs only the copy. */
export function planMade(leg: LegDef): boolean {
  return masters.has(leg);
}

/** Make a leg's plan now, if it is not made yet (about a second on the open world). The title calls this while idle. */
export function preparePlan(leg: LegDef) {
  masterOf(leg);
}

/**
 * The master plan itself, if it is made, for reading only (the title warms render caches from it). Never hand it to a
 * scene and never change it: every copy is made from it.
 */
export function planMaster(leg: LegDef): ChunkSource | null {
  return masters.get(leg)?.src ?? null;
}

/** A plan of its own for a new scene on this leg: a pristine copy of the master, made first if need be. */
export function takePlan(leg: LegDef): ChunkSource {
  const m = masterOf(leg);
  const data = dataObjects();
  return copyGraph(m.src, (o) => data.has(o) || m.terrain.has(o));
}

/** Forget every master (tests, and a page that wants its memory back). */
export function clearPlans() {
  masters.clear();
}
