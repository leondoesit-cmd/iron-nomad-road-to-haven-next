import { WEAR_SLOTS, gearDef, hexColor, type GearDef, type WearSlot } from '../data/gear';
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

/** A single item as a picture, drawn in the colours of the survivor who owns it. */
export function gearIcon(d: GearDef, index = 0, cls = ''): string {
  if (d.gun) return svg(gun(d.gun.model), cls);
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
