import * as THREE from 'three';
import { shared } from './dispose';
import { COPLANAR, coplanarOffset } from './depth';
import { MeshBuilder, S } from './builder';
import { MELABES } from '../world/melabes';

/**
 * Shopfronts with their own drawn sign, for the recreation of a real street. The signage and interior backdrop are a
 * 14 m wide, 4.8 m tall canvas panel; modelled serving equipment and door frames give the ground storey depth.
 * Everything above the sign band is transparent except the logos that stand over it.
 *
 * The drawing is a redraw from a photograph, not the photograph. If a real image of the front is dropped in at
 * `public/shops/<id>.png` (the whole panel, 14:4.8, with transparency above the sign if wanted) it replaces the drawing
 * once it has loaded; with no file there the drawing stays.
 */

export const SHOP_W = 14;
export const SHOP_H = 4.8;
const PX = 80;

export type ShopId = 'malabes';

/** Sign and shutters surround a real opening even if a photo replaces the canvas. */
export function buildShopFrontPanel(): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  const quad = (x0: number, x1: number, y0: number, y1: number) => {
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) {
      pos.push(x, y, 0); uv.push(x / SHOP_W + 0.5, y / SHOP_H);
    }
  };
  quad(-SHOP_W / 2, -MELABES.halfWidth, 0, MELABES.height);
  quad(MELABES.halfWidth, SHOP_W / 2, 0, MELABES.height);
  quad(-SHOP_W / 2, SHOP_W / 2, MELABES.height, SHOP_H);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

let panelGeo: THREE.BufferGeometry | null = null;
const detailGeos = new Map<ShopId, THREE.BufferGeometry>();
/**
 * A copy of a shop's front, its panel and its modelled details, ready to be moved into place. Every placement of a shop
 * is alike, so each is built once (the details are a few hundred boxes) and copied after.
 */
export function shopFrontGeometry(id: ShopId): { panel: THREE.BufferGeometry; details: THREE.BufferGeometry } {
  let details = detailGeos.get(id);
  if (!details) detailGeos.set(id, (details = buildShopFrontDetails(id)));
  return { panel: (panelGeo ??= buildShopFrontPanel()).clone(), details: details.clone() };
}

/** Where an optional photograph of the front is looked for. */
export const shopImageUrl = (id: ShopId) => `/shops/${id}.png`;

const materials = new Map<ShopId, THREE.MeshStandardMaterial>();

export function shopFrontMaterial(id: ShopId): THREE.MeshStandardMaterial {
  let m = materials.get(id);
  if (m) return m;
  const tex = shared(new THREE.CanvasTexture(drawFront(id)));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  m = coplanarOffset(new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.22, roughness: 0.85, metalness: 0, alphaTest: 0.5 }), COPLANAR.detail);
  m.userData.shared = true;
  materials.set(id, m);
  tryPhoto(id, m);
  return m;
}

/** Swap in a real image of the front if one has been supplied. Failing to find or decode it is fine. */
function tryPhoto(id: ShopId, m: THREE.MeshStandardMaterial) {
  if (typeof Image === 'undefined') return;
  new THREE.TextureLoader().load(
    shopImageUrl(id),
    (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      m.map = t;
      m.emissiveMap = t;
      m.needsUpdate = true;
    },
    undefined,
    () => {},
  );
}

// ------------------------------------------------------------------------------------------ drawing

type Ctx = CanvasRenderingContext2D;

function drawFront(id: ShopId): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SHOP_W * PX;
  c.height = SHOP_H * PX;
  const g = c.getContext('2d')!;
  if (id === 'malabes') malabes(g);
  return c;
}

const m = (v: number) => v * PX;

function flame(g: Ctx, cx: number, top: number, h: number) {
  const w = h * 0.62;
  g.save();
  g.translate(cx, top);
  g.beginPath();
  g.moveTo(0, h);
  g.bezierCurveTo(-w * 0.9, h * 0.8, -w * 0.7, h * 0.35, -w * 0.15, h * 0.28);
  g.bezierCurveTo(-w * 0.3, h * 0.12, -w * 0.1, h * 0.05, w * 0.05, 0);
  g.bezierCurveTo(w * 0.12, h * 0.22, w * 0.55, h * 0.3, w * 0.62, h * 0.58);
  g.bezierCurveTo(w * 0.72, h * 0.82, w * 0.4, h * 0.97, 0, h);
  g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#ff4a24');
  grad.addColorStop(1, '#c4161c');
  g.fillStyle = grad;
  g.fill();
  g.beginPath();
  g.moveTo(0, h * 0.97);
  g.bezierCurveTo(-w * 0.3, h * 0.85, -w * 0.2, h * 0.6, 0, h * 0.5);
  g.bezierCurveTo(w * 0.28, h * 0.65, w * 0.26, h * 0.88, 0, h * 0.97);
  g.closePath();
  g.fillStyle = '#ff9a3a';
  g.fill();
  g.restore();
}

