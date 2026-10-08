import { clamp } from '../core/math';
import { Btn, isHeld, wasPressed, wasReleased, type PlayerIntent } from '../input/intents';
import { POI_DEF, POI_KINDS, cleanName, NAME_MAX, type PoiKind } from '../sim/navmarks';
import { distLabel } from '../render/navMarkers';
import type { NavActions } from '../game/navigation';
import type { Player } from '../game/player';
import { MapProjection, fitRect, headingFor, type MapRect } from './mapdata';

/**
 * The big map you can work: a cursor, zoom and pan, and what the buttons do on it. One `MapNav` per player holds where the
 * map looks and where the cursor is; the painter (`ui/minimap.ts`) draws from it and tells it what lies under the cursor,
 * and `mapNavInput` turns that seat's input into cursor moves and actions while the map is open.
 *
 * Controls. Mouse (captured): the cursor follows it, the wheel zooms at the cursor, a drag pans, left click sets a waypoint,
 * right click marks. Keys: the move keys move the cursor on foot, E sets a waypoint, R marks, 1 and 2 zoom (the camera key
 * recentres). Pad: left stick moves the cursor on foot (right stick pans), the right stick moves it while driving, A sets a
 * waypoint, X marks, LB and RB zoom (and LT/RT on foot), R3 recentres, B backs out. Driving goes on underneath: only the
 * look input and the buttons the map uses are taken.
 */

export interface MapHover {
  kind: 'poi' | 'pin' | 'waypoint' | 'list';
  label: string;
  /** A mark's id, or a waypoint's seat. */
  id: number;
  x: number;
  z: number;
}

export interface MenuItem {
  id: string;
  label: string;
  color?: string;
  poi?: PoiKind;
}

export interface MapMenu {
  kind: 'kinds' | 'poi';
  /** Where the cursor was when it opened (world). */
  x: number;
  z: number;
  poiId: number;
  items: MenuItem[];
  sel: number;
}

/** What the painter tells the input about the panel it drew. */
export interface MapArea {
  w: number;
  h: number;
  /** Cursor x (from the area's centre) beyond which it is over the list of marks, or Infinity when there is none. */
  listX: number;
}

/** Local view: this many metres from the centre to the panel's shorter edge. */
export const LOCAL_REACH = 520;
const CURSOR_SPEED = 520;
const PAN_SPEED = 640;
const ZOOM_RATE = 1.9;
const WHEEL_STEP = 1.28;
const DRAG_START = 6;
/** Closest zoom, pixels per metre. */
export const MAX_SCALE = 5;

export class MapNav {
  /** The map mode this was set up for; 0 while the map is closed. */
  open = 0;
  cx = 0;
  cz = 0;
  scale = 0;
  heading = 0;
  /** The view follows the player until it is panned. */
  follow = true;
  /** The cursor, in CSS pixels from the map area's centre. */
  sx = 0;
  sy = 0;
  /** Set by the painter each draw. */
  area: MapArea = { w: 800, h: 420, listX: Infinity };
  /** Waiting for the painter to size the view to the panel (the whole-leg fit needs the panel's size and the leg's bounds). */
  fit = true;
  /** Whole-map scale and the closest and widest zoom, set by the painter. */
  fitScale = 0.1;
  minScale = 0.02;
  hover: MapHover | null = null;
  menu: MapMenu | null = null;
  /** Typing a mark's name (keyboard only). */
  naming: { id: number; text: string; kind: PoiKind } | null = null;
  /** The cursor moved since the painter last looked: hovering a menu row picks it. */
  moved = false;
  /** Seconds the cursor has been still, so a tooltip waits for it to settle. */
  still = 0;
  device: 'pad' | 'keyboard' | 'none' = 'none';
  mouse = false;
  /** A short line of feedback in the footer ("Waypoint set · 1.2 km"), and how long it stays. */
  flash = '';
  flashT = 0;
  /** The list of marks beside the map: its first row (scrolls to keep the selected one in view). */
  listTop = 0;
  private drag: { moved: number; on: boolean } | null = null;
  private stickT = 0;
  readonly proj = new MapProjection();

  /** The projection for the map area, centred at (px, py) on screen. */
  project(px: number, py: number): MapProjection {
    return this.proj.set(this.cx, this.cz, this.heading, this.scale, px, py);
  }

  /** The world point under the cursor. */
  cursorWorld(): { x: number; z: number } {
    const P = this.project(0, 0);
    return { x: P.worldX(this.sx, this.sy), z: P.worldZ(this.sx, this.sy) };
  }

