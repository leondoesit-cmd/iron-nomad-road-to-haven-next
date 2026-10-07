import * as THREE from 'three';
import { shared } from './dispose';
import { hash2 } from '../core/rng';
import type { SignSpawn, SignTheme } from '../world/layout';

/**
 * Drawn signs for the recreation of a real street: the Central Bus Station's green board, the light rail's red station
 * names, the stadium's, and the shop signs over the ground floors, Hebrew over English. Each distinct sign is one canvas
 * texture drawn at load time like every other texture in the game; a chunk merges every sign that shares a material into
 * one mesh. With no canvas (the tests run in plain Node) a sign is a flat coloured panel.
 */

const PX = 160;

interface Look {
  bg: string;
  fg: string;
  edge: string;
  cross?: boolean;
}

const LOOK: Record<Exclude<SignTheme, 'shop'>, Look> = {
  bus: { bg: '#0d5c3a', fg: '#ffffff', edge: '#f2c230' },
  rail: { bg: '#c8161d', fg: '#ffffff', edge: '#ffffff' },
  stadium: { bg: '#14307a', fg: '#ffffff', edge: '#f2c230' },
  bank: { bg: '#14305c', fg: '#f4f0e0', edge: '#c9a24a' },
  pharmacy: { bg: '#f1f3ec', fg: '#17824a', edge: '#17824a', cross: true },
  cafe: { bg: '#f0bf2c', fg: '#3a1a10', edge: '#3a1a10' },
  market: { bg: '#2b8a3c', fg: '#ffffff', edge: '#f4f0e0' },
  // A brand's sign carries its own colours (`SignSpawn.colors`); this is only the fallback.
  brand: { bg: '#f2f0ea', fg: '#1a1a1a', edge: '#1a1a1a' },
};
/** Ordinary shops take one of these, by their name. */
const SHOP_LOOKS: Look[] = [
  { bg: '#d9d2bf', fg: '#2a2a2a', edge: '#2a2a2a' },
  { bg: '#b3203a', fg: '#ffffff', edge: '#f4f0e0' },
  { bg: '#1e5f9e', fg: '#ffffff', edge: '#f4f0e0' },
  { bg: '#e07a1f', fg: '#1c120a', edge: '#1c120a' },
  { bg: '#4a2a5a', fg: '#f4e8d0', edge: '#f4e8d0' },
];

const materials = new Map<string, THREE.MeshStandardMaterial>();

/** One material per distinct sign (look, wording and proportions). */
export const signKey = (s: Pick<SignSpawn, 'theme' | 'text' | 'sub' | 'w' | 'h' | 'colors'>) => `${s.theme}|${s.text}|${s.sub ?? ''}|${Math.round((s.w / s.h) * 4)}|${s.colors ? s.colors.bg + s.colors.fg : ''}`;

export function signMaterial(s: Pick<SignSpawn, 'theme' | 'text' | 'sub' | 'w' | 'h' | 'colors'>): THREE.MeshStandardMaterial {
  const key = signKey(s);
  let m = materials.get(key);
  if (m) return m;
  const look = lookOf(s);
  try {
    if (typeof document === 'undefined') throw new Error('no canvas');
    const tex = shared(new THREE.CanvasTexture(draw(s, look)));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    m = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.2, roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  } catch {
    // No real canvas (a test run in Node): a flat panel in the sign's colour.
    m = new THREE.MeshStandardMaterial({ color: look.bg, roughness: 0.8 });
  }
  m.userData.shared = true;
  materials.set(key, m);
  return m;
}

function lookOf(s: Pick<SignSpawn, 'theme' | 'text' | 'colors'>): Look {
  if (s.theme === 'brand' && s.colors) return { bg: s.colors.bg, fg: s.colors.fg, edge: s.colors.bg };
  if (s.theme !== 'shop') return LOOK[s.theme];
  return SHOP_LOOKS[Math.floor(hash2(s.text.length * 31 + s.text.charCodeAt(0), s.text.charCodeAt(s.text.length - 1), 7) * SHOP_LOOKS.length) % SHOP_LOOKS.length];
}

