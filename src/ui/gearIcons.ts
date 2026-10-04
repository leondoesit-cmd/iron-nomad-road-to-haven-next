import { WEAR_SLOTS, gearDef, hasGear, hexColor, type AttachSlot, type GearDef, type GunModel, type WearSlot } from '../data/gear';
import { identityOf } from '../render/outfit';
import type { Loadout } from '../sim/gear';

/**
 * Flat SVG pictures of everything a survivor can carry, and a paper doll that wears the worn ones. All drawn here, in code, in
 * one 48 x 48 box per item, so a new entry in `gear.json` only needs a `look` or a model name that this file already knows.
 * Strokes use `non-scaling-stroke` (see `.gi` in the stylesheet) so the doll can stretch a garment over a body without
 * fattening its outline.
 */

const INK = '#1b140c';
const SKIN = '#d0a07c';
const SKIN_DK = '#b0825f';
const STEEL = '#8a9096';
const STEEL_DK = '#555a5f';
const WOOD = '#8a6a42';
const WOOD_DK = '#5c4529';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** Mix a #rrggbb toward black (f < 0) or white (f > 0). */
function shade(c: string, f: number): string {
  const n = parseInt(c.slice(1), 16);
  const t = f < 0 ? 0 : 255;
  const k = Math.abs(f);
  const ch = (v: number) => Math.round(v + (t - v) * k);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('')}`;
}

/** A closed shape with the house outline. */
const P = (d: string, fill: string, extra = '') => `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;
/** A line with no fill. */
const L = (d: string, stroke: string, w = 1.4) => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const R = (x: number, y: number, w: number, h: number, fill: string, rx = 1.5) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>`;
const C = (x: number, y: number, r: number, fill: string) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${INK}" stroke-width="1.4"/>`;
const E = (x: number, y: number, rx: number, ry: number, fill: string) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${INK}" stroke-width="1.4"/>`;

const svg = (inner: string, cls = '') => `<svg class="gi ${cls}" viewBox="0 0 48 48" aria-hidden="true">${inner}</svg>`;

/** The colours a worn piece is drawn in: its own, or the survivor's identity colours for the starter kit. */
interface Look {
  style: string;
  c: string;
  c2: string;
}

function lookFor(d: GearDef, index: number): Look {
  const id = identityOf(index);
  const l = d.look;
  const dflt: Record<string, number> = { head: id.helmet, face: id.scarf, body: id.jacket, hands: 0x2b2622, legs: 0x3d3f3a, feet: 0x2a211b, back: 0x4a4636 };
  const slot = d.slot ?? 'body';
  const base = l?.tint ? dflt[slot] : hexColor(l?.c, dflt[slot]);
  // Starter jacket trims in the survivor's trim colour, like the model.
  const second = l?.c2 ? hexColor(l.c2, 0x555555) : l?.tint && slot === 'body' ? id.trim : undefined;
  const c = hex(base);
  return { style: l?.style ?? 'bare', c, c2: second !== undefined ? hex(second) : shade(c, -0.35) };
}

// ------------------------------------------------------------------------------------------- worn pieces

function head(s: string, c: string, c2: string): string {
  const dk = shade(c, -0.3);
  switch (s) {
    case 'helmet':
      return (
        P('M9 31 C9 13 39 13 39 31Z', c) +
        P('M6 31 H42 V35 H6Z', dk) +
        L('M10 26 C14 20 34 20 38 26', shade(c, 0.3), 1.2) +
        C(19, 22, 3.6, '#2a2a2a') + C(29, 22, 3.6, '#2a2a2a') + C(19, 22, 1.8, '#d8b04a') + C(29, 22, 1.8, '#d8b04a')
      );
    case 'cap':
      return P('M10 31 C10 15 38 15 38 31Z', c) + P('M30 29 Q45 28 45 35 Q36 33 29 34Z', dk) + C(24, 17, 1.8, dk) + L('M24 17 V31', dk, 1);
    case 'hardhat':
      return P('M9 31 C9 11 39 11 39 31Z', c) + P('M21.5 13 H26.5 V31 H21.5Z', shade(c, 0.25)) + P('M5 31 H43 V35.5 H5Z', dk);
    case 'hood':
      return P('M24 6 C37 9 41 26 39 41 H9 C7 26 11 9 24 6Z', c) + P('M24 18 C32 18 33 32 24 38 C15 32 16 18 24 18Z', '#1a1410') + L('M12 38 C13 28 14 16 22 9', shade(c, 0.2), 1.2);
    case 'moto':
      return (
        P('M8 30 C8 11 40 11 40 30 V38 Q40 42 36 42 H12 Q8 42 8 38Z', c) +
        P('M12 23 H36 V32 Q24 35 12 32Z', '#10161c') + L('M15 26 H29', '#5d7587', 1.4) + L('M10 18 C16 14 32 14 38 18', shade(c, 0.3), 1.2)
      );
    case 'riot':
      return (
        P('M9 27 C9 10 39 10 39 27Z', c) + P('M11 25 H37 V37 Q37 41 33 41 H15 Q11 41 11 37Z', 'rgba(120,160,190,0.55)') +
        L('M15 29 H26', 'rgba(255,255,255,0.7)', 1.4) + P('M8 40 H40 V44 H8Z', dk)
      );
    default:
      // Bare head: hair on the crown.
      return P('M13 26 C13 10 35 10 35 26 C30 20 18 20 13 26Z', '#3a2a1c');
  }
}

function face(s: string, c: string, c2: string): string {
  const dk = shade(c, -0.3);
  switch (s) {
    case 'bandana':
      return P('M7 14 Q24 22 41 14 L24 43Z', c) + C(24, 15, 2.2, dk) + C(20, 24, 1, shade(c, 0.35)) + C(28, 24, 1, shade(c, 0.35)) + C(24, 32, 1, shade(c, 0.35));
    case 'goggles':
      return L('M3 24 H45', '#1b140c', 4) + C(15, 24, 8.5, c) + C(33, 24, 8.5, c) + C(15, 24, 5.6, c2) + C(33, 24, 5.6, c2) + L('M11 21 q2 -2 4 -2', 'rgba(255,255,255,0.8)', 1.4) + L('M29 21 q2 -2 4 -2', 'rgba(255,255,255,0.8)', 1.4);
    case 'respirator':
      return P('M10 14 Q24 8 38 14 L35 33 Q24 42 13 33Z', c) + C(12, 31, 5.5, dk) + C(36, 31, 5.5, dk) + L('M9 31 h6 M33 31 h6', shade(dk, 0.35), 1.2) + L('M3 20 H10 M38 20 H45', INK, 2);
    case 'gasmask':
      return (
        P('M9 10 Q24 4 39 10 L39 29 Q35 42 24 44 Q13 42 9 29Z', c) +
        E(16, 21, 5.5, 4.5, '#10161c') + E(32, 21, 5.5, 4.5, '#10161c') + L('M13 19 q2 -2 4 -1', 'rgba(255,255,255,0.7)', 1.2) + L('M29 19 q2 -2 4 -1', 'rgba(255,255,255,0.7)', 1.2) +
        C(24, 35, 6.5, dk) + L('M20 33 h8 M20 35.5 h8 M20 38 h8', shade(dk, 0.4), 1)
      );
    default:
      return '';
  }
}