  /** Set up for a newly opened map mode: the local view on the player, or the whole leg. */
  reset(mode: number, x: number, z: number) {
    this.open = mode;
    this.cx = x;
    this.cz = z;
    this.heading = 0;
    this.follow = mode === 1;
    this.sx = 0;
    this.sy = 0;
    this.scale = Math.min(this.area.w, this.area.h) / 2 / LOCAL_REACH;
    this.fit = true;
    this.menu = null;
    this.endNaming(false);
    this.drag = null;
    this.hover = null;
    this.flash = '';
  }

  close() {
    this.open = 0;
    this.menu = null;
    this.endNaming(false);
    this.drag = null;
    this.hover = null;
  }

  /**
   * Size the view to the panel once its size is known: the local view keeps its reach, the whole-leg view fits the leg
   * (north up, or turned when the leg runs along the panel). Called by the painter.
   */
  sizeTo(w: number, h: number, bounds: MapRect, overview: boolean, localReach: number) {
    const fitHeading = overview ? headingFor(bounds, w, h) : 0;
    const whole = fitRect(bounds, fitHeading, w, h, 6);
    this.fitScale = whole.scale;
    this.minScale = Math.min(whole.scale * 0.8, 0.05);
    if (this.fit) {
      this.fit = false;
      if (overview) {
        this.heading = fitHeading;
        this.scale = whole.scale;
        this.cx = whole.cx;
        this.cz = whole.cz;
        this.follow = false;
      } else this.scale = Math.min(w, h) / 2 / localReach;
    }
    this.area.w = w;
    this.area.h = h;
  }

  /** Zoom by a factor, keeping the world point under the cursor where it is. */
  zoomBy(f: number) {
    const s1 = clamp(this.scale * f, this.minScale, MAX_SCALE);
    if (s1 === this.scale) return;
    const w = this.cursorWorld();
    this.scale = s1;
    const P = this.project(0, 0);
    // After the change the cursor's screen point shows a different spot: move the centre by the difference.
    this.cx += w.x - P.worldX(this.sx, this.sy);
    this.cz += w.z - P.worldZ(this.sx, this.sy);
    if (this.follow && (this.sx || this.sy)) this.follow = false;
  }

  /** Pan so the map's content moves by (dx, dy) screen pixels. */
  panBy(dx: number, dy: number) {
    if (!dx && !dy) return;
    const P = this.project(0, 0);
    const x = P.worldX(-dx, -dy);
    const z = P.worldZ(-dx, -dy);
    this.cx = x;
    this.cz = z;
    this.follow = false;
  }

  /** Move the cursor by screen pixels; past the edge of the area the map pans instead. */
  moveCursor(dx: number, dy: number) {
    if (!dx && !dy) return;
    const hw = this.area.w / 2 - 4;
    const hh = this.area.h / 2 - 4;
    const nx = this.sx + dx;
    const ny = this.sy + dy;
    const cx = clamp(nx, -hw, hw);
    const cy = clamp(ny, -hh, hh);
    // Pushing on the edge scrolls the map the other way (content slides in from where the cursor points).
    if (nx !== cx || ny !== cy) this.panBy(cx - nx, cy - ny);
    this.sx = cx;
    this.sy = cy;
    this.moved = true;
    this.still = 0;
  }

  /** Back to the player, cursor in the middle. */
  recentre(x: number, z: number) {
    this.cx = x;
    this.cz = z;
    this.sx = 0;
    this.sy = 0;
    this.follow = true;
    this.moved = true;
  }

  say(text: string, secs = 2.2) {
    this.flash = text;
    this.flashT = secs;
  }

  startNaming(id: number, kind: PoiKind, text = '') {
    this.naming = { id, kind, text };
    naming = this;
    listen();
  }

  /** Finish typing a name: which mark, and the name to keep (null to leave it as it was). */
  endNaming(keep: boolean): { id: number; text: string | null } | null {
    const n = this.naming;
    this.naming = null;
    if (naming === this) naming = null;
    return n ? { id: n.id, text: keep ? cleanName(n.text) : null } : null;
  }

