import type { CompassPin } from '../game/scene';
import { MapProjection, fitRect, headingFor, radiusFor, type MapBase, type MapFrame, type MapPin, type MapPinKind, type MapRoad } from './mapdata';

/** Colours of the markers shared by the compass and the maps. */
export const PIN_COLOR: Record<MapPinKind, string> = {
  end: '#ffe08a',
  encounter: '#ff9a4a',
  zone: '#8ad8ff',
  ping: '#ffffff',
  ambush: '#ff4a3a',
  camp: '#ffe08a',
  fragment: '#3ad0ff',
  chassis: '#3aa0ff',
  threat: '#ff4a3a',
  watch: '#7ddc7a',
  sector: '#ffb454',
  hub: '#ffe08a',
  dock: '#5ad8ff',
  delve: '#c89aff',
  chest: '#ffd24a',
  key: '#7dffb0',
  lock: '#ff7a5a',
  exit: '#ffe08a',
  part: '#ffb454',
  ride: '#7ddc7a',
  site: '#e9dfc7',
  lake: '#5ad8ff',
};

/** What a map needs to know about the seat it is drawn for. */
export interface MapView {
  seat: number;
  x: number;
  z: number;
  /** The direction the camera looks (0 is north), which is what points up the minimap. */
  yaw: number;
  /** Metres per second, for the zoom. */
  speed: number;
  color: string;
  /** Share of the usual minimap radius that can be seen: dust in the air shrinks it. Missing means all of it. */
  reach?: number;
}

/** Pins that stay on the rim of the minimap when they are out of range, so the way to them is never lost. */
const RIM_KINDS = new Set<MapPinKind>(['end', 'camp', 'encounter', 'ping', 'exit', 'ride', 'delve', 'dock', 'chassis', 'fragment', 'lock', 'key']);
/** Pins the whole-leg view leaves off: they are only worth a glance when close. */
const NEAR_ONLY = new Set<MapPinKind>(['ambush', 'threat', 'part', 'sector', 'watch']);

const FONT = (px: number) => `${Math.round(px)}px Oswald, sans-serif`;
const MONO = (px: number) => `${Math.round(px)}px Share Tech Mono, monospace`;

interface Baked {
  canvas: HTMLCanvasElement;
  version: number;
}
const baked = new WeakMap<MapBase, Baked>();

/** The base's pixels as a canvas the context can scale and turn, refreshed when the base changes. */
function groundCanvas(base: MapBase): HTMLCanvasElement | null {
  let b = baked.get(base);
  if (!b) {
    const canvas = document.createElement('canvas');
    canvas.width = base.w;
    canvas.height = base.h;
    b = { canvas, version: -1 };
    baked.set(base, b);
  }
  if (b.version !== base.version) {
    const g = b.canvas.getContext('2d');
    if (!g) return null;
    g.putImageData(new ImageData(base.data as Uint8ClampedArray<ArrayBuffer>, base.w, base.h), 0, 0);
    b.version = base.version;
  }
  return b.canvas;
}

/** Draws the minimap and the larger map for one seat. Holds only drawing state, so every seat has its own. */
export class MapPainter {
  private proj = new MapProjection();
  private radius = 0;
  private dpr = 1;

  /** Sizes a canvas to a CSS box and returns its context with the transform set to CSS pixels. */
  private prepare(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    if (c.style.width !== `${w}px`) c.style.width = `${w}px`;
    if (c.style.height !== `${h}px`) c.style.height = `${h}px`;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d');
    if (!g) return null;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return g;
  }

