import * as THREE from 'three';
import type { MeshBuilder } from './builder';
import type { Mounts } from './attachments';
import { PANELS, type PanelId, type PanelPaint } from '../sim/paint';

/**
 * Per-panel paint, baked into a model as it is built. The builder keeps a colour and a surface per vertex; paint
 * surfaces are the ones with the paint roughness and metalness. Any such vertex that lies inside a sprayed panel is
 * recoloured, keeping its own light-and-dark variation, and its wear is cut right down: fresh paint covers rust.
 */

/** Which panel a point on the body belongs to, in the model's frame (the ground-frame `Mounts` numbers). */
export function panelAt(m: Mounts, x: number, y: number, z: number): PanelId | null {
  if (m.roof && y > m.roof.y - 0.3 && z > m.roof.z0 - 0.45 && z < m.roof.z1 + 0.45 && Math.abs(x) < m.roof.hw + 0.35) return 'roof';
  if (m.hood && y > m.hood.y - 0.22 && z > m.hood.z0 - 0.1 && Math.abs(x) < m.hood.hw + 0.4) return 'hood';
  if (!m.narrow && Math.abs(x) > m.hw - 0.14 && z > m.side.z0 - 0.05 && z < m.side.z1 + 0.05 && y > m.side.y0 - 0.12 && y < m.side.y1 + 0.18) return x > 0 ? 'doorL' : 'doorR';
  const front = m.narrow ? m.front.z * 0.35 : m.front.z - 0.45;
  const rear = m.narrow ? m.rear.z * 0.35 : m.rear.z + 0.45;
  if (z > front) return 'front';
  if (z < rear) return 'rear';
  return null;
}

const isPaintSurface = (r: number, mt: number) => (r > 0.45 && r < 0.51 && mt > 0.1 && mt < 0.14) || (r > 0.26 && r < 0.3 && mt > 0.08 && mt < 0.12);

const _c = new THREE.Color();

/** Recolour the sprayed panels of a model in a builder. Call after the body and its kit are in, before `build()`. */
export function paintPanels(b: MeshBuilder, base: number, panels: PanelPaint | undefined, m: Mounts) {
  if (!panels) return;
  const targets = new Map<PanelId, THREE.Color>();
  for (const p of PANELS) if (panels[p] !== undefined) targets.set(p, new THREE.Color(panels[p]));
  if (!targets.size) return;
  const baseC = new THREE.Color(base);
  const n = b.pos.length / 3;
  for (let i = 0; i < n; i++) {
    if (!isPaintSurface(b.srf[i * 4], b.srf[i * 4 + 1])) continue;
    // Only body paint: a vertex far from the vehicle's own colour is a roll cage or a can, not a panel.
    const r = b.col[i * 3];
    const g = b.col[i * 3 + 1];
    const bl = b.col[i * 3 + 2];
    const dev = Math.max(Math.abs(r - baseC.r), Math.abs(g - baseC.g), Math.abs(bl - baseC.b));
    if (dev > 0.5 * Math.max(0.08, baseC.r + baseC.g + baseC.b) / 3 + 0.12) continue;
    const panel = panelAt(m, b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]);
    const t = panel ? targets.get(panel) : undefined;
    if (!t) continue;
    // Keep the vertex's own variation relative to the vehicle's colour.
    const k = (v: number, base1: number) => v / Math.max(0.03, base1);
    _c.setRGB(t.r * k(r, baseC.r), t.g * k(g, baseC.g), t.b * k(bl, baseC.b));
    b.col[i * 3] = Math.min(4, _c.r);
    b.col[i * 3 + 1] = Math.min(4, _c.g);
    b.col[i * 3 + 2] = Math.min(4, _c.b);
    b.srf[i * 4 + 2] *= 0.15;
  }
}