  /** The keys while naming: letters and digits, Backspace, Enter to keep the name (or none, for the kind's own). */
  key(e: KeyboardEvent): 'done' | 'cancel' | null {
    const n = this.naming;
    if (!n) return null;
    if (e.key === 'Enter' || e.key === 'NumpadEnter') return 'done';
    if (e.key === 'Escape') return 'cancel';
    if (e.key === 'Backspace') n.text = n.text.slice(0, -1);
    else if (e.key === 'Delete') n.text = '';
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && n.text.length < NAME_MAX) n.text += e.key;
    return null;
  }

  /** Called by the input each tick with what the move and look gave, in pixels and stick values. */
  steer(dt: number, it: PlayerIntent, p: Player, sens: number, invertY: boolean) {
    const driving = p.state === 'driving';
    const pad = it.device === 'pad';
    // The mouse: the cursor follows it one to one.
    if (it.mouse) {
      const k = 0.0022 * sens;
      const dx = it.lookDelta[0] / k;
      const dy = (-it.lookDelta[1] / k) * (invertY ? -1 : 1);
      if (this.drag?.on) {
        // Dragging: the map goes with the hand, the cursor stays on the spot it grabbed.
        this.panBy(dx, dy);
      } else {
        if (this.drag) this.drag.moved += Math.hypot(dx, dy);
        if (this.drag && this.drag.moved > DRAG_START) this.drag.on = true;
        if (!this.menu || !this.drag) this.moveCursor(dx, dy);
      }
    }
    // Sticks and keys: the left stick (or move keys) on foot, the right stick (or turn keys) while driving.
    const stick = driving ? it.look : it.move;
    const sx = stick[0];
    const sy = stick[1];
    const mag = Math.hypot(sx, sy);
    if (mag > 0.12 && !(this.menu && !it.mouse)) {
      this.stickT += dt;
      const boost = this.stickT > 0.7 ? 1.7 : 1;
      const k = (CURSOR_SPEED * boost * Math.pow(Math.min(1, mag), 1.6) * dt) / mag;
      this.moveCursor(sx * k, -sy * k);
    } else this.stickT = 0;
    // The right stick on foot pans the map under the cursor.
    if (pad && !driving) {
      const rx = it.look[0];
      const ry = it.look[1];
      if (Math.hypot(rx, ry) > 0.15) this.panBy(-rx * PAN_SPEED * dt, ry * PAN_SPEED * dt);
    }
    this.still += dt;
  }

  /** The mouse button that both clicks and drags: pressed starts a possible drag, released is a click unless it dragged. */
  pressDrag() {
    this.drag = { moved: 0, on: false };
  }
  releaseDrag(): boolean {
    const click = !!this.drag && !this.drag.on;
    this.drag = null;
    return click;
  }
  get dragging() {
    return !!this.drag?.on;
  }
}

const NAVS = new WeakMap<Player, MapNav>();

/** Each player's map state. */
export function navOf(p: Player): MapNav {
  let n = NAVS.get(p);
  if (!n) {
    n = new MapNav();
    NAVS.set(p, n);
  }
  return n;
}

// ---------------------------------------------------------------- typing a name

/** The map that is taking typed keys right now (only one at a time: there is one keyboard). */
let naming: MapNav | null = null;
let listening = false;
/** Where a finished name goes: set by the scene whose map is open (`mapNavInput`). */
let commit: ((done: { id: number; text: string | null } | null) => void) | null = null;

/**
 * While a name is typed, keys go to it and not to the game: a listener ahead of the input manager's (capture phase on the
 * window) takes the key downs. Key ups pass, so keys held before typing started are still let go.
 */
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(
    'keydown',
    (e) => {
      const n = naming;
      if (!n?.naming) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat && e.key !== 'Backspace') return;
      const r = n.key(e);
      if (r) commit?.(n.endNaming(r === 'done'));
    },
    { capture: true },
  );
}

// ---------------------------------------------------------------- input

export interface MapNavHost {
  navActions: NavActions | null;
  input: { settings: { mouseSens: number; invertLookY: [boolean, boolean] } };
  audio: { play(id: 'click' | 'deny', x?: number, z?: number, vol?: number): void };
}

const bit = (b: number) => 1 << b;
/** Buttons the open map takes on foot and in the gunner's seat, and the ones it takes while driving (the pedals stay). */
const TAKE_FOOT = [Btn.A, Btn.X, Btn.B, Btn.LB, Btn.RB, Btn.LT, Btn.RT, Btn.R3, Btn.Jump, Btn.Left, Btn.Right, Btn.L3].reduce<number>((m, b) => m | bit(b), 0);
const TAKE_DRIVE_PAD = [Btn.A, Btn.X, Btn.B, Btn.LB, Btn.RB, Btn.R3].reduce<number>((m, b) => m | bit(b), 0);
const TAKE_DRIVE_KB = [Btn.A, Btn.X, Btn.RB, Btn.RT, Btn.LT, Btn.R3, Btn.Left, Btn.Right, Btn.LB].reduce<number>((m, b) => m | bit(b), 0);

