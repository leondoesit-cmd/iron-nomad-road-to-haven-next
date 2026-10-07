import * as THREE from 'three';
import { uploadPrefix } from './upload';
import { MeshBuilder, S } from './builder';
import { kitMaterial } from './materials';
import { shared } from './dispose';
import type { AnimalKind } from '../data';
import { PART_BIT } from '../sim/anatomy';

export const MAX_PER_KIND = 40;

/**
 * Wild animals: each species is one instanced body mesh plus one instanced limb mesh (legs, or wings for birds).
 * Legs are separate instances so they can swing from the hip with a plain matrix, no skinning, and a whole herd
 * stays at two draw calls per species. Models face +Z with the feet at y = 0.
 */

interface Model {
  body: THREE.BufferGeometry;
  /** One limb geometry per entry, hanging from (0,0,0): a leg, or a wing reaching along +x / -x. */
  limbs: THREE.BufferGeometry[];
  /** Where each limb instance sits in the body frame, and how it moves. */
  mounts: { x: number; y: number; z: number; limb: number; /** phase offset in radians */ off: number; kind: 'leg' | 'wing' | 'head' | 'stump'; slot?: number; /** Bit of the hidden-part mask that takes this one off. */ bit: number }[];
  /** Length of a leg, for how far a body sags when some are gone. */
  legLen?: number;
  /** Instances of the first limb mesh per animal. */
  per?: number;
  /** Pairs of legs move together (a bounding hare) instead of diagonally. */
  bound?: boolean;
  /** Radians of hip swing at a full run. */
  swing: number;
}

const fur = (c: number, w = 0.4) => S.cloth(c, w);

interface QuadSpec {
  len: number;
  h: number;
  w: number;
  leg: number;
  legR: number;
  /** Shoulder height above the back line (a hump) and its length along the spine. */
  hump?: number;
  neck: [number, number];
  head: [number, number, number];
  snout: number;
  ear: number;
  earSpread: number;
  tail: [number, number, number];
  coat: number;
  belly: number;
  mark?: number;
  bound?: boolean;
  tusks?: boolean;
  horns?: boolean;
  floppy?: boolean;
  /** Long ridged scimitar horns sweeping back over the shoulders, and a beard (an ibex). */
  scimitar?: boolean;
  /** Wide flat horns curving out and back from the poll (a water buffalo). */
  crescent?: boolean;
  /** A camel's hump on the middle of the back, this tall. */
  humpMid?: number;
  /** The neck dips forward and down to this point (ahead of and below its base) before rising to the head. */
  neckMid?: [number, number];
  /** Lower legs in another colour (a fox's black stockings, an ibex's dark shins). */
  shins?: number;
  /** A bushy tail ending in this colour (a fox's white tip). */
  brush?: number;
  seed: number;
}

