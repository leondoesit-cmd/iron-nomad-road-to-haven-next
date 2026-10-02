import * as THREE from 'three';
import { shared } from './dispose';

/**
 * Shopfronts with their own drawn sign, for the recreation of a real street. A shopfront is one flat panel laid over
 * the ground storey of a building, 14 m wide and 4.8 m tall, drawn on a canvas at load time like every other texture
 * in the game. Everything above the sign band is transparent except the logos that stand over it.
 *
 * The drawing is a redraw from a photograph, not the photograph. If a real image of the front is dropped in at
 * `public/shops/<id>.png` (the whole panel, 14:4.8, with transparency above the sign if wanted) it replaces the drawing
 * once it has loaded; with no file there the drawing stays.
 */

export const SHOP_W = 14;
export const SHOP_H = 4.8;
const PX = 80;

export type ShopId = 'malabes';

/** Where an optional photograph of the front is looked for. */
export const shopImageUrl = (id: ShopId) => `/shops/${id}.png`;

const materials = new Map<ShopId, THREE.MeshStandardMaterial>();

export function shopFrontMaterial(id: ShopId): THREE.MeshStandardMaterial {
  let m = materials.get(id);
  if (m) return m;
  const tex = shared(new THREE.CanvasTexture(drawFront(id)));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  m = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.22, roughness: 0.85, metalness: 0, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
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
  fitText(g, 'איכות וטעם מסעדה', x + w / 2, y + h * 0.78, w * 0.7, h * 0.2);
  (g as unknown as { direction: string }).direction = 'ltr';
  g.font = `${Math.round(h * 0.1)}px Arial, sans-serif`;
  g.textAlign = 'right';
  g.fillStyle = '#c8c8c2';
  g.fillText('SINCE 1975', x + w - 12, y + 14);
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
  // The open front: warm and dark, a counter, the spit, a fridge, a lit menu.
  const ox = m(3.3);
  const ow = m(7.4);
  const oy = bandY + bandH;
  const grad = g.createLinearGradient(0, oy, 0, m(SHOP_H));
  grad.addColorStop(0, '#2a1a10');
  grad.addColorStop(0.55, '#6b4424');
  grad.addColorStop(1, '#1d130c');
  g.fillStyle = grad;
  g.fillRect(ox, oy, ow, m(SHOP_H) - oy);
  g.fillStyle = '#f6dfa4';
  g.fillRect(ox + m(0.3), oy + m(0.12), ow - m(0.6), m(0.07));
  // Menu board and fridge.
  g.fillStyle = '#e8b53a';
  g.fillRect(m(7.5), oy + m(0.45), m(1.3), m(0.8));
  g.fillStyle = '#3a2410';
  for (let i = 0; i < 4; i++) g.fillRect(m(7.6), oy + m(0.55) + i * m(0.17), m(1.1 - (i % 2) * 0.3), m(0.07));
  g.fillStyle = '#a8231c';
  g.fillRect(m(9.0), oy + m(0.45), m(0.9), m(1.9));
  g.fillStyle = '#f0f0ea';
  g.fillRect(m(9.0), oy + m(0.45), m(0.9), m(0.22));
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(m(9.12), oy + m(0.8), m(0.66), m(1.2));
  // The spit, glowing at the front left.
  const spit = g.createLinearGradient(m(3.9), 0, m(4.5), 0);
  spit.addColorStop(0, '#7b4a2c');
  spit.addColorStop(0.5, '#c98a4c');
  spit.addColorStop(1, '#6a3d22');
  g.fillStyle = spit;
  g.beginPath();
  g.moveTo(m(3.95), oy + m(0.5));
  g.lineTo(m(4.45), oy + m(0.5));
  g.lineTo(m(4.62), oy + m(1.9));
  g.lineTo(m(3.78), oy + m(1.9));
  g.closePath();
  g.fill();
  g.fillStyle = '#ffb04a';
  g.fillRect(m(3.6), oy + m(0.6), m(0.1), m(1.3));
  // The counter: stainless steel with a bright edge.
  const cy = m(3.7);
  g.fillStyle = '#aeb3b7';
  g.fillRect(ox, cy, m(3.1), m(SHOP_H) - cy);
  g.fillStyle = '#e4e7e9';
  g.fillRect(ox, cy, m(3.1), m(0.1));
  g.fillStyle = 'rgba(0,0,0,0.22)';
  for (let i = 1; i < 4; i++) g.fillRect(ox + i * m(0.78), cy + m(0.14), 2, m(SHOP_H) - cy);
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