function body(s: string, c: string, c2: string): string {
  const dk = shade(c, -0.3);
  switch (s) {
    case 'jacket':
      return (
        P('M16 7 L7 11 L3 31 L10 33 L12 21 V43 H36 V21 L38 33 L45 31 L41 11 L32 7 Q24 14 16 7Z', c) +
        P('M16 7 Q24 15 32 7 L29 5 Q24 9 19 5Z', c2) + L('M24 14 V43', dk, 1.4) + R(14, 29, 7, 6, dk, 1) + R(27, 29, 7, 6, dk, 1) + L('M3 31 L10 33', c2, 3)
      );
    case 'vest':
      return (
        P('M15 7 L11 14 V43 H37 V14 L33 7 Q24 15 15 7Z', c) + L('M24 14 V43', dk, 1.2) + R(13, 24, 8, 8, c2, 1) + R(27, 24, 8, 8, c2, 1) + R(13, 34, 8, 6, c2, 1) + R(27, 34, 8, 6, c2, 1) + L('M15 7 L11 14 M33 7 L37 14', dk, 1.2)
      );
    case 'duster':
      return (
        P('M15 6 L6 11 L3 35 L9 37 L11 25 L9 46 H39 L37 25 L39 37 L45 35 L42 11 L33 6 Q24 14 15 6Z', c) +
        L('M24 13 V46', c2, 2) + P('M15 6 Q24 16 33 6 L30 4 Q24 9 18 4Z', c2) + L('M12 36 H20 M28 36 H36', c2, 1.4) + C(24, 24, 1.2, c2) + C(24, 32, 1.2, c2)
      );
    case 'plate':
      return (
        P('M13 7 H35 L39 16 L36 38 Q24 45 12 38 L9 16Z', c) + L('M12 20 H36 M13 29 H35', c2, 1.6) + L('M24 9 V41', c2, 1.4) + R(10, 5, 8, 5, STEEL_DK, 1) + R(30, 5, 8, 5, STEEL_DK, 1)
      );
    case 'riot':
      return (
        P('M13 8 H35 L38 38 Q24 45 10 38Z', c) + E(10, 12, 8, 5.5, c2) + E(38, 12, 8, 5.5, c2) + P('M16 14 H32 V26 Q24 30 16 26Z', shade(c, 0.12)) + R(11, 33, 26, 4, c2, 1) + L('M24 14 V26', dk, 1.2)
      );
    default:
      // The undershirt every bare survivor wears.
      return P('M16 7 L6 13 L10 22 L14 20 V43 H34 V20 L38 22 L42 13 L32 7 Q24 12 16 7Z', '#8a826e') + L('M18 8 Q24 13 30 8', shade('#8a826e', -0.3), 1.2);
  }
}

/** One glove, fingers up, palm facing us. */
function glove(s: string, c: string, c2: string): string {
  const dk = shade(c, -0.3);
  if (s === 'bare') return P('M14 28 H34 V40 Q34 46 28 46 H20 Q14 46 14 40Z', SKIN) + [0, 1, 2, 3].map((i) => R(14.5 + i * 5, 12 + (i === 1 || i === 2 ? -3 : 0), 4.2, 17, SKIN, 2)).join('') + R(31, 24, 5, 12, SKIN, 2.5);
  const fingers = s === 'fingerless' ? 7 : 16;
  const tip = s === 'fingerless' ? SKIN : c;
  return (
    [0, 1, 2, 3].map((i) => R(14.5 + i * 5, 14 + (i === 1 || i === 2 ? -3 : 0) + (16 - fingers), 4.2, fingers + 6, i < 4 ? tip : c, 2)).join('') +
    (s === 'fingerless' ? [0, 1, 2, 3].map((i) => R(14.5 + i * 5, 23 + (i === 1 || i === 2 ? -3 : 0), 4.2, 8, c, 1)).join('') : '') +
    P('M13 28 H35 V40 Q35 46 29 46 H19 Q13 46 13 40Z', c) +
    R(31, 24, 5.5, 12, c, 2.7) +
    R(12, 40, 24, 6, c2 === shade(c, -0.35) ? dk : c2, 1.5) +
    (s === 'padded' ? R(15, 27, 18, 5, shade(c, 0.2), 2) + L('M19 27 V32 M24 27 V32 M29 27 V32', dk, 1) : '') +
    (s === 'tactical' ? R(15, 27, 18, 5, '#2a2b2e', 1.5) + L('M16 36 H34', '#6a6e72', 1.6) : '') +
    (s === 'work' ? L('M17 34 H31', shade(c, 0.25), 1.2) : '')
  );
}

function hands(s: string, c: string, c2: string): string {
  return `<g transform="translate(-1 3) scale(0.62)">${glove(s, c, c2)}</g><g transform="translate(49 3) scale(-0.62 0.62)">${glove(s, c, c2)}</g>`;
}

function legs(s: string, c: string, c2: string): string {
  const dk = shade(c, -0.3);
  const pants = P('M12 5 H36 L38 43 H26 L24 18 L22 43 H10Z', c) + L('M12 9 H36', dk, 1.4) + L('M24 18 V9', dk, 1.2);
  switch (s) {
    case 'cargo':
      return pants + R(11, 21, 8, 9, shade(c, 0.12), 1) + R(29, 21, 8, 9, shade(c, 0.12), 1) + L('M11 24 H19 M29 24 H37', dk, 1);
    case 'padded':
      return pants + E(16, 28, 5, 6.5, c2) + E(32, 28, 5, 6.5, c2) + L('M12 28 H20 M28 28 H36', shade(c2, 0.3), 1);
    case 'greaves':
      return pants + P('M11 30 L21 30 L20 42 H11Z', c2) + P('M27 30 L37 30 L38 42 H28Z', c2) + L('M12 34 H20 M28 34 H36', shade(c2, 0.35), 1);
    case 'bare':
      return P('M14 5 H34 L36 43 H26 L24 20 L22 43 H12Z', SKIN) + L('M24 20 V9', SKIN_DK, 1.2);
    default:
      return pants + L('M16 24 V38 M32 24 V38', dk, 1);
  }
}

function foot(s: string, c: string, c2: string): string {
  const dk = shade(c, -0.35);
  const sole = (col: string) => R(5, 36, 38, 5, col, 2);
  switch (s) {
    case 'sneakers':
      return P('M7 36 V26 Q7 24 10 24 L22 26 Q26 30 34 31 Q43 32 43 36Z', c) + sole(c2) + L('M14 29 L18 31 M18 27 L22 29', c2, 1.4) + L('M7 32 H28', shade(c, 0.3), 1);
    case 'steel':
      return P('M9 8 H25 V27 L36 31 Q43 33 43 38 V40 H9Z', c) + sole(dk) + P('M30 30 Q42 32 43 38 V40 H30Z', c2) + L('M11 14 H23', shade(c, 0.35), 1.2);
    case 'runners':
      return P('M7 36 V24 Q7 22 10 22 L21 24 Q26 29 34 30 Q43 31 43 36Z', c) + sole(c2) + L('M12 31 Q22 28 36 33', c2, 2.2) + L('M13 27 L17 29', c2, 1.4);
    case 'bare':
      return P('M9 28 H25 V34 L36 36 Q43 38 43 40 V41 H9Z', SKIN) + L('M36 36 V41 M39 37 V41', SKIN_DK, 1);
    default:
      return P('M9 8 H25 V27 L36 31 Q43 33 43 38 V40 H9Z', c) + sole(dk) + L('M11 14 H23 M11 19 H23', shade(c, 0.3), 1.2) + L('M25 28 L33 31', dk, 1.2);
  }
}