function quadruped(sp: QuadSpec): Model {
  const b = new MeshBuilder();
  b.jitter = 0.09;
  b.seed(sp.seed);
  const coat = fur(sp.coat);
  const belly = fur(sp.belly, 0.3);
  const mark = fur(sp.mark ?? sp.coat);
  const dark = S.skin(0x1a1412);
  const cy = sp.leg + sp.h * 0.5 - 0.03; // body centre height
  const topY = cy + sp.h * 0.5;
  const fz = sp.len * 0.5;
  // Barrel torso: a stretched ellipsoid with a lighter belly and a rump patch.
  b.add('sphere16', 0, cy, 0, sp.w * 2, sp.h * 1.05, sp.len * 1.05, coat);
  b.add('sphere16', 0, cy - sp.h * 0.2, 0, sp.w * 1.6, sp.h * 0.7, sp.len * 0.8, belly);
  if (sp.mark !== undefined) b.add('sphere16', 0, cy + sp.h * 0.05, -fz * 0.82, sp.w * 1.5, sp.h * 0.8, sp.len * 0.28, mark);
  // Shoulder hump (boar, bear) and a bristle ridge along the spine.
  if (sp.hump) {
    b.add('sphere16', 0, topY - 0.03, fz * 0.38, sp.w * 1.8, sp.h * 0.5 + sp.hump, sp.len * 0.42, coat);
  }
  if (sp.humpMid) {
    b.add('sphere16', 0, topY + sp.humpMid * 0.3, -fz * 0.05, sp.w * 1.55, sp.humpMid * 2.1, sp.len * 0.46, coat);
    b.add('sphere16', 0, topY + sp.humpMid * 0.75, -fz * 0.08, sp.w * 0.9, sp.humpMid * 0.8, sp.len * 0.24, mark);
  }
  // Neck and head: their own mesh, hinged at the base of the neck, so the head can graze, snap up and be shot off.
  const hb = new MeshBuilder();
  hb.jitter = 0.09;
  hb.seed(sp.seed + 3);
  const pivot: [number, number, number] = [0, topY - sp.h * 0.25, fz * 0.62];
  const nx = sp.neck[0];
  const ny = sp.neck[1];
  const hx = 0;
  const hy = topY + ny;
  const hz = fz * 0.9 + nx;
  if (sp.neckMid) {
    // A long neck that hangs forward and comes up again to the head.
    const my = pivot[1] - sp.neckMid[1];
    const mz = pivot[2] + sp.neckMid[0];
    hb.limb(0, pivot[1], pivot[2], 0, my, mz, sp.h * 0.36, sp.h * 0.22, coat, 10);
    hb.limb(0, my, mz, hx, hy - 0.02, hz - 0.06, sp.h * 0.22, sp.head[0] * 0.6, coat, 10);
  } else hb.limb(0, topY - sp.h * 0.25, fz * 0.62, hx, hy - 0.02, hz - 0.04, sp.h * 0.42, sp.head[0] * 0.55, coat, 10);
  hb.add('sphere16', hx, hy, hz, sp.head[0] * 2, sp.head[1] * 2, sp.head[2] * 2, coat);
  // Muzzle, nose, eyes.
  const mz = hz + sp.head[2] * 0.6 + sp.snout * 0.5;
  hb.limb(hx, hy - sp.head[1] * 0.1, hz + sp.head[2] * 0.4, hx, hy - sp.head[1] * 0.25, mz, sp.head[0] * 0.62, sp.head[0] * 0.4, sp.belly === sp.coat ? coat : belly, 8, true);
  hb.sphereAt(hx, hy - sp.head[1] * 0.2, mz + sp.head[0] * 0.25, sp.head[0] * 0.22, dark);
  for (const sx of [1, -1]) hb.sphereAt(sx * sp.head[0] * 0.78, hy + sp.head[1] * 0.25, hz + sp.head[2] * 0.35, sp.head[0] * 0.14, S.glow(0xe8c070, 0.35));
  // Ears.
  for (const sx of [1, -1]) {
    if (sp.floppy) hb.add('sphere', sx * sp.head[0] * 0.95, hy + sp.head[1] * 0.1, hz - sp.head[2] * 0.2, sp.ear * 0.5, sp.ear * 1.1, sp.ear * 0.5, mark, 0, 0, sx * 0.5);
    else hb.add('cone6', sx * sp.earSpread, hy + sp.head[1] * 0.8 + sp.ear * 0.4, hz - sp.head[2] * 0.25, sp.ear * 0.55, sp.ear * 1.2, sp.ear * 0.3, coat, -0.15, 0, sx * -0.25);
  }
  if (sp.tusks) {
    for (const sx of [1, -1]) hb.limb(sx * sp.head[0] * 0.55, hy - sp.head[1] * 0.45, mz - 0.04, sx * sp.head[0] * 0.75, hy + sp.head[1] * 0.1, mz + 0.06, 0.016, 0.006, S.rock(0xe6dcc0), 6, true);
  }
  if (sp.horns) {
    for (const sx of [1, -1]) {
      hb.limb(sx * 0.05, hy + sp.head[1] * 0.8, hz - 0.04, sx * 0.1, hy + sp.head[1] * 0.8 + 0.2, hz - 0.1, 0.018, 0.012, S.rock(0x5a4a3a), 6, true);
      hb.limb(sx * 0.1, hy + sp.head[1] * 0.8 + 0.2, hz - 0.1, sx * 0.07, hy + sp.head[1] * 0.8 + 0.34, hz - 0.03, 0.012, 0.006, S.rock(0x5a4a3a), 6, true);
    }
  }
  if (sp.scimitar) {
    // Ridged horns rising from the brow and arcing back over the neck, and a goat's beard under the chin.
    const horn = S.rock(0x5c4c3a);
    for (const sx of [1, -1]) {
      let px = sx * 0.035;
      let py = hy + sp.head[1] * 0.75;
      let pz = hz - 0.01;
      for (let k = 1; k <= 7; k++) {
        const a = (k / 7) * 2.1;
        const nx = sx * (0.035 + k * 0.009);
        const ny = hy + sp.head[1] * 0.75 + Math.sin(a) * 0.24;
        const nz = hz - 0.01 - (1 - Math.cos(a)) * 0.2;
        const r0 = 0.024 * (1 - (k - 1) / 8);
        hb.limb(px, py, pz, nx, ny, nz, r0, r0 * 0.86, horn, 6, true);
        hb.sphereAt(nx, ny, nz, r0 * 1.12, horn, false);
        px = nx;
        py = ny;
        pz = nz;
      }
    }
    hb.limb(0, hy - sp.head[1] * 0.55, mz - 0.06, 0, hy - sp.head[1] * 1.6, mz - 0.1, 0.018, 0.006, mark, 6, true);
  }
  if (sp.crescent) {
    // Broad, flat, ridged horns: out from the poll, back, and up at the tips.
    const horn = S.rock(0x2e2a26);
    for (const sx of [1, -1]) {
      const pts: [number, number, number][] = [
        [sx * 0.08, hy + sp.head[1] * 0.7, hz - 0.02],
        [sx * 0.26, hy + sp.head[1] * 0.78, hz - 0.08],
        [sx * 0.42, hy + sp.head[1] * 0.7, hz - 0.22],
        [sx * 0.5, hy + sp.head[1] * 0.85, hz - 0.4],
        [sx * 0.47, hy + sp.head[1] * 1.1, hz - 0.52],
      ];
      for (let k = 0; k < pts.length - 1; k++) {
        const r0 = 0.06 * (1 - k / 4.4);
        hb.limb(...pts[k], ...pts[k + 1], r0, r0 * 0.78, horn, 7, true);
      }
    }
  }
  // What shows at the shoulder when the head is gone: raw neck. Its own part, drawn only once the head has come off.
  const sb = new MeshBuilder();
  sb.jitter = 0.06;
  sb.seed(sp.seed + 5);
  sb.sphereAt(0, sp.h * 0.12, sp.h * 0.12, sp.h * 0.34, S.skin(0x5a0c0a));
  // Tail.
  const [tl, tr, tu] = sp.tail;
  if (sp.brush !== undefined) {
    // A full brush: thick to the end, and the end another colour.
    const ex = cy + sp.h * 0.25 + tu;
    const ez = -fz * 0.95 - tl;
    b.limb(0, cy + sp.h * 0.25, -fz * 0.95, 0, ex, ez, tr * 0.7, tr, coat, 8, true);
    b.add('sphere16', 0, ex + (cy + sp.h * 0.25 - ex) * 0.1, ez - tr * 0.4, tr * 1.7, tr * 1.7, tr * 2.6, fur(sp.brush));
  } else b.limb(0, cy + sp.h * 0.25, -fz * 0.95, 0, cy + sp.h * 0.25 + tu, -fz * 0.95 - tl, tr, tr * 0.6, coat, 8, true);
  if (sp.bound) b.sphereAt(0, cy + sp.h * 0.3 + tu, -fz * 0.95 - tl, tr * 1.2, belly);
  // One leg, hanging from the hip: thigh, shin, hoof or paw.
  const lb = new MeshBuilder();
  lb.jitter = 0.07;
  lb.seed(sp.seed + 11);
  const L = sp.leg + 0.03;
  lb.limb(0, 0, 0, 0, -L * 0.5, 0.012, sp.legR * 1.5, sp.legR * 1.05, coat, 8, true);
  lb.limb(0, -L * 0.5, 0.012, 0, -L + sp.legR * 0.8, 0, sp.legR * 1.0, sp.legR * 0.8, sp.shins !== undefined ? fur(sp.shins) : coat, 8, true);
  // A camel's knobbly knees.
  if (sp.humpMid) lb.sphereAt(0, -L * 0.5, 0.02, sp.legR * 1.45, coat);
  lb.rbox(0, -L + sp.legR * 0.55, sp.legR * 0.5, sp.legR * 1.9, sp.legR * 1.2, sp.legR * 3.2, sp.legR * 0.4, sp.tusks || sp.horns ? S.leather(0x241c18, 0.6) : dark);
  const lx = sp.w * 0.62;
  const ly = sp.leg + 0.02;
  const lz = fz * 0.66;
  const hg = hb.build();
  hg.translate(-pivot[0], -pivot[1], -pivot[2]);
  return {
    body: b.build(),
    limbs: [lb.build(), hg, sb.build()],
    mounts: [
      { x: lx, y: ly, z: lz, limb: 0, off: 0, kind: 'leg', bit: PART_BIT.legLF },
      { x: -lx, y: ly, z: lz, limb: 0, off: sp.bound ? 0.5 : Math.PI, kind: 'leg', bit: PART_BIT.legRF },
      { x: lx, y: ly, z: -lz, limb: 0, off: sp.bound ? Math.PI + 0.5 : Math.PI, kind: 'leg', bit: PART_BIT.legLB },
      { x: -lx, y: ly, z: -lz, limb: 0, off: sp.bound ? Math.PI : 0, kind: 'leg', bit: PART_BIT.legRB },
      { x: pivot[0], y: pivot[1], z: pivot[2], limb: 1, off: 0, kind: 'head', bit: PART_BIT.head },
      { x: pivot[0], y: pivot[1], z: pivot[2], limb: 2, off: 0, kind: 'stump', bit: PART_BIT.head },
    ],
    legLen: L,
    bound: sp.bound,
    swing: sp.bound ? 0.9 : 0.7,
  };
}