/**
 * One tick of the open big map for a player: move the cursor and the view, act on the buttons, and take from the intent
 * what the map used so the player does not also fire, jump or look about. Called from `Player.update` while `mapMode > 0`.
 */
export function mapNavInput(host: MapNavHost, p: Player, it: PlayerIntent, dt: number) {
  const nav = navOf(p);
  const at = p.vehicle ? p.vehicle.position : p.pos;
  if (nav.open !== p.mapMode) nav.reset(p.mapMode, at.x, at.z);
  commit = (done) => {
    if (done && done.text !== null) host.navActions?.renamePoi(done.id, done.text);
  };
  nav.device = it.device;
  nav.mouse = it.mouse;
  if (nav.flashT > 0) nav.flashT -= dt;
  const driving = p.state === 'driving';
  const pad = it.device === 'pad';
  const kb = it.device === 'keyboard';
  if (nav.follow) {
    nav.cx = at.x;
    nav.cz = at.z;
  }
  if (nav.naming) {
    // Typing: the game hears nothing from this seat but the pedals.
    strip(it, driving, true);
    return;
  }
  const s = host.input.settings;
  nav.steer(dt, it, p, s.mouseSens, s.invertLookY[p.index] ?? false);
  // Zoom.
  let z = 0;
  if (pad) {
    if (isHeld(it, Btn.RB)) z += 1;
    if (isHeld(it, Btn.LB)) z -= 1;
    if (!driving) z += (it.rt > 0.2 ? it.rt : 0) - (it.lt > 0.2 ? it.lt : 0);
  } else if (kb) {
    if (isHeld(it, Btn.Right)) z += 1;
    if (isHeld(it, Btn.Left) || isHeld(it, Btn.LB)) z -= 1;
  }
  if (z) nav.zoomBy(Math.exp(z * ZOOM_RATE * dt));
  if (it.toolStep) nav.zoomBy(it.toolStep > 0 ? 1 / WHEEL_STEP : WHEEL_STEP);
  if (wasPressed(it, Btn.R3)) {
    nav.recentre(at.x, at.z);
    host.audio.play('click', undefined, undefined, 0.3);
  }
  // Confirm and mark. A mouse or the fire key clicks on release, so a press that turns into a drag is not a click.
  let confirm = wasPressed(it, Btn.A);
  let mark = wasPressed(it, Btn.X);
  if (kb) {
    if (wasPressed(it, Btn.RT)) nav.pressDrag();
    if (wasReleased(it, Btn.RT) && nav.releaseDrag()) confirm = true;
    if (wasPressed(it, Btn.LT)) mark = true;
  } else if (pad && !isHeld(it, Btn.RT)) nav.releaseDrag();
  const back = pad && wasPressed(it, Btn.B);
  const acts = host.navActions;
  if (nav.menu) {
    const m = nav.menu;
    if (it.nav & 1) m.sel = (m.sel + m.items.length - 1) % m.items.length;
    if (it.nav & 2) m.sel = (m.sel + 1) % m.items.length;
    if (confirm) pickMenu(host, p, nav);
    else if (mark || back) {
      nav.menu = null;
      host.audio.play('click', undefined, undefined, 0.25);
    }
  } else if (confirm) {
    const h = nav.hover;
    if (!acts) nav.say('No waypoints on this map');
    else if (h?.kind === 'list') {
      // A row of the list: go and look at that mark, cursor on it.
      nav.cx = h.x;
      nav.cz = h.z;
      nav.sx = 0;
      nav.sy = 0;
      nav.follow = false;
      nav.say(`${h.label} · ${distLabel(Math.hypot(h.x - at.x, h.z - at.z))} · confirm again to set a waypoint`, 3);
      host.audio.play('click', undefined, undefined, 0.3);
    } else {
      const w = h && (h.kind === 'poi' || h.kind === 'waypoint' || h.kind === 'pin') ? h : nav.cursorWorld();
      const on = acts.toggleWaypoint(p.index, w.x, w.z);
      nav.say(on ? `Waypoint set · ${distLabel(Math.hypot(w.x - at.x, w.z - at.z))}` : 'Waypoint cleared');
    }
  } else if (mark) {
    const h = nav.hover;
    if (!acts) nav.say('No marks on this map');
    else if (h && (h.kind === 'poi' || h.kind === 'list')) {
      const poi = acts.pois().find((q) => q.id === h.id);
      if (poi) {
        const items: MenuItem[] = [{ id: 'go', label: 'Navigate here' }];
        if (kb) items.push({ id: 'rename', label: 'Rename' });
        items.push({ id: 'pin', label: poi.pin ? 'Unpin from compass' : 'Pin to compass' }, { id: 'delete', label: 'Delete', color: '#ff8a6a' });
        nav.menu = { kind: 'poi', x: poi.x, z: poi.z, poiId: poi.id, items, sel: 0 };
      }
    } else {
      const w = nav.cursorWorld();
      nav.menu = { kind: 'kinds', x: w.x, z: w.z, poiId: 0, items: POI_KINDS.map((k) => ({ id: k, label: POI_DEF[k].name, color: POI_DEF[k].color, poi: k })), sel: 0 };
    }
    if (nav.menu) host.audio.play('click', undefined, undefined, 0.3);
  } else if (back) {
    // B with nothing open closes the map.
    p.mapMode = 0;
    nav.close();
  }
  strip(it, driving, !!nav.menu || !!nav.naming);
}