/** Two crossed knives under the flame. */
function knives(g: Ctx, cx: number, cy: number, len: number) {
  g.save();
  g.translate(cx, cy);
  for (const a of [-0.62, 0.62]) {
    g.save();
    g.rotate(a);
    g.fillStyle = '#f2f2ee';
    g.beginPath();
    g.moveTo(-len * 0.5, 0);
    g.lineTo(len * 0.22, -len * 0.07);
    g.lineTo(len * 0.5, len * 0.01);
    g.lineTo(len * 0.22, len * 0.07);
    g.closePath();
    g.fill();
    g.fillStyle = '#16161a';
    g.fillRect(-len * 0.62, -len * 0.05, len * 0.16, len * 0.1);
    g.restore();
  }
  g.restore();
}

/** Draw `text` centred on (x, y), shrinking the font until it fits `maxW`. */
function fitText(g: Ctx, text: string, x: number, y: number, maxW: number, px: number, weight = '') {
  const face = '"Noto Sans Hebrew", "Arial Hebrew", "Segoe UI", Arial, sans-serif';
  for (let i = 0; i < 40; i++) {
    g.font = `${weight} ${Math.round(px)}px ${face}`.trim();
    const w = g.measureText(text).width;
    // No measurement (a headless canvas) or it already fits: keep this size.
    if (typeof w !== 'number' || w <= maxW) break;
    px *= 0.94;
  }
  g.fillText(text, x, y);
}

function signBox(g: Ctx, x: number, y: number, w: number, h: number) {
  g.fillStyle = '#080c16';
  g.fillRect(x, y, w, h);
  g.strokeStyle = '#f1f1ec';
  g.lineWidth = 3;
  g.strokeRect(x + 3, y + 3, w - 6, h - 6);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  (g as unknown as { direction: string }).direction = 'rtl';
  g.fillStyle = '#ffffff';
  fitText(g, 'שווארמה מלאבס', x + w / 2, y + h * 0.42, w * 0.84, h * 0.4, 'bold');
  g.fillStyle = '#e8e8e2';
  fitText(g, 'איכות וטעם ליותר מפעם', x + w / 2, y + h * 0.78, w * 0.86, h * 0.2);
  (g as unknown as { direction: string }).direction = 'ltr';
}

/**
 * Depth over the drawn backdrop, in the panel's local frame (+z faces the street).
 * Reference: https://petahtikva.mynet.co.il/local_news/article/byajw1zqjl (Haim Ozer street photograph).
 * The paired spits, stainless equipment, black door frames and pale tiled surround are modelled rather than painted.
 */
