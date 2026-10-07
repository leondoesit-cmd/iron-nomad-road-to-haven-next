import { MeshBuilder, S } from './builder';
import { bridgePiers, deckLine, FOOTBRIDGE, type DeckPoint } from '../world/mall';

/**
 * Ofer Grand Mall's footbridge (see `world/mall.ts`), in the bridge's own frame: the deck leaves the mall's upper-floor
 * door heading -x, swings round to the south hung from one inclined white mast, and comes down a ramp. Drawn as in the
 * photographs: a pale deck with green glass under it on white ribs, a big cream tube along the outer edge, white hooked
 * posts with wires between them, a fan of cables to the inner edge, and a pink light strip under both edges. It is a
 * landmark prop (drawn whole by the far landscape) and solid as its own mesh, so what you see is what you walk on.
 */

type V3 = [number, number, number];

const WHITE = S.paint(0xf1f0ea, 0.18);
const CREAM = S.paint(0xe2dccb, 0.25);
const DECK = S.concrete(0xd3cfc4, 0.35);
const GREEN = S.glass(0x4c9a78);
const STEEL = S.steel(0xbfc3c6, 0.3);
const LED = S.glow(0xff2fa8, 0.6);

/** Right of the direction of travel (the inside of the curve, the mast's side). */
const inner = (p: DeckPoint): [number, number] => [-p.dz, p.dx];

function edge(p: DeckPoint, off: number, dy = 0): V3 {
  const [ix, iz] = inner(p);
  return [p.x + ix * off, p.y + dy, p.z + iz * off];
}

/** A strip between two offsets from the centre-line, as quads facing `up` (+1) or down (-1). */
function strip(b: MeshBuilder, pts: DeckPoint[], a: number, c: number, dy: number, up: 1 | -1, color: Parameters<MeshBuilder['box']>[6]) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    // `a` is toward the outside, `c` toward the inside: seen from above, outer-near, inner-near, inner-far, outer-far turns anticlockwise.
    const quad: [V3, V3, V3, V3] = [edge(p, a, dy), edge(p, c, dy), edge(q, c, dy), edge(q, a, dy)];
    if (up > 0) b.quad(quad[0], quad[1], quad[2], quad[3], color);
    else b.quad(quad[3], quad[2], quad[1], quad[0], color);
  }
}

/** A vertical face along one edge of the deck, facing out from the centre-line (`side` -1 outer, +1 inner). */
function side(b: MeshBuilder, pts: DeckPoint[], off: number, y0: number, y1: number, facing: 1 | -1, color: Parameters<MeshBuilder['box']>[6]) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const a = edge(p, off, y0);
    const bb = edge(q, off, y0);
    const c = edge(q, off, y1);
    const d = edge(p, off, y1);
    if (facing > 0) b.quad(a, bb, c, d, color);
    else b.quad(bb, a, d, c, color);
  }
}

