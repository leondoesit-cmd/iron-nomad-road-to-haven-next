import { PARTS, type PartSlot, type VehicleDef } from '../data';
import { slotsOf } from '../sim/parts';
import { mountsOfChassis } from './vehicleModels';
import type { PanelId } from '../sim/paint';

/**
 * Attach points. Every part slot is a physical place on a vehicle: the engine goes under the bonnet, the radiator
 * behind the grille, tyres on the wheels, plates on the doors. A socket is that place, as one or more boxes in the
 * chassis frame (x left, y up, z forward, origin at the chassis centre).
 *
 * The garage UI works in slots; the world works in sockets: carry a part up to a vehicle and its outline lights up
 * where it goes, and you have to stand within reach of it to bolt it on.
 */

export interface Anchor {
  /** Centre, chassis frame. */
  x: number;
  y: number;
  z: number;
  /** Full size along x, y and z. */
  sx: number;
  sy: number;
  sz: number;
}

export interface Socket {
  slot: PartSlot;
  label: string;
  anchors: Anchor[];
}

/** What each slot is called at the vehicle. */
export const SOCKET_LABEL: Record<PartSlot, string> = {
  engine: 'Engine bay',
  cooling: 'Radiator',
  wheels: 'Wheels',
  armor: 'Door plating',
  weapon: 'Gun mount',
  utility: 'Rack and tanks',
  front: 'Front bumper',
  roof: 'Roof',
  rear: 'Rear mount',
  side: 'Sills',
};

/** Where Rapier puts the wheels for a chassis (see physics/vehicle.ts): resting wheel centres, chassis frame. */
export function wheelCentres(def: VehicleDef): [number, number, number][] {
  const p = def.physics;
  const out: [number, number, number][] = [];
  const xs = p.wheelsX[0] === 0 ? [0] : p.wheelsX;
  for (let a = 0; a < p.wheelsZ.length; a++) {
    for (const wx of xs) {
      if (out.length >= p.wheelCount) break;
      out.push([wx, p.hardY - p.suspension.rest, p.wheelsZ[a]]);
    }
  }
  return out;
}

const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number): Anchor => ({ x, y, z, sx, sy, sz });

/** The socket for one slot on a chassis, or undefined if the chassis has no such mount. */
export function socketFor(def: VehicleDef, slot: PartSlot): Socket | undefined {
  if (!slotsOf(def).includes(slot)) return undefined;
  const mt = mountsOfChassis(def);
  const g0 = mt?.g0 ?? 0;
  const m = mt?.m;
  const w = def.width / 2;
  const len = def.length;
  const wr = def.physics.wheelRadius;
  let anchors: Anchor[] = [];
  if (slot === 'wheels') {
    anchors = wheelCentres(def).map(([x, y, z]) => box(x + Math.sign(x) * 0.04, y, z, Math.max(0.2, wr * 0.55), wr * 2.1, wr * 2.1));
  } else if (!m) {
    // A chassis with no model data (not one the garage builds): spread the sockets sensibly along the body.
    const z = slot === 'front' ? len / 2 : slot === 'rear' ? -len / 2 : 0;
    anchors = [box(0, 0.4, z, w * 1.4, 0.4, 0.5)];
  } else {
    const low = (y: number) => y - g0;
    switch (slot) {
      case 'engine':
        anchors = m.hood
          ? [box(0, low(m.hood.y) - 0.12, (m.hood.z0 + m.hood.z1) / 2, m.hood.hw * 1.7, 0.4, Math.max(0.5, m.hood.z1 - m.hood.z0))]
          : [box(0, low(m.sill) + 0.12, (m.side.z0 + m.side.z1) / 2 - 0.2, Math.max(0.3, m.hw * 1.6), 0.34, 0.6)];
        break;
      case 'cooling':
        anchors = [box(0, low(m.front.y), m.front.z - 0.08, Math.max(0.3, m.front.hw * 1.5), 0.3, 0.2)];
        break;
      case 'armor': {
        const y = low((m.side.y0 + m.side.y1) / 2);
        const z = (m.side.z0 + m.side.z1) / 2;
        const len2 = m.side.z1 - m.side.z0;
        anchors = m.narrow
          ? [box(0, y, z, Math.max(0.4, m.hw * 2 + 0.1), m.side.y1 - m.side.y0, len2)]
          : [1, -1].map((sx) => box(sx * (m.hw + 0.03), y, z, 0.1, Math.max(0.25, m.side.y1 - m.side.y0), len2));
        break;
      }
      case 'side': {
        const z = (m.side.z0 + m.side.z1) / 2;
        const len2 = m.side.z1 - m.side.z0;
        anchors = [1, -1].map((sx) => box(sx * (m.hw + 0.03), low(m.sill) + 0.02, z, 0.12, 0.14, len2));
        break;
      }
      case 'front':
        anchors = [box(0, low(m.front.y), m.front.z + 0.04, Math.max(0.35, m.front.hw * 2), 0.34, 0.26)];
        break;
      case 'rear':
        anchors = [box(0, low(m.rear.y) + 0.05, m.rear.z - 0.04, Math.max(0.35, m.rear.hw * 2), 0.4, 0.26)];
        break;
      case 'roof':
        anchors = m.roof ? [box(0, low(m.roof.y) + 0.06, (m.roof.z0 + m.roof.z1) / 2, m.roof.hw * 1.8, 0.16, Math.max(0.5, m.roof.z1 - m.roof.z0))] : [box(0, low(m.rear.y) + 0.6, 0, 0.5, 0.2, 0.5)];
        break;
      case 'weapon':
        if (m.gun) anchors = [box(m.gun.x, low(m.gun.y), m.gun.z, 0.45, 0.4, 0.55)];
        else if (m.trunk) anchors = [box(0, low(m.trunk.y) + 0.3, (m.trunk.z0 + m.trunk.z1) / 2, m.trunk.hw * 1.4, 0.6, Math.max(0.5, m.trunk.z1 - m.trunk.z0))];
        else anchors = [box(0, low(m.rear.y) + 0.6, m.rear.z + 0.5, 0.5, 0.5, 0.6)];
        break;
      case 'utility':
        anchors = m.trunk
          ? [box(0, low(m.trunk.y) + 0.12, (m.trunk.z0 + m.trunk.z1) / 2, m.trunk.hw * 1.5, 0.28, Math.max(0.5, m.trunk.z1 - m.trunk.z0))]
          : [box(0, low(m.rear.y) + 0.3, m.rear.z + 0.45, Math.max(0.3, m.rear.hw * 1.6), 0.3, 0.55)];
        break;
    }
  }
  return { slot, label: SOCKET_LABEL[slot], anchors };
}