export function buildShopFrontDetails(id: ShopId): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.seed(1978);
  const steel = S.metal(0xb7bab9, 0.24);
  const black = S.paint(0x19191b, 0.32);
  const tile = S.concrete(0xd5d0be, 0.35);
  // Lintel and jambs, leaving the entrance on the right of the serving counter.
  b.box(0, 2.94, 0.2, 7.4, 0.16, 0.38, tile);
  for (const x of [-3.65, 3.65]) b.box(x, 1.48, 0.18, 0.14, 2.96, 0.36, tile);
  b.box(0, 3.55, -0.12, 9.6, 1.24, 0.2, black);
  // Raised white borders around the two sign boards.
  for (const x of [-2.075, 2.075]) {
    for (const y of [3.09, 4.15]) b.box(x, y, 0.15, 2.96, 0.035, 0.045, S.paint(0xe9e9e2));
    for (const dx of [-1.475, 1.475]) b.box(x + dx, 3.62, 0.15, 0.035, 1.06, 0.045, S.paint(0xe9e9e2));
  }
  // A full-depth tiled room with an open street wall.
  // Top at 4 cm: clear the terrain (0) and the sidewalk/paving overlays (3–3.2 cm).
  b.box(0, 0.005, -MELABES.depth / 2, 7.4, 0.07, MELABES.depth, S.concrete(0x99978e, 0.35));
  b.box(0, 2.97, -MELABES.depth / 2, 7.4, 0.07, MELABES.depth, tile);
  for (const x of [-3.65, 3.65]) b.box(x, 1.46, -2.4, 0.10, 2.92, 4.8, tile);
  b.box(0, 1.46, -4.75, 7.3, 2.92, 0.1, tile);
  const grout = S.paint(0x8f938e, 0.4);
  for (let y = 0.28; y < 2.9; y += 0.28) b.box(0, y, -4.689, 7.25, 0.012, 0.006, grout);
  for (let x = -3.6; x < 3.7; x += 0.48) b.box(x, 1.46, -4.689, 0.012, 2.9, 0.006, grout);
  for (const z of [-1.2, -3.8]) b.box(0, 2.88, z, 6.8, 0.045, 0.14, S.glow(0xffedc8, 0.65));
  // Stainless serving counter and salad trays.
  b.box(MELABES.counter.x, 0.48, MELABES.counter.z, MELABES.counter.w, 0.96, MELABES.counter.d, steel);
  b.box(MELABES.counter.x, 0.98, MELABES.counter.z, MELABES.counter.w + 0.1, 0.055, MELABES.counter.d + 0.1, S.chrome());
  for (const x of [-3.1, -2.3, -1.5, -0.7]) b.box(x, 0.46, 0.22, 0.015, 0.78, 0.012, S.steel(0x74797b));
  for (const [i, color] of [0x688540, 0xab3927, 0xcec499, 0x719846].entries()) {
    const x = -1.9 + i * 0.37;
    b.box(x, 1.035, -0.15, 0.31, 0.045, 0.39, S.chrome());
    b.box(x, 1.06, -0.15, 0.25, 0.035, 0.32, S.plastic(color));
  }
  // Two tall stacks, as seen at the front of the real shop.
  for (const [i, x] of MELABES.spits.entries()) {
    b.box(x, 0.51, MELABES.spitZ, 0.84, 1.02, 0.84, steel);
    b.box(x, 1.84, MELABES.spitZ - 0.55, 0.75, 1.66, 0.13, S.steel(0x5e6263, 0.32));
    for (const y of [1.36, 1.78, 2.2]) b.box(x, y, MELABES.spitZ - 0.47, 0.47, 0.31, 0.035, S.glow(0xe47836, 0.65));
    b.cyl(x, 1.83, MELABES.spitZ, 0.035, 1.82, 0.035, S.chrome(), 0, 0, 0, 8);
    for (let k = 0; k < 28; k++) {
      const radius = 0.30 + k * 0.0045 + Math.sin(k * 2.4 + i) * 0.012;
      const colors = i ? [0x9b6338, 0xb77b48, 0x794729] : [0xbe9362, 0xc5a170, 0x986c43];
      b.frustum(x, 1.16 + k * 0.051, MELABES.spitZ, radius + 0.004, radius, 0.054, S.plastic(colors[k % 3], 0.12), 0, k * 0.14, 0, 14);
    }
    b.cyl(x, 1.08, MELABES.spitZ, 0.88, 0.045, 0.88, S.chrome(), 0, 0, 0, 16);
    b.box(x, 2.7, MELABES.spitZ - 0.24, 0.84, 0.15, 0.48, steel);
  }
  // The right side stays open as the entrance; a dark frame marks the service bay.
  b.box(0, 2.79, 0.32, 6.9, 0.04, 0.06, S.glow(0xffedc8, 0.6));
  void id; // All currently authored shopfronts use the Melabes design.
  return b.build();
}

/**
 * Shawarma Malabes: a black sign band with two white-framed boards and a red kosher badge between them, flame-and-knives
 * logos over the boards, dark pillars with a fire glow at the foot, an open front with the counter and spit inside, and
 * a roller shutter either side. Phone numbers on the real sign are left off.
 */
