import type { VehicleDef } from '../data';
import { accessPointsOf } from './accessPoints';
import { mountsOfChassis } from './vehicleModels';

/**
 * Where the things stowed INSIDE a vehicle sit: a floor in the chassis frame (x left, y up, z forward) that each stowed item
 * gets its own spot on, so taking one out comes from where it lay and the storage panel can point at it. A boot is the floor
 * behind the rear axle, reached from the tailgate; a pickup's cab and a buggy's seat well are behind the seats; a bike's
 * panniers hang either side of the tail. Pure geometry from the same mount data the models use; cached per chassis.
 */

export interface BootDeck {
  /** Centre of the floor's first row, and the way rows go (+1 forward into the body from the back, -1 backward). */
  x: number;
  y: number;
  z: number;
  dir: 1 | -1;
  /** Half width usable across, metres between rows, and rows before things stack. */
  hw: number;
  step: number;
  rows: number;
  /** Panniers: two sides instead of a grid. */
  sides: boolean;
}

const cache = new Map<string, BootDeck>();

/** The inside floor of a chassis. */
export function bootDeck(def: VehicleDef): BootDeck {
  let d = cache.get(def.id);
  if (!d) cache.set(def.id, (d = build(def)));
  return d;
}

function build(def: VehicleDef): BootDeck {
  const pts = accessPointsOf(def);
  const trunk = pts.find((p) => p.spot === 'trunk');
  const door = pts.find((p) => p.spot === 'doorL');
  const mt = mountsOfChassis(def);
  const hw = Math.max(0.12, Math.min(0.5, (mt?.m.hw ?? def.width / 2) * 0.62));
  if (def.id === 'moped' || def.id === 'quad' || def.id === 'trike') {
    // Panniers either side of the tail.
    const t = trunk ?? { x: 0, y: 0.6, z: -def.length / 2 };
    return { x: 0, y: t.y - 0.05, z: t.z + 0.3, dir: 1, hw: Math.max(0.18, (mt?.m.hw ?? 0.3) + 0.08), step: 0.22, rows: 2, sides: true };
  }
  if ((def.id === 'pickup' || def.id === 'buggy') && door) {
    // Behind the seats: a narrow shelf across the cab, reached through either door.
    return { x: 0, y: door.y - 0.15, z: door.z - 0.45, dir: -1, hw: Math.max(0.2, Math.abs(door.x) * 0.6), step: 0.22, rows: 1, sides: false };
  }
  const t = trunk ?? { x: 0, y: 0.7, z: -def.length / 2 + 0.2 };
  // The floor you see when the lid comes up, just under the lid's line. A van's load area runs a long way forward; a hatch or
  // a sedan's boot is a metre or so deep.
  const depth = def.id === 'van' || def.id === 'truck' || def.id === 'rig' ? 2.2 : 0.9;
  return { x: 0, y: t.y - 0.08, z: t.z + 0.3, dir: 1, hw, step: 0.28, rows: Math.max(1, Math.floor(depth / 0.28)), sides: false };
}

/** The spot of the `i`th of `n` stowed things, in the chassis frame. */
export function bootSpot(deck: BootDeck, i: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (deck.sides) {
    // Left pannier, right pannier, then the next pair forward and so on, stacking up when both are full.
    const side = i % 2 === 0 ? 1 : -1;
    const k = Math.floor(i / 2);
    const row = k % deck.rows;
    const layer = Math.floor(k / deck.rows);
    out[0] = side * deck.hw;
    out[1] = deck.y + layer * 0.18;
    out[2] = deck.z + row * deck.step * deck.dir;
    return out;
  }
  const cols = Math.max(1, Math.min(4, Math.floor((deck.hw * 2) / 0.3) + 1));
  const cells = cols * deck.rows;
  const cell = i % cells;
  // A boot only stacks so high: past a second layer things lie on top of one another.
  const layer = Math.min(1, Math.floor(i / cells));
  const col = cell % cols;
  const row = Math.floor(cell / cols);
  out[0] = cols === 1 ? deck.x : deck.x + (col / (cols - 1) - 0.5) * deck.hw * 2;
  out[1] = deck.y + layer * 0.16;
  out[2] = deck.z + row * deck.step * deck.dir;
  return out;
}
