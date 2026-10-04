import * as THREE from 'three';

/**
 * Screen-sized world markers: the dots, rings and tags that point at a part or a mount. They live in the 3D scene (so they
 * sit on the thing and hide behind the car) but are sized in screen pixels, not metres: a tag is a small line or two of
 * text at any distance, the same size a HUD label would be, and it follows the UI scale setting and the size of the view it is
 * drawn in (each half of a split screen is its own, smaller, view). Nothing here grows with proximity or hangs as a blob.
 *
 * Depth-aware: every marker is drawn twice, once with the depth test on at full strength and once with it off and faint, so a
 * mount behind a door is still found but plainly sits behind it.
 */

let UI_SCALE = 1;
/** The player's UI scale setting (the HUD's `--u`): markers scale with it like the rest of the interface. */
export function setMarkerUiScale(s: number) {
  UI_SCALE = Math.min(2.5, Math.max(0.5, s || 1));
}
export const markerUiScale = () => UI_SCALE;

/** Sizes at 1080p and UI scale 1, in CSS pixels. */
export const MARK_PX = { dot: 7, ring: 22, text: 14 };
/** The tag is never bigger than this (a 16 px or so line at scale 1) and never smaller than this share of its size. */
export const TAG_MAX_K = 1;
export const TAG_MIN_K = 0.8;
/** Beyond this camera distance (m) a marker starts to shrink, down to TAG_MIN_K. */
export const MARK_FAR = 9;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** How much a view's height changes a marker: a half-height split-screen view gets smaller ones. 1080 tall is 1. */
export const viewScale = (viewH: number) => clamp(viewH / 1080, 0.75, 1.25);

/** The size in screen pixels of a marker whose design size is `px`, at camera distance `dist` in a view `viewH` tall. */
export function markPx(px: number, dist: number, viewH: number): number {
  return px * UI_SCALE * viewScale(viewH) * clamp(MARK_FAR / Math.max(dist, 0.1), TAG_MIN_K, TAG_MAX_K);
}

/** World size of something that covers `px` screen pixels at `dist` from a camera of vertical field of view `fovDeg`. */
export function pxToWorld(px: number, dist: number, fovDeg: number, viewH: number): number {
  return (px * 2 * Math.tan((fovDeg * Math.PI) / 360) * dist) / Math.max(1, viewH);
}

const _size = new THREE.Vector2();
/** Height in CSS pixels of the view being drawn: the renderer tags each camera with it; failing that, the whole canvas. */
export function viewHeightOf(renderer: THREE.WebGLRenderer, camera: THREE.Camera): number {
  const h = (camera.userData as { viewH?: number }).viewH;
  if (h && h > 0) return h;
  return renderer.getSize(_size).y || 1080;
}

// ---------------------------------------------------------------- text

export interface TagLine {
  text: string;
  css?: string;
}

const ELLIPSIS = '…';
const trim = (t: string, n: number) => (t.length > n ? `${t.slice(0, Math.max(1, n - 1)).trimEnd()}${ELLIPSIS}` : t);

/**
 * A tag is at most two compact lines: what it is, and the one thing about it that matters. More than that and the rest are
 * folded into the second line (the tag over a socket says "Radiator" over "Now: Race Radiator 38%"), long ones are cut short.
 * Pure, so it can be tested.
 */
export function compactLines(lines: TagLine[], maxChars = 30): TagLine[] {
  const keep = lines.filter((l) => l.text.trim().length > 0);
  if (!keep.length) return [];
  const out: TagLine[] = [{ text: trim(keep[0].text.trim(), maxChars), css: keep[0].css }];
  if (keep.length > 1) {
    const rest = keep.slice(1);
    // A warning (red) outranks the facts; otherwise the facts are joined.
    const warn = rest.find((l) => l.css === '#ff8a6a');
    const text = warn ? warn.text : rest.map((l) => l.text.trim()).join(' · ');
    out.push({ text: trim(text, maxChars + 6), css: warn?.css ?? rest[0].css });
  }
  return out;
}

/**
 * The callout over a mount, as two short lines: what it is and the one thing worth knowing. "Engine bay: Tuned V6 - unbolt
 * tuned v6" becomes "Engine bay" over "Tuned V6"; "Swap in Tuned V6 (replaces X) · 3.5 L V6 · 150 kW" becomes "Swap in Tuned
 * V6" over "3.5 L V6". The parenthesis and everything after the third part go to the HUD prompt, which already says it.
 */
export function focusLines(text: string, css: string): TagLine[] {
  const segs = text.split(/\s+[-·]\s+/).map((t) => t.replace(/\s*\([^)]*\)/g, '').trim()).filter(Boolean);
  const first = segs[0] ?? text;
  const i = first.indexOf(': ');
  if (i >= 0) return compactLines([{ text: first.slice(0, i), css: '#cfc8b4' }, { text: first.slice(i + 2) || segs[1] || '', css }]);
  return compactLines([{ text: first, css }, ...(segs[1] ? [{ text: segs[1], css: '#d8d2bf' }] : [])]);
}

export interface TextSprite {
  sprite: THREE.Sprite;
  /** Design size in CSS pixels at UI scale 1, 1080p. */
  w: number;
  h: number;
  dispose(): void;
}

const FONT = '"Barlow Condensed", "Arial Narrow", sans-serif';
const OVERSAMPLE = 2;

/**
 * A text sprite: a small dark plate with one or two lines, drawn at twice the pixel size so it is crisp, shown at its design
 * size in screen pixels wherever it is. Null outside a browser (tests, no canvas).
 */