function vulture(): Model {
  const b = new MeshBuilder();
  b.jitter = 0.08;
  b.seed(401);
  const dark = fur(0x2b2622, 0.5);
  const ruff = fur(0xd8d0c0, 0.4);
  const skin = S.skin(0xb06a5a);
  b.add('sphere16', 0, 0, 0, 0.34, 0.3, 0.7, dark);
  b.limb(0, 0.04, 0.22, 0, 0.12, 0.42, 0.06, 0.04, skin, 8, true);
  b.add('sphere16', 0, 0.14, 0.45, 0.13, 0.13, 0.17, skin);
  b.add('cone6', 0, 0.11, 0.56, 0.05, 0.12, 0.05, S.rock(0x6a5c48), Math.PI / 2 + 0.3, 0, 0);
  b.add('sphere16', 0, 0.06, 0.34, 0.2, 0.1, 0.12, ruff);
  b.add('box', 0, -0.02, -0.46, 0.26, 0.02, 0.32, dark);
  for (const sx of [1, -1]) b.limb(sx * 0.07, -0.1, -0.05, sx * 0.07, -0.26, 0.0, 0.015, 0.012, skin, 6, true);
  const wing = (sign: number, seed: number) => {
    const w = new MeshBuilder();
    w.jitter = 0.08;
    w.seed(seed);
    // A shoulder, a forearm and a fan of long primaries trailing behind.
    w.limb(0, 0, 0.05, sign * 0.55, 0.04, 0.02, 0.05, 0.035, dark, 6, true);
    w.add('box', sign * 0.5, 0.0, -0.1, 1.0, 0.014, 0.34, dark);
    for (let i = 0; i < 5; i++) {
      const x = sign * (0.95 + i * 0.12);
      w.add('box', x, 0.0, -0.1 - i * 0.03, 0.2, 0.012, 0.3 - i * 0.03, dark);
    }
    w.add('box', sign * 0.4, 0.0, 0.1, 0.8, 0.012, 0.12, ruff);
    return w.build();
  };
  return {
    body: b.build(),
    limbs: [wing(1, 402), wing(-1, 403)],
    mounts: [
      { x: 0.12, y: 0.06, z: 0.05, limb: 0, off: 0, kind: 'wing', bit: PART_BIT.wingL },
      { x: -0.12, y: 0.06, z: 0.05, limb: 1, off: 0, kind: 'wing', bit: PART_BIT.wingR },
    ],
    swing: 0,
  };
}

/**
 * A bird's wing reaching along +x (or -x), hinged at the shoulder: an arm, a blade of coverts, and primaries fanned at the
 * tip. `tip` colours the flight feathers (a stork's black), `bar` a band across the coverts (a mallard's blue speculum).
 */