/** Every socket a chassis has, in the slot order of the garage. */
export function socketsOf(def: VehicleDef): Socket[] {
  return PARTS.slots.map((s) => socketFor(def, s)).filter((s): s is Socket => !!s);
}

/**
 * How near a point (chassis frame) is to a socket: the distance to the closest anchor, with height counting half so
 * the engine bay is reachable from the ground.
 */
export function socketDistance(sock: Socket, x: number, y: number, z: number): { dist: number; anchor: Anchor } {
  let best = sock.anchors[0];
  let bd = Infinity;
  for (const a of sock.anchors) {
    const d = Math.hypot(a.x - x, (a.y - y) * 0.5, a.z - z);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return { dist: bd, anchor: best };
}

/** Where a paintable panel is on the vehicle, as a box in the chassis frame: for aiming a spray can. */
export function panelAnchor(def: VehicleDef, panel: PanelId): Anchor | undefined {
  const mt = mountsOfChassis(def);
  if (!mt) return undefined;
  const { m, g0 } = mt;
  const low = (y: number) => y - g0;
  switch (panel) {
    case 'hood':
      return m.hood ? box(0, low(m.hood.y), (m.hood.z0 + m.hood.z1) / 2, m.hood.hw * 1.8, 0.1, Math.max(0.4, m.hood.z1 - m.hood.z0)) : undefined;
    case 'roof':
      return m.roof ? box(0, low(m.roof.y), (m.roof.z0 + m.roof.z1) / 2, m.roof.hw * 1.8, 0.1, Math.max(0.5, m.roof.z1 - m.roof.z0)) : undefined;
    case 'doorL':
    case 'doorR': {
      if (m.narrow) return undefined;
      const sx = panel === 'doorL' ? 1 : -1;
      return box(sx * (m.hw + 0.02), low((m.side.y0 + m.side.y1) / 2), (m.side.z0 + m.side.z1) / 2, 0.08, Math.max(0.3, m.side.y1 - m.side.y0 + 0.2), m.side.z1 - m.side.z0);
    }
    case 'front':
      return box(0, low(m.front.y) + (m.narrow ? 0.1 : 0.15), m.front.z - 0.15, Math.max(0.3, m.front.hw * 2), 0.5, 0.3);
    case 'rear':
      return box(0, low(m.rear.y) + (m.narrow ? 0.1 : 0.15), m.rear.z + 0.15, Math.max(0.3, m.rear.hw * 2), 0.5, 0.3);
  }
}
