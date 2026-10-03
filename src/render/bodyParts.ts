/**
 * Parts that can come off a vehicle. A model builder wraps the primitives of a bolt-on module, a door or a mirror in
 * `b.mark(tag, meta)` ... `b.end()`, and the merged body keeps the vertex range of each, so the part can later be
 * lifted out of the shared mesh (to hang loose, or to fly off as debris) without the model being built in pieces.
 * Pure data: no three.js, so the rules in sim/ and the tests can use it too.
 */

/** How a part is held on: it sets how the joint fails and how the part moves as it works loose. */
export type JointKind = 'weld' | 'bolt' | 'hinge' | 'clip' | 'strap';

export interface PartMeta {
  /** The fitted-part slot this belongs to. Unset for body work (doors, mirrors, bumpers): not something you carry away. */
  slot?: string;
  /** Which flank: +1 is the left (+x), -1 the right, 0 the centre line. */
  side: -1 | 0 | 1;
  joint: JointKind;
  /** Kilograms, for the debris it becomes. */
  mass: number;
  /** Sudden speed change (m/s) at the part that its joint takes before it starts to give. */
  tol: number;
  /** Where the joint is, in the frame the model was built in. Defaults to the middle of the part. */
  pivot?: [number, number, number];
  /** Round things (spare wheels) roll when they land. */
  round?: boolean;
}

/** One contiguous run of vertices and indices in the merged body that belongs to a part. A part may have several runs. */
export interface PartRange {
  tag: string;
  v0: number;
  v1: number;
  i0: number;
  i1: number;
  meta: PartMeta;
}

export type PartKind = 'door' | 'mirror' | 'bumper' | 'slot' | 'spare' | 'crate' | 'sign' | 'lightbar' | 'bullbar';

export function partTag(kind: PartKind, qualifier: string | number = ''): string {
  return qualifier === '' ? kind : `${kind}:${qualifier}`;
}

/** What each bolt-on module is made of, by id: its joint, weight and how hard a knock it takes. */
const SLOT_PARTS: Record<string, { joint: JointKind; mass: number; tol: number; round?: boolean }> = {
  fr_bull: { joint: 'weld', mass: 34, tol: 12 },
  fr_blade: { joint: 'weld', mass: 58, tol: 15 },
  fr_spike: { joint: 'weld', mass: 44, tol: 13 },
  rf_rack: { joint: 'bolt', mass: 20, tol: 10 },
  rf_light: { joint: 'bolt', mass: 6, tol: 6 },
  rf_cage: { joint: 'weld', mass: 48, tol: 15 },
  rr_spare: { joint: 'bolt', mass: 26, tol: 9.5, round: true },
  rr_wing: { joint: 'bolt', mass: 7, tol: 5.5 },
  rr_box: { joint: 'bolt', mass: 42, tol: 11 },
  sd_skirt: { joint: 'weld', mass: 16, tol: 11 },
  sd_plate: { joint: 'bolt', mass: 24, tol: 12.5 },
  sd_pipes: { joint: 'clip', mass: 10, tol: 7 },
};

/** Body work that is not a module: it is built into the car, but it is only bolted or clipped and it does come off. */
const BODY_PARTS: Record<string, { joint: JointKind; mass: number; tol: number; round?: boolean }> = {
  door: { joint: 'hinge', mass: 22, tol: 10 },
  mirror: { joint: 'clip', mass: 1.2, tol: 3.6 },
  bumper: { joint: 'bolt', mass: 15, tol: 12 },
  armor: { joint: 'weld', mass: 20, tol: 14 },
  utility: { joint: 'strap', mass: 9, tol: 6.5 },
  spare: { joint: 'bolt', mass: 24, tol: 9.5, round: true },
  crate: { joint: 'strap', mass: 12, tol: 5.5 },
  sign: { joint: 'weld', mass: 14, tol: 9 },
  lightbar: { joint: 'bolt', mass: 5, tol: 6 },
  bullbar: { joint: 'weld', mass: 30, tol: 12.5 },
};

/**
 * The meta for a part. `mk` (1..3) toughens a module's joint, `id` picks the module's own table row.
 * A part that is not in either table gets a middling bolt-on, so a new model never has to wait on this file.
 */
export function partMeta(o: { kind: string; id?: string; slot?: string; mk?: number; side?: -1 | 0 | 1; pivot?: [number, number, number] }): PartMeta {
  const row = (o.id && SLOT_PARTS[o.id]) || BODY_PARTS[o.kind] || { joint: 'bolt' as const, mass: 15, tol: 8 };
  const mk = o.mk ?? 1;
  return { slot: o.slot, side: o.side ?? 0, joint: row.joint, mass: row.mass, tol: row.tol * (0.88 + 0.12 * mk), pivot: o.pivot, round: row.round };
}

/** Parts grouped by tag, ranges merged: what the controller works with. */
export interface PartGroup {
  tag: string;
  meta: PartMeta;
  ranges: PartRange[];
}

export function groupParts(ranges: PartRange[] | undefined): PartGroup[] {
  const by = new Map<string, PartGroup>();
  for (const r of ranges ?? []) {
    let g = by.get(r.tag);
    if (!g) by.set(r.tag, (g = { tag: r.tag, meta: r.meta, ranges: [] }));
    g.ranges.push(r);
  }
  return [...by.values()];
}