function birdWing(sign: number, span: number, chord: number, col: number, tip: number, seed: number, bar?: number): THREE.BufferGeometry {
  const w = new MeshBuilder();
  w.jitter = 0.06;
  w.seed(seed);
  const c = fur(col, 0.4);
  const t = fur(tip, 0.4);
  w.limb(0, 0, 0.02, sign * span * 0.45, 0.01, 0.0, chord * 0.14, chord * 0.1, c, 6, true);
  w.add('box', sign * span * 0.33, 0, -chord * 0.22, span * 0.66, 0.012, chord * 0.75, c);
  if (bar !== undefined) w.add('box', sign * span * 0.36, 0.004, -chord * 0.42, span * 0.36, 0.012, chord * 0.18, fur(bar, 0.25));
  // The trailing edge and the fingers.
  w.add('box', sign * span * 0.4, -0.002, -chord * 0.58, span * 0.7, 0.01, chord * 0.22, t);
  for (let i = 0; i < 5; i++) {
    const x = sign * (span * 0.66 + i * span * 0.075);
    w.add('box', x, 0, -chord * (0.2 + i * 0.05), span * 0.13, 0.01, chord * (0.72 - i * 0.08), t, 0, sign * i * 0.08, 0);
  }
  return w.build();
}

interface WaderSpec {
  /** Body half-width, depth and length. */
  w: number;
  h: number;
  len: number;
  leg: number;
  /** Points of the neck from its base (relative to the shoulder pivot), the last one under the head. */
  neck: [number, number, number][];
  head: number;
  bill: number;
  billCol: number;
  legCol: number;
  back: number;
  under: number;
  neckCol: number;
  wingTip: number;
  span: number;
  chord: number;
  /** A dark plume off the back of the head (a heron). */
  crest?: number;
  seed: number;
}

/** A heron or a stork: a slim body high on two long bare legs, an S of a neck, a dagger of a bill, broad wings folded. */
function wader(sp: WaderSpec): Model {
  const b = new MeshBuilder();
  b.jitter = 0.07;
  b.seed(sp.seed);
  const back = fur(sp.back);
  const under = fur(sp.under, 0.3);
  const cy = sp.leg + sp.h * 0.5;
  b.add('sphere16', 0, cy, 0, sp.w * 2, sp.h, sp.len, back);
  b.add('sphere16', 0, cy - sp.h * 0.18, sp.len * 0.08, sp.w * 1.7, sp.h * 0.7, sp.len * 0.75, under);
  // Tail feathers, and the breast plumes hanging over the legs.
  b.add('box', 0, cy + sp.h * 0.05, -sp.len * 0.52, sp.w * 1.4, 0.015, sp.len * 0.3, fur(sp.wingTip), -0.25, 0, 0);
  b.add('cone6', 0, cy - sp.h * 0.25, sp.len * 0.36, sp.w * 1.1, sp.h * 0.7, sp.w * 0.8, under, Math.PI, 0, 0);
  // Neck and head, hinged at the shoulder so it can coil, stretch and stab.
  const hb = new MeshBuilder();
  hb.jitter = 0.05;
  hb.seed(sp.seed + 3);
  const pivot: [number, number, number] = [0, cy + sp.h * 0.25, sp.len * 0.38];
  const nc = fur(sp.neckCol, 0.3);
  const pts = sp.neck;
  for (let k = 0; k < pts.length - 1; k++) {
    const r0 = sp.w * (0.55 - k * 0.07);
    hb.limb(...pts[k], ...pts[k + 1], r0, r0 * 0.85, nc, 8, true);
  }
  const [hx, hy, hz] = pts[pts.length - 1];
  hb.add('sphere16', hx, hy, hz + sp.head * 0.3, sp.head * 1.6, sp.head * 1.7, sp.head * 2.4, nc);
  hb.add('cone6', hx, hy - sp.head * 0.1, hz + sp.head * 1.2 + sp.bill * 0.5, sp.head * 0.55, sp.bill, sp.head * 0.45, S.skin(sp.billCol), Math.PI / 2, 0, 0);
  for (const sx of [1, -1]) hb.sphereAt(sx * sp.head * 0.55, hy + sp.head * 0.2, hz + sp.head * 0.75, sp.head * 0.16, S.glow(0xe8d070, 0.3));
  if (sp.crest !== undefined) hb.limb(hx, hy + sp.head * 0.4, hz, hx, hy + sp.head * 0.2, hz - sp.head * 4, sp.head * 0.18, sp.head * 0.04, fur(sp.crest), 5, true);
  const hg = hb.build();
  hg.translate(-pivot[0], -pivot[1], -pivot[2]);
  const sb = new MeshBuilder();
  sb.sphereAt(0, 0.02, 0.02, sp.w * 0.5, S.skin(0x5a0c0a));
  // A leg: thigh feathered into the body, then the long bare shank, the backward-bent ankle and splayed toes.
  const lb = new MeshBuilder();
  lb.jitter = 0.05;
  lb.seed(sp.seed + 11);
  const legc = S.skin(sp.legCol);
  const L = sp.leg + sp.h * 0.15;
  lb.limb(0, 0, 0, 0, -L * 0.5, -0.03, 0.018, 0.012, legc, 6, true);
  lb.limb(0, -L * 0.5, -0.03, 0, -L + 0.01, 0.0, 0.012, 0.01, legc, 6, true);
  for (const a of [-0.5, 0, 0.5]) lb.rod(0, -L + 0.008, 0, Math.sin(a) * 0.09, -L + 0.004, Math.cos(a) * 0.09, 0.006, legc, 4);
  lb.rod(0, -L + 0.008, 0, 0, -L + 0.004, -0.05, 0.005, legc, 4);
  return {
    body: b.build(),
    limbs: [lb.build(), hg, sb.build(), birdWing(1, sp.span, sp.chord, sp.back, sp.wingTip, sp.seed + 21), birdWing(-1, sp.span, sp.chord, sp.back, sp.wingTip, sp.seed + 22)],
    mounts: [
      { x: sp.w * 0.45, y: L, z: 0, limb: 0, off: 0, kind: 'leg', bit: PART_BIT.legLF },
      { x: -sp.w * 0.45, y: L, z: 0, limb: 0, off: Math.PI, kind: 'leg', bit: PART_BIT.legRF },
      { x: pivot[0], y: pivot[1], z: pivot[2], limb: 1, off: 0, kind: 'head', bit: PART_BIT.head },
      { x: pivot[0], y: pivot[1], z: pivot[2], limb: 2, off: 0, kind: 'stump', bit: PART_BIT.head },
      { x: sp.w * 0.8, y: cy + sp.h * 0.3, z: sp.len * 0.12, limb: 3, off: 0, kind: 'wing', bit: PART_BIT.wingL },
      { x: -sp.w * 0.8, y: cy + sp.h * 0.3, z: sp.len * 0.12, limb: 4, off: 0, kind: 'wing', bit: PART_BIT.wingR },
    ],
    legLen: L,
    swing: 0.55,
  };
}