function back(s: string, c: string, c2: string): string {
  const dk = shade(c, -0.3);
  switch (s) {
    case 'ruck':
      return (
        P('M12 8 Q24 3 36 8 L40 40 Q24 45 8 40Z', c) + P('M13 8 Q24 14 35 8 L36 20 Q24 26 12 20Z', c2) + R(14, 28, 20, 10, dk, 2) + L('M24 24 V30', INK, 1.4) + L('M10 12 L8 40 M38 12 L40 40', shade(c, 0.2), 1.4)
      );
    case 'satchel':
      return (
        L('M6 6 Q24 -2 42 6', INK, 3) + L('M6 6 Q24 -2 42 6', WOOD_DK, 1.6) + P('M9 14 H39 V38 Q24 42 9 38Z', c) + P('M9 14 H39 V25 Q24 30 9 25Z', shade(c, 0.12)) + R(21, 25, 6, 5, STEEL, 1) + L('M12 33 H36', dk, 1)
      );
    case 'duffel':
      return (
        L('M16 15 Q24 4 32 15', INK, 3) + L('M16 15 Q24 4 32 15', c2, 1.6) + P('M5 16 H43 Q46 28 43 38 H5 Q2 28 5 16Z', c) + L('M5 27 H43', c2, 2) + L('M16 16 V38 M32 16 V38', dk, 1.2) + R(21, 24, 6, 5, STEEL, 1)
      );
    case 'frame':
      return (
        L('M12 5 V43 M36 5 V43 M12 12 H36 M12 28 H36', c2, 3) + L('M12 5 V43 M36 5 V43 M12 12 H36 M12 28 H36', INK, 1) + R(10, 29, 28, 11, c, 3) + P('M9 3 H39 V10 H9Z', shade(c, 0.1), '') + L('M15 3 V10 M24 3 V10 M33 3 V10', dk, 1)
      );
    default:
      return '';
  }
}

// ------------------------------------------------------------------------------------------- weapons and tools

