import type { CompassPin } from '../game/scene';
import { POI_DEF, type PoiKind } from '../sim/navmarks';
import { distLabel } from '../render/navMarkers';
import { MapProjection, buildingKey, radiusFor, takeDirty, type MapBase, type MapFrame, type MapLabel, type MapPin, type MapPinKind, type MapRect, type MapRoad, type MapWater } from './mapdata';
import { LOCAL_REACH, type MapHover, type MapNav } from './mapnav';

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
  waypoint: '#ffffff',
  poi: '#e9dfc7',
  site: '#e9dfc7',
  lake: '#5ad8ff',
  falls: '#bdf2ff',
  spring: '#7fe8d6',
  swamp: '#a9b86a',
  river: '#8fd4e8',
  heritage: '#e8c48a',
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
/** Readable names for the pin kinds, for the tooltip when the cursor is on one. */
const PIN_NAME: Partial<Record<MapPinKind, string>> = {
  end: 'Destination',
  encounter: 'Encounter',
  zone: 'Scavenge zone',
  ping: 'Ping',
  ambush: 'Hostile',
  camp: 'Camp',
  fragment: 'Relay fragment',
  chassis: 'Chassis',
  threat: 'Threat',
  watch: 'Watch post',
  hub: 'Hub',
  dock: 'Dock',
  delve: 'Way down',
  chest: 'Chest',
  key: 'Key',
  lock: 'Locked door',
  exit: 'Exit',
  part: 'Loot',
  ride: 'Your ride',
  site: 'Place',
  lake: 'Lake',
  falls: 'Falls',
  spring: 'Spring',
  swamp: 'Swamp',
  river: 'River',
  heritage: 'Landmark',
};

const FONT = (px: number) => `${Math.round(px)}px Oswald, sans-serif`;
const MONO = (px: number) => `${Math.round(px)}px Share Tech Mono, monospace`;
const LABEL_FONT = (px: number, weight = 600) => `${weight} ${Math.round(px)}px "Barlow Condensed", "Arial Narrow", sans-serif`;
const AMBER = 'rgba(255,180,84,0.6)';
const PAPER = '#e9dfc7';

interface Baked {
  canvas: HTMLCanvasElement;
  image: ImageData | null;
  version: number;
}
const baked = new WeakMap<MapBase, Baked>();

/**
 * The base's pixels as a canvas the context can scale and turn. Only the rows that changed since the last upload are sent
 * (a bake in progress changes a band at a time), through one ImageData that shares the base's own buffer.
 */
function groundCanvas(base: MapBase): HTMLCanvasElement | null {
  let b = baked.get(base);
  if (!b) {
    const canvas = document.createElement('canvas');
    canvas.width = base.w;
    canvas.height = base.h;
    b = { canvas, image: null, version: -1 };
    baked.set(base, b);
    base.dirty0 = 0;
    base.dirty1 = base.h;
  }
  if (b.version !== base.version) {
    const g = b.canvas.getContext('2d');
    if (!g) return null;
    b.image ??= new ImageData(base.data as Uint8ClampedArray<ArrayBuffer>, base.w, base.h);
    const rows = takeDirty(base);
    if (rows) g.putImageData(b.image, 0, 0, 0, rows[0], base.w, rows[1] - rows[0]);
    b.version = base.version;
  }
  return b.canvas;
}

// ------------------------------------------------------------------------------------------------- glyphs