/** A mallard drake riding the water: the waterline is y = 0, the green head on a short neck, the wings folded on its back. */
function duck(): Model {
  const b = new MeshBuilder();
  b.jitter = 0.06;
  b.seed(501);
  const grey = fur(0x9a968c);
  const breast = fur(0x6a3e2a);
  b.add('sphere16', 0, 0.07, 0, 0.21, 0.15, 0.42, grey);
  b.add('sphere16', 0, 0.09, 0.13, 0.19, 0.15, 0.18, breast);
  b.add('sphere16', 0, 0.1, -0.15, 0.16, 0.13, 0.16, fur(0x2a2a2a));
  // The drake's curl over a white tail.
  b.add('box', 0, 0.11, -0.24, 0.1, 0.02, 0.09, fur(0xe0ddd2), -0.3, 0, 0);
  b.limb(0, 0.15, -0.2, 0, 0.2, -0.22, 0.012, 0.008, fur(0x1a1a1a), 5, true);
  const hb = new MeshBuilder();
  hb.jitter = 0.05;
  hb.seed(503);
  const pivot: [number, number, number] = [0, 0.13, 0.15];
  const green = { c: 0x1c4a2a, r: 0.35, m: 0, w: 0.2 };
  hb.limb(0, 0.13, 0.15, 0, 0.24, 0.2, 0.045, 0.04, green, 8, true);
  hb.add('sphere16', 0, 0.26, 0.21, 0.09, 0.09, 0.11, green);
  hb.add('box', 0, 0.245, 0.29, 0.045, 0.016, 0.08, S.skin(0xd8b030));
  hb.add('box', 0, 0.162, 0.17, 0.095, 0.012, 0.07, fur(0xf0eee6));
  for (const sx of [1, -1]) hb.sphereAt(sx * 0.038, 0.27, 0.24, 0.008, S.glow(0x201810, 0.1));
  const hg = hb.build();
  hg.translate(-pivot[0], -pivot[1], -pivot[2]);
  const sb = new MeshBuilder();
  sb.sphereAt(0, 0.02, 0.02, 0.05, S.skin(0x5a0c0a));
  return {
    body: b.build(),
    limbs: [hg, sb.build(), birdWing(1, 0.42, 0.22, 0x7a6e60, 0x4a443c, 505, 0x2a46a8), birdWing(-1, 0.42, 0.22, 0x7a6e60, 0x4a443c, 506, 0x2a46a8)],
    mounts: [
      { x: pivot[0], y: pivot[1], z: pivot[2], limb: 0, off: 0, kind: 'head', bit: PART_BIT.head },
      { x: pivot[0], y: pivot[1], z: pivot[2], limb: 1, off: 0, kind: 'stump', bit: PART_BIT.head },
      { x: 0.07, y: 0.13, z: 0.02, limb: 2, off: 0, kind: 'wing', bit: PART_BIT.wingL },
      { x: -0.07, y: 0.13, z: 0.02, limb: 3, off: 0, kind: 'wing', bit: PART_BIT.wingR },
    ],
    swing: 0,
  };
}