function malabes(g: Ctx) {
  g.clearRect(0, 0, m(SHOP_W), m(SHOP_H));
  const bandY = m(0.55);
  const bandH = m(1.3);
  // Roller shutters either side, each under a plain board.
  for (const x0 of [0, 11.8]) {
    const x = m(x0);
    const w = m(x0 === 0 ? 2.2 : 2.2);
    g.fillStyle = '#8c9092';
    g.fillRect(x, bandY, w, m(SHOP_H) - bandY);
    g.fillStyle = 'rgba(40,44,46,0.35)';
    for (let y = bandY + m(1.4); y < m(SHOP_H); y += 7) g.fillRect(x, y, w, 2);
    g.fillStyle = x0 === 0 ? '#101012' : '#6a3a40';
    g.fillRect(x, bandY, w, m(1.15));
    g.fillStyle = x0 === 0 ? '#d9b82a' : '#ece2d6';
    for (let i = 0; i < 4; i++) g.fillRect(x + m(0.2), bandY + m(0.22) + i * m(0.22), w - m(0.4 + (i % 2) * 0.5), m(0.09));
  }
  // Pale ceiling and dark tiled interior, behind the three-dimensional serving equipment.
  const ox = m(3.3);
  const ow = m(7.4);
  const oy = bandY + bandH;
  const grad = g.createLinearGradient(0, oy, 0, m(SHOP_H));
  grad.addColorStop(0, '#d6d5cd');
  grad.addColorStop(0.2, '#434541');
  grad.addColorStop(1, '#181a18');
  g.fillStyle = grad;
  g.fillRect(ox, oy, ow, m(SHOP_H) - oy);
  g.fillStyle = '#f6dfa4';
  g.fillRect(ox + m(0.3), oy + m(0.12), ow - m(0.6), m(0.07));
  // White tiled rear wall and a small Hebrew menu, without invented prices.
  g.fillStyle = '#b7b8b0';
  g.fillRect(ox + m(0.4), oy + m(0.45), m(3.0), m(2.3));
  g.fillStyle = '#727772';
  for (let y = oy + m(0.45); y < m(SHOP_H); y += m(0.28)) g.fillRect(ox + m(0.4), y, m(3), 1);
  for (let x = ox + m(0.4); x < ox + m(3.4); x += m(0.48)) g.fillRect(x, oy + m(0.45), 1, m(2.3));
  g.fillStyle = '#111314';
  g.fillRect(m(6.6), oy + m(0.42), m(0.9), m(1.05));
  g.fillStyle = '#f3f0e5';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.direction = 'rtl';
  for (const [i, text] of ['שווארמה', 'בפיתה · בלאפה', 'בצלחת'].entries()) fitText(g, text, m(7.05), oy + m(0.64 + i * 0.27), m(0.8), m(0.15));
  // Dark reflective glass on the right, with the street reflected in it.
  const glass = g.createLinearGradient(m(7.6), oy, m(10.6), m(SHOP_H));
  glass.addColorStop(0, '#657369');
  glass.addColorStop(0.5, '#2d3833');
  glass.addColorStop(1, '#141a19');
  g.fillStyle = glass;
  g.fillRect(m(7.6), oy + m(0.12), m(3), m(2.8));
  g.fillStyle = 'rgba(210,218,200,0.18)';
  g.fillRect(m(7.75), oy + m(0.5), m(2.7), m(0.25));
  g.fillRect(m(8.65), oy + m(0.75), m(0.13), m(1.8));
  g.direction = 'ltr';
  // Pillars with a fire glow at the foot and a strip of vertical lettering.
  for (const x0 of [2.2, 10.7]) {
    const x = m(x0);
    g.fillStyle = '#17171a';
    g.fillRect(x, bandY, m(1.1), m(SHOP_H) - bandY);
    const glow = g.createLinearGradient(0, m(3.2), 0, m(SHOP_H));
    glow.addColorStop(0, 'rgba(216,100,26,0)');
    glow.addColorStop(1, 'rgba(240,120,30,0.95)');
    g.fillStyle = glow;
    g.fillRect(x, m(3.2), m(1.1), m(SHOP_H) - m(3.2));
    g.fillStyle = 'rgba(235,235,230,0.55)';
    for (let i = 0; i < 9; i++) g.fillRect(x + m(0.18), bandY + m(1.6) + i * m(0.22), m(0.1), m(0.12 + (i % 3) * 0.04));
  }
  // The real address; the birth date previously painted on the sign was unverified.
  g.fillStyle = '#ededdf';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.direction = 'rtl';
  fitText(g, 'חיים עוזר', m(2.75), m(2.15), m(0.94), m(0.16));
  fitText(g, '4', m(2.75), m(2.48), m(0.7), m(0.3), 'bold');
  for (const x0 of [3.3, 10.3]) {
    const x = m(x0);
    const wood = g.createLinearGradient(x, 0, x + m(0.4), 0);
    wood.addColorStop(0, '#5a321c');
    wood.addColorStop(0.5, '#8a4a22');
    wood.addColorStop(1, '#4a2a18');
    g.fillStyle = wood;
    g.fillRect(x, oy, m(0.4), m(SHOP_H) - oy);
  }
  // The sign band.
  g.fillStyle = '#0b0b0d';
  g.fillRect(m(2.2), bandY, m(9.6), bandH);
  g.fillStyle = '#9fe6a8';
  g.fillRect(m(2.2), bandY + bandH - 4, m(9.6), 4);
  signBox(g, m(3.45), bandY + m(0.12), m(2.95), m(1.06));
  signBox(g, m(7.6), bandY + m(0.12), m(2.95), m(1.06));
  // Kosher badge between the boards.
  g.fillStyle = '#d02034';
  g.beginPath();
  g.arc(m(7.0), bandY + bandH / 2, m(0.38), 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#f4f4f0';
  g.lineWidth = 3;
  g.stroke();
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  (g as unknown as { direction: string }).direction = 'rtl';
  g.font = `bold ${Math.round(m(0.3))}px "Noto Sans Hebrew", "Arial Hebrew", "Segoe UI", Arial, sans-serif`;
  g.fillText('כשר', m(7.0), bandY + bandH / 2);
  // Logos standing on the band, over each board.
  for (const cx of [m(4.92), m(9.08)]) {
    knives(g, cx, bandY - m(0.02), m(0.42));
    flame(g, cx, m(0.0), m(0.52));
  }
}