function gun(m: string): string {
  const BLK = '#3a3d41';
  switch (m) {
    case 'pistol':
      return P('M7 14 H37 V23 H7Z', STEEL) + R(6, 13, 14, 3, STEEL_DK, 1) + P('M10 23 H21 L17 39 H8Z', WOOD_DK) + P('M20 23 H28 V28 Q24 30 21 28Z', BLK) + L('M36 17 H42', INK, 2) + L('M14 18 H31', shade(STEEL, 0.3), 1);
    case 'revolver':
      return P('M20 15 H43 V21 H20Z', STEEL) + C(17, 19, 7.5, STEEL_DK) + C(17, 19, 2, INK) + C(17, 13, 2, INK) + C(22, 22, 2, INK) + P('M6 15 L10 11 H14 V19 H8Z', STEEL) + P('M6 24 L14 24 L18 38 L8 40 L5 28Z', WOOD) + L('M24 17 H41', shade(STEEL, 0.3), 1);
    case 'smg':
      return P('M7 15 H34 V24 H7Z', STEEL_DK) + R(34, 17, 10, 4, STEEL, 1) + P('M16 24 H22 V41 H15Z', BLK) + P('M26 24 H32 L31 33 H26Z', BLK) + L('M2 17 H7 M2 17 V25 H8', STEEL, 2) + R(10, 12, 14, 3, STEEL, 1) + L('M10 19 H30', shade(STEEL_DK, 0.35), 1);
    case 'sawn':
      return P('M20 14 H45 V19 H20Z', STEEL_DK) + P('M20 19 H45 V24 H20Z', STEEL) + P('M3 21 L20 17 V28 L9 36 Q3 38 3 33Z', WOOD) + R(18, 15, 5, 12, BLK, 1) + L('M24 21 H44', INK, 1);
    case 'pump':
      return P('M16 14 H45 V18 H16Z', STEEL_DK) + P('M16 18 H45 V21 H16Z', STEEL) + P('M26 21 H38 V26 H26Z', WOOD) + P('M3 22 L16 18 V27 L8 38 Q3 40 3 35Z', WOOD) + R(14, 17, 7, 9, STEEL_DK, 1) + L('M3 22 L16 18', WOOD_DK, 1);
    case 'rifle':
      return P('M2 22 L14 18 V27 L7 38 Q2 40 2 35Z', WOOD) + P('M14 17 H44 V21 H14Z', STEEL_DK) + P('M14 21 H30 V26 H14Z', STEEL) + P('M30 21 H44 V23 H30Z', STEEL) + R(18, 11, 14, 5, BLK, 2) + C(19, 13.5, 2.4, '#5d7587') + C(31, 13.5, 2, '#5d7587') + P('M20 26 H25 V35 H21Z', BLK);
    case 'compact':
      return P('M10 16 H34 V23 H10Z', STEEL) + R(9, 15, 11, 3, STEEL_DK, 1) + P('M12 23 H21 L18 37 H11Z', BLK) + P('M21 23 H27 V27 Q24 29 21 27Z', BLK) + L('M34 19 H38', INK, 2) + L('M14 19 H30', shade(STEEL, 0.3), 1);
    case 'cannon':
      return P('M20 13 H44 V21 H20Z', STEEL) + L('M24 17 H42', INK, 1) + C(17, 19, 8.5, STEEL_DK) + C(17, 19, 2.2, INK) + C(17, 12.6, 2.2, INK) + C(23, 22, 2.2, INK) + P('M6 13 L10 9 H14 V19 H8Z', STEEL) + P('M6 25 L14 25 L18 40 L8 42 L5 29Z', WOOD_DK) + L('M26 12 H44', shade(STEEL, 0.3), 1.2);
    case 'mp':
      return P('M7 15 H33 V23 H7Z', STEEL_DK) + R(33, 17, 9, 3, STEEL, 1) + P('M19 23 H25 V44 H18Z', BLK) + P('M8 23 H15 L13 35 H7Z', WOOD_DK) + R(10, 12, 12, 3, STEEL, 1) + L('M10 19 H30', shade(STEEL_DK, 0.35), 1);
    case 'smg2':
      return P('M9 15 H35 V24 H9Z', STEEL_DK) + P('M35 17 H44 V22 H35Z', STEEL) + P('M18 24 H24 V42 H17Z', BLK) + P('M10 24 H16 L14 35 H9Z', BLK) + L('M9 17 H3 V25 H9', STEEL, 1.8) + R(10, 11.5, 22, 3, STEEL, 1) + L('M12 19 H32', shade(STEEL_DK, 0.35), 1);
    case 'carbine':
      return P('M2 22 L12 19 V28 L6 36 Q2 38 2 33Z', WOOD) + P('M12 17 H38 V23 H12Z', STEEL_DK) + P('M24 17.5 H38 V23 H24Z', WOOD) + L('M38 19.5 H46', STEEL, 2) + P('M17 23 H22 Q25 31 21 41 L16 39 Q18 31 17 23Z', BLK) + L('M12 17 H24', shade(STEEL_DK, 0.4), 1.2);
    case 'ar':
      return P('M2 21 L12 19 V27 L5 33 H2Z', BLK) + P('M12 16.5 H33 V23 H12Z', STEEL_DK) + P('M26 17 H40 V22.5 H26Z', STEEL) + L('M40 19.5 H46', INK, 2) + P('M17 23 H22 L24 39 H19Z', BLK) + P('M10 23 H15 L13 31 H9Z', BLK) + L('M12 15 H36', shade(STEEL_DK, 0.4), 1.4);
    case 'br':
      return P('M2 22 L14 18 V28 L7 37 Q2 39 2 34Z', WOOD) + P('M14 16.5 H36 V23.5 H14Z', STEEL_DK) + P('M30 17.5 H40 V22.5 H30Z', WOOD) + L('M40 20 H46', INK, 2) + P('M20 23.5 H26 V40 H20Z', BLK) + L('M14 15.5 H34', shade(STEEL_DK, 0.4), 1.4);
    case 'dmr':
      return P('M2 20 L12 18 V28 L6 33 H2Z', BLK) + P('M12 16.5 H30 V23.5 H12Z', STEEL_DK) + P('M30 17.5 H42 V23 H30Z', STEEL) + L('M42 20.2 H47', INK, 2.4) + P('M17 23.5 H22 V38 H17Z', BLK) + L('M12 15.5 H32', shade(STEEL_DK, 0.4), 1.4);
    case 'sniper':
      return P('M1 21 L12 18 V29 L5 35 H1Z', '#4a5240') + P('M12 17 H32 V24 H12Z', STEEL_DK) + P('M32 18.5 H46 V22.5 H32Z', STEEL) + L('M46 20.5 H47.5', INK, 2.6) + C(21, 15.5, 1.8, STEEL) + L('M21 15.5 H25', INK, 1.4) + P('M18 24 H24 V30 H18Z', BLK) + L('M12 16 H30', shade(STEEL_DK, 0.4), 1.2);
    case 'lever':
      return P('M2 22 L12 19 V28 L6 36 Q2 38 2 33Z', WOOD) + P('M12 17 H28 V24 H12Z', '#9a7a3a') + P('M28 17.5 H46 V21 H28Z', STEEL_DK) + P('M26 21 H44 V24 H26Z', STEEL) + L('M14 24 Q18 34 24 28', INK, 2) + L('M14 24 Q18 33 24 28', '#9a7a3a', 1.2) + P('M26 24 H40 V27 H26Z', WOOD);
    case 'crossbow':
      return R(3, 21, 36, 5, WOOD, 1.5) + L('M36 23 Q41 11 46 7', INK, 3.4) + L('M36 23 Q41 11 46 7', STEEL_DK, 1.8) + L('M36 24 Q41 36 46 40', INK, 3.4) + L('M36 24 Q41 36 46 40', STEEL_DK, 1.8) + L('M46 7 L33 23.5 L46 40', '#e8e0c4', 1) + L('M10 21 H40', STEEL, 2) + P('M8 26 H14 L13 36 H7Z', BLK);
    case 'combat':
      return P('M2 21 L12 18 V29 L5 33 H2Z', BLK) + P('M12 15 H29 V23 H12Z', STEEL_DK) + P('M29 15.5 H46 V18.5 H29Z', STEEL) + P('M29 18.5 H44 V21.5 H29Z', STEEL_DK) + P('M29 21.5 H40 V25 H29Z', BLK) + P('M12 23 H17 L15 32 H11Z', BLK) + L('M12 14 H28', shade(STEEL_DK, 0.4), 1.2);
    case 'coach':
      return P('M3 22 L16 19 V28 L8 37 Q3 38 3 33Z', WOOD) + P('M16 15 H46 V19 H16Z', STEEL_DK) + P('M16 19 H46 V23 H16Z', STEEL) + P('M26 23 H36 V27 H26Z', WOOD) + R(14, 17, 6, 8, BLK, 1) + L('M18 14 L21 12', INK, 2.2);
    case 'lmg':
      return P('M2 20 L12 18 V29 L5 34 H2Z', BLK) + P('M12 14.5 H34 V25 H12Z', STEEL_DK) + P('M34 17 H43 V22 H34Z', STEEL) + L('M43 19.5 H47', INK, 2.4) + R(15, 25, 15, 12, '#4a5236', 2) + L('M18 28 H27 M18 32 H27', '#6a7452', 1) + L('M32 22 L38 33 M34 22 L40 33', STEEL, 1.6) + L('M12 13 H32', shade(STEEL_DK, 0.4), 1.4) + P('M9 25 H13 L12 31 H8Z', BLK);
    default:
      return R(8, 16, 30, 8, STEEL);
  }
}

function melee(m: string): string {
  // Drawn upright, then turned on the diagonal like an item on a table.
  let g = '';
  switch (m) {
    case 'knife':
      g = P('M24 4 Q29 14 27.5 28 H20.5 Q19 14 24 4Z', '#c4c8cc') + L('M24 8 V26', '#8a9096', 1.2) + R(17, 28, 14, 3.5, STEEL_DK, 1) + P('M20.5 31.5 H27.5 L28 44 H20Z', WOOD_DK) + L('M21 36 H27 M21 40 H27', WOOD, 1);
      break;
    case 'bat':
      g = P('M20 3 H28 Q30 10 29 30 L27 42 Q24 45 21 42 L19 30 Q18 10 20 3Z', '#a5835a') + L('M22 8 Q22 20 23 36', shade('#a5835a', 0.3), 1.2) + R(21, 36, 6, 8, '#2a2622', 2) + L('M19 12 L29 12', '#6a5236', 1);
      break;
    case 'machete':
      g = P('M20 3 H30 Q29 16 28 28 H21 Q22 12 20 3Z', '#b8bcc0') + L('M23 8 Q24 18 24 26', '#8a9096', 1.2) + R(19, 28, 12, 3, STEEL_DK, 1) + P('M21 31 H28 L29 44 H21Z', '#2a2622') + L('M22 35 H28 M22 39 H28', '#4a4440', 1);
      break;
    case 'axe':
      g = P('M22 6 H27 L28 44 H21Z', WOOD) + P('M21 7 Q8 6 5 19 Q14 21 21 19Z', '#b8bcc0') + P('M5 19 Q8 6 21 7', 'none') + L('M8 16 Q13 13 20 12', '#e8eaec', 1.2) + R(20, 5, 9, 4, STEEL_DK, 1);
      break;
    case 'pipe':
      g = P('M21 3 H27 V41 H21Z', '#8a9096') + L('M23 6 V38', '#c4c8cc', 1.2) + R(20, 36, 8, 8, '#2a2622', 2) + L('M20 40 H28', '#4a4440', 1) + R(20, 2, 8, 3, STEEL_DK, 1);
      break;
    case 'sledge':
      g = P('M22.5 12 H25.5 V44 H22.5Z', WOOD) + R(10, 3, 28, 12, '#7a7e82', 2) + R(8, 4, 4, 10, '#b8bcc0', 1) + R(36, 4, 4, 10, '#b8bcc0', 1) + L('M14 6 H34', '#b8bcc0', 1.2) + R(21, 38, 6, 6, '#2a2622', 2);
      break;
    case 'katana':
      g = P('M23.5 2 Q28 14 26.5 29 H21 Q21 14 23.5 2Z', '#d4d8dc') + L('M24.5 6 Q25 16 24 27', '#8a9096', 1.2) + R(17, 29, 14, 3, '#3a3224', 1.5) + P('M21 32 H27 L27.5 45 H20.5Z', '#2a2630') + L('M21 35 L27 38 M21 39 L27 42', '#8a2a2a', 1.2);
      break;
    default:
      g = R(21, 6, 6, 36, STEEL);
  }
  return `<g transform="rotate(38 24 24)">${g}</g>`;
}

