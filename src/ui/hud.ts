import { setMarkerUiScale } from '../render/markers';
import { gearDef, t } from '../data';
import { DRUGS } from '../sim/drugs';
import { STAMINA, bleedLabel, wearLabel, wearOf } from '../sim/vitals';
import { ARCHERY } from '../sim/archery';
import { canRelieve, isNeedAct, needChips, type NeedAct } from '../sim/needs';
import type { Campaign } from '../game/campaign';
import { LABEL, whole } from '../sim/resources';
import { loyaltyBand } from '../sim/loyalty';
import { SALVAGE_STAGES } from '../sim/salvage';
import { OIL_CRITICAL, OIL_LOW } from '../sim/oil';
import { COOLANT_CRITICAL, COOLANT_LOW } from '../sim/fluids';
import { T_HOT, T_MAX, T_OVERHEAT } from '../sim/thermal';
import { fuelMismatch } from '../sim/fuel';
import { carriedName } from '../sim/carry';
import { formatClock, wrapAngle, clamp, clamp01 } from '../core/math';
import { PLAYER_CSS } from '../render/palette';
import type { Scene, CompassPin } from '../game/scene';
import type { LegScene } from '../game/legScene';
import type { CampScene } from '../game/campScene';
import { QUICK, type Player, type QuickId } from '../game/player';
import { heldItem } from '../sim/gear';
import type { Vehicle } from '../game/vehicle';
import { promptLabel, type Slot } from '../input/input';
import type { MapFrame } from './mapdata';
import { MapPainter, PIN_COLOR, drawPoiGlyph, drawWaypointGlyph } from './minimap';
import { navOf } from './mapnav';
import { distLabel } from '../render/navMarkers';
import { keyLabel, live } from '../input/bindings';
import { heatLabel, stormLabel, stormMapRadius, windAt } from '../sim/weather';
import { STALK } from '../sim/hunting';
import { wildSlot } from '../game/wildShrooms';
import { glanceExtras, glanceVehicle, updateCarHud, type CarHudState } from './carCard';
import { updateDrugStrip } from './drugStrip';

/** The key or button a prompt names, as this seat has it bound. */
export function btnLabel(slot: Slot | null, btn: string): string {
  return promptLabel(slot, btn);
}

class PlayerHud {
  root: HTMLElement;
  private q = new Map<string, HTMLElement>();
  private last = new Map<string, string>();
  private compass: HTMLCanvasElement;
  private cctx: CanvasRenderingContext2D;
  private dpr = 1;
  readonly painter = new MapPainter();
  constructor(
    host: HTMLElement,
    public index: number,
  ) {
    const color = PLAYER_CSS[index];
    host.innerHTML = `
    <div class="hud" style="--pc:${color}">
      <div class="gray" data-k="gray"></div>
      <div class="vignette" data-k="vig"></div>
      <div class="drugfx" data-k="drugfx"></div>
      <div class="underwater" data-k="uw"></div>
      <div class="belt" data-k="belt"></div>
      <div class="corner tl">
        <div class="pane ident">
          <div class="who"><span class="pcolor" style="background:${color}"></span><span data-k="name"></span></div>
          <div class="sighead"><span data-k="siglabel">NOISE</span><span class="val" data-k="sigval">0</span></div>
          <div class="sig" data-k="sigbar"><div class="fill" data-k="sigfill"></div></div>
          <div class="sighint" data-k="sighint"></div>
        </div>
        <div class="chips" data-k="chips"></div>
        <div class="objective" data-k="obj"></div>
      </div>
      <div class="toast" data-k="toast"></div>
      <div class="corner tc">
        <canvas class="compass" data-k="compass"></canvas>
        <div class="pane trip">
          <div class="tline"><span class="clock" data-k="clock"></span><span class="daytag" data-k="daytag"></span></div>
          <div class="legbar" data-k="legbar"><div class="fill" data-k="legfill"></div><div class="dusk" data-k="legdusk"></div><div class="me" data-k="legme"></div></div>
        </div>
      </div>
      <div class="corner tr">
        <canvas class="minimap" data-k="minimap"></canvas>
      </div>
      <div class="corner bl">
        <div class="pane vitals">
          <div class="vhead"><span data-k="vname">ON FOOT</span><div class="speed" data-k="speed">0<small>km/h</small></div></div>
          <div class="tach" data-k="tach"><div class="fill" data-k="tachfill"></div></div>
          <div class="gauge hp" data-k="hprow"><span class="gl" data-k="hplabel">HEALTH</span><div class="bar" data-k="hpbar"><div class="fill" data-k="hpfill"></div></div><span class="val" data-k="hpval"></span></div>
          <div class="gauge stamina" data-k="stamrow"><span class="gl">STAMINA</span><div class="bar stam" data-k="stambar"><div class="fill" data-k="stamfill"></div></div><span class="val" data-k="stamval"></span></div>
          <div class="gauge breath" data-k="breathrow"><span class="gl">BREATH</span><div class="bar air" data-k="airbar"><div class="fill" data-k="airfill"></div></div><span class="val" data-k="airval"></span></div>
          <div class="gauge" data-k="fuelrow"><span class="gl">FUEL</span><div class="bar fuel" data-k="fuelbar"><div class="fill" data-k="fuelfill"></div></div><span class="val" data-k="fuelval"></span></div>
          <div class="gauge" data-k="oilrow"><span class="gl">OIL</span><div class="bar oil" data-k="oilbar"><div class="fill" data-k="oilfill"></div></div><span class="val" data-k="oilval"></span></div>
          <div class="gauge" data-k="waterrow"><span class="gl">COOLANT</span><div class="bar water" data-k="waterbar"><div class="fill" data-k="waterfill"></div></div><span class="val" data-k="waterval"></span></div>
          <div class="gauge" data-k="temprow"><span class="gl">ENGINE</span><div class="bar temp" data-k="tempbar"><div class="fill" data-k="tempfill"></div></div><span class="val" data-k="tempval"></span></div>
          <div class="faults" data-k="comp"></div>
        </div>
      </div>
      <div class="corner br">
        <div class="pane gunbox">
          <div class="wname" data-k="wname">PISTOL</div>
          <div class="ammo" data-k="ammo">12<small>/90</small></div>
          <div class="equip" data-k="equip"></div>
        </div>
        <div class="supplies" data-k="stocks"></div>
      </div>
      <div class="bc">
        <div class="vread" data-k="vread"></div>
        <div class="notes" data-k="notes"></div>
        <div class="prompt" data-k="prompt"><span class="btn" data-k="pbtn">A</span><span data-k="ptext"></span><div class="hold" data-k="phold"></div></div>
        <div class="prompt alt" data-k="prompt2"><span class="btn x" data-k="pbtn2">X</span><span data-k="ptext2"></span></div>
      </div>
      <div class="reticle" data-k="reticle"><div class="drawring" data-k="drawring"></div></div>
      <div class="handdot" data-k="handdot"></div>
      <div class="lookinfo" data-k="look"></div>
      <div class="handhints" data-k="hands"></div>
      <div class="carcard" data-k="carcard"></div>
      <div class="trunk" data-k="trunk"></div>
      <div class="carbk" data-k="carbk"></div>
      <div class="mapfull" data-k="mapfull"><canvas data-k="mapcv"></canvas></div>
      <div class="msgs"><div class="sub" data-k="sub"></div><div class="tipbox" data-k="tip"></div></div>
      <div class="banner" data-k="banner"></div>
      <div class="tether" data-k="tether">PARTNER TOO FAR: REGROUP</div>
      <div class="center-msg" data-k="cmsg"><div class="big" data-k="cbig"></div><div class="small" data-k="csmall"></div></div>
      <div class="wheel" data-k="wheel"></div>
      <div class="sheet" data-k="sheet"></div>
      <div class="build-hud" data-k="build"></div>
      <div class="disc" data-k="disc"><div><h2 data-k="dtitle">CONTROLLER DISCONNECTED</h2><p>Reconnect the pad or press a key to continue.</p></div></div>
    </div>`;
    this.root = host.firstElementChild as HTMLElement;
    host.querySelectorAll<HTMLElement>('[data-k]').forEach((el) => this.q.set(el.dataset.k!, el));
    this.q.set('root', this.root);
    this.compass = this.q.get('compass') as unknown as HTMLCanvasElement;
    this.cctx = this.compass.getContext('2d')!;
    this.q.get('name')!.textContent = '';
  }