/** A hooded crow: grey body, black head, wings and tail, on two short black legs it hops about on. */
function crow(): Model {
  const b = new MeshBuilder();
  b.jitter = 0.06;
  b.seed(601);
  const grey = fur(0x8e8e8a);
  const black = fur(0x1a1a1c, 0.25);
  b.add('sphere16', 0, 0.17, 0, 0.13, 0.12, 0.3, grey);
  b.add('box', 0, 0.18, -0.2, 0.08, 0.015, 0.16, black, -0.15, 0, 0);
  const hb = new MeshBuilder();
  hb.jitter = 0.04;
  hb.seed(603);
  const pivot: [number, number, number] = [0, 0.2, 0.1];
  hb.limb(0, 0.2, 0.1, 0, 0.25, 0.15, 0.045, 0.04, black, 8, true);
  hb.add('sphere16', 0, 0.26, 0.17, 0.08, 0.08, 0.09, black);
  hb.add('cone6', 0, 0.25, 0.235, 0.03, 0.07, 0.025, black, Math.PI / 2, 0, 0);
  for (const sx of [1, -1]) hb.sphereAt(sx * 0.03, 0.272, 0.19, 0.007, S.glow(0x302010, 0.1));
  const hg = hb.build();
  hg.translate(-pivot[0], -pivot[1], -pivot[2]);
  const sb = new MeshBuilder();
  sb.sphereAt(0, 0.02, 0.02, 0.04, S.skin(0x5a0c0a));
  const lb = new MeshBuilder();
  lb.limb(0, 0, 0, 0, -0.11, 0.01, 0.009, 0.006, black, 5, true);
  for (const a of [-0.45, 0, 0.45]) lb.rod(0, -0.11, 0.01, Math.sin(a) * 0.04, -0.112, 0.01 + Math.cos(a) * 0.04, 0.004, black, 4);
  return {
    body: b.build(),
    limbs: [lb.build(), hg, sb.build(), birdWing(1, 0.45, 0.2, 0x1a1a1c, 0x101012, 605), birdWing(-1, 0.45, 0.2, 0x1a1a1c, 0x101012, 606)],
    mounts: [
      { x: 0.035, y: 0.11, z: 0, limb: 0, off: 0, kind: 'leg', bit: PART_BIT.legLF },
      { x: -0.035, y: 0.11, z: 0, limb: 0, off: 0.4, kind: 'leg', bit: PART_BIT.legRF },
      { x: pivot[0], y: pivot[1], z: pivot[2], limb: 1, off: 0, kind: 'head', bit: PART_BIT.head },
      { x: pivot[0], y: pivot[1], z: pivot[2], limb: 2, off: 0, kind: 'stump', bit: PART_BIT.head },
      { x: 0.05, y: 0.21, z: 0.03, limb: 3, off: 0, kind: 'wing', bit: PART_BIT.wingL },
      { x: -0.05, y: 0.21, z: 0.03, limb: 4, off: 0, kind: 'wing', bit: PART_BIT.wingR },
    ],
    legLen: 0.11,
    swing: 0.5,
  };
}

/** Everything the renderer needs per species, built on first use. */
const RAW: Record<AnimalKind, () => Model> = {
  hare: () =>
    quadruped({ len: 0.4, h: 0.2, w: 0.1, leg: 0.17, legR: 0.03, neck: [0.04, 0.08], head: [0.05, 0.055, 0.07], snout: 0.05, ear: 0.2, earSpread: 0.04, tail: [0.07, 0.04, 0.02], coat: 0x9a8460, belly: 0xd8ccb0, mark: 0xb89a6a, bound: true, seed: 101 }),
  deer: () =>
    quadruped({ len: 0.95, h: 0.4, w: 0.15, leg: 0.8, legR: 0.04, neck: [0.28, 0.4], head: [0.09, 0.1, 0.18], snout: 0.16, ear: 0.17, earSpread: 0.1, tail: [0.12, 0.04, 0.0], coat: 0xa87e50, belly: 0xe2d4b6, mark: 0xece2cc, horns: true, seed: 102 }),
  dog: () =>
    quadruped({ len: 0.68, h: 0.26, w: 0.1, leg: 0.42, legR: 0.04, neck: [0.14, 0.14], head: [0.085, 0.09, 0.15], snout: 0.16, ear: 0.13, earSpread: 0.06, tail: [0.3, 0.025, 0.16], coat: 0x6a5846, belly: 0x948468, mark: 0x3e342c, seed: 103 }),
  wolf: () =>
    quadruped({ len: 0.78, h: 0.3, w: 0.12, leg: 0.5, legR: 0.045, neck: [0.17, 0.12], head: [0.095, 0.1, 0.17], snout: 0.19, ear: 0.13, earSpread: 0.07, tail: [0.36, 0.035, -0.04], coat: 0x6e7174, belly: 0xa8a49a, mark: 0x3a3c40, seed: 104 }),
  boar: () =>
    quadruped({ len: 1.0, h: 0.5, w: 0.22, leg: 0.36, legR: 0.045, hump: 0.12, neck: [0.14, 0.0], head: [0.15, 0.15, 0.2], snout: 0.17, ear: 0.12, earSpread: 0.12, tail: [0.12, 0.02, 0.02], coat: 0x54443a, belly: 0x6e5c4c, mark: 0x3a2f28, tusks: true, seed: 105 }),
  bear: () =>
    quadruped({ len: 1.45, h: 0.8, w: 0.36, leg: 0.62, legR: 0.1, hump: 0.2, neck: [0.2, -0.04], head: [0.2, 0.19, 0.27], snout: 0.18, ear: 0.1, earSpread: 0.17, tail: [0.06, 0.05, 0.0], coat: 0x4c443e, belly: 0x5e554c, mark: 0x7a7066, floppy: true, seed: 106 }),
  vulture,
  ibex: () =>
    quadruped({ len: 0.85, h: 0.36, w: 0.14, leg: 0.6, legR: 0.038, neck: [0.18, 0.26], head: [0.08, 0.085, 0.15], snout: 0.12, ear: 0.1, earSpread: 0.08, tail: [0.08, 0.03, 0.05], coat: 0xa88a64, belly: 0xe4d8c0, mark: 0x5a4632, shins: 0x4a3c30, scimitar: true, seed: 107 }),
  camel: () =>
    quadruped({ len: 1.4, h: 0.62, w: 0.27, leg: 1.1, legR: 0.06, neck: [0.55, 0.42], neckMid: [0.42, -0.05], head: [0.11, 0.11, 0.24], snout: 0.2, ear: 0.07, earSpread: 0.08, tail: [0.42, 0.03, -0.32], coat: 0xb8946a, belly: 0xcaa880, mark: 0xa07c54, humpMid: 0.36, floppy: false, seed: 108 }),
  fox: () =>
    quadruped({ len: 0.48, h: 0.18, w: 0.075, leg: 0.26, legR: 0.024, neck: [0.08, 0.1], head: [0.065, 0.065, 0.1], snout: 0.13, ear: 0.12, earSpread: 0.05, tail: [0.38, 0.055, -0.04], coat: 0xc06a2c, belly: 0xf0e6d8, mark: 0xd27a3a, shins: 0x2a201a, brush: 0xf2eee6, seed: 109 }),
  jackal: () =>
    quadruped({ len: 0.6, h: 0.22, w: 0.09, leg: 0.36, legR: 0.03, neck: [0.12, 0.12], head: [0.075, 0.08, 0.13], snout: 0.14, ear: 0.13, earSpread: 0.055, tail: [0.27, 0.04, -0.1], coat: 0xa88a5e, belly: 0xdccca8, mark: 0x5a4a38, brush: 0x2a221a, seed: 110 }),
  buffalo: () =>
    quadruped({ len: 1.6, h: 0.75, w: 0.4, leg: 0.58, legR: 0.09, hump: 0.06, neck: [0.12, -0.12], head: [0.17, 0.17, 0.27], snout: 0.16, ear: 0.1, earSpread: 0.2, tail: [0.55, 0.03, -0.4], coat: 0x34302e, belly: 0x3e3a37, mark: 0x26221f, crescent: true, floppy: true, seed: 111 }),
  heron: () =>
    wader({
      w: 0.1, h: 0.2, len: 0.45, leg: 0.55,
      neck: [[0, 0, 0], [0, 0.1, 0.07], [0, 0.18, 0.03], [0, 0.27, 0.07], [0, 0.33, 0.12]],
      head: 0.045, bill: 0.15, billCol: 0xd8a830, legCol: 0x6a5a40, back: 0x8a9096, under: 0xc8ccd0, neckCol: 0xd8dcdc, wingTip: 0x2a2c30,
      span: 0.85, chord: 0.38, crest: 0x1a1a1e, seed: 701,
    }),
  stork: () =>
    wader({
      w: 0.11, h: 0.22, len: 0.5, leg: 0.6,
      neck: [[0, 0, 0], [0, 0.12, 0.06], [0, 0.22, 0.08], [0, 0.3, 0.12]],
      head: 0.05, bill: 0.2, billCol: 0xc8361e, legCol: 0xc24a30, back: 0xeeeae2, under: 0xf4f2ec, neckCol: 0xf2f0ea, wingTip: 0x161618,
      span: 0.95, chord: 0.42, seed: 711,
    }),
  egret: () =>
    wader({
      w: 0.07, h: 0.15, len: 0.33, leg: 0.4,
      neck: [[0, 0, 0], [0, 0.08, 0.05], [0, 0.15, 0.02], [0, 0.22, 0.06], [0, 0.26, 0.1]],
      head: 0.032, bill: 0.1, billCol: 0x1a1a1a, legCol: 0x1c1c1c, back: 0xf4f4f0, under: 0xfafaf6, neckCol: 0xf6f6f2, wingTip: 0xeeeeea,
      span: 0.6, chord: 0.28, crest: 0xf0f0ec, seed: 721,
    }),
  duck,
  crow,
};

