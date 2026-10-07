import type { Aabb } from './layout';

/** Shared shop coordinates: x along the frontage, +z toward the street. */
export const MELABES = {
  halfWidth: 3.7, depth: 4.8, height: 2.95,
  spits: [-2.55, -0.9] as const, spitZ: -2.55,
  counter: { x: -1.65, z: -0.15, w: 4, d: 0.72 },
  service: { x: -0.1, z: -0.85 },
  cycle: 22, serveAt: 18, delay: 30,
};
export function melabesPhase(time: number) {
  const t = ((time % MELABES.cycle) + MELABES.cycle) % MELABES.cycle;
  return { t, cycle: Math.floor(time / MELABES.cycle), serving: t >= MELABES.serveAt };
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** Piecewise walking routes stay clear of both large spits and the front counter. */
export function melabesPose(time: number): { x: number; z: number; yaw: number; carving: boolean; serving: boolean; walk: number; stroke: number; portion: number } {
  const { t, serving } = melabesPhase(time);
  const a = [MELABES.spits[0] - 0.75, MELABES.spitZ + 0.62];
  const b = [MELABES.spits[1] - 0.75, MELABES.spitZ + 0.62];
  const service = [MELABES.service.x, MELABES.service.z];
  const route = (start: number, end: number, pts: number[][]) => {
    const lengths = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    const total = lengths.reduce((v, l) => v + l, 0);
    let d = (t - start) / (end - start) * total;
    let i = 0;
    while (i < lengths.length - 1 && d > lengths[i]) d -= lengths[i++];
    const p = pts[i], q = pts[i + 1];
    return { x: mix(p[0], q[0], d / lengths[i]), z: mix(p[1], q[1], d / lengths[i]), yaw: Math.atan2(q[0] - p[0], q[1] - p[1]), walk: 1 };
  };
  let pose = { x: service[0], z: service[1], yaw: 0, walk: 0 };
  if (t < 3) pose = route(0, 3, [service, [-3.35, -0.85], a]);
  else if (t < 7) pose = { x: a[0], z: a[1], yaw: Math.PI, walk: 0 };
  else if (t < 11) pose = route(7, 11, [a, [-3.35, -3.9], [0.2, -3.9], [0.2, -1.7], b]);
  else if (t < 15) pose = { x: b[0], z: b[1], yaw: Math.PI, walk: 0 };
  else if (t < 18) pose = route(15, 18, [b, [0.65, -1.4], service]);
  return { ...pose, carving: (t >= 3 && t < 7) || (t >= 11 && t < 15), serving, stroke: ((t - 3) * 1.6) % 1,
    portion: t < 3 ? 0.1 : t < 7 ? mix(0.1, 0.55, (t - 3) / 4) : t < 11 ? 0.55 : t < 15 ? mix(0.55, 1, (t - 11) / 4) : 1 };
}
export function melabesFrame(a: Pick<Aabb, 'minX' | 'maxX' | 'minZ' | 'maxZ'>) {
  const side = a.minX > 0 ? 1 : -1;
  const x = (side > 0 ? a.minX : a.maxX) - side * 0.14;
  const z = (a.minZ + a.maxZ) / 2;
  return { side, x, z, point: (lx: number, lz: number) => ({ x: x - side * lz, z: z + side * lx }) };
}
/** Four solid volumes leave a full-height recessed ground-floor opening. */
export function melabesBuildingBoxes(a: Aabb, nextId: () => number): Aabb[] {
  const f = melabesFrame(a);
  const back = f.point(0, -MELABES.depth).x;
  const z0 = f.z - MELABES.halfWidth, z1 = f.z + MELABES.halfWidth;
  return [
    { ...a, id: nextId(), y0: MELABES.height },
    { ...a, id: nextId(), maxZ: z0, y1: MELABES.height },
    { ...a, id: nextId(), minZ: z1, y1: MELABES.height },
    { ...a, id: nextId(), minX: f.side > 0 ? back : a.minX, maxX: f.side > 0 ? a.maxX : back, minZ: z0, maxZ: z1, y1: MELABES.height },
  ];
}
export function melabesInterior(a: Pick<Aabb, 'minX' | 'maxX' | 'minZ' | 'maxZ'>, x: number, z: number, r: number) {
  const f = melabesFrame(a);
  const localZ = (f.x - x) * f.side;
  return Math.abs(z - f.z) + r < MELABES.halfWidth && localZ - r > -MELABES.depth;
}
/** Equipment collisions in the same frame as its render geometry. */
export function melabesEquipment(a: Pick<Aabb, 'minX' | 'maxX' | 'minZ' | 'maxZ'>, nextId: () => number): Aabb[] {
  const f = melabesFrame(a);
  const box = (x: number, z: number, w: number, d: number, y1: number, mat: Aabb['mat']): Aabb => {
    const p = f.point(x, z);
    return { id: nextId(), minX: p.x - d / 2, maxX: p.x + d / 2, minZ: p.z - w / 2, maxZ: p.z + w / 2, y0: 0, y1, kind: 'furniture', hp: 99999, mat };
  };
  const c = MELABES.counter;
  return [box(c.x, c.z, c.w, c.d, 1.01, 'sheet'), ...MELABES.spits.map((x) => box(x, MELABES.spitZ, 0.88, 0.88, 2.75, 'steel'))];
}