export function footbridgeModel(): MeshBuilder {
  const B = FOOTBRIDGE;
  const b = new MeshBuilder();
  b.jitter = 0;
  const hw = B.width / 2;
  const fine = deckLine(1);
  // The deck: pale walking surface, white fascias, and under it the green glass between white edges.
  strip(b, fine, -hw, hw, 0, 1, DECK);
  side(b, fine, -hw, -0.16, 0.02, -1, WHITE);
  side(b, fine, hw, -0.16, 0.02, 1, WHITE);
  strip(b, fine, -hw, hw, -0.16, -1, WHITE);
  strip(b, fine, -hw + 0.35, hw - 0.25, -0.34, -1, GREEN);
  // The pink lights along both edges underneath.
  for (const off of [-hw + 0.1, hw - 0.1]) {
    for (let i = 0; i + 1 < fine.length; i += 1) {
      const p = edge(fine[i], off, -0.2);
      const q = edge(fine[i + 1], off, -0.2);
      b.rod(p[0], p[1], p[2], q[0], q[1], q[2], 0.035, LED, 4);
    }
  }
  // The tube along the outer edge, ribs from it across under the glass, every two metres while the deck is high.
  const coarse = deckLine(2).filter((p) => p.y > 1.0);
  const tubeOff = -hw + 0.3;
  for (let i = 0; i + 1 < coarse.length; i++) {
    const p = edge(coarse[i], tubeOff, -0.62);
    const q = edge(coarse[i + 1], tubeOff, -0.62);
    b.rod(p[0], p[1], p[2], q[0], q[1], q[2], 0.42, CREAM, 12);
    if (i > 0 && coarse[i].part === 1) b.sphereAt(p[0], p[1], p[2], 0.42, CREAM, false);
    const r0 = edge(coarse[i], tubeOff + 0.2, -0.45);
    const r1 = edge(coarse[i], hw - 0.12, -0.2);
    b.rod(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], 0.07, WHITE, 6);
  }
  const last = coarse[coarse.length - 1];
  const end = edge(last, tubeOff, -0.62);
  b.sphereAt(end[0], end[1], end[2], 0.42, CREAM, false);
  // Railings: white posts every two metres, hooked out at the top, a handrail, and wires between the posts.
  const posts = deckLine(2);
  for (const s of [-1, 1] as const) {
    const off = s * (hw - 0.1);
    const tops: V3[] = [];
    for (let i = 0; i < posts.length; i++) {
      const p = posts[i];
      if (p.s < 0.3) continue;
      const foot = edge(p, off, 0);
      const top = edge(p, off, 1.15);
      const hook = edge(p, off + s * 0.22, 1.32);
      b.rod(foot[0], foot[1], foot[2], top[0], top[1], top[2], 0.035, WHITE, 6);
      b.rod(top[0], top[1], top[2], hook[0], hook[1], hook[2], 0.03, WHITE, 6);
      tops.push(top);
      if (tops.length < 2) continue;
      const prev = posts[i - 1];
      const a = tops[tops.length - 2];
      b.rod(a[0], a[1], a[2], top[0], top[1], top[2], 0.035, WHITE, 6);
      for (const h of [0.22, 0.45, 0.68, 0.91]) {
        const w0 = edge(prev, off, h);
        const w1 = edge(p, off, h);
        b.rod(w0[0], w0[1], w0[2], w1[0], w1[1], w1[2], 0.009, STEEL, 4);
      }
    }
  }
  // The mast: a tapered white spike leaning away from the curve, with a kink two-thirds of the way up.
  const m = B.mast;
  const kink: V3 = [m.x + (m.topX - m.x) * 0.62, m.topY * 0.62, m.z + (m.topZ - m.z) * 0.62];
  b.box(m.x, 0.3, m.z, 2.4, 0.6, 2.4, S.concrete(0xb8b2a6, 0.6));
  b.limb(m.x, 0, m.z, kink[0], kink[1], kink[2], 0.62, 0.42, WHITE, 12);
  b.limb(kink[0], kink[1], kink[2], m.topX, m.topY, m.topZ, 0.42, 0.06, WHITE, 12, true);
  // The cables: from the upper mast down to the inner edge of the deck, every three metres round the curve.
  const along = deckLine(3).filter((p) => p.s > B.straight - 13 && p.s < B.straight + (Math.PI / 2) * B.radius + 15);
  along.forEach((p, i) => {
    const t = 0.7 + (i / Math.max(1, along.length - 1)) * 0.26;
    const top: V3 = [m.x + (m.topX - m.x) * t, m.topY * t, m.z + (m.topZ - m.z) * t];
    const foot = edge(p, hw + 0.08, -0.05);
    b.rod(top[0], top[1], top[2], foot[0], foot[1], foot[2], 0.028, STEEL, 4);
  });
  // The piers, and a concrete apron at the foot of the ramp.
  for (const q of bridgePiers()) {
    b.rod(q.x, 0, q.z, q.x, q.top, q.z, 0.3, CREAM, 10);
    b.box(q.x, 0.15, q.z, 1.1, 0.3, 1.1, S.concrete(0xb8b2a6, 0.6));
  }
  const foot = posts[posts.length - 1];
  b.box(foot.x, 0.04, foot.z - 1.2, B.width + 1.2, 0.08, 2.6, S.concrete(0xc4beb0, 0.5));
  return b;
}

/**
 * What the bridge collides as, in the same frame: the deck as a slab, each railing as a solid wall to handrail height,
 * the mast and the piers. The cables, ribs and lights are out of reach and stay scenery, which keeps the mesh small.
 */
export function footbridgeCollider(): MeshBuilder {
  const B = FOOTBRIDGE;
  const b = new MeshBuilder();
  b.jitter = 0;
  const hw = B.width / 2;
  const line = deckLine(2);
  strip(b, line, -hw, hw, 0, 1, DECK);
  strip(b, line, -hw, hw, -0.16, -1, DECK);
  side(b, line, -hw, -0.16, 0, -1, DECK);
  side(b, line, hw, -0.16, 0, 1, DECK);
  const rails = line.filter((p) => p.s >= 0.3);
  for (const off of [-(hw - 0.1), hw - 0.1]) {
    side(b, rails, off, 0, 1.15, -1, DECK);
    side(b, rails, off, 0, 1.15, 1, DECK);
  }
  // The tube under the outer edge, as a box section: it is what a tall vehicle would meet.
  const high = line.filter((p) => p.y > 1.0);
  side(b, high, -hw + 0.3, -1.04, -0.16, -1, DECK);
  strip(b, high, -hw - 0.12, -hw + 0.72, -1.04, -1, DECK);
  const m = B.mast;
  b.rod(m.x, 0, m.z, m.topX, m.topY, m.topZ, 0.5, WHITE, 6);
  for (const q of bridgePiers()) b.rod(q.x, 0, q.z, q.x, q.top, q.z, 0.3, CREAM, 6);
  return b;
}