function tool(t: string): string {
  switch (t) {
    case 'wrench':
      return `<g transform="rotate(-40 24 24)">${P('M20 18 H28 L29 42 Q24 46 19 42Z', STEEL)}${P('M15 4 H21 V11 H27 V4 H33 V13 Q33 19 24 20 Q15 19 15 13Z', STEEL)}${L('M24 24 V38', shade(STEEL, 0.4), 1.2)}</g>`;
    case 'crowbar':
      return `<g transform="rotate(-38 24 24)">${P('M22 10 H26 V42 Q26 46 22 44 Q20 42 22 38Z', '#6a2a22')}${P('M26 10 Q26 2 18 3 Q17 6 22 7 V10Z', '#6a2a22')}${L('M24 14 V36', '#a8453a', 1.2)}${P('M20 40 L26 40 L28 46 L20 46Z', STEEL_DK)}</g>`;
    case 'jerrycan':
      return (
        P('M9 14 H33 L39 21 V41 Q39 44 36 44 H12 Q9 44 9 41Z', '#c83a28') +
        P('M13 8 H27 V14 H13Z', '#a62c1e') + R(30, 8, 6, 6, STEEL, 1) + L('M14 24 L34 40 M34 24 L14 40', '#8f2418', 2) + L('M12 18 H30', '#e8685a', 1.2) + R(13, 5, 14, 3, STEEL_DK, 1)
      );
    default:
      return R(10, 10, 28, 28, STEEL);
  }
}

// ------------------------------------------------------------------------------------------- attachments

const LENS = '#5d8fb8';
const RED = '#e8321e';
const RUBBER = '#26262a';