function finish(m: Model): Model {
  const seen: number[] = [];
  for (const mt of m.mounts) {
    seen[mt.limb] = (seen[mt.limb] ?? 0) + 1;
    mt.slot = seen[mt.limb] - 1;
  }
  m.per = seen[0] ?? 0;
  return m;
}

interface Batch {
  model: Model;
  body: THREE.InstancedMesh;
  limbs: THREE.InstancedMesh[];
  count: number;
}

const _m = new THREE.Matrix4();
const _b = new THREE.Matrix4();
const _l = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _qa = new THREE.Quaternion();

/** What a body is doing besides walking; see `AnimalRenderer.push`. */
export interface AnimalPose {
  mask?: number;
  head?: number;
  look?: number;
  rear?: number;
  fold?: number;
  /** Legs held at this angle instead of walking (a heron in flight trails them behind). */
  legs?: number;
  /** Extra pitch of the whole body, nose down (a dabbling duck up-ends). */
  pitch?: number;
  /** Lying down on its brisket, 0 standing to 1 down (a wounded animal bedded up): legs folded under, body on the ground. */
  lie?: number;
}
const NO_POSE: AnimalPose = {};

export class AnimalRenderer {
  readonly group = new THREE.Group();
  private batches = new Map<AnimalKind, Batch>();

