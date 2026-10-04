import type { VehicleDef } from '../data';
import { slotsOf } from '../sim/parts';
import { SPOT_NAME, type Spot } from '../sim/access';
import { mountsOfChassis } from './vehicleModels';
import { cabinLayout } from './interior';
import { socketFor, wheelCentres } from './sockets';

/**
 * Where on a vehicle each job is done: its access points, in the chassis frame (x left, y up, z forward, origin at the
 * chassis centre), derived from the same mount data the models and sockets use. The rules for which job goes where, and what
 * has to be open, are `sim/access.ts`; this is only geometry. A point sits on the outside surface of the thing it names, so a
 * person standing a stride off it is within reach.
 */

export interface AccessPoint {
  /** Unique on a vehicle: `hood`, `doorL`, `wheel2`, `under1`... */
  id: string;
  spot: Spot;
  /** Which wheel, or which side of a pair (`under` and `flank`: 0 is the left). */
  index: number;
  x: number;
  y: number;
  z: number;
  /** What it is called in a callout. */
  label: string;
}

const cache = new Map<string, AccessPoint[]>();

/** The access points of a chassis. Cached: they never change for a def. */
export function accessPointsOf(def: VehicleDef): AccessPoint[] {
  let hit = cache.get(def.id);
  if (!hit) cache.set(def.id, (hit = build(def)));
  return hit;
}

function build(def: VehicleDef): AccessPoint[] {
  const out: AccessPoint[] = [];
  const slots = slotsOf(def);
  const add = (spot: Spot, x: number, y: number, z: number, index = 0, id = spot as string) => out.push({ id, spot, index, x, y, z, label: SPOT_NAME[spot].name });
  const mt = mountsOfChassis(def);
  const L = def.length / 2;
  const W = def.width / 2;
  const wheels = wheelCentres(def);
  const zMid = (def.physics.wheelsZ[0] + def.physics.wheelsZ[def.physics.wheelsZ.length - 1]) / 2;
  if (!mt) {
    // A chassis with no model data (a war truck, a rig): spread the points along the body.
    add('hood', 0, 0.9, L * 0.7);
    add('trunk', 0, 0.9, -L + 0.2);
    add('flap', -(W + 0.05), 0.9, -L * 0.5);
    add('front', 0, 0.6, L + 0.2);
    add('rear', 0, 0.7, -L - 0.2);
    for (const [i, sx] of [[0, 1], [1, -1]] as const) add('flank', sx * (W + 0.1), 0.5, 0, i, `flank${i}`);
    for (const [i, sx] of [[0, 1], [1, -1]] as const) add('under', sx * (W + 0.1), 0.2, zMid, i, `under${i}`);
    if (slots.includes('roof')) add('roof', 0, 1.9, 0);
    if (slots.includes('weapon')) add('gun', 0, 1.5, -0.3);
    wheels.forEach(([x, y, z], i) => add('wheel', x + (Math.abs(x) < 0.05 ? 0 : Math.sign(x) * 0.35), y, z, i, `wheel${i}`));
    return out;
  }
  const { m, g0 } = mt;
  const low = (y: number) => y - g0;
  // The engine bay: at the front edge of the bonnet, so you stand at the nose or at a front wing. A bike has the motor on show.
  if (m.hood) add('hood', 0, low(m.hood.y), m.hood.z1 - 0.45);
  else add('hood', 0, low(m.sill) + 0.25, (m.side.z0 + m.side.z1) / 2 - 0.2);
  // Doors: the handle of each, wherever there is a cabin to climb into (a buggy has no panel there, but the seat is reached from it).
  if (cabinLayout(def)) {
    const y = low((m.side.y0 + m.side.y1) / 2);
    const z = (m.side.z0 + m.side.z1) / 2;
    add('doorL', m.hw + 0.02, y, z);
    add('doorR', -(m.hw + 0.02), y, z);
  }
  // The boot, tailgate, rear doors, bed or rack: at the rear edge.
  add('trunk', 0, low(m.trunk ? m.trunk.y : m.rear.y + 0.35), m.rear.z + 0.05);
  // The fuel flap: a rear flank, on the right (the side the driver does not climb in from).
  add('flap', -(m.hw + (m.narrow ? 0.14 : 0.04)), low(m.narrow ? m.side.y1 + 0.05 : m.side.y1 - 0.12), m.rear.z + (m.narrow ? 0.5 : 0.9));
  wheels.forEach(([x, y, z], i) => add('wheel', x + (Math.abs(x) < 0.05 ? 0 : Math.sign(x) * 0.35), y, z, i, `wheel${i}`));
  // Underneath: from a crouch beside the sill, either side, halfway between the axles.
  for (const [i, sx] of [[0, 1], [1, -1]] as const) add('under', sx * (m.hw + 0.1), low(m.sill) - 0.02, zMid, i, `under${i}`);
  if (slots.includes('roof') && m.roof) add('roof', 0, low(m.roof.y) + 0.05, (m.roof.z0 + m.roof.z1) / 2);
  add('front', 0, low(m.front.y) + 0.1, m.front.z + 0.2);
  add('rear', 0, low(m.rear.y) + 0.3, m.rear.z - 0.2);
  for (const [i, sx] of [[0, 1], [1, -1]] as const) add('flank', sx * (m.hw + 0.1), low(m.sill) + 0.35, m.side.z0 + 0.25, i, `flank${i}`);
  if (slots.includes('weapon')) {
    const g = socketFor(def, 'weapon')?.anchors[0];
    if (g) add('gun', g.x, g.y, g.z);
  }
  return out;
}

/** The points of one kind, in index order. */
export const pointsAt = (def: VehicleDef, spot: Spot): AccessPoint[] => accessPointsOf(def).filter((p) => p.spot === spot);
