/**
 * The crosshair's looks, chosen in Settings: a design, the size of its centre dot, and a colour. The HUD draws it from the
 * same few marks (`.reticle` in styles.css): two arms, a dot, a ring, a chevron, shown and clipped by `data-look`.
 */
export const RETICLE_LOOKS = [
  { id: 'gap', name: 'Open cross' },
  { id: 'gapdot', name: 'Open cross + dot' },
  { id: 'cross', name: 'Solid cross' },
  { id: 'dot', name: 'Dot' },
  { id: 'ring', name: 'Circle' },
  { id: 'ringdot', name: 'Circle + dot' },
  { id: 'ringcross', name: 'Circle + cross' },
  { id: 't', name: 'T' },
  { id: 'x', name: 'X' },
  { id: 'xdot', name: 'X + dot' },
  { id: 'chevron', name: 'Chevron' },
  { id: 'brackets', name: 'Brackets + dot' },
] as const;
export type ReticleLook = (typeof RETICLE_LOOKS)[number]['id'];

/** Centre dot sizes, px (before UI scale). */
export const RETICLE_DOTS = [2, 3, 4, 5, 6, 8, 10, 12, 14];

export const RETICLE_COLORS = [
  { id: 'white', name: 'White', css: '#ffffff' },
  { id: 'green', name: 'Green', css: '#5cff6a' },
  { id: 'red', name: 'Red', css: '#ff4a3a' },
  { id: 'yellow', name: 'Yellow', css: '#ffe14a' },
  { id: 'cyan', name: 'Cyan', css: '#4ae8ff' },
  { id: 'pink', name: 'Pink', css: '#ff5ad2' },
] as const;
export type ReticleColor = (typeof RETICLE_COLORS)[number]['id'];

export interface ReticleStyle {
  look: ReticleLook;
  dot: number;
  color: ReticleColor;
}

export const DEFAULT_RETICLE: ReticleStyle = { look: 'gap', dot: 4, color: 'white' };

/** A saved style, checked: anything unknown falls back to the default. */
export function readReticle(v: unknown): ReticleStyle {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof ReticleStyle, unknown>>;
  const look = RETICLE_LOOKS.find((l) => l.id === o.look)?.id ?? DEFAULT_RETICLE.look;
  const color = RETICLE_COLORS.find((c) => c.id === o.color)?.id ?? DEFAULT_RETICLE.color;
  const dot = typeof o.dot === 'number' && RETICLE_DOTS.includes(o.dot) ? o.dot : DEFAULT_RETICLE.dot;
  return { look, dot, color };
}

/** The marks inside a `.reticle`. */
export const RETICLE_MARKS = '<i class="r-arms"><i class="r-v"></i><i class="r-h"></i></i><i class="r-ring"></i><i class="r-chev"></i><i class="r-brk"></i><i class="r-dot"></i>';

/** Put a style on a `.reticle` element. */
export function applyReticle(el: HTMLElement, s: ReticleStyle) {
  el.dataset.look = s.look;
  el.style.setProperty('--rd', `${s.dot}px`);
  el.style.setProperty('--rc', RETICLE_COLORS.find((c) => c.id === s.color)!.css);
}

/** One step through a list, wrapping. */
export function stepIn<T>(list: readonly T[], cur: T, dir: number): T {
  const i = list.indexOf(cur);
  return list[(Math.max(0, i) + dir + list.length) % list.length];
}