  el(k: string) {
    return this.q.get(k)!;
  }

  setText(k: string, v: string) {
    if (this.last.get(k) === v) return;
    this.last.set(k, v);
    this.q.get(k)!.textContent = v;
  }
  setHtml(k: string, v: string) {
    if (this.last.get(k) === v) return;
    this.last.set(k, v);
    this.q.get(k)!.innerHTML = v;
  }
  setStyle(k: string, prop: string, v: string) {
    const key = `${k}:${prop}`;
    if (this.last.get(key) === v) return;
    this.last.set(key, v);
    const style = this.q.get(k)!.style;
    // Custom properties (the --trip and --haze the stylesheet reads) only take through setProperty.
    if (prop.startsWith('--')) style.setProperty(prop, v);
    else (style as unknown as Record<string, string>)[prop] = v;
  }
  setClass(k: string, v: string) {
    const key = `${k}:class`;
    if (this.last.get(key) === v) return;
    this.last.set(key, v);
    const base = this.q.get(k)!.dataset.base ?? (this.q.get(k)!.dataset.base = this.q.get(k)!.className.split(' ')[0]);
    this.q.get(k)!.className = `${base} ${v}`.trim();
  }

  private compassW = 0;
  private compassH = 0;
  drawCompass(camYaw: number, pins: CompassPin[], from: { x: number; z: number }, partner: { x: number; z: number } | null, pcolor: string, partnerColor: string, scale: number) {
    const c = this.compass;
    // Centred between the noise panel and the minimap, so it narrows in a half-width view instead of colliding with them.
    const hostW = this.root.clientWidth || 640;
    const W = Math.round(Math.max(140, Math.min(340 * scale, hostW - 2 * 190 * scale)));
    const H = Math.round(42 * scale);
    // Twenty times a second: only touch the canvas's box when it changes, so a still HUD costs no style work.
    if (this.compassW !== W || this.compassH !== H) {
      this.compassW = W;
      this.compassH = H;
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.dpr !== dpr || c.width !== W * dpr) {
      this.dpr = dpr;
      c.width = W * dpr;
      c.height = H * dpr;
    }
    const g = this.cctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(12,9,6,0.62)';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,180,84,0.35)';
    g.strokeRect(0.5, 0.5, W - 1, H - 1);
    const half = Math.PI * 0.62; // visible half-range
    const xOf = (rel: number) => W / 2 - (rel / half) * (W / 2);
    // Ticks every 15 degrees, letters at cardinals.
    g.font = `${Math.round(13 * scale)}px Oswald, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let a = 0; a < 360; a += 15) {
      const abs = (a * Math.PI) / 180;
      const rel = wrapAngle(abs - camYaw);
      if (Math.abs(rel) > half) continue;
      const x = xOf(rel);
      const card = a % 90 === 0;
      g.strokeStyle = card ? 'rgba(255,225,160,0.95)' : 'rgba(255,180,84,0.4)';
      g.beginPath();
      g.moveTo(x, H - 4);
      g.lineTo(x, H - (card ? 14 : 9));
      g.stroke();
      if (card) {
        g.fillStyle = a === 0 ? '#ffe08a' : '#e9dfc7';
        // North is +Z (down the road). 0 = N, 90 deg (toward -X) is W because +X is left when facing +Z.
        const label = a === 0 ? 'N' : a === 90 ? 'W' : a === 180 ? 'S' : 'E';
        g.fillText(label, x, H - 24);
      }
    }
    // Pins
    for (const pin of pins) {
      const dx = pin.x - from.x;
      const dz = pin.z - from.z;
      const d = Math.hypot(dx, dz);
      if (d < 6) continue;
      const rel = wrapAngle(Math.atan2(dx, dz) - camYaw);
      const x = clamp(xOf(rel), 10, W - 10);
      const edge = Math.abs(rel) > half;
      g.fillStyle = pin.color ?? PIN_COLOR[pin.kind];
      g.globalAlpha = edge ? 0.55 : 1;
      if (pin.kind === 'waypoint') drawWaypointGlyph(g, x, 11, 5, pin.color ?? '#fff');
      else if (pin.kind === 'poi' && pin.poi) drawPoiGlyph(g, pin.poi, x, 11, 4.6, pin.color);
      else if (pin.kind === 'ambush') {
        g.beginPath();
        g.moveTo(x, 6);
        g.lineTo(x + 5, 15);
        g.lineTo(x - 5, 15);
        g.closePath();
        g.fill();
      } else if (pin.kind === 'ping') {
        g.beginPath();
        g.arc(x, 11, 5, 0, Math.PI * 2);
        g.lineWidth = 2;
        g.strokeStyle = '#fff';
        g.stroke();
        g.lineWidth = 1;
      } else {
        g.fillRect(x - 4, 7, 8, 8);
      }
      g.globalAlpha = 1;
      if (pin.dist) {
        // A waypoint, a pinned mark or a ride on its way: how far, in its own colour, at any range.
        g.globalAlpha = edge ? 0.7 : 1;
        g.fillStyle = pin.color ?? PIN_COLOR[pin.kind];
        g.font = `${Math.round(10 * scale)}px Share Tech Mono, monospace`;
        // Kept whole at the ends of the strip, where an edge pin sits.
        const text = distLabel(d);
        const tw = g.measureText(text).width;
        g.fillText(text, clamp(x, tw / 2 + 2, W - tw / 2 - 2), 25);
        g.font = `${Math.round(13 * scale)}px Oswald, sans-serif`;
        g.globalAlpha = 1;
      } else if (pin.label && d < 900 && !edge) {
        g.fillStyle = '#e9dfc7';
        g.font = `${Math.round(10 * scale)}px Share Tech Mono, monospace`;
        g.fillText(pin.label.length > 5 ? pin.label.slice(0, 5) : pin.label, x, 24);
        g.font = `${Math.round(13 * scale)}px Oswald, sans-serif`;
      }
    }
    // Partner arrow in their colour, with distance.
    if (partner) {
      const dx = partner.x - from.x;
      const dz = partner.z - from.z;
      const d = Math.hypot(dx, dz);
      const rel = wrapAngle(Math.atan2(dx, dz) - camYaw);
      const x = clamp(xOf(rel), 12, W - 12);
      g.fillStyle = partnerColor;
      g.beginPath();
      g.moveTo(x, 4);
      g.lineTo(x + 7, 17);
      g.lineTo(x - 7, 17);
      g.closePath();
      g.fill();
      g.strokeStyle = '#000';
      g.stroke();
      g.fillStyle = partnerColor;
      g.font = `${Math.round(11 * scale)}px Share Tech Mono, monospace`;
      g.fillText(`${Math.round(d)}m`, x, 28);
    }
    g.strokeStyle = pcolor;
    g.beginPath();
    g.moveTo(W / 2, 0);
    g.lineTo(W / 2, 7);
    g.stroke();
  }
}

export interface HudExtras {
  /** Elapsed fraction of the day for the leg bar and its Dusk marker. */
  legProgress?: (p: Player) => { frac: number; dusk: number; label: string } | null;
}

/** Corner-only HUD for each half: Signature, compass, vehicle/player status, weapon, context prompt. */
export class Hud {
  huds: PlayerHud[];
  private acc = 0;
  private subTimer = 0;
  private tipTimer = 0;
  private bannerTimer = 0;
  uiScale = 1;
  wheelSel = [-1, -1];
  private tipText = '';
  private subText = '';
  private bannerTitle = '';
  private bannerSub = '';
  disconnected: [boolean, boolean] = [false, false];

  constructor(public halves: HTMLElement[]) {
    this.huds = halves.map((h, i) => new PlayerHud(h, i));
  }

  private layoutName: 'horizontal' | 'vertical' = 'vertical';
  private seats: 1 | 2 = 2;

  setLayout(l: 'horizontal' | 'vertical') {
    this.layoutName = l;
    const cls = l === 'horizontal' ? ['h-top', 'h-bottom'] : ['v-left', 'v-right'];
    // Solo: the first half fills the screen and the second one and the divider go away.
    this.halves.forEach((h, i) => (h.className = this.seats === 1 ? `half ${i === 0 ? 'full' : 'off'}` : `half ${cls[i]}`));
    const div = document.getElementById('divider');
    if (div) {
      div.className = l === 'horizontal' ? 'h' : 'v';
      div.style.display = this.seats === 1 ? 'none' : '';
    }
  }

  setSeats(n: 1 | 2) {
    this.seats = n;
    this.setLayout(this.layoutName);
  }

  setScale(s: number) {
    this.uiScale = s;
    setMarkerUiScale(s);
    document.documentElement.style.setProperty('--u', String(s));
  }

  showSub(text: string, secs = 6) {
    this.subText = text;
    this.subTimer = secs;
  }
  showTip(text: string, secs = 9) {
    this.tipText = text;
    this.tipTimer = secs;
  }
  showBanner(title: string, sub = '', secs = 6) {
    this.bannerTitle = title;
    this.bannerSub = sub;
    this.bannerTimer = secs;
  }

  setVisible(v: boolean) {
    for (const h of this.huds) h.root.style.display = v ? '' : 'none';
  }

  /** The last map frame and its scene, so an open big map can be redrawn every frame between the HUD's own updates. */
  private lastFrame: MapFrame | null = null;
  private lastScene: Scene | null = null;

  /** This tick's seats, for prompts that name the other player's buttons. */
  private slotsNow: (Slot | null)[] = [];

  update(scene: Scene | null, dt: number, slots: (Slot | null)[], extras: HudExtras = {}) {
    this.slotsNow = slots;
    this.subTimer -= dt;
    this.tipTimer -= dt;
    this.bannerTimer -= dt;
    this.acc += dt;
    if (!scene) return;
    if (this.acc < 0.05) {
      this.openMaps(scene, slots, dt);
      return;
    }
    const step = this.acc;
    this.acc = 0;
    void step;
    const basePins = scene.compassPins();
    const frame = scene.mapFrame(basePins);
    this.lastFrame = frame;
    this.lastScene = scene;
    const leg = scene.mode === 'leg' ? (scene as LegScene) : null;
    for (let i = 0; i < 2; i++) {
      const h = this.huds[i];
      const p = scene.players[i];
      if (!p) continue;
      const reveal = scene.revealPins(p);
      this.updateOne(h, p, scene, reveal.length ? basePins.concat(reveal) : basePins, leg, slots[i] ?? null, extras, frame, step);
    }
  }

  /** An open big map follows its cursor every frame: only the map is redrawn, from the frame of the last full update. */
  private openMaps(scene: Scene, slots: (Slot | null)[], dt: number) {
    const f = this.lastFrame;
    if (!f || this.lastScene !== scene) return;
    for (let i = 0; i < 2; i++) {
      const p = scene.players[i];
      if (!p || p.mapMode === 0) continue;
      this.updateMap(this.huds[i], p, scene, f, slots[i] ?? null, viewOf(p), dt);
    }
  }

  /** The buttons of the big map as this seat has them, long and short (for a narrow split-screen panel). */
  private mapHint(p: Player, slot: Slot | null, next: string): [string, string] {
    const nav = navOf(p);
    const pad = slot?.kind === 'pad';
    const mouse = slot?.kind === 'kb' && live.mouseLocked && live.mouseSeat === p.index;
    const L = (b: string) => btnLabel(slot, b).toUpperCase();
    const map = `${L('Right')} ${next}`;
    if (nav.naming) return ['TYPE A NAME · ENTER KEEPS IT', 'TYPE · ENTER'];
    if (nav.menu) {
      const pick = pad ? L('A') : mouse ? 'CLICK' : L('A');
      const back = pad ? `${L('X')}/${L('B')}` : mouse ? 'RMB' : L('X');
      return [`▲▼ CHOOSE · ${pick} PICK · ${back} BACK`, `${pick} PICK · ${back} BACK`];
    }
    if (pad) {
      const zoom = `${L('LB')}/${L('RB')}`;
      return [`${L('A')} WAYPOINT · ${L('X')} MARK · ${zoom} ZOOM · ${L('R3')} CENTRE · ${map}`, `${L('A')} WAYPOINT · ${L('X')} MARK · ${zoom} ZOOM`];
    }
    if (mouse) return [`CLICK WAYPOINT · RMB MARK · WHEEL ZOOM · DRAG PAN · ${L('R3')} CENTRE · ${map}`, 'CLICK WAYPOINT · RMB MARK · WHEEL ZOOM'];
    const k = slot?.kind === 'kb' ? live.bindings.kb[slot.set - 1] : null;
    const zoom = k ? `${keyLabel(k.prevBuild)}/${keyLabel(k.nextBuild)}` : '1/2';
    return [`${L('A')} WAYPOINT · ${L('X')} MARK · ${zoom} ZOOM · ${L('R3')} CENTRE · ${map}`, `${L('A')} WAYPOINT · ${L('X')} MARK · ${zoom} ZOOM`];
  }

  /** The corner minimap, or the larger map when the seat has opened it. */
  private updateMap(h: PlayerHud, p: Player, scene: Scene, frame: MapFrame | null, slot: Slot | null, view: { x: number; z: number; yaw: number }, dt: number) {
    const mode = frame ? p.mapMode : 0;
    const hostW = h.root.clientWidth || 640;
    const hostH = h.root.clientHeight || 360;
    const v = p.vehicle;
    const mv = { seat: p.index, x: view.x, z: view.z, yaw: view.yaw, speed: v ? Math.abs(v.speed) : p.moveSpeed, color: PLAYER_CSS[p.index], reach: stormMapRadius(scene.storm) };
    h.setStyle('minimap', 'display', frame && mode === 0 ? 'block' : 'none');
    h.setStyle('mapfull', 'display', frame && mode > 0 ? 'block' : 'none');
    if (!frame) return;
    if (mode === 0) {
      // Closed: the next opening starts afresh on the player.
      const nav = navOf(p);
      if (nav.open) nav.close();
      const size = Math.round(clamp(Math.min(150 * this.uiScale, hostH * 0.3, hostW * 0.3), 84, 200));
      h.painter.mini(h.el('minimap') as HTMLCanvasElement, frame, mv, size, dt);
    } else {
      const next = mode + 1 < scene.mapModes ? (frame.mode === 'leg' ? 'WHOLE LEG' : 'WIDER') : 'CLOSE';
      // Below the compass and clock, above the vehicle and weapon blocks, so the corners stay readable around it.
      const top = Math.round(clamp(hostH * 0.14, 36, 96 * this.uiScale));
      const bottom = Math.round(clamp(hostH * 0.14, 36, 120 * this.uiScale));
      const w = Math.round(hostW * 0.9);
      const hh = Math.max(120, hostH - top - bottom);
      h.setStyle('mapfull', 'top', `${top}px`);
      const [long, short] = this.mapHint(p, slot, next);
      h.painter.full(h.el('mapcv') as HTMLCanvasElement, frame, mv, navOf(p), mode, w, hh, w > 760 * this.uiScale ? long : short, this.uiScale);
    }
  }

  private updateOne(h: PlayerHud, p: Player, scene: Scene, pins: CompassPin[], leg: LegScene | null, slot: Slot | null, extras: HudExtras, frame: MapFrame | null, dt: number) {
    const camp = scene.campaign;
    const v = p.vehicle;
    const partner = scene.players[1 - p.index];
    h.setText('name', p.name.toUpperCase());
    // Signature
    const sig = p.signatureShown;
    h.setStyle('sigfill', 'width', `${clamp(sig, 0, 100)}%`);
    h.setClass('sigbar', sig >= 60 ? 'high' : sig >= 30 ? 'mid' : '');
    h.setText('sigval', String(Math.round(sig)));
    const dust = scene.mode !== 'delve' && scene.biome !== 'city';
    h.setText('siglabel', dust ? 'DUST' : 'NOISE');
    h.setText('sighint', scene.mode === 'delve' ? 'the dead are listening' : dust ? 'seen from the road' : 'heard across the city');
    const chips: string[] = [];
    if (leg && leg.gap > 150) chips.push(`<span class="chip ${leg.gap > 250 ? 'bad' : 'warn'}">PARTNER ${Math.round(leg.gap)}m</span>`);
    if (scene.night > 0.4) chips.push('<span class="chip warn">NIGHT · LIGHTS DOUBLE NOISE</span>');
    if (v && v.lights) chips.push('<span class="chip">LIGHTS</span>');
    if (p.state === 'driving' && v && !v.engineOn) chips.push('<span class="chip">ENGINE OFF</span>');
    if (p.pinned >= 2) chips.push('<span class="chip bad">PINNED</span>');
    if (p.crouch && p.state === 'foot') chips.push('<span class="chip good">CROUCHED</span>');
    // Stalking game on foot: which way your scent drifts, and how much the most watchful animal near you has made of you.
    const stalk = p.state === 'foot' && scene.mode === 'leg' ? scene.wildlife?.stalkView(p) : null;
    if (stalk) {
      const [wx, wz] = windAt(scene.storm, scene.time);
      chips.push(`<span class="chip">SCENT ${driftArrow(wrapAngle(Math.atan2(wx, wz) - p.cam.yaw))}</span>`);
      const s = stalk.smelled ? ['bad', 'GAME SMELLS YOU'] : stalk.fleeing ? ['bad', 'GAME SPOOKED'] : stalk.aware >= STALK.alert ? ['warn', 'GAME WATCHING'] : stalk.aware >= STALK.calm ? ['warn', 'GAME UNEASY'] : ['good', 'UNSEEN'];
      chips.push(`<span class="chip ${s[0]}">${s[1]}</span>`);
    }
    if (leg && leg.hordeCountdown(p) > 0) chips.push(`<span class="chip bad">HORDE ${formatClock(leg.hordeCountdown(p))}</span>`);
    if (p.bleed.level > 0 && p.state !== 'downed') chips.push(`<span class="chip bad">${bleedLabel(p.bleed.level)}</span>`);
    if (p.stamina.winded && p.state === 'foot') chips.push('<span class="chip warn">WINDED</span>');
    for (const s of p.drugs.status()) chips.push(`<span class="chip ${s.kind}">${s.text}</span>`);
    if (p.state === 'foot' || p.state === 'driving' || p.state === 'gunner') for (const c of needChips(p.needs)) chips.push(`<span class="chip ${c.kind}">${c.text}</span>`);
    const qsel = p.quickSel;
    // The body's chores are on the belt but not worth a standing chip: the need chips above say when one is due.
    const qn = isNeedAct(qsel) ? 0 : qsel === 'wild' ? wildSlot(p).n : scene.campaign.items[qsel];
    // A dressing is worth showing while hurt; a drug only while you have one.
    const dressing = qsel === 'bandage' || qsel === 'medkit';
    if ((p.state === 'foot' || p.state === 'driving') && !p.beltOpen && qn > 0 && (!dressing || p.hp < p.maxHp - 0.5 || p.bleed.level > 0)) {
      chips.push(`<span class="chip${dressing && p.bleed.level > 0 ? ' good' : ''}">${btnLabel(slot, 'Down')} ${(qsel === 'wild' ? wildSlot(p).chip : quickName(qsel)).toUpperCase()} ×${qn}</span>`);
    }
    h.setHtml('chips', chips.join(''));
    // The story's objective: a heading, a checklist ticking off as it is done, and a line of advice.
    const ob = scene.objective;
    h.setStyle('obj', 'display', ob ? 'block' : 'none');
    if (ob) {
      const steps = (ob.steps ?? []).map((s) => `<div class="ostep${s.done ? ' done' : ''}">${s.done ? '✓' : '·'} ${escapeHtml(s.text)}</div>`).join('');
      h.setHtml('obj', `<div class="otitle">${escapeHtml(ob.title)}</div>${steps}${ob.hint ? `<div class="ohint">${escapeHtml(ob.hint)}</div>` : ''}`);
    }
    const tl = scene.toastLine;
    if (tl && p.index === 0) tl.t -= dt;
    h.setStyle('toast', 'display', tl && tl.t > 0 ? 'block' : 'none');
    if (tl && tl.t > 0) h.setText('toast', tl.text);
    this.updateTrip(h, p, scene, slot);

    // Compass
    const view = viewOf(p);
    const cyaw = view.yaw;
    const myPos = { x: view.x, z: view.z };
    const pp = partner ? (partner.vehicle ? partner.vehicle.position : partner.pos) : null;
    h.drawCompass(cyaw, pins, myPos, pp ? { x: pp.x, z: pp.z } : null, PLAYER_CSS[p.index], PLAYER_CSS[1 - p.index], this.uiScale);
    this.updateMap(h, p, scene, frame, slot, { x: myPos.x, z: myPos.z, yaw: cyaw }, dt);

    // Leg progress and clock
    const prog = extras.legProgress?.(p);
    if (leg) {
      const L = leg.leg.length;
      h.setStyle('legfill', 'width', `${clamp(myPos.z / L, 0, 1) * 100}%`);
      h.setStyle('legme', 'left', `${clamp(myPos.z / L, 0, 1) * 100}%`);
      h.setStyle('legdusk', 'left', '72%');
      h.setStyle('legdusk', 'display', leg.leg.open ? 'none' : '');
      const sec = leg.clock.secondsToDark;
      // A night that is played out on the road (night camp off) counts down to the morning instead.
      const toDawn = leg.clock.night && leg.leg.open && leg.freeNight;
      h.setText('clock', toDawn ? formatClock(leg.clock.secondsToDawn) : leg.clock.night ? '+' + formatClock((leg.clock.t - 1) * leg.clock.dayLength) : formatClock(sec));
      const dust = stormLabel(leg.storm, leg.stormRising) || leg.weather?.label() || heatLabel(leg.heat);
      h.setText('daytag', toDawn ? 'TO DAWN' : leg.clock.dusk ? (leg.clock.night ? 'INTO THE NIGHT' : 'TO DARK') : dust ? `TO DUSK BELL · ${dust}` : 'TO DUSK BELL');
      h.setStyle('legbar', 'display', '');
    } else {
      h.setStyle('legbar', 'display', 'none');
      if (prog) h.setText('daytag', prog.label);
    }
    // Camp: build timer, phase, and the placement strip.
    if (scene.mode === 'camp') {
      const camp = scene as CampScene;
      h.setText('clock', camp.phase === 'build' ? formatClock(camp.buildSecondsLeft) : '');
      h.setText('daytag', camp.phase === 'build' ? `BUILD · HOLD ${btnLabel(slot, 'B').toUpperCase()} WHEN READY` : camp.phase === 'night' ? 'NIGHT RAID' : camp.phase === 'dawn' ? 'DAWN' : 'LEDGER');
      const html = camp.buildHud(p);
      h.setStyle('build', 'display', html ? 'flex' : 'none');
      h.setHtml('build', html);
    } else h.setStyle('build', 'display', 'none');
    // Delve: chests found and what to do next, in the clock and tag slots.
    if (scene.mode === 'delve') {
      const line = (scene as unknown as { hudLine(): { clock: string; tag: string } }).hudLine();
      h.setText('clock', line.clock);
      h.setText('daytag', line.tag);
    }

    // Vehicle / player status
    const cur = v ?? p.ownVehicle;
    if (v && (p.state === 'driving' || p.state === 'gunner')) {
      h.setText('vname', v.def.name.toUpperCase());
      h.setStyle('stamrow', 'display', 'none');
      const f = v.hpFrac;
      h.setText('hplabel', 'HULL');
      h.setText('hpval', `${Math.round(f * 100)}%`);
      h.setStyle('hpfill', 'width', `${f * 100}%`);
      h.setClass('hpbar', f < 0.25 ? 'crit' : f < 0.55 ? 'low' : '');
      h.setStyle('fuelrow', 'display', 'flex');
      const ff = v.fuel / v.tankMax;
      h.setStyle('fuelfill', 'width', `${clamp(ff, 0, 1) * 100}%`);
      h.setClass('fuelbar', ff < 0.15 || this.wrongFuel(v) ? 'fuel crit' : v.fuelType === 'diesel' ? 'fuel diesel' : 'fuel');
      h.setText('fuelval', this.fuelText(v));
      this.oilGauge(h, v);
      this.waterGauge(h, v);
      this.tempGauge(h, v);
      h.setStyle('speed', 'display', '');
      // A small gear letter beside the speed and a thin rev bar under it, from the real drivetrain.
      const dr = v.powertrain ? v.drive : null;
      const gear = !dr || dr.redline <= 0 || !v.engineOn ? '' : dr.gear < 0 ? 'R' : dr.cvt ? 'D' : String(dr.gear);
      h.setHtml('speed', `${Math.round(Math.abs(v.speed) * 3.6)}<small>km/h</small>${gear ? `<small class="gear">${gear}</small>` : ''}`);
      h.setStyle('tach', 'display', gear ? '' : 'none');
      if (gear) {
        h.setStyle('tachfill', 'width', `${Math.round(Math.min(1, dr!.rpmFrac) * 100)}%`);
        h.setClass('tach', dr!.rpmFrac > 0.93 ? 'tach red' : 'tach');
      }
      // Only what is broken is listed, in words, so a healthy vehicle has a quiet corner.
      const c = v.health.comp;
      const faults: string[] = [];
      const fault = (txt: string, cls: string) => faults.push(`<span class="chip ${cls}">${txt}</span>`);
      if (v.health.burning) fault('ON FIRE', 'bad');
      if (c.engine <= 0.001) fault('ENGINE DEAD', 'bad');
      else if (c.engine < 0.99) fault(`ENGINE ${Math.round(c.engine * 100)}%`, c.engine < 0.5 ? 'bad' : 'warn');
      const flats = c.tires.filter((x) => x <= 0).length;
      if (flats) fault(`${flats} FLAT TYRE${flats > 1 ? 'S' : ''}`, 'bad');
      if (v.health.leaking) fault('FUEL LEAK', 'bad');
      if (c.mount <= 0.001) fault('GUN MOUNT GONE', 'bad');
      else if (c.mount < 0.99) fault('GUN MOUNT DAMAGED', 'warn');
      const gb = c.gearbox ?? 1;
      if (v.stats.noDrive || gb < 0.25) fault('GEARBOX FAILING', 'bad');
      else if (gb < 0.5) fault('GEARBOX WORN', 'warn');
      h.setHtml('comp', faults.join(''));
    } else if (p.state === 'foot' || p.state === 'entering' || p.state === 'downed' || p.state === 'dead') {
      h.setText('vname', p.state === 'dead' ? 'DOWN FOR GOOD' : 'ON FOOT');
      // Stamina shows only while it is being used, so a rested survivor has a clean corner.
      const wind = p.stamina.value / STAMINA.max;
      h.setStyle('stamrow', 'display', p.state === 'foot' && (wind < 0.995 || p.stamina.winded) ? 'flex' : 'none');
      h.setStyle('stamfill', 'width', `${wind * 100}%`);
      h.setClass('stambar', p.stamina.winded ? 'stam winded' : 'stam');
      h.setText('stamval', p.stamina.winded ? 'WINDED' : `${Math.round(wind * 100)}%`);
      // Breath shows once the swimmer has gone under, and until the lungs are full again.
      const air = p.breath.air;
      h.setStyle('breathrow', 'display', p.state === 'foot' && (p.underwater || air < 0.995) ? 'flex' : 'none');
      h.setStyle('airfill', 'width', `${air * 100}%`);
      h.setClass('airbar', air < 0.3 ? 'low' : '');
      h.setText('airval', air <= 0 ? 'DROWNING' : `${Math.round(air * 100)}%`);
      h.setText('hplabel', 'HEALTH');
      h.setText('hpval', p.bleed.level > 0 ? bleedLabel(p.bleed.level).toUpperCase() : String(Math.ceil(p.hp)));
      h.setStyle('hpfill', 'width', `${(p.hp / p.maxHp) * 100}%`);
      h.setClass('hpbar', p.bleed.level > 0 ? 'bleed' : p.hp < 25 ? 'crit' : p.hp < 55 ? 'low' : '');
      h.setStyle('fuelrow', 'display', cur && !cur.wreck ? 'flex' : 'none');
      if (cur) {
        const ff = cur.fuel / cur.tankMax;
        h.setStyle('fuelfill', 'width', `${clamp(ff, 0, 1) * 100}%`);
        h.setClass('fuelbar', this.wrongFuel(cur) ? 'fuel crit' : cur.fuelType === 'diesel' ? 'fuel diesel' : 'fuel');
        h.setText('fuelval', this.fuelText(cur));
      }
      this.oilGauge(h, cur && !cur.wreck ? cur : null);
      this.waterGauge(h, cur && !cur.wreck ? cur : null);
      this.tempGauge(h, cur && !cur.wreck ? cur : null);
      h.setStyle('speed', 'display', 'none');
      h.setStyle('tach', 'display', 'none');
      h.setHtml('comp', '');
    } else {
      this.oilGauge(h, null);
      this.waterGauge(h, null);
      this.tempGauge(h, null);
    }

    // Weapon block
    const pad = slot?.kind === 'pad';
    void pad;
    if (p.state === 'driving' && v) {
      if (v.def.weapon === 'frontLMG') {
        h.setText('wname', 'FRONT LMG');
        h.setHtml('ammo', `${camp.ammo}<small> rds</small>`);
      } else if (v.def.weapon === 'bedMG') {
        h.setText('wname', 'BED MG · PARTNER GUNS');
        h.setHtml('ammo', `${camp.ammo}<small> rds</small>`);
      } else {
        h.setText('wname', 'NO WEAPON');
        h.setHtml('ammo', '');
      }
      h.setHtml('equip', `<span class="on">${btnLabel(slot, 'X')} HORN</span><span>${btnLabel(slot, 'B')} LIGHTS</span>`);
    } else if (p.state === 'gunner' && v) {
      h.setText('wname', 'BED MG');
      h.setHtml('ammo', `${camp.ammo}<small> rds</small>`);
      h.setHtml('equip', '');
    } else if (p.carry) {
      h.setText('wname', 'CARRYING');
      h.setHtml('ammo', `<small>${escapeHtml(carriedName(p.carry))}</small>`);
      h.setHtml('equip', `<span class="on">HANDS FULL</span>`);
    } else {
      const eq = p.equip;
      h.setText('wname', p.reloadT > 0 ? 'RELOADING' : p.heldName().toUpperCase());
      const worn = eq === 'gun' || eq === 'melee' ? heldItem(p.gear) : null;
      const cond = worn && wearOf(worn.cond) < 0.6 ? `<small class="${wearOf(worn.cond) < 0.3 ? 'bad' : 'warn'}"> ${wearLabel(worn.cond).toUpperCase()}</small>` : '';
      const bowHeld = eq === 'gun' && !!worn && !!gearDef(worn.id).gun?.draw;
      if (bowHeld) h.setHtml('ammo', `${p.mag}<small>/${camp.items.arrow} ARROWS</small>${cond}`);
      else if (eq === 'gun') h.setHtml('ammo', `${p.mag}<small>/${camp.ammo}</small>${cond}`);
      else if (eq === 'melee') h.setHtml('ammo', `<small>${Math.round(p.meleeDamage())} DMG</small>${cond}`);
      else if (eq === 'wrench') h.setHtml('ammo', `<small>${whole(camp.stocks.scrap)} SCRAP · ${whole(camp.stocks.parts)} PARTS</small>`);
      else if (eq === 'crowbar') h.setHtml('ammo', `<small>${camp.inventory.length}/${camp.inventoryCap} PARTS</small>`);
      else if (eq === 'jerrycan') h.setHtml('ammo', `<small>${camp.stocks.fuel.toFixed(1)} FU PETROL · ${camp.items.diesel.toFixed(1)} DIESEL · ${(camp.items.oil * 3).toFixed(1)} L OIL · ${camp.items.water.toFixed(0)} L WATER</small>`);
      else h.setHtml('ammo', `<small>${p.utility === 'horn' ? '∞' : camp.items[p.utility as 'flare']}</small>`);
      // The belt: what is in each hand slot, with the one in hand lit, then the throwable.
      const belt = p.gear.belt.map((it, i) => (it ? `<span class="${eq !== 'utility' && p.gear.sel === i ? 'on' : ''}">${gearDef(it.id).short}</span>` : '')).join('');
      h.setHtml('equip', `${belt}<span class="${eq === 'utility' ? 'on' : ''}">${p.utility.toUpperCase()}</span>`);
    }
    // Convoy supplies: label dim, number bright. Oil and water live on the convoy sheet and the jerrycan readout.
    const supply = (label: string, n: string, low = false) => `<span${low ? ' class="low"' : ''}><i>${label}</i>${n}</span>`;
    h.setHtml(
      'stocks',
      supply('FUEL', camp.stocks.fuel.toFixed(0), camp.stocks.fuel < 4) +
        (camp.items.diesel > 0.05 ? supply('DIESEL', camp.items.diesel.toFixed(0)) : '') +
        supply('RATIONS', String(whole(camp.stocks.rations)), camp.stocks.rations < 3) +
        supply('SCRAP', String(whole(camp.stocks.scrap))) +
        supply('PARTS', String(whole(camp.stocks.parts))),
    );

    // The car screens (the part card, the storage panel, the breakdown) and what they take the place of.
    const car = updateCarHud(h, p);
    // The vehicle you are standing next to: what it is and what is wrong with it.
    h.setHtml('vread', car.card || car.panel || car.details ? '' : this.vehicleReadout(p, scene));

    // Notes
    h.setHtml('notes', p.notes.slice(-3).map((n) => `<div class="note ${n.kind}">${escapeHtml(n.text)}</div>`).join(''));

    // Prompt
    const pr = car.panel ? null : p.prompt;
    if (pr) {
      h.setStyle('prompt', 'display', 'flex');
      h.setText('ptext', pr.text);
      h.setText('pbtn', btnLabel(slot, pr.button));
      h.setClass('pbtn', pr.button === 'Y' ? 'y' : pr.button === 'X' ? 'x' : '');
      h.setStyle('phold', 'width', pr.progress >= 0 ? `${clamp(pr.progress, 0, 1) * 100}%` : '0%');
    } else h.setStyle('prompt', 'display', 'none');
    const alt = p.promptAlt;
    h.setStyle('prompt2', 'display', pr && alt ? 'flex' : 'none');
    if (pr && alt) {
      h.setText('ptext2', alt.text);
      h.setText('pbtn2', btnLabel(slot, alt.button));
      h.setClass('prompt2', alt.ok ? 'alt' : 'alt off');
    }

    // Reticle: on foot aiming or manning the bed gun.
    const driveRet = p.state === 'driving' && p.equip === 'gun';
    const showRet = (p.state === 'foot' && p.equip === 'gun' && !p.carry) || p.state === 'gunner' || driveRet;
    // What you hold or look at, named under the crosshair, and what the buttons do with it down the left side.
    const look = p.state === 'foot' ? p.lookInfo : null;
    h.setStyle('look', 'display', look ? 'block' : 'none');
    if (look) h.setHtml('look', look.lines.map((l, i) => `<div${i > 0 && l.css ? ` style="color:${l.css}"` : ''}>${escapeHtml(l.text)}</div>`).join(''));
    h.setStyle('handdot', 'display', !showRet && p.state === 'foot' && (look || p.carry) ? 'block' : 'none');
    const hints = p.state === 'foot' ? p.handHints : [];
    h.setStyle('hands', 'display', hints.length ? 'block' : 'none');
    if (hints.length) h.setHtml('hands', hints.map((x) => `<div>${escapeHtml(x.text)}: <b>${escapeHtml(x.key)}</b></div>`).join(''));
    // Sights up in first person, the sights or the scope are the mark: the crosshair fades out (a bow keeps it, for the draw).
    const sighted = p.state === 'foot' && p.firstPerson && p.human.heldKind !== 'bow' ? clamp01((p.ads - 0.35) / 0.45) : 0;
    h.setStyle('reticle', 'display', showRet && sighted < 0.99 ? 'block' : 'none');
    h.setStyle('reticle', 'opacity', ((driveRet ? 0.5 : 1) * (1 - sighted)).toFixed(2));
    // A bow's reticle closes as the string comes back, and a ring round it fills with the draw: gold at full, red once the arm shakes.
    const draw = showRet && p.state === 'foot' ? p.bowDraw : 0;
    h.setStyle('reticle', 'transform', `scale(${((1 + (1 - Math.max(p.ads, draw)) * 0.4) * (1 + p.bloom * 0.5)).toFixed(3)})`);
    h.setStyle('drawring', 'display', draw > 0.01 ? 'block' : 'none');
    if (draw > 0.01) {
      h.setStyle('drawring', '--d', draw.toFixed(2));
      h.setClass('drawring', p.bowString.held > ARCHERY.holdFree ? 'shake' : draw >= 1 ? 'full' : '');
    }

    // Damage / downed overlays
    const hurt = clamp(1 - p.hp / p.maxHp, 0, 1);
    h.setStyle('vig', 'opacity', String(p.state === 'foot' ? hurt * 0.9 * (p.sinceHit < 0.6 ? 1 : 0.55) : p.state === 'driving' && v ? clamp(1 - v.hpFrac, 0, 1) * 0.6 : 0));
    h.setStyle('uw', 'opacity', p.state === 'foot' && p.underwater && p.firstPerson ? '1' : '0');
    h.setClass('gray', p.state === 'downed' || p.state === 'dead' ? 'on' : '');

    // Center messages
    if (p.state === 'downed') {
      h.setStyle('cmsg', 'display', 'block');
      h.setText('cbig', 'YOU ARE DOWN');
      // The partner's button, on the partner's own device.
      h.setText('csmall', `Partner: hold ${btnLabel(this.slotsNow[1 - p.index] ?? null, 'A')} next to you to revive`);
    } else if (p.pinned >= 2 && p.state === 'foot') {
      h.setStyle('cmsg', 'display', 'block');
      h.setText('cbig', 'PINNED');
      h.setText('csmall', `Rotate the left stick (${Math.min(5, Math.round(p.pinBreak))}/5) or get your partner to shoot`);
    } else if (p.state === 'dead') {
      h.setStyle('cmsg', 'display', 'block');
      h.setText('cbig', 'BLED OUT');
      h.setText('csmall', 'Respawning at the convoy for a Scrap fee');
    } else h.setStyle('cmsg', 'display', 'none');

    // Shared messages
    h.setStyle('sub', 'display', this.subTimer > 0 ? 'block' : 'none');
    h.setText('sub', this.subText);
    h.setStyle('tip', 'display', this.tipTimer > 0 ? 'block' : 'none');
    h.setText('tip', this.tipText);
    h.setStyle('banner', 'display', this.bannerTimer > 0 ? 'block' : 'none');
    h.setHtml('banner', `${escapeHtml(this.bannerTitle)}<small>${escapeHtml(this.bannerSub)}</small>`);
    h.setStyle('tether', 'display', p.tetherWarn ? 'block' : 'none');
    h.setClass('disc', this.disconnected[p.index] ? 'on' : '');
    this.updateWheel(h, p, slot);
    this.updateSheet(h, p, scene, leg, car);
  }

  private wrongFuel(v: Vehicle): boolean {
    return v.convoyEngine && !!fuelMismatch(v.stats.fuel, v.fuelType, v.fuel);
  }

  /** "12.3 DSL", or "12.3 DSL ≠ PTR" when the tank holds the wrong fuel for the engine. */
  private fuelText(v: Vehicle): string {
    const tag = (t: string) => (t === 'diesel' ? 'DSL' : 'PTR');
    return `${v.fuel.toFixed(1)} ${tag(v.fuelType)}${this.wrongFuel(v) ? ` ≠ ${tag(v.stats.fuel)}` : ''}`;
  }

  /** The engine temperature bar: only for a convoy vehicle with a simulated engine. */
  private tempGauge(h: PlayerHud, v: Vehicle | null) {
    const show = !!v && !v.wreck && v.convoyEngine && v.engineOn;
    h.setStyle('temprow', 'display', show ? 'flex' : 'none');
    if (!show || !v) return;
    const T = v.temp;
    h.setStyle('tempfill', 'width', `${clamp(T / T_MAX, 0, 1) * 100}%`);
    h.setClass('tempbar', T >= T_OVERHEAT ? 'temp crit' : T >= T_HOT ? 'temp low' : 'temp');
    h.setText('tempval', T >= T_OVERHEAT ? 'OVERHEATING' : T >= T_HOT ? 'HOT' : 'NORMAL');
  }

  /** The oil bar under the fuel bar: shown for a convoy vehicle with an engine that burns it. */
  private oilGauge(h: PlayerHud, v: Vehicle | null) {
    const show = !!v && !v.wreck && v.faction === 'convoy' && v.def.physics.kind !== 'boat';
    h.setStyle('oilrow', 'display', show ? 'flex' : 'none');
    if (!show || !v) return;
    const o = v.health.comp.oil;
    h.setStyle('oilfill', 'width', `${clamp(o, 0, 1) * 100}%`);
    h.setClass('oilbar', o < OIL_CRITICAL ? 'oil crit' : o < OIL_LOW ? 'oil low' : 'oil');
    h.setText('oilval', o < OIL_CRITICAL ? 'DRY' : o < OIL_LOW ? `LOW ${Math.round(o * 100)}%` : `${Math.round(o * 100)}%`);
  }

  /** The cooling-system bar: shown with the oil bar, for a convoy vehicle with a radiator to fill. */
  private waterGauge(h: PlayerHud, v: Vehicle | null) {
    const show = !!v && !v.wreck && v.convoyEngine && v.def.physics.kind !== 'boat';
    h.setStyle('waterrow', 'display', show ? 'flex' : 'none');
    if (!show || !v) return;
    const w = v.health.comp.coolant ?? 1;
    h.setStyle('waterfill', 'width', `${clamp(w, 0, 1) * 100}%`);
    h.setClass('waterbar', w < COOLANT_CRITICAL ? 'water crit' : w < COOLANT_LOW ? 'water low' : 'water');
    h.setText('waterval', w < COOLANT_CRITICAL ? 'DRY' : w < COOLANT_LOW ? `LOW ${Math.round(w * 100)}%` : `${Math.round(w * 100)}%`);
  }

  /** A card for the nearest vehicle when on foot: name, owner, and condition chips so it is clear what needs doing. */
  private vehicleReadout(p: Player, scene: Scene): string {
    if (p.state !== 'foot' || p.buildMode || p.action) return '';
    // The car under the crosshair, from a glance away; failing that, the nearest.
    const v = glanceVehicle(p) ?? p.nearestVehicle(6.5, (q) => q.kind !== 'crew' && !q.hostile);
    if (!v) return '';
    const c = v.health.comp;
    const tag = scene.cars.describe(v);
    const parts: string[] = [];
    const chip = (txt: string, cls = '') => parts.push(`<span class="chip ${cls}">${txt}</span>`);
    // Healthy systems are folded into one chip; only what needs doing is spelled out.
    let trouble = 0;
    const flag = (txt: string, cls: 'warn' | 'bad') => {
      trouble++;
      chip(txt, cls);
    };
    if (v.wreck) {
      const left = SALVAGE_STAGES.length - v.salvaged;
      chip(left > 0 ? `${left} STAGE${left > 1 ? 'S' : ''} TO STRIP` : 'NOTHING LEFT', left > 0 ? 'good' : '');
    } else {
      if (c.engine < 0.1) flag('ENGINE DEAD', 'bad');
      else if (c.engine < 0.999) flag(`ENGINE ${Math.round(c.engine * 100)}%`, 'warn');
      const flats = c.tires.filter((x) => x <= 0.001).length;
      if (flats) flag(`${flats} FLAT TYRE${flats > 1 ? 'S' : ''}`, 'bad');
      if (v.convoyEngine && v.stats.noEngine) flag('NO ENGINE', 'bad');
      const fuelPct = v.fuel / Math.max(0.01, v.tankMax);
      chip(`${v.fuelType === 'diesel' ? 'DIESEL' : 'PETROL'} TANK ${Math.round(fuelPct * 100)}%`, v.fuel < 0.5 ? 'bad' : fuelPct < 0.25 ? 'warn' : '');
      if (this.wrongFuel(v)) flag(`ENGINE WANTS ${v.stats.fuel.toUpperCase()}`, 'bad');
      if (v.convoyEngine && v.temp >= T_HOT) flag(v.temp >= T_OVERHEAT ? 'OVERHEATED' : 'HOT', v.temp >= T_OVERHEAT ? 'bad' : 'warn');
      if (c.oil < OIL_LOW) flag(c.oil < OIL_CRITICAL ? 'OIL DRY' : 'OIL LOW', c.oil < OIL_CRITICAL ? 'bad' : 'warn');
      else if (c.oil < 0.99) chip(`OIL ${Math.round(c.oil * 100)}%`);
      const water = c.coolant ?? 1;
      if (v.convoyEngine && water < COOLANT_LOW) flag(water < COOLANT_CRITICAL ? 'COOLANT DRY' : 'COOLANT LOW', water < COOLANT_CRITICAL ? 'bad' : 'warn');
      else if (v.convoyEngine && water < 0.99) chip(`COOLANT ${Math.round(water * 100)}%`);
      if (v.convoyEngine && v.stats.noDrive) flag('NO GEARBOX', 'bad');
      else if (v.convoyEngine && (c.gearbox ?? 1) < 0.5) flag(`GEARBOX ${Math.round((c.gearbox ?? 1) * 100)}%`, (c.gearbox ?? 1) < 0.25 ? 'bad' : 'warn');
      if (v.stats.overload > 1.08) flag('SAGGING UNDER LOAD', 'warn');
      if (v.stats.tyresGone) flag(`${v.stats.tyresGone} BARE WHEEL${v.stats.tyresGone > 1 ? 'S' : ''}`, 'bad');
      if (v.stats.hoodOff) flag('NO BONNET', 'warn');
      if (v.stats.doorsOff) flag(`${v.stats.doorsOff} DOOR${v.stats.doorsOff > 1 ? 'S' : ''} OFF`, 'warn');
      if (v.hpFrac < 0.65) flag(`BODY ${Math.round(v.hpFrac * 100)}%`, v.hpFrac < 0.35 ? 'bad' : 'warn');
      if (v.stats.noSteer) flag('NO STEERING WHEEL', 'bad');
      if (v.stats.noDriverSeat) flag('NO DRIVER SEAT', 'warn');
      if (v.stats.noPassengerSeat) flag('NO PASSENGER SEAT', 'warn');
      if (v.stats.noDash) flag('NO DASH', 'warn');
      const bent = v.bodywork.dentLevel();
      if (bent > 0.5) flag('CRUMPLED', 'warn');
      else if (bent > 0.06) chip('DENTED');
      const off = v.bodywork.missing();
      if (off) flag(`${off} PANEL${off > 1 ? 'S' : ''} OFF`, 'warn');
      if (v.health.leaking) flag('LEAKING', 'bad');
      if (v.health.burning) flag('ON FIRE', 'bad');
      if (!trouble) chip('ALL SYSTEMS OK', 'good');
    }
    const fitted = v.build ? Object.keys(v.build.fit).length : 0;
    if (fitted) chip(`${fitted} PART${fitted > 1 ? 'S' : ''} FITTED`);
    return `<div class="vcard"><b>${escapeHtml(v.def.name.toUpperCase())}</b> <em>${tag}</em></div><div class="chips">${parts.join('')}</div>${glanceExtras(p, v)}`;
  }

  private updateWheel(h: PlayerHud, p: Player, slot: Slot | null) {
    if (!p.commandWheel) {
      h.setStyle('wheel', 'display', 'none');
      return;
    }
    h.setStyle('wheel', 'display', 'block');
    // Six slices, clockwise from the top (game.ts picks them by the stick's angle).
    const names = ['PING', 'FOLLOW', 'REGROUP', 'CALL RIDE', 'SPREAD', 'HOLD'];
    const pos = [[50, 6], [88, 30], [88, 72], [50, 96], [12, 72], [12, 30]];
    const sel = this.wheelSel[p.index];
    h.setHtml(
      'wheel',
      names
        .map((n, i) => `<div class="${i === sel ? 'sel' : ''}" style="left:${pos[i][0]}%;top:${pos[i][1]}%;transform:translate(-50%,-50%)">${n}</div>`)
        .join('') + `<div style="left:50%;top:50%;transform:translate(-50%,-50%);color:#b97d2c">CREW ORDERS</div>`,
    );
    void slot;
  }

  /** The drug belt, and the parts of a trip that live on the HUD: it sways, and (without the post chain) the picture gets a CSS filter. */
  private updateTrip(h: PlayerHud, p: Player, scene: Scene, slot: Slot | null) {
    const d = p.drugs;
    const look = d.look();
    const m = d.mods();
    // The HUD itself loses its footing.
    const trip = Math.round(clamp(m.trip + m.sway * 0.6 + look.warp * 0.4, 0, 1) * 10) / 10;
    h.setClass('root', trip > 0.15 ? 'tripping' : '');
    h.setStyle('root', '--trip', String(trip));
    // On low quality there is no post chain, so the lens effects fall back to a filter over the picture.
    const fallback = !scene.R.usePost;
    const haze = Math.round(clamp(look.hue * 0.6 + look.warp * 0.5 + look.sat * 0.3 + look.blur + look.dbl * 0.5, 0, 1) * 20) / 20;
    const dark = Math.round(look.dark * 20) / 20;
    h.setClass('drugfx', fallback && (haze > 0 || dark > 0) ? 'on' : '');
    h.setStyle('drugfx', '--haze', String(haze));
    h.setStyle('drugfx', '--dark', String(dark));
    updateDrugStrip(h.root, p, scene.campaign, slot);
    if (!p.beltOpen) {
      h.setStyle('belt', 'display', 'none');
      return;
    }
    const sel = p.quickSel;
    const slots = QUICK.map((id) => {
      const q = quickDef(id, p);
      const n = quickCount(id, p, scene.campaign);
      return `<div class="slot${id === sel ? ' sel' : ''}${n.none ? ' none' : ''}" style="--dc:${q.color}"><b>${q.glyph}</b><i>${n.slot}</i></div>`;
    }).join('');
    const def = quickDef(sel, p);
    const hint = p.state === 'driving' ? `hold to cycle · release, then tap ${btnLabel(slot, 'Down')} to take` : `◀ ▶ to choose · release to close · tap ${btnLabel(slot, 'Down')} to take`;
    h.setHtml('belt', `<div class="slots">${slots}</div><div class="slotname" style="color:${def.color}">${def.name} ${quickCount(sel, p, scene.campaign).label}</div><div class="slotblurb">${def.blurb}</div><div class="slothint">${hint}</div>`);
    h.setStyle('belt', 'display', 'flex');
  }

  private updateSheet(h: PlayerHud, p: Player, scene: Scene, leg: LegScene | null, car?: CarHudState) {
    if (!p.sheet || car?.details) {
      h.setStyle('sheet', 'display', 'none');
      return;
    }
    h.setStyle('sheet', 'display', 'block');
    const c = scene.campaign;
    const stocks = (['fuel', 'rations', 'scrap', 'parts', 'tech', 'medicine'] as const)
      .map((k) => `<div>${LABEL[k].toUpperCase()} <b>${k === 'fuel' ? c.stocks[k].toFixed(1) : whole(c.stocks[k])}</b></div>${k === 'fuel' && c.items.diesel > 0.05 ? `<div>DIESEL <b>${c.items.diesel.toFixed(1)}</b></div>` : ''}`)
      .join('');
    const crew = c.crewLive.length
      ? c.crewLive
          .map((m) => {
            const band = loyaltyBand(m.loyalty);
            const face = band === 'loyal' ? '🙂' : band === 'steady' ? '😐' : band === 'resentful' ? '😠' : band === 'mutinous' ? '🤬' : '💀';
            return `<div>${face} ${m.name.toUpperCase()} · ${m.role.toUpperCase()} · ${band.toUpperCase()} (${Math.round(m.loyalty)})<br><span style="opacity:.7;text-transform:none">${m.grievances[0] ?? 'No grievances'}</span></div>`;
          })
          .join('')
      : '<div style="opacity:.7">No crew yet. Hire at a Waypoint.</div>';
    const n = p.needs;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const body = `FED ${pct(n.food)} · WATER ${pct(n.water)} · BLADDER ${pct(n.bladder)} · BOWELS ${pct(n.bowel)}`;
    const items = `${body}<br>OIL ${(c.items.oil * 3).toFixed(1)} L · FLARES ${c.items.flare} · MOLOTOVS ${c.items.molotov} · CHARGES ${c.items.charge} · MEDKITS ${c.items.medkit} · STIMS ${c.items.stim} · PAINKILLERS ${c.items.painkiller} · ADRENALINE ${c.items.adrenaline} · HAZE ${c.items.haze} · AMMO ${c.ammo}`;
    const here = p.vehicle?.position ?? p.pos;
    const haven = leg?.leg.open ? leg.src.layout.end : null;
    const route = leg
      ? haven
        ? `${leg.leg.name.toUpperCase()} · ${(Math.hypot(haven.x - here.x, haven.z - here.z) / 1000).toFixed(1)} km TO HAVEN`
        : `${leg.leg.name.toUpperCase()} · ${Math.round(leg.leg.length - here.z)} m TO CAMP`
      : 'CAMP';
    h.setHtml(
      'sheet',
      `<h4>CONVOY SHEET · ${route}</h4><div class="stocks">${stocks}</div><div style="margin-top:4px;font-family:var(--mono)">${items}</div><h4 style="margin-top:8px">CREW</h4><div class="crew">${crew}</div><div style="margin-top:6px;opacity:.7;font-family:var(--mono)">FRAGMENTS ${c.fragments.size}/4 · CHASSIS ${c.chassis}</div>`,
    );
  }
}

/** Where a seat is and which way its camera looks (0 north), as the compass and the maps need it. */
function viewOf(p: Player): { x: number; z: number; yaw: number } {
  const v = p.vehicle;
  const cam = p.cam;
  const lookDx = cam.look.x - cam.pos.x;
  const lookDz = cam.look.z - cam.pos.z;
  const yaw = Math.hypot(lookDx, lookDz) > 1e-3 ? Math.atan2(lookDx, lookDz) : p.cam.yaw;
  return { x: v ? v.position.x : p.pos.x, z: v ? v.position.z : p.pos.z, yaw };
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

void t;

/** What a quick-belt slot shows: the body's chores and the dressings are ours, everything else is a drug. */
function quickDef(id: QuickId, p?: Player): { name: string; glyph: string; color: string; blurb: string } {
  if (id === 'wild') return p ? wildSlot(p) : { name: 'Wild mushrooms', glyph: '🍄', color: '#c9a36a', blurb: '' };
  if (id === 'eat') return { name: 'Eat', glyph: '🍖', color: '#d6a45a', blurb: 'Eat a ration from the stores: fills you up by half. Hungry slows your recovery, starving hurts. Your hands are busy for a moment.' };
  if (id === 'drink') return { name: 'Drink', glyph: '🚰', color: '#5fb6e8', blurb: 'Drink three quarters of a litre from the water reserve, or from the lake if you stand at one: free, but raw water can upset your stomach.' };
  if (id === 'piss') return { name: 'Piss', glyph: '💦', color: '#e6d34a', blurb: 'Empty your bladder. A few seconds standing still: walk off, fire or take a hit and it stops. Keys: see the Control settings.' };
  if (id === 'shit') return { name: 'Shit', glyph: '💩', color: '#9b6a3a', blurb: 'Empty your bowels. A long squat with your guard down. A full bowel spoils your sprint and aim until you go.' };
  if (id === 'bandage') return { name: 'Bandage', glyph: '✚', color: '#e8e0c8', blurb: 'Stops bleeding and mends a little. Quick: your hands are busy for under a second.' };
  if (id === 'medkit') return { name: 'Medkit', glyph: '✜', color: '#ff6f5f', blurb: 'Stops bleeding and heals 60. Your hands are busy for over a second.' };
  return DRUGS[id];
}
/** What a belt slot counts: doses in the stores, or for the body's chores, a share of the stores or of the need. */
function quickCount(id: QuickId, p: Player, c: Campaign): { slot: string; label: string; none: boolean } {
  if (!isNeedAct(id)) {
    const n = id === 'wild' ? wildSlot(p).n : c.items[id];
    return { slot: String(n), label: `×${n}`, none: n <= 0 };
  }
  const act: NeedAct = id;
  const n = p.needs;
  if (act === 'eat') {
    const r = whole(c.stocks.rations);
    return { slot: String(r), label: `×${r}`, none: r < 1 };
  }
  if (act === 'drink') {
    const l = `${c.items.water.toFixed(0)} L`;
    return { slot: l, label: l, none: c.items.water < 0.05 };
  }
  const v = `${Math.round((act === 'piss' ? n.bladder : n.bowel) * 100)}%`;
  return { slot: v, label: `${v} full`, none: !canRelieve(n, act).ok };
}
function quickName(id: QuickId): string {
  return quickDef(id).name;
}

/** An arrow for which way the wind carries your scent, relative to where you are looking (up: ahead of you). */
function driftArrow(rel: number): string {
  // Yaw grows toward the view's left, so the arrows run the other way round.
  const i = (((Math.round(-rel / (Math.PI / 4)) % 8) + 8) % 8) as number;
  return ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][i];
}