  /** The round minimap that sits in the corner: turned so up is where the camera looks. */
  mini(canvas: HTMLCanvasElement, f: MapFrame, v: MapView, size: number, dt: number) {
    const g = this.prepare(canvas, size, size);
    if (!g) return;
    const R = size / 2;
    const target = radiusFor(f, v.speed) * (v.reach ?? 1);
    this.radius = this.radius === 0 ? target : this.radius + (target - this.radius) * Math.min(1, dt * 2.5);
    const scale = (R - 3) / this.radius;
    const P = this.proj.set(v.x, v.z, v.yaw, scale, R, R);
    g.save();
    g.beginPath();
    g.arc(R, R, R - 1.5, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = 'rgba(12,9,6,0.78)';
    g.fillRect(0, 0, size, size);
    this.ground(g, P, f);
    if (!f.base) this.rings(g, P, size);
    this.layers(g, P, f, v, { labels: false, rim: R - 8, size });
    g.restore();
    // Frame, range and north.
    g.strokeStyle = 'rgba(255,180,84,0.55)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(R, R, R - 1.5, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 1;
    const nx = P.x(v.x, v.z + this.radius) - R;
    const ny = P.y(v.x, v.z + this.radius) - R;
    const nl = Math.hypot(nx, ny) || 1;
    const fs = Math.max(9, size * 0.085);
    g.font = FONT(fs);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffe08a';
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.lineWidth = 3;
    g.strokeText('N', R + (nx / nl) * (R - fs * 0.9), R + (ny / nl) * (R - fs * 0.9));
    g.fillText('N', R + (nx / nl) * (R - fs * 0.9), R + (ny / nl) * (R - fs * 0.9));
    g.lineWidth = 1;
    g.font = MONO(Math.max(8, size * 0.07));
    g.fillStyle = 'rgba(233,223,199,0.85)';
    g.fillText(`${Math.round(this.radius / 10) * 10}m`, R, size - fs * 0.7);
  }

  /** The bigger map. Mode 1 is a window around you, north up; mode 2 is the whole leg. */
  full(canvas: HTMLCanvasElement, f: MapFrame, v: MapView, mode: number, w: number, h: number, hint: string, u: number) {
    const g = this.prepare(canvas, w, h);
    if (!g) return;
    g.fillStyle = 'rgba(14,10,6,0.95)';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,180,84,0.6)';
    g.strokeRect(0.5, 0.5, w - 1, h - 1);
    const head = Math.round(22 * u);
    const foot = Math.round(20 * u);
    const mx = 10;
    const bx = mx;
    const by = head + 4;
    const bw = w - mx * 2;
    const bh = h - head - foot - 8;
    g.save();
    g.beginPath();
    g.rect(bx, by, bw, bh);
    g.clip();
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(bx, by, bw, bh);
    let P: MapProjection;
    if ((mode >= 2 && f.overview) || f.mode === 'delve') {
      const heading = headingFor(f.bounds, bw, bh);
      const fit = fitRect(f.bounds, heading, bw, bh, 6);
      P = this.proj.set(fit.cx, fit.cz, heading, fit.scale, bx + bw / 2, by + bh / 2);
    } else {
      const reach = f.mode === 'leg' ? 520 : Math.max(f.radiusMax * 1.6, 60);
      const scale = (Math.min(bw, bh) / 2) / reach;
      P = this.proj.set(v.x, v.z, 0, scale, bx + bw / 2, by + bh / 2);
    }
    this.ground(g, P, f);
    if (!f.base) this.rings(g, P, Math.min(bw, bh));
    this.layers(g, P, f, v, { labels: true, rim: 0, size: Math.min(bw, bh), overview: mode >= 2 });
    g.restore();
    // Heading text.
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = FONT(14 * u);
    g.fillStyle = '#ffe08a';
    g.fillText(`${f.title.toUpperCase()}${mode >= 2 && f.overview ? ' · WHOLE LEG' : ''}`, mx, head / 2 + 1);
    g.textAlign = 'right';
    g.font = MONO(10 * u);
    g.fillStyle = 'rgba(233,223,199,0.85)';
    g.fillText(hint, w - mx, h - foot / 2 - 1);
    // Which way is north on this map.
    const n = { x: P.x(P.cx, P.cz + 100) - P.x(P.cx, P.cz), y: P.y(P.cx, P.cz + 100) - P.y(P.cx, P.cz) };
    g.save();
    g.translate(w - mx - 12 * u, head / 2 + 1);
    g.rotate(Math.atan2(n.x, -n.y));
    g.fillStyle = '#ffe08a';
    g.beginPath();
    g.moveTo(0, -8 * u);
    g.lineTo(5 * u, 5 * u);
    g.lineTo(-5 * u, 5 * u);
    g.closePath();
    g.fill();
    g.restore();
    // The key to the markers, if there is room for it beside the button hint.
    g.textAlign = 'left';
    g.font = MONO(10 * u);
    const key = legend(f);
    if (g.measureText(key).width + g.measureText(hint).width + 28 < w - mx * 2) {
      g.fillStyle = 'rgba(233,223,199,0.7)';
      g.fillText(key, mx, h - foot / 2 - 1);
    }
  }

  // ------------------------------------------------------------------ layers

  private ground(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame) {
    const base = f.base;
    if (!base) return;
    const c = groundCanvas(base);
    if (!c) return;
    g.save();
    // Smoothed both ways: zoomed in, the 8 m ground pixels would otherwise show as blocks.
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const [a, b, cc, d, e, ff] = P.matrix(base.x0, base.z0, base.cell);
    g.transform(a, b, cc, d, e, ff);
    g.drawImage(c, 0, 0);
    g.restore();
  }

  private rings(g: CanvasRenderingContext2D, P: MapProjection, size: number) {
    g.strokeStyle = 'rgba(255,180,84,0.18)';
    g.lineWidth = 1;
    for (const k of [1 / 3, 2 / 3]) {
      g.beginPath();
      g.arc(P.px, P.py, (size / 2) * k, 0, Math.PI * 2);
      g.stroke();
    }
  }