/**
 * Take what the map used from the intent, so the player does not act on it too: on foot everything but the chores and the
 * menus' own buttons; driving, only the look and the map's buttons, so the car is still driven (on keys the move keys are
 * throttle and steering, on a pad the triggers and the left stick).
 */
function strip(it: PlayerIntent, driving: boolean, menu = false) {
  const pad = it.device === 'pad';
  // With a menu open, the D-pad steps through it: it must not also open the quick belt or the wheel.
  const mask = (!driving ? TAKE_FOOT : pad ? TAKE_DRIVE_PAD : TAKE_DRIVE_KB) | (menu && pad ? bit(Btn.Up) | bit(Btn.Down) : 0);
  it.held &= ~mask;
  it.pressed &= ~mask;
  it.released &= ~mask;
  it.look[0] = 0;
  it.look[1] = 0;
  it.lookDelta[0] = 0;
  it.lookDelta[1] = 0;
  it.toolStep = 0;
  it.stickLoops = 0;
  // The seat is aimed by the map now: the camera must not turn with the mouse either.
  it.mouse = false;
  if (!driving) {
    it.move[0] = 0;
    it.move[1] = 0;
    it.sprint = false;
    it.handbrake = false;
    it.lt = 0;
    it.rt = 0;
  } else if (pad) {
    // A is the map's confirm, not the handbrake.
    it.handbrake = false;
  } else {
    // On keys the fire button is the map's click.
    it.lt = 0;
    it.rt = 0;
  }
}

function pickMenu(host: MapNavHost, p: Player, nav: MapNav) {
  const m = nav.menu!;
  const acts = host.navActions;
  const item = m.items[m.sel];
  nav.menu = null;
  if (!acts || !item) return;
  if (m.kind === 'kinds') {
    const poi = acts.addPoi(p.index, m.x, m.z, item.poi!);
    nav.say(`Marked: ${POI_DEF[item.poi!].name}`);
    // On keys, a name can be typed for it straight away.
    if (nav.device === 'keyboard') nav.startNaming(poi.id, poi.kind);
    return;
  }
  const poi = acts.pois().find((q) => q.id === m.poiId);
  if (!poi) return;
  if (item.id === 'go') {
    const at = p.vehicle ? p.vehicle.position : p.pos;
    if (!acts.waypoint(p.index) || Math.hypot(acts.waypoint(p.index)!.x - poi.x, acts.waypoint(p.index)!.z - poi.z) > 1) acts.toggleWaypoint(p.index, poi.x, poi.z);
    nav.say(`Waypoint set · ${distLabel(Math.hypot(poi.x - at.x, poi.z - at.z))}`);
  } else if (item.id === 'rename') nav.startNaming(poi.id, poi.kind, poi.name);
  else if (item.id === 'pin') {
    acts.togglePin(poi.id);
    nav.say(poi.pin ? 'Pinned to the compass' : 'Unpinned');
  } else if (item.id === 'delete') {
    acts.removePoi(poi.id);
    nav.hover = null;
    nav.say('Mark deleted');
  }
}