/** One add-on drawn alone in the 48 box, lying along the gun (muzzle to the right). The same drawing is shrunk onto the gun's own icon. */
function modPic(look: string): string {
  const slots = (n: number, x: number, y: number, h: number, dx: number, w = 1.2) => Array.from({ length: n }, (_, i) => L(`M${x + i * dx} ${y} v${h}`, INK, w)).join('');
  switch (look) {
    case 'dot':
      return R(13, 31, 22, 4, STEEL_DK, 1) + R(14, 18, 20, 13, '#2e3236', 3) + R(31, 20, 4, 9, LENS, 1) + C(33, 24.5, 1.2, RED) + L('M16 22 H28', shade('#2e3236', 0.3), 1);
    case 'reflex':
      return R(12, 32, 24, 4, STEEL_DK, 1) + R(13, 14, 3, 18, '#2e3236', 1) + R(32, 14, 3, 18, '#2e3236', 1) + R(14, 14, 20, 3, '#2e3236', 1) + R(29, 17, 2, 14, 'rgba(120,180,230,0.55)', 0) + C(30, 24, 1.2, RED);
    case 'holo':
      return R(11, 32, 26, 4, STEEL_DK, 1) + R(12, 13, 24, 19, '#2e3236', 3) + R(32, 15, 3, 15, LENS, 1) + R(13, 15, 3, 15, LENS, 1) + C(33.5, 22.5, 1.3, RED) + L('M16 13 H32', shade('#2e3236', 0.35), 1);
    case 'pdot':
      return R(14, 30, 20, 4, STEEL_DK, 1) + R(17, 20, 14, 10, '#2e3236', 2) + R(28, 21.5, 3, 7, LENS, 1) + C(29.5, 25, 1, RED);
    case 'scope':
      return R(14, 30, 5, 5, STEEL_DK, 1) + R(29, 30, 5, 5, STEEL_DK, 1) + R(6, 19, 34, 11, '#2a2d31', 4) + P('M32 16 H42 V33 H32Z', STEEL_DK) + C(41, 24.5, 5.5, LENS) + R(2, 21, 6, 7, STEEL_DK, 2) + R(21, 14, 5, 5, STEEL, 1);
    case 'scope4':
      return R(12, 30, 5, 6, STEEL_DK, 1) + R(30, 30, 5, 6, STEEL_DK, 1) + R(4, 19, 38, 11, '#2a2d31', 4) + P('M32 14 H43 V35 H32Z', STEEL_DK) + C(42, 24.5, 7, LENS) + C(42, 24.5, 3, '#9ac4e4') + R(1, 20.5, 6, 8, STEEL_DK, 2) + R(18, 14, 6, 5, STEEL, 1) + L('M10 24 H30', shade('#2a2d31', 0.3), 1);
    case 'scope8':
      return R(10, 31, 5, 6, STEEL_DK, 1) + R(32, 31, 5, 6, STEEL_DK, 1) + R(2, 19, 42, 12, '#24272b', 4) + P('M31 11 H45 V39 H31Z', STEEL_DK) + C(44, 25, 10, LENS) + C(44, 25, 5, '#9ac4e4') + R(0, 21, 5, 8, STEEL_DK, 2) + R(17, 13, 7, 6, STEEL, 1) + R(25, 16, 5, 4, STEEL, 1) + L('M8 25 H29', shade('#24272b', 0.3), 1);
    case 'supp_s':
      return R(3, 21, 6, 8, STEEL, 1) + R(8, 17, 34, 16, '#1c1d20', 4) + slots(5, 14, 19, 12, 5.5) + L('M10 21 H40', shade('#1c1d20', 0.4), 1);
    case 'supp_l':
      return R(2, 22, 5, 6, STEEL, 1) + R(6, 15, 40, 20, '#1c1d20', 5) + slots(6, 12, 17, 16, 6) + L('M8 19 H44', shade('#1c1d20', 0.4), 1.2) + R(41, 15, 5, 20, STEEL_DK, 1);
    case 'can_s':
      return R(3, 21, 6, 8, STEEL, 1) + R(8, 17, 32, 16, '#7a4a2e', 3) + L('M16 17 V33 M24 17 V33 M32 17 V33', '#4a2a18', 1.6) + L('M10 21 H38', '#a86a44', 1);
    case 'can_l':
      return R(2, 22, 5, 6, STEEL, 1) + R(6, 15, 38, 20, '#7a4a2e', 3) + L('M14 15 V35 M24 15 V35 M34 15 V35', '#4a2a18', 1.8) + R(6, 22, 38, 4, '#5c6266', 1) + L('M8 19 H42', '#a86a44', 1);
    case 'comp':
      return R(4, 21, 6, 8, STEEL, 1) + R(10, 17, 24, 16, STEEL_DK, 3) + slots(3, 16, 18, 14, 6, 2) + L('M12 21 H32', shade(STEEL_DK, 0.4), 1);
    case 'comp2':
      return R(4, 21, 6, 8, STEEL, 1) + R(10, 16, 30, 18, STEEL_DK, 3) + slots(4, 16, 18, 14, 6, 2.2) + L('M12 20 H38', shade(STEEL_DK, 0.4), 1) + C(40, 25, 3, INK);
    case 'brake':
      return R(4, 21, 6, 8, STEEL, 1) + R(10, 14, 28, 22, '#2a2d31', 2) + R(15, 21, 4, 8, INK, 1) + R(24, 21, 4, 8, INK, 1) + R(32, 21, 4, 8, INK, 1) + L('M12 18 H36', shade('#2a2d31', 0.4), 1);
    case 'hider':
      return R(3, 21, 6, 8, STEEL, 1) + R(9, 18, 22, 14, STEEL_DK, 3) + P('M31 18 L44 15 V19 L35 22Z', STEEL) + P('M31 32 L44 35 V31 L35 28Z', STEEL) + L('M36 18 V32', INK, 1);
    case 'choke':
      return R(5, 19, 8, 12, STEEL, 1) + R(12, 14, 20, 22, '#2a2d31', 3) + R(30, 18, 6, 14, STEEL_DK, 2) + C(36, 25, 3.5, INK) + L('M16 18 H28', shade('#2a2d31', 0.4), 1);
    case 'bar_s':
      return R(10, 22, 28, 5, STEEL, 1.5) + R(36, 20, 5, 9, STEEL_DK, 1) + L('M12 24 H34', shade(STEEL, 0.4), 1);
    case 'bar_h':
      return R(4, 20, 38, 8, STEEL_DK, 2) + L('M10 21.5 H40 M10 26.5 H40', shade(STEEL_DK, 0.45), 1.4) + R(40, 18, 5, 12, STEEL, 2) + C(44, 24, 1.8, INK);
    case 'bar_m':
      return R(3, 21, 40, 6, '#a8acb2', 2) + L('M6 22.5 H40', '#e8eaec', 1) + R(40, 19, 6, 10, STEEL_DK, 1.5) + C(44.5, 24, 1.6, INK) + L('M12 21 V27 M26 21 V27', STEEL_DK, 1.4);
    case 'bar_f':
      return R(2, 18, 44, 12, '#3a3d41', 3) + L('M6 21 H44 M6 24 H44 M6 27 H44', '#8a9096', 1.3) + R(44, 17, 3, 14, STEEL_DK, 1) + C(46, 24, 1.4, INK);
    case 'bar_c':
      return R(3, 21, 40, 6, STEEL, 1.5) + R(8, 17, 16, 14, STEEL_DK, 2) + L('M12 20 V28 M16 20 V28 M20 20 V28', INK, 1) + R(41, 20, 5, 8, STEEL_DK, 1) + C(45, 24, 1.4, INK);
    case 'bar_r':
      return R(3, 21, 42, 6, STEEL, 1.5) + L('M6 22.5 H42', shade(STEEL, 0.4), 1) + R(42, 19, 4, 10, STEEL_DK, 1) + C(45, 24, 1.4, INK);
    case 'bar_g':
      return R(3, 18, 42, 6, STEEL, 1.5) + R(3, 24, 42, 6, STEEL_DK, 1.5) + R(41, 17, 5, 14, STEEL_DK, 1) + C(44, 21, 1.4, INK) + C(44, 27, 1.4, INK);
    case 'limbs':
      return L('M4 24 H26', WOOD_DK, 4) + L('M26 24 Q36 24 44 8', INK, 4) + L('M26 24 Q36 24 44 8', STEEL_DK, 2.4) + L('M26 24 Q36 24 44 40', INK, 4) + L('M26 24 Q36 24 44 40', STEEL_DK, 2.4) + C(41, 10, 3, STEEL) + C(41, 38, 3, STEEL) + L('M44 8 L30 24 L44 40', '#e8e0c4', 1);
    case 'grip':
      return R(11, 8, 26, 7, STEEL_DK, 1.5) + R(19, 14, 10, 28, RUBBER, 3) + L('M21 20 H27 M21 25 H27 M21 30 H27 M21 35 H27', shade(RUBBER, 0.35), 1.1);
    case 'grip_a':
      return R(10, 9, 28, 7, STEEL_DK, 1.5) + `<g transform="rotate(-28 24 28)">${R(19, 14, 10, 28, RUBBER, 3)}${L('M21 20 H27 M21 25 H27 M21 30 H27', shade(RUBBER, 0.35), 1.1)}</g>`;
    case 'bipod':
      return R(8, 12, 32, 7, STEEL_DK, 1.5) + L('M18 19 L10 42 M30 19 L38 42', INK, 3.6) + L('M18 19 L10 42 M30 19 L38 42', STEEL, 1.8) + R(7, 41, 7, 3, INK, 1) + R(35, 41, 7, 3, INK, 1);
    case 'mag_ext':
      return P('M16 3 H32 V8 L33 44 H15 L16 8Z', '#2a2c30') + L('M18 12 H31 M18 18 H31 M18 24 H31 M18 30 H31 M18 36 H31', shade('#2a2c30', 0.35), 1.2) + R(14, 42, 20, 3, STEEL_DK, 1);
    case 'mag_q':
      return P('M17 3 H31 V10 L32 34 H16 L17 10Z', '#2a2c30') + P('M13 33 H35 L36 42 H12Z', STEEL_DK) + R(15, 38, 18, 3, RUBBER, 1) + L('M19 12 H29 M19 18 H29 M19 24 H29', shade('#2a2c30', 0.35), 1.2);
    case 'drum':
      return C(24, 26, 15, '#2a2c30') + C(24, 26, 9, STEEL_DK) + C(24, 26, 3, INK) + R(19, 4, 10, 8, '#2a2c30', 2) + L('M13 26 H35 M24 15 V37', shade(STEEL_DK, 0.3), 1);
    case 'loader':
      return [0, 1, 2, 3, 4, 5].map((i) => C(24 + Math.cos((i * Math.PI) / 3) * 10, 25 + Math.sin((i * Math.PI) / 3) * 10, 3.4, '#c9a24a')).join('') + C(24, 25, 4, STEEL_DK) + L('M24 21 V6', STEEL, 3);
    case 'tube':
      return R(2, 21, 40, 7, STEEL_DK, 2) + R(40, 19, 5, 11, STEEL, 1) + L('M6 23.5 H38', shade(STEEL_DK, 0.4), 1) + R(14, 19, 3, 11, STEEL, 1);
    case 'saddle':
      return R(14, 6, 20, 36, '#4a3626', 3) + [0, 1, 2, 3].map((i) => R(18, 10 + i * 8, 12, 6, '#b02a1c', 1.5) + R(18, 10 + i * 8, 12, 2, '#d9a521', 0.5)).join('') + L('M14 12 H34', '#2a2018', 1);
    case 'crank':
      return C(22, 25, 13, STEEL_DK) + C(22, 25, 4, INK) + L('M22 25 L38 12', STEEL, 3) + C(38, 12, 3.2, RUBBER) + L('M12 25 H32 M22 15 V35', shade(STEEL_DK, 0.3), 1.2);
    case 'butt':
      return R(14, 6, 12, 36, RUBBER, 4) + R(24, 14, 10, 20, STEEL_DK, 2) + L('M17 12 V36 M21 12 V36', shade(RUBBER, 0.4), 1.2);
    case 'butt2':
      return R(10, 8, 14, 36, RUBBER, 4) + R(22, 6, 22, 9, '#2a2c2e', 3) + R(22, 18, 8, 18, STEEL_DK, 2) + L('M13 14 V38 M17 14 V38', shade(RUBBER, 0.4), 1.2);
    case 'stock_p':
      return L('M42 14 L10 16 M42 30 L10 32', INK, 3.4) + L('M42 14 L10 16 M42 30 L10 32', STEEL, 1.6) + R(6, 12, 6, 24, RUBBER, 2) + L('M42 14 V30', STEEL, 2);
    case 'stock_s':
      return L('M42 14 L10 12 M42 32 L10 36', INK, 3.4) + L('M42 14 L10 12 M42 32 L10 36', STEEL, 1.6) + R(6, 10, 6, 28, RUBBER, 2) + L('M26 13 V34', STEEL, 1.6);
    case 'stock_h':
      return P('M44 14 L12 8 Q6 8 6 14 V36 Q6 42 12 42 L44 32Z', '#2a2c30') + R(4, 8, 7, 34, RUBBER, 3) + L('M14 16 H38 M14 24 H38 M14 32 H38', shade('#2a2c30', 0.3), 1.1);
    case 'stock_t':
      return P('M44 16 L12 12 Q6 12 6 18 V34 Q6 40 12 40 L44 30Z', '#2a2c30') + R(11, 6, 24, 8, '#3a3d41', 3) + R(4, 12, 7, 28, RUBBER, 3) + L('M14 22 H38 M14 30 H38', shade('#2a2c30', 0.3), 1.1);
    case 'laser':
      return R(10, 15, 24, 18, '#2a2d31', 3) + R(32, 20, 7, 8, '#4a4d52', 1) + C(37, 24, 2.6, RED) + L('M40 24 H47', RED, 1.4) + L('M14 20 H30', shade('#2a2d31', 0.4), 1) + R(12, 33, 18, 4, STEEL_DK, 1);
    case 'torch':
      return R(8, 14, 26, 20, '#2a2d31', 4) + P('M32 11 L42 8 V40 L32 37Z', STEEL_DK) + E(41, 24, 2.4, 10, '#fff6c4') + L('M12 19 H30', shade('#2a2d31', 0.4), 1) + R(12, 34, 18, 4, STEEL_DK, 1);
    case 'combo':
      return R(6, 12, 28, 24, '#2a2d31', 4) + P('M32 9 L42 6 V32 L32 30Z', STEEL_DK) + E(40, 19, 2.2, 8, '#fff6c4') + R(32, 33, 7, 8, '#4a4d52', 1) + C(37, 37, 2.2, RED) + L('M10 17 H28', shade('#2a2d31', 0.4), 1) + R(10, 36, 18, 4, STEEL_DK, 1);
    default:
      return R(10, 18, 28, 12, STEEL);
  }
}