  private layers(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame, v: MapView, o: { labels: boolean; rim: number; size: number; overview?: boolean }) {
    const s = P.scale;
    // The open world's roads: only those that reach the view, tracks only up close.
    if (f.roads.length) {
      const reach = (o.size / 2 + 24) / s;
      const near = (r: MapRoad) => r.x1 > P.cx - reach && r.x0 < P.cx + reach && r.z1 > P.cz - reach && r.z0 < P.cz + reach;
      const draw = (r: MapRoad, col: string, width: number) => {
        g.beginPath();
        for (let i = 0; i < r.pts.length; i += 2) {
          const x = P.x(r.pts[i], r.pts[i + 1]);
          const y = P.y(r.pts[i], r.pts[i + 1]);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.strokeStyle = col;
        g.lineWidth = width;
        g.stroke();
      };
      g.lineJoin = 'round';
      g.lineCap = 'round';
      const wide = !!o.overview;
      for (const kind of ['track', 'road', 'highway'] as const) {
        for (const r of f.roads) {
          if (r.kind !== kind || !near(r)) continue;
          if (kind === 'track' && (wide || s < 0.35)) continue;
          const w = Math.max(kind === 'track' ? 1.2 : 1.6, r.half * 2 * s);
          if (kind !== 'track') draw(r, 'rgba(14,11,8,0.85)', w + 2);
          draw(r, kind === 'track' ? 'rgba(120,100,70,0.7)' : kind === 'road' ? '#7a7466' : '#8a8272', w);
        }
      }
      g.lineWidth = 1;
    }
    // Road.
    if (f.road && f.road.length > 3) {
      const path = () => {
        g.beginPath();
        for (let i = 0; i < f.road!.length; i += 2) {
          const x = P.x(f.road![i], f.road![i + 1]);
          const y = P.y(f.road![i], f.road![i + 1]);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
      };
      const w = Math.max(2, f.roadHalf * 2 * s);
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(14,11,8,0.85)';
      g.lineWidth = w + 2;
      path();
      g.stroke();
      g.strokeStyle = f.mode === 'leg' && f.base && f.bounds.x1 - f.bounds.x0 < 400 ? '#6e675a' : '#8a8272';
      g.lineWidth = w;
      path();
      g.stroke();
      g.lineWidth = 1;
    }
    // Mined ground.
    for (const poly of f.hazards) {
      g.beginPath();
      for (let i = 0; i < poly.length; i += 2) {
        const x = P.x(poly[i], poly[i + 1]);
        const y = P.y(poly[i], poly[i + 1]);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fillStyle = 'rgba(255,74,58,0.2)';
      g.fill();
      g.setLineDash([5, 4]);
      g.strokeStyle = 'rgba(255,90,70,0.8)';
      g.stroke();
      g.setLineDash([]);
    }
    // Pins.
    const u = o.labels ? 1 : 0.85;
    const t = performance.now() / 1000;
    for (const pin of f.pins) {
      if (o.overview && NEAR_ONLY.has(pin.kind) && pin.kind !== 'ambush') continue;
      let x = P.x(pin.x, pin.z);
      let y = P.y(pin.x, pin.z);
      let edge = false;
      if (o.rim > 0) {
        const dx = x - P.px;
        const dy = y - P.py;
        const d = Math.hypot(dx, dy);
        if (d > o.rim) {
          if (!RIM_KINDS.has(pin.kind)) continue;
          x = P.px + (dx / d) * o.rim;
          y = P.py + (dy / d) * o.rim;
          edge = true;
        }
      }
      this.pin(g, pin, x, y, u, edge, t, o.labels);
    }
    // Others on the ground.
    for (const b of f.blips) {
      const x = P.x(b.x, b.z);
      const y = P.y(b.x, b.z);
      if (o.rim > 0 && Math.hypot(x - P.px, y - P.py) > o.rim) continue;
      g.fillStyle = b.kind === 'foe' ? '#ff4a3a' : b.kind === 'crew' ? '#7ddc7a' : '#c9b48a';
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.beginPath();
      g.arc(x, y, o.labels ? 3 : 2.4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    // The convoy: your partner in their colour, you on top.
    const me = f.movers.find((m) => m.seat === v.seat);
    for (const m of f.movers) {
      if (m === me) continue;
      this.arrow(g, P, m, m.color, o.labels ? 8 : 6, false);
    }
    if (me) this.arrow(g, P, me, me.color, o.labels ? 9 : 7, true);
    void o.size;
  }

  private arrow(g: CanvasRenderingContext2D, P: MapProjection, m: { x: number; z: number; yaw: number }, color: string, r: number, self: boolean) {
    const x = P.x(m.x, m.z);
    const y = P.y(m.x, m.z);
    // Screen angle of the unit's heading: where a step along its facing lands, relative to where it stands.
    const hx = P.x(m.x + Math.sin(m.yaw), m.z + Math.cos(m.yaw)) - x;
    const hy = P.y(m.x + Math.sin(m.yaw), m.z + Math.cos(m.yaw)) - y;
    g.save();
    g.translate(x, y);
    g.rotate(Math.atan2(hx, -hy));
    g.beginPath();
    g.moveTo(0, -r);
    g.lineTo(r * 0.72, r * 0.8);
    g.lineTo(0, r * 0.4);
    g.lineTo(-r * 0.72, r * 0.8);
    g.closePath();
    g.fillStyle = color;
    g.fill();
    g.lineWidth = self ? 2 : 1.5;
    g.strokeStyle = self ? '#ffffff' : '#000000';
    g.stroke();
    g.restore();
    g.lineWidth = 1;
  }

  private pin(g: CanvasRenderingContext2D, pin: MapPin, x: number, y: number, u: number, edge: boolean, t: number, labels: boolean) {
    const col = pin.kind === 'ambush' ? PIN_COLOR.ambush : PIN_COLOR[pin.kind];
    g.globalAlpha = edge ? 0.7 : 1;
    g.fillStyle = col;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.lineWidth = 1.5;
    const r = (pin.kind === 'end' || pin.kind === 'camp' || pin.kind === 'exit' ? 6 : 4.2) * u;
    switch (pin.kind) {
      case 'ambush':
        g.beginPath();
        g.moveTo(x, y - r);
        g.lineTo(x + r, y + r * 0.8);
        g.lineTo(x - r, y + r * 0.8);
        g.closePath();
        g.fill();
        g.stroke();
        break;
      case 'ping': {
        const k = (t * 1.6) % 1;
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, 3 + k * 9 * u, 0, Math.PI * 2);
        g.globalAlpha = (edge ? 0.7 : 1) * (1 - k);
        g.stroke();
        g.globalAlpha = edge ? 0.7 : 1;
        g.beginPath();
        g.arc(x, y, 2.5, 0, Math.PI * 2);
        g.fillStyle = '#fff';
        g.fill();
        break;
      }
      case 'encounter':
      case 'delve':
      case 'lock':
      case 'key':
      case 'chest':
        g.beginPath();
        g.moveTo(x, y - r * 1.2);
        g.lineTo(x + r * 1.1, y);
        g.lineTo(x, y + r * 1.2);
        g.lineTo(x - r * 1.1, y);
        g.closePath();
        g.fill();
        g.stroke();
        break;
      case 'end':
      case 'camp':
      case 'exit':
        // A flag on a pole.
        g.beginPath();
        g.moveTo(x - r * 0.6, y + r);
        g.lineTo(x - r * 0.6, y - r * 1.3);
        g.lineTo(x + r * 1.1, y - r * 0.6);
        g.lineTo(x - r * 0.6, y);
        g.closePath();
        g.fill();
        g.stroke();
        break;
      case 'site':
        g.beginPath();
        g.moveTo(x - r, y + r * 0.7);
        g.lineTo(x - r, y - r * 0.2);
        g.lineTo(x, y - r);
        g.lineTo(x + r, y - r * 0.2);
        g.lineTo(x + r, y + r * 0.7);
        g.closePath();
        g.fill();
        g.stroke();
        break;
      default:
        g.fillRect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
        g.strokeRect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
    }
    g.lineWidth = 1;
    g.globalAlpha = 1;
    if (labels && pin.label && pin.kind !== 'ping' && pin.kind !== 'ambush') {
      g.font = MONO(10);
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.fillStyle = 'rgba(0,0,0,0.85)';
      g.fillText(pin.label, x + 1, y + r + 2);
      g.fillStyle = PIN_COLOR[pin.kind];
      g.fillText(pin.label, x, y + r + 1);
    }
  }
}

function legend(f: MapFrame): string {
  if (f.mode === 'leg') return `YOU · PARTNER ▲ · CAMP ⚑ · ENCOUNTER ◆ · SCAVENGE ■${f.hazards.length ? ' · MINES ▨' : ''}`;
  if (f.mode === 'delve') return 'YOU · PARTNER ▲ · CHEST ◆ · EXIT ⚑ · ONLY WHERE YOU HAVE BEEN';
  return 'YOU · PARTNER ▲ · WATCH POSTS ■ · THREATS ●';
}

/** A compass pin as a map pin. */
export const asMapPin = (p: CompassPin): MapPin => ({ x: p.x, z: p.z, kind: p.kind, label: p.label });

