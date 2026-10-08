import * as THREE from 'three';
import { markPx, pxToWorld, viewHeightOf } from './markers';

/**
 * The waypoint in the world: a small diamond in its owner's colour over the spot, and under it how far it is, a short
 * line for each view (each player reads their own distance). Screen-sized like the other markers (`markers.ts`), drawn over
 * everything, and never further than `REACH` from the camera so a far waypoint is not cut off by the far plane: it stands
 * on the same line of sight, nearer. It fades out as you close on it.
 */

/** Design sizes in CSS pixels at 1080p and UI scale 1. */
const DIAMOND_PX = 15;
const LABEL_PX = { w: 64, h: 18 };
/** The farthest a marker is put from the camera (it keeps its bearing, so it looks the same). */
const REACH = 240;
const OVERSAMPLE = 2;

let diamondTex: THREE.CanvasTexture | null = null;
function diamondTexture(): THREE.CanvasTexture | null {
  if (diamondTex) return diamondTex;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  g.translate(32, 32);
  const d = (r: number) => {
    g.beginPath();
    g.moveTo(0, -r);
    g.lineTo(r * 0.78, 0);
    g.lineTo(0, r);
    g.lineTo(-r * 0.78, 0);
    g.closePath();
  };
  d(29);
  g.fillStyle = 'rgba(0,0,0,0.8)';
  g.fill();
  d(23);
  g.fillStyle = '#fff';
  g.fill();
  // A dark pip in the middle, so it reads as a target and not a gem.
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath();
  g.arc(0, 0, 5, 0, Math.PI * 2);
  g.fill();
  diamondTex = new THREE.CanvasTexture(c);
  diamondTex.colorSpace = THREE.SRGBColorSpace;
  return diamondTex;
}

const _cam = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** Put a sprite on the line from the camera to `at`, no further than REACH, and size it to `px` x `py` screen pixels. */
function place(s: THREE.Sprite, at: THREE.Vector3, cam: THREE.PerspectiveCamera, r: THREE.WebGLRenderer, px: number, py: number, lift: number) {
  const vh = viewHeightOf(r, cam);
  cam.getWorldPosition(_cam);
  _dir.subVectors(at, _cam);
  const real = _dir.length();
  const d = Math.min(real, REACH);
  if (real > 1e-3) _dir.multiplyScalar(d / real);
  s.position.copy(_cam).add(_dir);
  const k = markPx(1, d, vh);
  const w = pxToWorld(px * k, d, cam.fov, vh);
  const h = pxToWorld(py * k, d, cam.fov, vh);
  s.scale.set(w, h, 1);
  // The label hangs under the diamond: a lift in screen pixels, turned to metres at this distance.
  if (lift) s.position.y -= pxToWorld(lift * k, d, cam.fov, vh);
  s.updateMatrixWorld();
  return real;
}

export class WaypointMarker {
  readonly group = new THREE.Group();
  private diamond: THREE.Sprite;
  private labels: { sprite: THREE.Sprite; canvas: HTMLCanvasElement | null; tex: THREE.CanvasTexture | null; text: string }[] = [];
  private readonly at = new THREE.Vector3();
  private alpha = 1;

  constructor(
    color: string,
    /** Each view's camera, by seat, so a label shows only in the view whose distance it gives. */
    private cameraOf: (seat: number) => THREE.Camera | undefined,
  ) {
    const mat = new THREE.SpriteMaterial({ map: diamondTexture() ?? undefined, color: new THREE.Color(color), transparent: true, depthTest: false, depthWrite: false, fog: false });
    this.diamond = new THREE.Sprite(mat);
    this.diamond.renderOrder = 70;
    this.diamond.frustumCulled = false;
    this.diamond.onBeforeRender = (r, _s, cam) => {
      const real = place(this.diamond, this.at, cam as THREE.PerspectiveCamera, r, DIAMOND_PX, DIAMOND_PX, 0);
      mat.opacity = this.alpha * fade(real);
    };
    this.group.add(this.diamond);
    for (let seat = 0; seat < 2; seat++) {
      const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
      if (canvas) {
        canvas.width = LABEL_PX.w * OVERSAMPLE;
        canvas.height = LABEL_PX.h * OVERSAMPLE;
      }
      const tex = canvas ? new THREE.CanvasTexture(canvas) : null;
      if (tex) {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
      }
      const lm = new THREE.SpriteMaterial({ map: tex ?? undefined, transparent: true, depthTest: false, depthWrite: false, fog: false });
      const sprite = new THREE.Sprite(lm);
      sprite.renderOrder = 71;
      sprite.frustumCulled = false;
      sprite.center.set(0.5, 1);
      sprite.onBeforeRender = (r, _s, cam) => {
        // Only in the view of the seat this label measures from.
        if (cam !== this.cameraOf(seat)) {
          sprite.scale.set(1e-6, 1e-6, 1);
          sprite.updateMatrixWorld();
          return;
        }
        const real = place(sprite, this.at, cam as THREE.PerspectiveCamera, r, LABEL_PX.w, LABEL_PX.h, DIAMOND_PX * 0.62);
        lm.opacity = this.alpha * fade(real);
      };
      this.group.add(sprite);
      this.labels.push({ sprite, canvas, tex, text: '' });
    }
  }

  setPos(x: number, y: number, z: number) {
    this.at.set(x, y, z);
    // Where three.js thinks it is matters only for sorting; the real placement happens per view.
    this.diamond.position.set(x, y, z);
  }

  setColor(color: string) {
    (this.diamond.material as THREE.SpriteMaterial).color.set(color);
  }

  setAlpha(a: number) {
    this.alpha = a;
    this.group.visible = a > 0.02;
  }

  /** The distance line in one seat's view. Redrawn only when the words change. */
  setLabel(seat: number, text: string) {
    const l = this.labels[seat];
    if (!l || l.text === text) return;
    l.text = text;
    const c = l.canvas;
    if (!c || !l.tex) return;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(OVERSAMPLE, 0, 0, OVERSAMPLE, 0, 0);
    g.clearRect(0, 0, LABEL_PX.w, LABEL_PX.h);
    if (!text) {
      l.tex.needsUpdate = true;
      return;
    }
    g.font = '700 13px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const tw = Math.min(LABEL_PX.w - 2, (g.measureText?.(text)?.width ?? text.length * 6) + 10);
    g.fillStyle = 'rgba(12,10,8,0.6)';
    g.fillRect((LABEL_PX.w - tw) / 2, 2, tw, LABEL_PX.h - 4);
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(8,6,4,0.85)';
    g.strokeText(text, LABEL_PX.w / 2, LABEL_PX.h / 2 + 0.5);
    g.fillStyle = '#f4f1e6';
    g.fillText(text, LABEL_PX.w / 2, LABEL_PX.h / 2 + 0.5);
    l.tex.needsUpdate = true;
  }

  dispose() {
    (this.diamond.material as THREE.SpriteMaterial).dispose();
    for (const l of this.labels) {
      l.tex?.dispose();
      (l.sprite.material as THREE.SpriteMaterial).dispose();
    }
    this.group.removeFromParent();
  }
}

/** Fades out over the last stretch, so it is gone by the time you are on it. */
const fade = (d: number) => Math.min(1, Math.max(0, (d - 12) / 26));

/** "340 m", "1.2 km": how a distance reads on a marker or the compass. */
export function distLabel(d: number): string {
  if (d < 995) return `${Math.max(1, Math.round(d / (d < 100 ? 1 : 10)) * (d < 100 ? 1 : 10))} m`;
  return `${(d / 1000).toFixed(d < 9950 ? 1 : 0)} km`;
}