  private batch(kind: AnimalKind): Batch {
    let b = this.batches.get(kind);
    if (b) return b;
    const model = finish(RAW[kind]());
    const winged = kind === 'vulture' || kind === 'heron' || kind === 'stork' || kind === 'duck' || kind === 'crow' || kind === 'egret';
    const mat = kitMaterial({ detail: false, side: winged ? THREE.DoubleSide : THREE.FrontSide });
    const mk = (g: THREE.BufferGeometry, n: number) => {
      shared(g);
      const m = new THREE.InstancedMesh(g, mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      m.setColorAt(0, _c.set(1, 1, 1));
      this.group.add(m);
      return m;
    };
    const perLimb = model.per ?? 1;
    b = { model, body: mk(model.body, MAX_PER_KIND), limbs: model.limbs.map((g) => mk(g, MAX_PER_KIND * perLimb)), count: 0 };
    this.batches.set(kind, b);
    return b;
  }

  begin() {
    for (const b of this.batches.values()) b.count = 0;
  }

  /**
   * One animal. `gait` is 0 standing to 1 flat out, `roll` lays it on its side (dead), `flap` drives the wings,
   * `bank` leans a flier into its turn, and `tint` multiplies the coat. `pose` is everything a living body does besides walk:
   * `mask` the parts that are gone, `head` how far the head is lowered (+) or raised (-), `look` how far it is turned,
   * `rear` how far the front is lifted (a bear on its hind legs), `fold` how far a bird's wings are tucked in.
   */
  push(kind: AnimalKind, scale: number, x: number, y: number, z: number, yaw: number, phase: number, gait: number, roll: number, flap: number, bank: number, tint: number, pose: AnimalPose = NO_POSE) {
    const b = this.batch(kind);
    if (b.count >= MAX_PER_KIND) return;
    const i = b.count++;
    const mdl = b.model;
    const mask = pose.mask ?? 0;
    // Legs gone: the body sags toward the side that is missing them and the legs that are left shorten to meet the ground.
    let gone = 0;
    let front = 0;
    let side = 0;
    if (mdl.legLen) {
      for (const m of mdl.mounts) {
        if (m.kind !== 'leg' || !(mask & m.bit)) continue;
        gone++;
        front += m.z > 0 ? 1 : -1;
        side += m.x > 0 ? 1 : -1;
      }
    }
    const sag = gone >= 3 ? 0.8 : gone === 2 ? 0.42 : gone === 1 ? 0.14 : 0;
    // A hare bounds, a deer stots (all four feet off the ground at once, high and springy), the rest bob.
    const bounce =
      kind === 'hare' || kind === 'crow'
        ? Math.abs(Math.sin(phase)) * (kind === 'crow' ? 0.06 : 0.16) * gait
        : kind === 'deer' || kind === 'ibex'
          ? Math.abs(Math.sin(phase * 0.6)) * (kind === 'ibex' ? 0.22 : 0.3) * gait * gait * scale
          : Math.abs(Math.sin(phase)) * 0.04 * gait * scale;
    const pitch = (kind === 'hare' ? Math.sin(phase) * 0.25 * gait : 0) + front * 0.1 * Math.min(1, gone) - (pose.rear ?? 0) * 0.55 + (pose.pitch ?? 0);
    _e.set(pitch, yaw, roll + bank - side * 0.09 * Math.min(1, gone), 'YXZ');
    _q.setFromEuler(_e);
    const lie = pose.lie ?? 0;
    _p.set(x, y + bounce - (sag + lie * 0.82) * (mdl.legLen ?? 0) * scale + (pose.rear ?? 0) * 0.3 * scale, z);
    _s.set(scale, scale, scale);
    _b.compose(_p, _q, _s);
    b.body.setMatrixAt(i, _b);
    b.body.setColorAt(i, _c.setScalar(tint));
    const per = mdl.per ?? 1;
    for (let k = 0; k < mdl.mounts.length; k++) {
      const m = mdl.mounts[k];
      let ang = 0;
      let sy = 1;
      let sx = 1;
      let yawL = 0;
      const off = (mask & m.bit) !== 0;
      if (m.kind === 'leg') {
        ang = pose.legs !== undefined ? pose.legs : Math.sin(phase + m.off) * mdl.swing * gait * (off ? 0.3 : 1);
        // Bedded: forelegs folded back under the chest, hind legs tucked forward under the belly.
        if (lie > 0) ang = ang * (1 - lie) + lie * (m.z > 0 ? 1.45 : -1.45);
        // A stump hangs short; the legs that are left shorten with the sag.
        sy = off ? 0.26 : (1 - sag * 0.7) * (1 - lie * 0.25);
      } else if (m.kind === 'head') {
        ang = pose.head ?? 0;
        yawL = pose.look ?? 0;
        if (off) sx = sy = 0;
      } else if (m.kind === 'stump') {
        if (!off) sx = sy = 0;
      } else {
        // A wing beats about the body's long axis. Folding raises it, then lays it back along the flank: the blade ends up
        // upright against the side with the primaries reaching past the tail and the trailing edge down.
        const fold = pose.fold ?? 0;
        const side = m.x > 0 ? 1 : -1;
        ang = (Math.sin(flap + m.off) * 0.7 * (1 - fold) + fold * Math.PI * 0.5) * side + side * 0.08 * (1 - fold);
        yawL = -fold * Math.PI * 0.5;
        sx = 1 - fold * 0.5;
        if (off) sx = sy = 0;
      }
      _p.set(m.x, m.y, m.z);
      if (m.kind === 'leg') _e.set(ang, 0, 0);
      else if (m.kind === 'head') _e.set(ang, yawL, 0, 'YXZ');
      else if (m.kind === 'stump') _e.set(0, 0, 0);
      else _e.set(yawL, 0, ang, 'XYZ');
      _qa.setFromEuler(_e);
      _l.compose(_p, _qa, _s.set(sx, sy, sx));
      _m.multiplyMatrices(_b, _l);
      const idx = m.limb === 0 ? i * per + (m.slot ?? 0) : i;
      b.limbs[m.limb].setMatrixAt(idx, _m);
      b.limbs[m.limb].setColorAt(idx, _c.setScalar(tint));
    }
  }

  end() {
    for (const b of this.batches.values()) {
      const per = b.model.per ?? 1;
      b.body.count = b.count;
      uploadPrefix(b.body.instanceMatrix, b.count);
      if (b.body.instanceColor) uploadPrefix(b.body.instanceColor, b.count);
      b.limbs.forEach((l, i) => {
        l.count = b.count * (i === 0 ? per : 1);
        uploadPrefix(l.instanceMatrix, l.count);
        if (l.instanceColor) uploadPrefix(l.instanceColor, l.count);
      });
    }
  }

  dispose() {
    for (const b of this.batches.values()) {
      b.body.dispose();
      b.limbs.forEach((l) => l.dispose());
      b.model.body.dispose();
      b.model.limbs.forEach((g) => g.dispose());
    }
    this.batches.clear();
  }
}