/** Where on a gun's own picture each slot's add-on sits, by the kind of gun: handguns, sub-machine guns, long guns, shotguns, the crossbow. */
type IconSpot = Record<AttachSlot, [number, number]>;
const SPOTS: Record<string, IconSpot> = {
  hand: { optic: [22, 10], muzzle: [44, 18], barrel: [38, 18], under: [28, 28], mag: [15, 40], stock: [4, 19], rail: [31, 27] },
  smg: { optic: [20, 9], muzzle: [44, 18], barrel: [38, 18], under: [32, 29], mag: [19, 43], stock: [4, 19], rail: [34, 27] },
  long: { optic: [27, 11], muzzle: [46, 20], barrel: [40, 20], under: [37, 27], mag: [20, 41], stock: [5, 22], rail: [38, 25] },
  shot: { optic: [30, 11], muzzle: [46, 18], barrel: [40, 18], under: [35, 27], mag: [32, 25], stock: [5, 24], rail: [22, 23] },
  bow: { optic: [20, 17], muzzle: [43, 23], barrel: [40, 23], under: [24, 31], mag: [8, 26], stock: [4, 23], rail: [28, 28] },
};
const SPOT_OF: Record<GunModel, keyof typeof SPOTS> = {
  pistol: 'hand', compact: 'hand', revolver: 'hand', cannon: 'hand', mp: 'hand', smg: 'smg', smg2: 'smg',
  rifle: 'long', carbine: 'long', ar: 'long', br: 'long', dmr: 'long', sniper: 'long', lever: 'long', lmg: 'long',
  sawn: 'shot', pump: 'shot', combat: 'shot', coach: 'shot', crossbow: 'bow',
};

/** What is fitted to a gun, shrunk onto its picture: stock and magazine behind, then the rail and underbarrel, the muzzle, and the optic on top. */
function modsOnGun(model: GunModel, att: Partial<Record<AttachSlot, string>>): string {
  const spot = SPOTS[SPOT_OF[model]];
  const order: AttachSlot[] = ['stock', 'mag', 'under', 'rail', 'barrel', 'muzzle', 'optic'];
  let out = '';
  for (const slot of order) {
    const id = att[slot];
    const look = id && hasGear(id) ? gearDef(id).mod?.look : undefined;
    if (!look) continue;
    const [x, y] = spot[slot];
    const k = slot === 'optic' ? 0.4 : slot === 'mag' || slot === 'stock' ? 0.34 : 0.32;
    out += `<g transform="translate(${x} ${y}) scale(${k}) translate(-24 -24)">${modPic(look)}</g>`;
  }
  return out;
}

// ------------------------------------------------------------------------------------------- things that are not gear