export function makeTextSprite(lines: TagLine[], order = 60): TextSprite | null {
  if (typeof document === 'undefined' || !lines.length) return null;
  const px = MARK_PX.text;
  const pad = 5;
  const gap = Math.round(px * 0.18);
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  if (!g) return null;
  g.font = `700 ${px * OVERSAMPLE}px ${FONT}`;
  let tw = 0;
  for (const l of lines) {
    const mw = g.measureText?.(l.text)?.width;
    // Without real font metrics (a stubbed canvas) fall back to half an em a letter.
    tw = Math.max(tw, typeof mw === 'number' && Number.isFinite(mw) ? mw / OVERSAMPLE : l.text.length * px * 0.5);
  }
  const w = Math.ceil(tw + pad * 2);
  const h = Math.ceil(lines.length * px * 1.12 + gap * (lines.length - 1) + pad * 1.4);
  c.width = w * OVERSAMPLE;
  c.height = h * OVERSAMPLE;
  g.scale(OVERSAMPLE, OVERSAMPLE);
  g.fillStyle = 'rgba(12,10,8,0.66)';
  roundRect(g, 0, 0, w, h, 3);
  g.fill();
  g.font = `700 ${px}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  lines.forEach((l, i) => {
    const y = pad * 0.7 + px * 0.56 + i * (px * 1.12 + gap);
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(8,6,4,0.85)';
    g.strokeText(l.text, w / 2, y);
    g.fillStyle = l.css ?? (i === 0 ? '#f4f1e6' : '#d8d2bf');
    g.fillText(l.text, w / 2, y);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, opacity: 0 });
  const sprite = new THREE.Sprite(mat);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = order;
  sprite.onBeforeRender = (r, _s, camera) => {
    const cam = camera as THREE.PerspectiveCamera;
    const vh = viewHeightOf(r, cam);
    const dist = cam.position.distanceTo(sprite.position);
    const f = markPx(1, dist, vh);
    sprite.scale.set(pxToWorld(w * f, dist, cam.fov, vh), pxToWorld(h * f, dist, cam.fov, vh), 1);
    sprite.updateMatrixWorld();
  };
  sprite.scale.set(0.5, (0.5 * h) / w, 1);
  return {
    sprite,
    w,
    h,
    dispose() {
      tex.dispose();
      mat.dispose();
      sprite.removeFromParent();
    },
  };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------------------------------------------------------------- dots and rings

const TEX = new Map<string, THREE.CanvasTexture>();
function markTexture(kind: 'dot' | 'ring'): THREE.CanvasTexture | null {
  let t = TEX.get(kind);
  if (t) return t;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.translate(32, 32);
  if (kind === 'dot') {
    // A crisp disc with a dark rim, so it reads on a bright bonnet and a dark engine bay alike.
    g.fillStyle = 'rgba(0,0,0,0.75)';
    g.beginPath();
    g.arc(0, 0, 22, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(0, 0, 16, 0, Math.PI * 2);
    g.fill();
  } else {
    // A thin ring, two pixels of white inside a hair of dark.
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = 7;
    g.beginPath();
    g.arc(0, 0, 26, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 3.5;
    g.beginPath();
    g.arc(0, 0, 26, 0, Math.PI * 2);
    g.stroke();
  }
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  TEX.set(kind, t);
  return t;
}

function markMat(kind: 'dot' | 'ring', color: number, front: boolean): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({ map: markTexture(kind) ?? undefined, color, transparent: true, depthTest: front, depthWrite: false, fog: false, opacity: front ? 1 : 0.3 });
}

/** A small marker, `px` screen pixels across: a dot or a ring, bright where it is in view and faint where it is behind something. */
export class Mark {
  readonly group = new THREE.Group();
  /** Pulse factor on the size. */
  k = 1;
  private readonly sprites: THREE.Sprite[];

  constructor(
    kind: 'dot' | 'ring',
    private readonly px: number,
    color: number,
    order: number,
  ) {
    this.sprites = [true, false].map((front) => {
      const s = new THREE.Sprite(markMat(kind, color, front));
      s.renderOrder = front ? order + 1 : order;
      s.onBeforeRender = (r, _s, camera) => this.fit(s, r, camera as THREE.PerspectiveCamera);
      s.scale.setScalar(0.05);
      this.group.add(s);
      return s;
    });
  }

  private fit(s: THREE.Sprite, r: THREE.WebGLRenderer, cam: THREE.PerspectiveCamera) {
    const vh = viewHeightOf(r, cam);
    const dist = cam.position.distanceTo(s.position);
    s.scale.setScalar(pxToWorld(markPx(this.px, dist, vh) * this.k, dist, cam.fov, vh));
    s.updateMatrixWorld();
  }

  setPos(p: THREE.Vector3) {
    for (const s of this.sprites) s.position.copy(p);
  }

  setColor(color: number) {
    for (const s of this.sprites) (s.material as THREE.SpriteMaterial).color.setHex(color);
  }

  dispose() {
    for (const s of this.sprites) (s.material as THREE.SpriteMaterial).dispose();
    this.group.removeFromParent();
  }

  get visible() {
    return this.group.visible;
  }
  set visible(v: boolean) {
    this.group.visible = v;
  }

  /** Fade in or out: 0..1. */
  setAlpha(a: number) {
    this.group.visible = a > 0.02;
    (this.sprites[0].material as THREE.SpriteMaterial).opacity = a;
    (this.sprites[1].material as THREE.SpriteMaterial).opacity = a * 0.3;
  }
}