/** The glyph of a player's mark, `r` pixels in radius, centred on (x, y). */
export function drawPoiGlyph(g: CanvasRenderingContext2D, kind: PoiKind, x: number, y: number, r: number, color = POI_DEF[kind].color) {
  g.save();
  g.translate(x, y);
  g.fillStyle = color;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.lineWidth = 1.5;
  g.lineJoin = 'round';
  const dark = 'rgba(16,12,8,0.9)';
  g.beginPath();
  switch (kind) {
    case 'camp':
      // A tent with its door open.
      g.moveTo(0, -r * 1.05);
      g.lineTo(r * 1.1, r * 0.8);
      g.lineTo(-r * 1.1, r * 0.8);
      g.closePath();
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(0, -r * 0.1);
      g.lineTo(r * 0.32, r * 0.8);
      g.lineTo(-r * 0.32, r * 0.8);
      g.closePath();
      g.fillStyle = dark;
      g.fill();
      break;
    case 'fuel':
      // A jerrycan: body, handle notch and a spout.
      g.rect(-r * 0.75, -r * 0.7, r * 1.5, r * 1.6);
      g.fill();
      g.stroke();
      g.beginPath();
      g.rect(r * 0.15, -r * 1.12, r * 0.5, r * 0.42);
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(-r * 0.45, -r * 0.35);
      g.lineTo(r * 0.45, r * 0.6);
      g.moveTo(r * 0.45, -r * 0.35);
      g.lineTo(-r * 0.45, r * 0.6);
      g.strokeStyle = dark;
      g.lineWidth = 1.2;
      g.stroke();
      break;
    case 'loot':
      // A crate with its boards.
      g.rect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(-r * 0.85, 0);
      g.lineTo(r * 0.85, 0);
      g.moveTo(0, -r * 0.85);
      g.lineTo(0, r * 0.85);
      g.strokeStyle = dark;
      g.lineWidth = 1.1;
      g.stroke();
      break;
    case 'danger':
      // A round sign with an exclamation mark (the triangle is the hostile pin's).
      g.arc(0, 0, r * 0.98, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = dark;
      g.fillRect(-r * 0.13, -r * 0.62, r * 0.26, r * 0.72);
      g.fillRect(-r * 0.13, r * 0.28, r * 0.26, r * 0.26);
      break;
    case 'car':
      // A car from the side: body, roof and two wheels.
      g.moveTo(-r * 1.1, r * 0.35);
      g.lineTo(-r * 1.1, -r * 0.15);
      g.lineTo(-r * 0.55, -r * 0.2);
      g.lineTo(-r * 0.3, -r * 0.7);
      g.lineTo(r * 0.45, -r * 0.7);
      g.lineTo(r * 0.7, -r * 0.2);
      g.lineTo(r * 1.1, -r * 0.1);
      g.lineTo(r * 1.1, r * 0.35);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = dark;
      for (const wx of [-0.55, 0.55]) {
        g.beginPath();
        g.arc(wx * r, r * 0.45, r * 0.3, 0, Math.PI * 2);
        g.fill();
      }
      break;
    case 'water':
      // A drop.
      g.moveTo(0, -r * 1.15);
      g.bezierCurveTo(r * 0.5, -r * 0.45, r * 0.9, r * 0.05, r * 0.9, r * 0.32);
      g.arc(0, r * 0.32, r * 0.9, 0, Math.PI);
      g.bezierCurveTo(-r * 0.9, r * 0.05, -r * 0.5, -r * 0.45, 0, -r * 1.15);
      g.fill();
      g.stroke();
      break;
    case 'food':
      // An apple with a leaf.
      g.arc(0, r * 0.15, r * 0.85, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.beginPath();
      g.ellipse(r * 0.35, -r * 0.8, r * 0.38, r * 0.18, -0.6, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      break;
    case 'note':
      // A sheet with two lines on it.
      g.rect(-r * 0.75, -r * 0.95, r * 1.5, r * 1.9);
      g.fill();
      g.stroke();
      g.beginPath();
      for (const ly of [-0.35, 0.1, 0.55]) {
        g.moveTo(-r * 0.45, ly * r);
        g.lineTo(r * 0.45, ly * r);
      }
      g.strokeStyle = dark;
      g.lineWidth = 1;
      g.stroke();
      break;
    case 'star':
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const rr = k % 2 ? r * 0.48 : r * 1.15;
        if (k === 0) g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
      g.stroke();
      break;
  }
  g.restore();
}

/** A waypoint: a diamond in its owner's colour with a white rim and a dark pip. */
export function drawWaypointGlyph(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  g.save();
  g.translate(x, y);
  g.beginPath();
  g.moveTo(0, -r * 1.25);
  g.lineTo(r * 0.95, 0);
  g.lineTo(0, r * 1.25);
  g.lineTo(-r * 0.95, 0);
  g.closePath();
  g.lineJoin = 'round';
  g.lineWidth = 3.2;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.stroke();
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 1.3;
  g.strokeStyle = '#fff';
  g.stroke();
  g.beginPath();
  g.arc(0, 0, Math.max(1.2, r * 0.22), 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,0.75)';
  g.fill();
  g.restore();
}

/** A metres value as a round, short label for the grid and the scale bar. */
const metres = (m: number) => (m >= 1000 ? `${m / 1000} km` : `${m} m`);
/** The nice step (1, 2 or 5 times a power of ten) nearest above `v`. */
function niceStep(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, v))));
  for (const k of [1, 2, 5, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

interface StaticCache {
  c: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  cx: number;
  cz: number;
  scale: number;
  heading: number;
  /** CSS size of the cached picture (the area plus a margin all round). */
  w: number;
  h: number;
  dpr: number;
  key: string;
  bake: string;
  at: number;
}

/** Margin of the cached big-map picture beyond the visible area, so a pan only redraws once it has run out. */
const MARGIN = 120;

/** Draws the minimap and the larger map for one seat. Holds only drawing state, so every seat has its own. */
export class MapPainter {
  private proj = new MapProjection();
  private cacheProj = new MapProjection();
  private radius = 0;
  private dpr = 1;
  private box: MapRect = { x0: 0, x1: 0, z0: 0, z1: 0 };
  private cache: StaticCache | null = null;
  private lastScale = 0;
  private scaleAt = 0;
  /** Rows of the list of marks and of an open menu, as drawn: hit-tested against the cursor. */
  private listRows: { y0: number; y1: number; id: number; x: number; z: number; label: string }[] = [];
  private menuRows: { y0: number; y1: number; x0: number; x1: number }[] = [];
  /** Label boxes already placed this draw, so names do not pile on each other. */
  private placed: number[] = [];

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
    P.worldBox(0, 0, size, size, this.box);
    this.drawStatic(g, P, f, { size, overview: false, big: false });
    if (!f.base) this.rings(g, P, size);
    this.drawRoutes(g, P, f, 2.2);
    this.layers(g, P, f, v, { labels: false, rim: R - 8, size });
    this.drawMarks(g, P, f, v, { rim: R - 9, labels: false, u: 0.85 });
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

  /**
   * The bigger map, which the cursor works on: a window around you (mode 1) or the whole leg (mode 2), zoomed and panned
   * as the seat's `MapNav` says. The ground, roads and names come from a cached picture; the moving parts are drawn over it.
   */
  full(canvas: HTMLCanvasElement, f: MapFrame, v: MapView, nav: MapNav, mode: number, w: number, h: number, hint: string, u: number) {
    const g = this.prepare(canvas, w, h);
    if (!g) return;
    const now = performance.now();
    g.fillStyle = 'rgba(14,10,6,0.95)';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = AMBER;
    g.strokeRect(0.5, 0.5, w - 1, h - 1);
    const head = Math.round(22 * u);
    const foot = Math.round(20 * u);
    const mx = 10;
    const bx = mx;
    const by = head + 4;
    const bw = w - mx * 2;
    const bh = h - head - foot - 8;
    const overview = (mode >= 2 && f.overview) || f.mode === 'delve';
    if (nav.open !== mode) nav.reset(mode, v.x, v.z);
    nav.sizeTo(bw, bh, f.bounds, overview, f.mode === 'leg' ? LOCAL_REACH : Math.max(f.radiusMax * 1.6, 60));
    if (nav.follow) {
      nav.cx = v.x;
      nav.cz = v.z;
    }
    const P = nav.project(bx + bw / 2, by + bh / 2);
    // A copy, so the drawing helpers can use this.proj without moving the nav's own.
    const PP = this.proj.set(P.cx, P.cz, P.heading, P.scale, P.px, P.py);
    P.worldBox(bx, by, bx + bw, by + bh, this.box);
    if (PP.scale !== this.lastScale) {
      this.lastScale = PP.scale;
      this.scaleAt = now;
    }
    g.save();
    g.beginPath();
    g.rect(bx, by, bw, bh);
    g.clip();
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(bx, by, bw, bh);
    this.blitStatic(g, PP, f, bx, by, bw, bh, now, mode >= 2);
    if (!f.base) this.rings(g, PP, Math.min(bw, bh));
    this.drawRoutes(g, PP, f, 3);
    this.layers(g, PP, f, v, { labels: true, rim: 0, size: Math.min(bw, bh), overview: mode >= 2 });
    nav.hover = null;
    this.drawMarks(g, PP, f, v, { rim: 0, labels: true, u: 1, nav });
    const listW = this.drawList(g, f, v, nav, bx, by, bw, bh, u);
    nav.area.listX = listW > 0 ? bw / 2 - listW : Infinity;
    this.drawScale(g, PP, bx + 10, by + bh - 12, u);
    if (mode >= 2) this.drawLegend(g, f, bx + 10, by + bh - 34 * u, u);
    // The cursor, what it is on, and an open menu or name being typed.
    const cx = bx + bw / 2 + nav.sx;
    const cy = by + bh / 2 + nav.sy;
    this.drawCursor(g, cx, cy, nav, v.color);
    if (nav.menu) this.drawMenu(g, nav, cx, cy, bx, by, bw, bh, u);
    else if (nav.naming) this.drawNaming(g, nav, cx, cy, bx, by, bw, bh, u);
    else if (nav.hover) this.drawTip(g, nav.hover, cx, cy, v, nav, bx, by, bw, bh, u);
    nav.moved = false;
    g.restore();
    // Heading: title, view, and which way north is.
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = FONT(14 * u);
    g.fillStyle = '#ffe08a';
    g.fillText(`${f.title.toUpperCase()}${mode >= 2 && f.overview ? ' · WHOLE LEG' : ''}`, mx, head / 2 + 1);
    const n = { x: PP.x(PP.cx, PP.cz + 100) - PP.x(PP.cx, PP.cz), y: PP.y(PP.cx, PP.cz + 100) - PP.y(PP.cx, PP.cz) };
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
    g.textAlign = 'right';
    g.font = MONO(10 * u);
    g.fillStyle = 'rgba(233,223,199,0.6)';
    g.fillText(`${metres(niceStep(70 / PP.scale))} GRID`, w - mx - 28 * u, head / 2 + 1);
    // Footer: what the cursor is over (or the last thing done), and the buttons.
    g.textAlign = 'right';
    g.font = MONO(10 * u);
    g.fillStyle = 'rgba(233,223,199,0.85)';
    const hw = g.measureText(hint).width;
    g.fillText(hint, w - mx, h - foot / 2 - 1);
    g.textAlign = 'left';
    const cw = nav.cursorWorld();
    const dx = cw.x - v.x;
    const dz = cw.z - v.z;
    const bearing = ((Math.round((Math.atan2(-dx, dz) * 180) / Math.PI) % 360) + 360) % 360;
    const line = nav.flashT > 0 && nav.flash ? nav.flash.toUpperCase() : `⌖ ${Math.round(-cw.x)}E ${Math.round(cw.z)}N · ${distLabel(Math.hypot(dx, dz))} · ${String(bearing).padStart(3, '0')}° ${compassPoint(bearing)}`;
    g.fillStyle = nav.flashT > 0 && nav.flash ? '#ffe08a' : 'rgba(233,223,199,0.85)';
    if (g.measureText(line).width + hw + 20 < w - mx * 2) g.fillText(line, mx, h - foot / 2 - 1);
  }

  // ------------------------------------------------------------------ the cached picture of the big map

  /** Draw the static layers from the cache, redrawing the cache when the view has moved off it or the map changed. */
  private blitStatic(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame, bx: number, by: number, bw: number, bh: number, now: number, overview: boolean) {
    const dpr = this.dpr;
    const cw = Math.round(bw + MARGIN * 2);
    const ch = Math.round(bh + MARGIN * 2);
    const key = `${f.staticVersion}|${f.labels.length}|${overview ? 1 : 0}|${f.title}`;
    const bake = `${f.base?.version ?? 0}|${f.tiles?.version ?? 0}`;
    let c = this.cache;
    let redraw = !c || c.w !== cw || c.h !== ch || c.dpr !== dpr || c.heading !== P.heading || c.key !== key;
    if (c && !redraw) {
      const r = P.scale / c.scale;
      const X = P.x(c.cx, c.cz);
      const Y = P.y(c.cx, c.cz);
      const dw = cw * r;
      const dh = ch * r;
      const covers = X - dw / 2 <= bx + 0.5 && Y - dh / 2 <= by + 0.5 && X + dw / 2 >= bx + bw - 0.5 && Y + dh / 2 >= by + bh - 0.5;
      // A zoom is shown scaled from the cache while it moves, and redrawn sharp once it settles (or runs out of picture).
      if (!covers || r < 0.5 || r > 2 || (Math.abs(r - 1) > 1e-3 && now - this.scaleAt > 140)) redraw = true;
      // The ground still baking: fold the new rows in a few times a second, not every frame.
      else if (c.bake !== bake && now - c.at > 300) redraw = true;
    }
    if (redraw) {
      if (!c || c.w !== cw || c.h !== ch || c.dpr !== dpr) {
        const canvas = c?.c ?? document.createElement('canvas');
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        const cg = canvas.getContext('2d');
        if (!cg) return;
        c = this.cache = { c: canvas, g: cg, cx: 0, cz: 0, scale: 1, heading: 0, w: cw, h: ch, dpr, key, bake, at: now };
      }
      const cc = c!;
      cc.cx = P.cx;
      cc.cz = P.cz;
      cc.scale = P.scale;
      cc.heading = P.heading;
      cc.key = key;
      cc.bake = bake;
      cc.at = now;
      const cg = cc.g;
      cg.setTransform(dpr, 0, 0, dpr, 0, 0);
      cg.clearRect(0, 0, cw, ch);
      const CP = this.cacheProj.set(P.cx, P.cz, P.heading, P.scale, cw / 2, ch / 2);
      const keep = { ...this.box };
      CP.worldBox(0, 0, cw, ch, this.box);
      this.drawStatic(cg, CP, f, { size: Math.min(cw, ch), overview, big: true, w: cw, h: ch });
      this.box = keep;
    }
    const cc = this.cache!;
    const r = P.scale / cc.scale;
    const X = P.x(cc.cx, cc.cz);
    const Y = P.y(cc.cx, cc.cz);
    g.save();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'medium';
    g.drawImage(cc.c, X - (cc.w * r) / 2, Y - (cc.h * r) / 2, cc.w * r, cc.h * r);
    g.restore();
  }

  // ------------------------------------------------------------------ layers

  /** Ground, finer tiles, grid, water, roads, buildings, minefields and place names: what does not move. */
  private drawStatic(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame, o: { size: number; overview: boolean; big: boolean; w?: number; h?: number }) {
    this.ground(g, P, f);
    if (o.big && o.w && o.h) this.grid(g, P, o.w, o.h);
    this.waters(g, P, f);
    this.roads(g, P, f, o.overview);
    this.road(g, P, f);
    this.buildings(g, P, f);
    this.hazards(g, P, f);
    if (o.big) this.placeLabels(g, P, f);
  }

  private ground(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame) {
    const base = f.base;
    if (!base) return;
    const c = groundCanvas(base);
    if (!c) return;
    g.save();
    // Smoothed both ways: zoomed in, the ground pixels would otherwise show as blocks.
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const [a, b, cc, d, e, ff] = P.matrix(base.x0, base.z0, base.cell);
    g.transform(a, b, cc, d, e, ff);
    g.drawImage(c, 0, 0);
    g.restore();
    // Up close, the finer tiles over it (asked for here, baked by the scene a little each frame).
    const T = f.tiles;
    if (T && P.scale >= T.minScale) {
      T.want(this.box);
      T.forEach(this.box, (t) => {
        if (!t.canvas) return;
        g.save();
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        const [a2, b2, c2, d2, e2, f2] = P.matrix(t.x0, t.z0, t.cell);
        g.transform(a2, b2, c2, d2, e2, f2);
        // The image has a pixel of overlap all round: drawing only the tile's own square lets the edge blend into the next.
        g.drawImage(t.canvas, 1, 1, t.size, t.size, 0, 0, t.size, t.size);
        g.restore();
      });
    }
  }

  /** A faint metric grid, its step a round number that keeps the lines well apart at this zoom. */
  private grid(g: CanvasRenderingContext2D, P: MapProjection, w: number, h: number) {
    const step = niceStep(70 / P.scale);
    const b = this.box;
    g.save();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,236,200,0.07)';
    g.beginPath();
    let lines = 0;
    for (let x = Math.ceil(b.x0 / step) * step; x <= b.x1 && lines < 120; x += step, lines++) {
      g.moveTo(P.x(x, b.z0), P.y(x, b.z0));
      g.lineTo(P.x(x, b.z1), P.y(x, b.z1));
    }
    for (let z = Math.ceil(b.z0 / step) * step; z <= b.z1 && lines < 240; z += step, lines++) {
      g.moveTo(P.x(b.x0, z), P.y(b.x0, z));
      g.lineTo(P.x(b.x1, z), P.y(b.x1, z));
    }
    g.stroke();
    g.restore();
    void w;
    void h;
  }

  private near(r: { x0: number; x1: number; z0: number; z1: number }, pad: number) {
    const b = this.box;
    return r.x1 > b.x0 - pad && r.x0 < b.x1 + pad && r.z1 > b.z0 - pad && r.z0 < b.z1 + pad;
  }

  private line(g: CanvasRenderingContext2D, P: MapProjection, pts: number[]) {
    g.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      const x = P.x(pts[i], pts[i + 1]);
      const y = P.y(pts[i], pts[i + 1]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
  }

  /** Rivers and streams over the ground: the baked ground is too coarse for a stream a few metres wide. */
  private waters(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame) {
    if (!f.waters.length) return;
    const s = P.scale;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (const w of f.waters) {
      if (!this.near(w, 30)) continue;
      const width = Math.max(w.half > 3 ? 1.6 : 1, w.half * 2 * s);
      this.line(g, P, w.pts);
      // A darker bank under the water's own colour.
      if (width > 2.5) {
        g.strokeStyle = 'rgba(20,40,44,0.55)';
        g.lineWidth = width + 1.6;
        g.stroke();
      }
      g.strokeStyle = '#3f8fa2';
      g.lineWidth = width;
      g.stroke();
    }
    g.lineWidth = 1;
  }

  /**
   * The open world's roads by class: a dark casing under each, tracks as a fine dashed line only up close, roads in grey,
   * the highway wider and warmer with a centre line once it is wide enough to carry one. Widths follow the zoom (true width
   * when close) with a floor so a road never vanishes.
   */
  private roads(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame, overview: boolean) {
    if (!f.roads.length) return;
    const s = P.scale;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const draw = (r: MapRoad, col: string, width: number) => {
      this.line(g, P, r.pts);
      g.strokeStyle = col;
      g.lineWidth = width;
      g.stroke();
    };
    const widthOf = (r: MapRoad) => Math.max(r.kind === 'track' ? 1.1 : r.kind === 'road' ? 1.7 : 2.6, r.half * 2 * s);
    // Casings first, so crossings join cleanly.
    for (const kind of ['track', 'road', 'highway'] as const) {
      for (const r of f.roads) {
        if (r.kind !== kind || !this.near(r, 30)) continue;
        if (kind === 'track') {
          if (overview || s < 0.3) continue;
          continue;
        }
        draw(r, 'rgba(14,11,8,0.85)', widthOf(r) + (kind === 'highway' ? 2.4 : 2));
      }
    }
    for (const kind of ['track', 'road', 'highway'] as const) {
      for (const r of f.roads) {
        if (r.kind !== kind || !this.near(r, 30)) continue;
        const w = widthOf(r);
        if (kind === 'track') {
          if (overview || s < 0.3) continue;
          g.setLineDash(s > 1.2 ? [5, 3] : [3, 3]);
          draw(r, 'rgba(150,124,86,0.85)', w);
          g.setLineDash([]);
        } else if (kind === 'road') draw(r, '#8a8476', w);
        else {
          draw(r, '#b59a66', w);
          if (w > 7) {
            g.setLineDash([6, 7]);
            draw(r, 'rgba(250,236,190,0.55)', 1);
            g.setLineDash([]);
          }
        }
      }
    }
    g.lineWidth = 1;
  }

  /** A corridor leg's one road. */
  private road(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame) {
    if (!f.road || f.road.length <= 3) return;
    const w = Math.max(2, f.roadHalf * 2 * P.scale);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    this.line(g, P, f.road);
    g.strokeStyle = 'rgba(14,11,8,0.85)';
    g.lineWidth = w + 2;
    g.stroke();
    g.strokeStyle = f.mode === 'leg' && f.base && f.bounds.x1 - f.bounds.x0 < 400 ? '#6e675a' : '#8a8272';
    g.lineWidth = w;
    g.stroke();
    if (w > 8) {
      g.setLineDash([6, 7]);
      g.strokeStyle = 'rgba(250,236,190,0.45)';
      g.lineWidth = 1;
      g.stroke();
      g.setLineDash([]);
    }
    g.lineWidth = 1;
  }

  /** Footprints of the buildings, once close enough to tell one from the next. */
  private buildings(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame) {
    const B = f.buildings;
    if (!B || P.scale < 0.7) return;
    const b = this.box;
    const seen = new Set<number>();
    g.save();
    g.fillStyle = 'rgba(70,58,46,0.92)';
    g.strokeStyle = 'rgba(214,196,160,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    let n = 0;
    for (let ix = Math.floor(b.x0 / B.cell); ix <= Math.floor(b.x1 / B.cell); ix++) {
      for (let iz = Math.floor(b.z0 / B.cell); iz <= Math.floor(b.z1 / B.cell); iz++) {
        const list = B.grid.get(buildingKey(ix, iz));
        if (!list) continue;
        for (const i of list) {
          if (seen.has(i) || n > 900) continue;
          seen.add(i);
          n++;
          const x0 = B.boxes[i * 4];
          const z0 = B.boxes[i * 4 + 1];
          const x1 = B.boxes[i * 4 + 2];
          const z1 = B.boxes[i * 4 + 3];
          g.moveTo(P.x(x0, z0), P.y(x0, z0));
          g.lineTo(P.x(x1, z0), P.y(x1, z0));
          g.lineTo(P.x(x1, z1), P.y(x1, z1));
          g.lineTo(P.x(x0, z1), P.y(x0, z1));
          g.closePath();
        }
      }
    }
    g.fill();
    g.stroke();
    g.restore();
  }

  /** Mined ground, hatched. */
  private hazards(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame) {
    for (const poly of f.hazards) {
      this.line(g, P, poly);
      g.closePath();
      g.fillStyle = 'rgba(255,74,58,0.2)';
      g.fill();
      g.setLineDash([5, 4]);
      g.strokeStyle = 'rgba(255,90,70,0.8)';
      g.stroke();
      g.setLineDash([]);
    }
  }

  /** District, hub and street names in the map's own type, the bigger ones first, none on top of another. */
  private placeLabels(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame) {
    if (!f.labels.length) return;
    const s = P.scale;
    this.placed.length = 0;
    const order: MapLabel[] = f.labels.filter((l) => s >= l.min && s <= l.max && this.near({ x0: l.x, x1: l.x, z0: l.z, z1: l.z }, 200));
    const rank = { district: 0, hub: 1, town: 2, place: 3 } as const;
    order.sort((a, b) => rank[a.kind] - rank[b.kind]);
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (const l of order) {
      const x = P.x(l.x, l.z);
      const y = P.y(l.x, l.z);
      const size = l.kind === 'district' ? 17 : l.kind === 'hub' ? 13 : l.kind === 'town' ? 12 : 11;
      g.font = LABEL_FONT(size, l.kind === 'place' ? 500 : 700);
      const text = l.kind === 'place' ? l.text : l.text.toUpperCase().split('').join(l.kind === 'district' ? ' ' : '');
      const tw = g.measureText(text).width;
      if (!this.claim(x - tw / 2 - 3, y - size * 0.7, x + tw / 2 + 3, y + size * 0.7)) continue;
      g.lineWidth = 3.5;
      g.strokeStyle = 'rgba(10,8,6,0.8)';
      g.strokeText(text, x, y);
      g.fillStyle = l.kind === 'district' ? 'rgba(244,232,206,0.92)' : l.kind === 'hub' ? '#ffe08a' : l.kind === 'town' ? PAPER : 'rgba(233,223,199,0.82)';
      g.fillText(text, x, y);
    }
    g.restore();
  }

  /** Reserve a screen box for a label; false if it would sit on one already placed. */
  private claim(x0: number, y0: number, x1: number, y1: number): boolean {
    const p = this.placed;
    for (let i = 0; i < p.length; i += 4) if (x0 < p[i + 2] && x1 > p[i] && y0 < p[i + 3] && y1 > p[i + 1]) return false;
    p.push(x0, y0, x1, y1);
    return true;
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

  /** Each waypoint's route: a cased line in its owner's colour, dashed where it leaves the road. */
  private drawRoutes(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame, width: number) {
    const routes = f.nav.routes;
    if (!routes.length) return;
    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (const r of routes) {
      const n = r.pts.length / 2;
      if (n < 2) continue;
      const seg = (a: number, b: number, dash: boolean) => {
        if (b <= a) return;
        g.beginPath();
        for (let i = a; i <= b; i++) {
          const x = P.x(r.pts[i * 2], r.pts[i * 2 + 1]);
          const y = P.y(r.pts[i * 2], r.pts[i * 2 + 1]);
          if (i === a) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.setLineDash(dash ? [width * 2, width * 1.6] : []);
        g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.lineWidth = width + 2.4;
        g.stroke();
        g.strokeStyle = r.color;
        g.globalAlpha = 0.92;
        g.lineWidth = width;
        g.stroke();
        g.globalAlpha = 1;
      };
      if (r.direct || n === 2) seg(0, n - 1, true);
      else {
        seg(0, 1, true);
        seg(1, n - 2, false);
        seg(n - 2, n - 1, true);
      }
    }
    g.setLineDash([]);
    g.restore();
  }

  /** Pins, people on the ground, and the convoy. */
  private layers(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame, v: MapView, o: { labels: boolean; rim: number; size: number; overview?: boolean }) {
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
      g.fillStyle = b.kind === 'foe' ? '#ff4a3a' : b.kind === 'crew' ? '#7ddc7a' : b.kind === 'folk' ? '#e6ecf5' : '#c9b48a';
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
  }

  /**
   * The players' marks and waypoints. On the minimap a waypoint out of range sits on the rim with an arrow and its distance;
   * on the big map the one nearest the cursor becomes what the cursor is on (`nav.hover`).
   */
  private drawMarks(g: CanvasRenderingContext2D, P: MapProjection, f: MapFrame, v: MapView, o: { rim: number; labels: boolean; u: number; nav?: MapNav }) {
    const L = f.nav;
    const nav = o.nav;
    const cxs = nav ? P.px + nav.sx : 0;
    const cys = nav ? P.py + nav.sy : 0;
    let best: MapHover | null = null;
    let bd = 13;
    const consider = (h: MapHover, x: number, y: number, bonus = 0) => {
      if (!nav) return;
      const d = Math.hypot(x - cxs, y - cys) - bonus;
      if (d < bd) {
        bd = d;
        best = h;
      }
    };
    if (nav) {
      // Pins with a name can be pointed at too.
      for (const pin of f.pins) {
        if (pin.kind === 'river' || pin.kind === 'ping' || pin.kind === 'ambush') continue;
        const name = PIN_NAME[pin.kind];
        if (!name) continue;
        const label = pin.label && pin.label.length > 1 ? `${name}: ${pin.label}` : name;
        consider({ kind: 'pin', label, id: 0, x: pin.x, z: pin.z }, P.x(pin.x, pin.z), P.y(pin.x, pin.z));
      }
    }
    const r = 5.4 * o.u;
    for (const m of L.pois) {
      let x = P.x(m.x, m.z);
      let y = P.y(m.x, m.z);
      if (o.rim > 0) {
        const d = Math.hypot(x - P.px, y - P.py);
        if (d > o.rim) {
          if (!m.pin) continue;
          x = P.px + ((x - P.px) / d) * o.rim;
          y = P.py + ((y - P.py) / d) * o.rim;
        }
      }
      drawPoiGlyph(g, m.kind, x, y, r, m.color);
      if (o.labels && P.scale > 0.25) this.smallLabel(g, m.label, x, y + r + 2, m.color);
      consider({ kind: 'poi', label: m.label, id: m.id, x: m.x, z: m.z }, x, y, 2);
    }
    for (const w of L.waypoints) {
      let x = P.x(w.x, w.z);
      let y = P.y(w.x, w.z);
      const dist = Math.hypot(w.x - v.x, w.z - v.z);
      let edge = false;
      if (o.rim > 0) {
        const dx = x - P.px;
        const dy = y - P.py;
        const d = Math.hypot(dx, dy);
        if (d > o.rim) {
          // On the rim, pointing out toward it, with how far.
          x = P.px + (dx / d) * o.rim;
          y = P.py + (dy / d) * o.rim;
          edge = true;
          const a = Math.atan2(dy, dx);
          g.save();
          g.translate(x, y);
          g.rotate(a);
          g.beginPath();
          g.moveTo(9, 0);
          g.lineTo(2, -5);
          g.lineTo(2, 5);
          g.closePath();
          g.fillStyle = w.color;
          g.strokeStyle = 'rgba(0,0,0,0.85)';
          g.lineWidth = 1.5;
          g.stroke();
          g.fill();
          g.restore();
          x -= (dx / d) * 7;
          y -= (dy / d) * 7;
        }
      }
      drawWaypointGlyph(g, x, y, edge ? 4.2 : 5.6 * o.u, w.color);
      if (edge || (o.labels && w.seat === v.seat)) {
        const text = o.labels ? `WAYPOINT · ${distLabel(dist)}` : distLabel(dist);
        this.smallLabel(g, text, x, y + 8, w.color);
      }
      consider({ kind: 'waypoint', label: w.seat === v.seat ? 'Your waypoint' : 'Partner waypoint', id: w.seat, x: w.x, z: w.z }, x, y, 3);
    }
    if (nav) nav.hover = best;
  }

  private smallLabel(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
    g.font = MONO(10);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = 'rgba(0,0,0,0.85)';
    g.fillText(text, x + 1, y + 1);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  // ------------------------------------------------------------------ the big map's furniture

  /** The marks made on this leg, nearest first, in a column on the right. Returns its width (0 when there are none). */
  private drawList(g: CanvasRenderingContext2D, f: MapFrame, v: MapView, nav: MapNav, bx: number, by: number, bw: number, bh: number, u: number): number {
    const pois = f.nav.pois;
    this.listRows.length = 0;
    if (!pois.length) return 0;
    const W = Math.round(Math.min(bw * 0.34, Math.max(130, 168 * u)));
    const x0 = bx + bw - W;
    const rowH = Math.round(17 * u);
    const top = by + Math.round(20 * u);
    const rows = Math.max(1, Math.floor((bh - 26 * u) / rowH));
    const sorted = pois
      .map((p) => ({ p, d: Math.hypot(p.x - v.x, p.z - v.z) }))
      .sort((a, b) => a.d - b.d);
    const cxs = bx + bw / 2 + nav.sx;
    const cys = by + bh / 2 + nav.sy;
    const over = cxs >= x0;
    // Keep the row under the cursor in view: the list scrolls when the cursor pushes at its ends.
    if (over && cys > top + rows * rowH - rowH && nav.listTop + rows < sorted.length) nav.listTop++;
    if (over && cys < top + rowH * 0.6 && nav.listTop > 0) nav.listTop--;
    nav.listTop = Math.max(0, Math.min(nav.listTop, sorted.length - rows));
    g.save();
    g.fillStyle = 'rgba(14,10,6,0.82)';
    g.fillRect(x0, by, W, Math.min(bh, 26 * u + Math.min(rows, sorted.length) * rowH));
    g.strokeStyle = 'rgba(255,180,84,0.35)';
    g.beginPath();
    g.moveTo(x0 + 0.5, by);
    g.lineTo(x0 + 0.5, by + Math.min(bh, 26 * u + Math.min(rows, sorted.length) * rowH));
    g.stroke();
    g.font = FONT(11 * u);
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffe08a';
    g.fillText(`MARKS · ${pois.length}`, x0 + 8, by + 10 * u);
    for (let k = 0; k < rows && nav.listTop + k < sorted.length; k++) {
      const { p, d } = sorted[nav.listTop + k];
      const y0 = top + k * rowH;
      const hot = over && cys >= y0 && cys < y0 + rowH;
      if (hot) {
        g.fillStyle = 'rgba(255,224,138,0.12)';
        g.fillRect(x0 + 1, y0, W - 1, rowH);
        g.fillStyle = '#ffe08a';
        g.fillRect(x0 + 1, y0, 2, rowH);
        nav.hover = { kind: 'list', label: p.label, id: p.id, x: p.x, z: p.z };
      }
      drawPoiGlyph(g, p.kind, x0 + 14, y0 + rowH / 2, 4.6 * u, p.color);
      g.font = MONO(10 * u);
      g.textAlign = 'right';
      g.fillStyle = 'rgba(233,223,199,0.7)';
      const ds = distLabel(d);
      g.fillText(ds, x0 + W - 6, y0 + rowH / 2);
      const dw = g.measureText(ds).width;
      g.textAlign = 'left';
      g.fillStyle = hot ? '#fff6dc' : PAPER;
      g.fillText(fit(g, `${p.pin ? '• ' : ''}${p.label}`, W - 34 - dw), x0 + 24, y0 + rowH / 2);
      this.listRows.push({ y0, y1: y0 + rowH, id: p.id, x: p.x, z: p.z, label: p.label });
    }
    if (sorted.length > rows) {
      g.font = MONO(9 * u);
      g.textAlign = 'right';
      g.fillStyle = 'rgba(233,223,199,0.5)';
      g.fillText(`${nav.listTop + 1}-${Math.min(sorted.length, nav.listTop + rows)} of ${sorted.length}`, x0 + W - 6, by + 10 * u);
    }
    g.restore();
    return W;
  }

  /** A scale bar: a round length in metres. */
  private drawScale(g: CanvasRenderingContext2D, P: MapProjection, x: number, y: number, u: number) {
    const m = niceStep(90 / P.scale);
    const px = m * P.scale;
    g.save();
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x, y - 4);
    g.lineTo(x, y);
    g.lineTo(x + px, y);
    g.lineTo(x + px, y - 4);
    g.stroke();
    g.strokeStyle = PAPER;
    g.lineWidth = 1.5;
    g.stroke();
    g.font = MONO(10 * u);
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.fillStyle = 'rgba(0,0,0,0.85)';
    g.fillText(metres(m), x + px + 6, y + 2);
    g.fillStyle = PAPER;
    g.fillText(metres(m), x + px + 5, y + 1);
    g.restore();
  }

  /** The key to the markers, in a small box in the corner of the whole-leg view. */
  private drawLegend(g: CanvasRenderingContext2D, f: MapFrame, x: number, y: number, u: number) {
    const items: [string, (gx: number, gy: number) => void][] = [
      ['YOU', (gx, gy) => this.arrow(g, this.proj, { x: this.proj.worldX(gx, gy), z: this.proj.worldZ(gx, gy), yaw: this.proj.heading }, '#ff8a1f', 5, true)],
      ['CAMP', (gx, gy) => this.pin(g, { x: 0, z: 0, kind: 'camp' }, gx, gy, 0.75, false, 0, false)],
      [f.mode === 'delve' ? 'CHEST' : 'ENCOUNTER', (gx, gy) => this.pin(g, { x: 0, z: 0, kind: f.mode === 'delve' ? 'chest' : 'encounter' }, gx, gy, 0.75, false, 0, false)],
      ['SCAVENGE', (gx, gy) => this.pin(g, { x: 0, z: 0, kind: 'zone' }, gx, gy, 0.75, false, 0, false)],
      ['WAYPOINT', (gx, gy) => drawWaypointGlyph(g, gx, gy, 4.2, '#ff8a1f')],
      ['ROUTE', (gx, gy) => {
        g.strokeStyle = '#ff8a1f';
        g.lineWidth = 2.5;
        g.beginPath();
        g.moveTo(gx - 6, gy);
        g.lineTo(gx + 6, gy);
        g.stroke();
        g.lineWidth = 1;
      }],
    ];
    if (f.hazards.length) items.push(['MINES', (gx, gy) => {
      g.fillStyle = 'rgba(255,74,58,0.4)';
      g.fillRect(gx - 5, gy - 4, 10, 8);
    }]);
    g.save();
    g.font = MONO(9 * u);
    let w = 8;
    for (const [t] of items) w += g.measureText(t).width + 26;
    g.fillStyle = 'rgba(14,10,6,0.72)';
    g.fillRect(x - 4, y - 9 * u, w, 18 * u);
    let cx = x + 6;
    for (const [t, draw] of items) {
      draw(cx, y);
      g.font = MONO(9 * u);
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(233,223,199,0.8)';
      g.fillText(t, cx + 9, y + 0.5);
      cx += g.measureText(t).width + 26;
    }
    g.restore();
  }

  private drawCursor(g: CanvasRenderingContext2D, x: number, y: number, nav: MapNav, color: string) {
    g.save();
    const r = nav.hover ? 9 : 7;
    const gap = 3;
    g.lineCap = 'round';
    const cross = () => {
      g.beginPath();
      g.moveTo(x - r - 5, y);
      g.lineTo(x - gap, y);
      g.moveTo(x + gap, y);
      g.lineTo(x + r + 5, y);
      g.moveTo(x, y - r - 5);
      g.lineTo(x, y - gap);
      g.moveTo(x, y + gap);
      g.lineTo(x, y + r + 5);
    };
    cross();
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.lineWidth = 3;
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.2;
    g.stroke();
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 3;
    g.stroke();
    g.strokeStyle = nav.hover ? '#ffe08a' : color;
    g.lineWidth = 1.3;
    g.stroke();
    g.restore();
  }

  /** What the cursor is on: its name, how far, and what the buttons would do. */
  private drawTip(g: CanvasRenderingContext2D, h: MapHover, cx: number, cy: number, v: MapView, nav: MapNav, bx: number, by: number, bw: number, bh: number, u: number) {
    const lines = [h.label, `${distLabel(Math.hypot(h.x - v.x, h.z - v.z))}${h.kind === 'poi' || h.kind === 'list' ? ' · options: mark button' : h.kind === 'waypoint' ? ' · confirm to clear' : ''}`];
    if (h.kind === 'list') lines[1] = `${distLabel(Math.hypot(h.x - v.x, h.z - v.z))} · confirm to show`;
    void nav;
    this.box2(g, lines, cx + 14, cy + 12, bx, by, bw, bh, u, null);
  }

  /** A small panel of text lines near (x, y), kept inside the map area. */
  private box2(g: CanvasRenderingContext2D, lines: string[], x: number, y: number, bx: number, by: number, bw: number, bh: number, u: number, sel: number | null, colors?: (string | undefined)[], glyphs?: (PoiKind | undefined)[]) {
    g.save();
    g.font = MONO(10 * u);
    const pad = 6;
    const rowH = Math.round(15 * u);
    let w = 0;
    for (const l of lines) w = Math.max(w, g.measureText(l).width);
    const gw = glyphs ? 16 : 0;
    w += pad * 2 + gw;
    const h = lines.length * rowH + pad;
    let x0 = x;
    let y0 = y;
    if (x0 + w > bx + bw - 4) x0 = x - w - 28;
    if (y0 + h > by + bh - 4) y0 = by + bh - 4 - h;
    if (x0 < bx + 4) x0 = bx + 4;
    if (y0 < by + 4) y0 = by + 4;
    g.fillStyle = 'rgba(14,10,6,0.9)';
    g.fillRect(x0, y0, w, h);
    g.strokeStyle = 'rgba(255,180,84,0.45)';
    g.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    this.menuRows.length = 0;
    lines.forEach((l, i) => {
      const ry = y0 + pad / 2 + i * rowH;
      this.menuRows.push({ y0: ry, y1: ry + rowH, x0, x1: x0 + w });
      if (sel === i) {
        g.fillStyle = 'rgba(255,224,138,0.14)';
        g.fillRect(x0 + 1, ry, w - 2, rowH);
        g.fillStyle = '#ffe08a';
        g.fillRect(x0 + 1, ry, 2, rowH);
      }
      const gk = glyphs?.[i];
      if (gk) drawPoiGlyph(g, gk, x0 + pad + 5, ry + rowH / 2, 4.2 * u, colors?.[i]);
      g.fillStyle = sel === i ? '#fff6dc' : i === 0 && sel === null ? PAPER : colors?.[i] && !gk ? colors[i]! : 'rgba(233,223,199,0.85)';
      g.fillText(l, x0 + pad + gw, ry + rowH / 2 + 0.5);
    });
    g.restore();
    return { x0, y0, w, h };
  }

  /** The chooser of kinds, or what to do with a mark, by the cursor. The mouse picks a row by pointing at it. */
  private drawMenu(g: CanvasRenderingContext2D, nav: MapNav, cx: number, cy: number, bx: number, by: number, bw: number, bh: number, u: number) {
    const m = nav.menu!;
    const title = m.kind === 'kinds' ? 'MARK AS' : 'MARK';
    const lines = [title, ...m.items.map((i) => i.label)];
    const colors = [undefined, ...m.items.map((i) => (m.kind === 'kinds' ? i.color : i.color))];
    const glyphs = [undefined, ...m.items.map((i) => i.poi)];
    const sel = m.sel + 1;
    // Hit-test against last draw's rows before drawing this one.
    if (nav.moved && nav.mouse && this.menuRows.length === lines.length) {
      for (let i = 1; i < this.menuRows.length; i++) {
        const r = this.menuRows[i];
        if (cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy < r.y1) m.sel = i - 1;
      }
    }
    this.box2(g, lines, cx + 14, cy - 8, bx, by, bw, bh, u, sel, colors, glyphs);
  }

  /** The name being typed for a mark, with a caret. */
  private drawNaming(g: CanvasRenderingContext2D, nav: MapNav, cx: number, cy: number, bx: number, by: number, bw: number, bh: number, u: number) {
    const n = nav.naming!;
    const caret = Math.floor(performance.now() / 500) % 2 ? '▌' : ' ';
    const text = n.text ? `${n.text}${caret}` : `${caret}(${POI_DEF[n.kind].name})`;
    this.box2(g, ['NAME THIS MARK', text, 'type · Enter keeps it'], cx + 14, cy - 8, bx, by, bw, bh, u, 1, [undefined, POI_DEF[n.kind].color, undefined]);
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
      case 'falls':
        // A notch: water going over.
        g.beginPath();
        g.moveTo(x - r, y - r * 0.7);
        g.lineTo(x + r, y - r * 0.7);
        g.lineTo(x, y + r);
        g.closePath();
        g.fill();
        g.stroke();
        break;
      case 'spring':
      case 'lake':
        g.beginPath();
        g.arc(x, y, r * (pin.kind === 'lake' ? 0.9 : 0.75), 0, Math.PI * 2);
        g.fill();
        g.stroke();
        break;
      case 'swamp':
        g.beginPath();
        g.ellipse(x, y, r * 1.1, r * 0.6, 0, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        break;
      case 'river':
        // No marker: only its name, beside the water on the larger maps.
        break;
      case 'heritage':
        // A little tower with a crenellated top: a building with a name and a past.
        g.beginPath();
        g.moveTo(x - r * 0.8, y + r);
        g.lineTo(x - r * 0.8, y - r);
        g.lineTo(x - r * 0.4, y - r);
        g.lineTo(x - r * 0.4, y - r * 0.6);
        g.lineTo(x - r * 0.1, y - r * 0.6);
        g.lineTo(x - r * 0.1, y - r);
        g.lineTo(x + r * 0.2, y - r);
        g.lineTo(x + r * 0.2, y - r * 0.6);
        g.lineTo(x + r * 0.5, y - r * 0.6);
        g.lineTo(x + r * 0.5, y - r);
        g.lineTo(x + r * 0.8, y - r);
        g.lineTo(x + r * 0.8, y + r);
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
      // Water is named in italics, the way maps name it; everything else in the plain mono.
      const water = pin.kind === 'river' || pin.kind === 'lake' || pin.kind === 'falls' || pin.kind === 'spring' || pin.kind === 'swamp';
      g.font = water ? `italic ${LABEL_FONT(12, 600)}` : MONO(10);
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.fillStyle = 'rgba(0,0,0,0.85)';
      g.fillText(pin.label, x + 1, y + r + 2);
      g.fillStyle = PIN_COLOR[pin.kind];
      g.fillText(pin.label, x, y + r + 1);
    }
  }
}

/** The eight points of the compass for a bearing in degrees (0 north, 90 east). */
function compassPoint(b: number) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8];
}

/** Cut a line short with an ellipsis so it fits `w` pixels. */
function fit(g: CanvasRenderingContext2D, s: string, w: number) {
  if (g.measureText(s).width <= w) return s;
  let t = s;
  while (t.length > 1 && g.measureText(`${t}…`).width > w) t = t.slice(0, -1);
  return `${t}…`;
}

/** A compass pin as a map pin. */
export const asMapPin = (p: CompassPin): MapPin => ({ x: p.x, z: p.z, kind: p.kind, label: p.label });

void ({} as MapWater);