/** The throwables, and the medkit, as small pictures. */
export function itemIcon(id: 'flare' | 'molotov' | 'charge' | 'horn' | 'medkit', cls = ''): string {
  switch (id) {
    case 'flare':
      return svg(
        `<g transform="rotate(35 24 26)">${P('M21 14 H27 V42 H21Z', '#c83a28')}${R(20, 12, 8, 4, '#2a2622', 1)}${L('M21 22 H27 M21 28 H27', '#f2d96a', 1.4)}</g>` + `<path d="M12 8 L16 14 M24 3 V10 M35 8 L31 14 M8 18 L14 19" stroke="#ffc14a" stroke-width="2" stroke-linecap="round"/>` + C(24, 11, 2.6, '#fff2a0'),
        cls,
      );
    case 'molotov':
      return svg(
        P('M18 20 H30 Q34 24 34 32 V40 Q34 44 30 44 H18 Q14 44 14 40 V32 Q14 24 18 20Z', 'rgba(110,170,120,0.85)') +
          P('M20 8 H28 V20 H20Z', 'rgba(110,170,120,0.85)') + L('M22 10 L18 4 Q16 2 18 1', '#d8d0b8', 2.6) + `<path d="M18 4 Q14 -1 18 -3 Q18 0 21 1Z" fill="#ff8a1f"/>` + R(15, 30, 18, 8, '#e8e0cc', 1) + P('M16 34 Q24 40 32 34 V43 Q24 46 16 43Z', 'rgba(255,138,31,0.8)', 'opacity="0.0"'),
        cls,
      );
    case 'charge':
      return svg(
        R(9, 22, 30, 18, '#b83a2a', 2) + L('M9 28 H39 M9 34 H39', '#7a2418', 1.2) + R(14, 24, 20, 4, '#e8e0cc', 1) + L('M24 22 Q24 12 32 10 Q36 9 38 5', '#d8d0b8', 2) + `<path d="M36 3 L38 7 L42 6 L39 9 L41 13 L37 10 L34 13 L35 9 L32 6 L36 6Z" fill="#ffc14a" stroke="#c4741a" stroke-width="1"/>`,
        cls,
      );
    case 'horn':
      return svg(P('M6 18 H14 L36 8 V40 L14 30 H6Z', '#d9a521') + P('M36 8 Q44 24 36 40Z', '#b3841a') + R(14, 30, 6, 10, '#6a4a2a', 1) + L('M10 22 V26', '#fff2a0', 1.4), cls);
    case 'medkit':
      return svg(R(5, 12, 38, 28, '#e8e4d8', 4) + R(16, 8, 16, 6, '#b8b4a8', 2) + R(21, 17, 6, 18, '#c83a28', 1) + R(15, 23, 18, 6, '#c83a28', 1), cls);
  }
}

// ------------------------------------------------------------------------------------------- public pictures

/** A single item as a picture, drawn in the colours of the survivor who owns it. A gun's fitted add-ons (`att`) are drawn on it. */
export function gearIcon(d: GearDef, index = 0, cls = '', att?: Partial<Record<AttachSlot, string>>): string {
  if (d.gun) return svg(gun(d.gun.model) + (att ? modsOnGun(d.gun.model, att) : ''), cls);
  if (d.mod) return svg(modPic(d.mod.look), cls);
  if (d.melee) return svg(melee(d.melee.model), cls);
  if (d.tool) return svg(tool(d.tool), cls);
  const { style, c, c2 } = lookFor(d, index);
  switch (d.slot) {
    case 'head':
      return svg(head(style, c, c2), cls);
    case 'face':
      return svg(face(style, c, c2), cls);
    case 'body':
      return svg(body(style, c, c2), cls);
    case 'hands':
      return svg(hands(style, c, c2), cls);
    case 'legs':
      return svg(legs(style, c, c2), cls);
    case 'feet':
      return svg(foot(style, c, c2), cls);
    case 'back':
      return svg(back(style, c, c2), cls);
    default:
      return svg(R(10, 10, 28, 28, STEEL), cls);
  }
}

/** A faint outline for a slot with nothing in it, so the doll shows where things go. */
export function slotGlyph(slot: WearSlot): string {
  const d = {
    head: head('bare', '#000000', '#000000'),
    face: face('bandana', '#000000', '#000000'),
    body: body('shirt', '#000000', '#000000'),
    hands: hands('bare', '#000000', '#000000'),
    legs: legs('bare', '#000000', '#000000'),
    feet: foot('bare', '#000000', '#000000'),
    back: back('ruck', '#000000', '#000000'),
  }[slot];
  return svg(d, 'ghost');
}

/**
 * The survivor, front on, in what they are wearing. Skin and undershirt are the body; each worn piece is the same drawing as its
 * icon, stretched over the right part.
 */
export function dollSvg(worn: Loadout['worn'], index: number): string {
  const look = {} as Record<WearSlot, Look | null>;
  for (const s of WEAR_SLOTS) look[s] = worn[s] ? lookFor(gearDef(worn[s]!.id), index) : null;
  const at = (inner: string, x: number, y: number, sx: number, sy = sx, flip = false) =>
    `<g transform="translate(${x} ${y}) scale(${flip ? -sx : sx} ${sy})">${inner}</g>`;

  // The body underneath: bare arms, bare legs, neck, head.
  const skinLimb = (d: string) => P(d, SKIN);
  const bodyL = look.body;
  const longSleeves = !!bodyL && ['jacket', 'duster', 'riot'].includes(bodyL.style);
  const armColor = longSleeves ? bodyL!.c : bodyL && bodyL.style === 'shirt' ? '#8a826e' : null;
  const arm = (side: 1 | -1) => {
    const x = side === 1 ? 86 : 34;
    const d = `M${x} 54 L${x + side * 15} 62 L${x + side * 14} 128 L${x + side * 1} 128 L${x - side * 1} 62Z`;
    return skinLimb(d) + (armColor ? P(`M${x} 54 L${x + side * 16} 62 L${x + side * 14} ${longSleeves ? 118 : 86} L${x} ${longSleeves ? 118 : 86} L${x - side * 1} 62Z`, armColor) : '');
  };

  const out: string[] = [];
  out.push(`<ellipse cx="60" cy="238" rx="38" ry="6" fill="rgba(0,0,0,0.22)"/>`);
  if (look.back) out.push(at(back(look.back.style, look.back.c, look.back.c2), 18, 34, 1.78, 1.9));
  out.push(arm(1) + arm(-1));
  out.push(P('M52 44 H68 V56 H52Z', SKIN_DK));
  // legs: the icon's own pair, stretched down the body.
  const lg = look.legs ?? { style: 'bare', c: SKIN, c2: SKIN };
  out.push(at(legs(lg.style, lg.c, lg.c2), 26.4, 112, 1.4, 2.55));
  // feet
  const ft = look.feet ?? { style: 'bare', c: SKIN, c2: SKIN };
  out.push(at(foot(ft.style, ft.c, ft.c2), 37, 196, 0.5, 0.9) + at(foot(ft.style, ft.c, ft.c2), 83, 196, 0.5, 0.9, true));
  // torso
  const bd = look.body ?? { style: 'shirt', c: '#8a826e', c2: '#6a6250' };
  out.push(at(body(bd.style, bd.c, bd.c2), 28, 48, 1.35, 1.65));
  // head
  out.push(`<ellipse cx="60" cy="30" rx="15" ry="18" fill="${SKIN}" stroke="${INK}" stroke-width="1.4"/>`);
  out.push(`<circle cx="54" cy="29" r="1.6" fill="#1a1410"/><circle cx="66" cy="29" r="1.6" fill="#1a1410"/>${L('M55 39 Q60 41 65 39', '#8a5a40', 1.2)}`);
  const fc = look.face;
  if (fc) out.push(at(face(fc.style, fc.c, fc.c2), 40, 18, 0.85, 0.8));
  const hd = look.head;
  out.push(at(head(hd ? hd.style : 'bare', hd ? hd.c : '#3a2a1c', hd ? hd.c2 : '#000000'), 37, hd ? 2 : 4, 0.92, 0.92));
  // hands
  const hn = look.hands ?? { style: 'bare', c: SKIN, c2: SKIN };
  const hand = (side: 1 | -1) => at(glove(hn.style, hn.c, hn.c2), side === 1 ? 83 : 37, 120, side === 1 ? 0.42 : -0.42, 0.42);
  out.push(hand(1) + hand(-1));
  return `<svg class="doll-svg" viewBox="0 0 120 244" aria-hidden="true">${out.join('')}</svg>`;
}