function draw(s: Pick<SignSpawn, 'theme' | 'text' | 'sub' | 'w' | 'h' | 'colors'>, look: Look): HTMLCanvasElement {
  const W = Math.round(s.w * PX * 0.5);
  const H = Math.max(48, Math.round(s.h * PX * 0.5));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = look.bg;
  g.fillRect(0, 0, W, H);
  // A thin rule round the edge.
  const e = Math.max(2, H * 0.06);
  g.strokeStyle = look.edge;
  g.lineWidth = e * 0.5;
  g.strokeRect(e, e, W - 2 * e, H - 2 * e);
  const fit = (text: string, px: number, maxW: number, weight: string) => {
    let size = px;
    g.font = `${weight} ${size}px "Arial Hebrew", "Arial", "Helvetica Neue", sans-serif`;
    while (size > 8 && g.measureText(text).width > maxW) {
      size -= 2;
      g.font = `${weight} ${size}px "Arial Hebrew", "Arial", "Helvetica Neue", sans-serif`;
    }
  };
  g.fillStyle = look.fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const padL = look.cross ? H * 0.9 : 0;
  const cx = (W + padL) / 2;
  const maxW = W - padL - e * 6;
  if (s.sub) {
    fit(s.text, H * 0.52, maxW, 'bold');
    g.fillText(s.text, cx, H * 0.4);
    fit(s.sub, H * 0.24, maxW, '');
    g.fillText(s.sub, cx, H * 0.78);
  } else {
    fit(s.text, H * 0.6, maxW, 'bold');
    g.fillText(s.text, cx, H * 0.52);
  }
  if (look.cross) {
    // The green cross of a pharmacy.
    const r = H * 0.28;
    const px = H * 0.5 + e;
    g.fillStyle = look.fg;
    g.fillRect(px - r * 0.3, H / 2 - r, r * 0.6, r * 2);
    g.fillRect(px - r, H / 2 - r * 0.3, r * 2, r * 0.6);
  }
  // Weather: streaks of grime down from the top and a dusty fade at the foot.
  for (let i = 0; i < 9; i++) {
    const x = hash2(i * 13 + W, H, 3) * W;
    g.fillStyle = `rgba(30,24,18,${0.05 + hash2(i, W, 9) * 0.1})`;
    g.fillRect(x, 0, 1 + hash2(i, 5, 1) * 3, H * (0.3 + hash2(i, 8, 2) * 0.6));
  }
  const fade = g.createLinearGradient(0, H * 0.6, 0, H);
  fade.addColorStop(0, 'rgba(40,34,26,0)');
  fade.addColorStop(1, 'rgba(40,34,26,0.35)');
  g.fillStyle = fade;
  g.fillRect(0, H * 0.6, W, H * 0.4);
  return c;
}

/**
 * Merge the signs that share a material into one geometry each. Every sign is a flat panel facing the way its `yaw`
 * says (yaw 0 faces +z), with a half-turn flip handled by the winding so it shows from the front only.
 */
export function buildSignGeometries(signs: SignSpawn[]): { material: THREE.MeshStandardMaterial; geometry: THREE.BufferGeometry }[] {
  const groups = new Map<string, SignSpawn[]>();
  for (const s of signs) {
    const k = signKey(s);
    let a = groups.get(k);
    if (!a) groups.set(k, (a = []));
    a.push(s);
  }
  const out: { material: THREE.MeshStandardMaterial; geometry: THREE.BufferGeometry }[] = [];
  for (const arr of groups.values()) {
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (const s of arr) {
      const base = pos.length / 3;
      const sx = Math.sin(s.yaw);
      const cz = Math.cos(s.yaw);
      // Local +x of the panel (to the viewer's right when looking at its front) in world terms: (cos yaw, -sin yaw).
      const rx = cz;
      const rz = -sx;
      for (const [u, v] of [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]] as const) {
        pos.push(s.x + rx * u * s.w, s.y - s.h / 2 + v * s.h, s.z + rz * u * s.w);
        nor.push(sx, 0, cz);
        uv.push(u + 0.5, v);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    out.push({ material: signMaterial(arr[0]), geometry: g });
  }
  return out;
}
