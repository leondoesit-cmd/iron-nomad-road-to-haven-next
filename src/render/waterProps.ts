import { MeshBuilder, S } from './builder';
import type { PropKind } from '../world/layout';
import { readBridgeTag } from '../world/hydro';

/**
 * Built things that go with the open world's running water. Local frame as for every prop: the road surface at y = 0, +Z
 * along the road, metres. Drawn by the far landscape for the whole map, so a bridge shows down the road from afar.
 */

export const WATER_KINDS = new Set<PropKind>(['bridge']);

/**
 * Where a road crosses a river or stream: the road runs over a causeway and the water passes under it through culverts. The
 * bridge is what you see of that: a concrete headwall on each face of the causeway, running down to the river bed with the
 * culvert mouths in it, a parapet along the top, and wing walls into the banks. `tag` packs the span along the road, how far
 * the bed lies under the road and the road's half-width (`bridgeTag` in `world/hydro.ts`).
 */
export function bridge(seed: number, tag: number): MeshBuilder {
  const { span, drop, half } = readBridgeTag(tag);
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.03;
  const conc = S.concrete(0xa49e92, 0.62);
  const light = S.concrete(0xbcb6aa, 0.5);
  const dark = S.concrete(0x16140f, 0.2);
  const stain = S.concrete(0x6e6a5e, 0.75);
  const rail = S.steel(0x6a6e70, 0.7);
  // The causeway keeps the road's height to 3.0 m past its edge and is down to the channel by 4.4 m (`courseCut` in
  // world/hydro.ts). The headwall fills that slope and stands a metre clear of its foot, so the terrain mesh, whose 2 m cells
  // smear the slope outward, never laps over the culvert mouths.
  const inner = half + 2.8;
  const outer = half + 5.4;
  const W = (inner + outer) / 2;
  const bed = -drop - 0.4;
  const n = Math.max(1, Math.round(span / 5.5));
  const bay = span / n;
  const archW = bay * 0.72;
  const archH = Math.max(1.1, Math.min(drop - 0.4, 3.6));
  for (const s of [-1, 1]) {
    // Headwall: a solid block of concrete from the road's shoulder to the river bed.
    b.box(s * W, (0.15 + bed) / 2, 0, outer - inner, 0.15 - bed, span, conc);
    // A darker tide band where the water has stood against it.
    b.box(s * (outer + 0.01), bed + (drop - archH * 0.4) / 2 + 0.2, 0, 0.02, drop - archH * 0.4, span - 0.2, stain);
    // Culvert mouths: dark openings with a lintel over each.
    for (let k = 0; k < n; k++) {
      const zc = -span / 2 + (k + 0.5) * bay;
      b.box(s * (outer + 0.03), bed + archH / 2 + 0.3, zc, 0.04, archH, archW, dark);
      b.box(s * (outer + 0.03), bed + archH + 0.3 + 0.18, zc, 0.04, 0.36, archW * 0.7, dark);
      b.box(s * (outer + 0.07), bed + archH + 0.75, zc, 0.1, 0.3, archW + 0.5, light);
    }
    // Parapet and coping along the outer edge of the top, the length of the headwall.
    b.box(s * (outer - 0.2), 0.6, 0, 0.36, 0.9, span, conc);
    b.box(s * (outer - 0.2), 1.09, 0, 0.46, 0.08, span + 0.2, light);
    // A guard rail on posts at the edge of the road, running on a little past the water.
    for (let z = -span / 2 - 3; z <= span / 2 + 3.01; z += 2.5) b.box(s * (half + 0.9), 0.38, z, 0.1, 0.76, 0.1, rail);
    b.box(s * (half + 0.95), 0.62, 0, 0.04, 0.26, span + 6, rail);
    // Wing walls from the ends of the headwall, splayed back into the banks.
    for (const e of [-1, 1]) {
      const len = 5;
      const a = 0.45;
      const h = Math.max(1.2, drop * 0.85);
      b.box(s * (outer - 0.3 + Math.sin(a) * len * 0.5), 0.15 - h / 2, e * (span / 2 - 0.3 + Math.cos(a) * len * 0.5), 0.6, h, len, conc, 0, s * e * a, 0);
    }
  }
  // Kerb stones at the parapet ends.
  for (const s of [-1, 1]) for (const e of [-1, 1]) b.box(s * (outer - 0.2), 0.75, e * (span / 2 + 0.3), 0.6, 1.2, 0.6, light);
  b.groundShade(-0.5, 0.6, 0.3);
  return b;
}

export function buildWaterLandmark(kind: PropKind, seed: number, tag: number): MeshBuilder | null {
  switch (kind) {
    case 'bridge':
      return bridge(seed, tag);
    default:
      return null;
  }
}
