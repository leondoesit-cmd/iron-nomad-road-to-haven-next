import { gearDef, t } from '../data';
import { DRUGS } from '../sim/drugs';
import { STAMINA, bleedLabel, wearLabel, wearOf } from '../sim/vitals';
import { LABEL, whole } from '../sim/resources';
import { loyaltyBand } from '../sim/loyalty';
import { SALVAGE_STAGES } from '../sim/salvage';
import { OIL_CRITICAL, OIL_LOW } from '../sim/oil';
import { COOLANT_CRITICAL, COOLANT_LOW } from '../sim/fluids';
import { T_HOT, T_MAX, T_OVERHEAT } from '../sim/thermal';
import { fuelMismatch } from '../sim/fuel';
import { carriedName } from '../sim/carry';
import { formatClock, wrapAngle, clamp } from '../core/math';
import { PLAYER_CSS } from '../render/palette';
import type { Scene, CompassPin } from '../game/scene';
import type { LegScene } from '../game/legScene';
import type { CampScene } from '../game/campScene';
import { QUICK, type Player, type QuickId } from '../game/player';
import { heldItem } from '../sim/gear';
import type { Vehicle } from '../game/vehicle';
import { promptLabel, type Slot } from '../input/input';
import type { MapFrame } from './mapdata';
import { MapPainter, PIN_COLOR } from './minimap';
import { stormLabel, stormMapRadius } from '../sim/weather';

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
      <div class="belt" data-k="belt"></div>
      <div class="corner tl">
        <div class="tag"><span class="pcolor" style="background:${color}"></span><span data-k="name"></span></div>
        <div class="sigrow"><div class="sig" data-k="sigbar"><div class="fill" data-k="sigfill"></div></div><span class="val" data-k="sigval">0</span></div>
        <div class="tag" data-k="siglabel">NOISE</div>
        <div class="chips" data-k="chips"></div>
      </div>
      <div class="corner tr">
        <canvas class="compass" data-k="compass"></canvas>
        <div class="legbar" data-k="legbar"><div class="fill" data-k="legfill"></div><div class="dusk" data-k="legdusk"></div><div class="me" data-k="legme"></div></div>
        <div class="tag"><span class="clock" data-k="clock"></span> <span data-k="daytag"></span></div>
        <canvas class="minimap" data-k="minimap"></canvas>
      </div>
      <div class="corner bl">
        <div class="tag" data-k="vname">ON FOOT</div>
        <div class="bar" data-k="hpbar"><div class="fill" data-k="hpfill"></div></div>
        <div class="bar stam" data-k="stambar"><div class="fill" data-k="stamfill"></div></div>
        <div class="row" data-k="fuelrow"><div class="bar fuel" data-k="fuelbar"><div class="fill" data-k="fuelfill"></div></div><span class="val" data-k="fuelval"></span></div>
        <div class="row" data-k="oilrow"><div class="bar oil" data-k="oilbar"><div class="fill" data-k="oilfill"></div></div><span class="val" data-k="oilval">OIL</span></div>
        <div class="row" data-k="waterrow"><div class="bar water" data-k="waterbar"><div class="fill" data-k="waterfill"></div></div><span class="val" data-k="waterval">WATER</span></div>
        <div class="row" data-k="temprow"><div class="bar temp" data-k="tempbar"><div class="fill" data-k="tempfill"></div></div><span class="val" data-k="tempval">TEMP</span></div>
        <div class="row"><div class="speed" data-k="speed">0<small>km/h</small></div><div class="comp" data-k="comp"></div></div>
      </div>
      <div class="corner br">
        <div class="tag" data-k="wname">PISTOL</div>
        <div class="ammo" data-k="ammo">12<small>/90</small></div>
        <div class="equip" data-k="equip"></div>
        <div class="tag" data-k="stocks"></div>
      </div>
      <div class="bc">
        <div class="vread" data-k="vread"></div>
        <div class="notes" data-k="notes"></div>
        <div class="prompt" data-k="prompt"><span class="btn" data-k="pbtn">A</span><span data-k="ptext"></span><div class="hold" data-k="phold"></div></div>
        <div class="prompt alt" data-k="prompt2"><span class="btn x" data-k="pbtn2">X</span><span data-k="ptext2"></span></div>
      </div>
      <div class="reticle" data-k="reticle"></div>
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

  drawCompass(camYaw: number, pins: CompassPin[], from: { x: number; z: number }, partner: { x: number; z: number } | null, pcolor: string, partnerColor: string, scale: number) {
    const c = this.compass;
    // Fit the compass to the half it lives in so the corners never collide in a narrow left/right view.
    const hostW = this.root.clientWidth || 640;
    const W = Math.round(Math.max(150, Math.min(320 * scale, hostW * 0.46)));
    const H = Math.round(46 * scale);
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
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
      g.fillStyle = PIN_COLOR[pin.kind];
      g.globalAlpha = edge ? 0.55 : 1;
      if (pin.kind === 'ambush') {
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
      if (pin.label && d < 900 && !edge) {
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

  update(scene: Scene | null, dt: number, slots: (Slot | null)[], extras: HudExtras = {}) {
    this.subTimer -= dt;
    this.tipTimer -= dt;
    this.bannerTimer -= dt;
    this.acc += dt;
    if (!scene) return;
    if (this.acc < 0.05) return;
    const step = this.acc;
    this.acc = 0;
    void step;
    const basePins = scene.compassPins();
    const frame = scene.mapFrame(basePins);
    const leg = scene.mode === 'leg' ? (scene as LegScene) : null;
    for (let i = 0; i < 2; i++) {
      const h = this.huds[i];
      const p = scene.players[i];
      if (!p) continue;
      const reveal = scene.revealPins(p);
      this.updateOne(h, p, scene, reveal.length ? basePins.concat(reveal) : basePins, leg, slots[i] ?? null, extras, frame, step);
    }
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
      h.painter.full(h.el('mapcv') as HTMLCanvasElement, frame, mv, mode, w, hh, `${btnLabel(slot, 'Right')} · ${next}`, this.uiScale);
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
    h.setText('siglabel', scene.mode === 'delve' ? 'NOISE · THE DEAD LISTEN' : scene.biome === 'city' ? 'NOISE · HEARD IN CITIES' : 'DUST · SEEN ON THE ROAD');
    const chips: string[] = [];
    if (leg && leg.gap > 150) chips.push(`<span class="chip ${leg.gap > 250 ? 'bad' : 'warn'}">PARTNER ${Math.round(leg.gap)}m</span>`);
    if (scene.night > 0.4) chips.push('<span class="chip warn">NIGHT: 2x SIGNATURE WITH LIGHTS</span>');
    if (v && v.lights) chips.push('<span class="chip">LIGHTS</span>');
    if (p.state === 'driving' && v && !v.engineOn) chips.push('<span class="chip">ENGINE OFF</span>');
    if (p.pinned >= 2) chips.push('<span class="chip bad">PINNED</span>');
    if (p.crouch && p.state === 'foot') chips.push('<span class="chip good">CROUCHED</span>');
    if (leg && leg.hordeCountdown(p) > 0) chips.push(`<span class="chip bad">HORDE ${formatClock(leg.hordeCountdown(p))}</span>`);
    if (p.bleed.level > 0 && p.state !== 'downed') chips.push(`<span class="chip bad">${bleedLabel(p.bleed.level)}</span>`);
    if (p.stamina.winded && p.state === 'foot') chips.push('<span class="chip warn">WINDED</span>');
    for (const s of p.drugs.status()) chips.push(`<span class="chip ${s.kind}">${s.text}</span>`);
    const qsel = p.quickSel;
    const qn = scene.campaign.items[qsel];
    // A dressing is worth showing while hurt; a drug only while you have one.
    const dressing = qsel === 'bandage' || qsel === 'medkit';
    if ((p.state === 'foot' || p.state === 'driving') && !p.beltOpen && qn > 0 && (!dressing || p.hp < p.maxHp - 0.5 || p.bleed.level > 0)) {
      chips.push(`<span class="chip${dressing && p.bleed.level > 0 ? ' good' : ''}">${btnLabel(slot, 'Down')} ${quickName(qsel).toUpperCase()} ×${qn}</span>`);
    }
    h.setHtml('chips', chips.join(''));
    this.updateTrip(h, p, scene, slot);

    // Compass
    const cam = p.cam;
    const lookDx = cam.look.x - cam.pos.x;
    const lookDz = cam.look.z - cam.pos.z;
    const cyaw = Math.hypot(lookDx, lookDz) > 1e-3 ? Math.atan2(lookDx, lookDz) : p.cam.yaw;
    const myPos = { x: v ? v.position.x : p.pos.x, z: v ? v.position.z : p.pos.z };
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
      h.setText('clock', leg.clock.night ? '+' + formatClock((leg.clock.t - 1) * leg.clock.dayLength) : formatClock(sec));
      const dust = stormLabel(leg.storm, leg.stormRising);
      h.setText('daytag', leg.clock.dusk ? (leg.clock.night ? 'INTO THE NIGHT' : 'TO DARK') : dust ? `TO DUSK BELL · ${dust}` : 'TO DUSK BELL');
      h.setStyle('legbar', 'display', '');
    } else {
      h.setStyle('legbar', 'display', 'none');
      if (prog) h.setText('daytag', prog.label);
    }
    // Camp: build timer, phase, and the placement strip.
    if (scene.mode === 'camp') {
      const camp = scene as CampScene;
      h.setText('clock', camp.phase === 'build' ? formatClock(camp.buildSecondsLeft) : '');
      h.setText('daytag', camp.phase === 'build' ? 'BUILD · HOLD B WHEN READY' : camp.phase === 'night' ? 'NIGHT RAID' : camp.phase === 'dawn' ? 'DAWN' : 'LEDGER');
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
      h.setStyle('stambar', 'display', 'none');
      const f = v.hpFrac;
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
      h.setText('speed', `${Math.round(Math.abs(v.speed) * 3.6)}`);
      h.el('speed').innerHTML = `${Math.round(Math.abs(v.speed) * 3.6)}<small>km/h</small>`;
      const c = v.health.comp;
      const cls = (x: number) => (x <= 0.001 ? 'bad' : x < 0.99 ? 'mid' : '');
      h.setHtml(
        'comp',
        `<i class="${cls(c.engine)}" title="engine">E</i><i class="${c.tires.some((x) => x <= 0) ? 'bad' : ''}">T</i><i class="${v.health.leaking ? 'bad' : ''}">F</i><i class="${cls(c.mount)}">W</i><i class="${c.oil < OIL_CRITICAL ? 'bad' : c.oil < OIL_LOW ? 'mid' : ''}" title="oil">O</i><i class="${(c.coolant ?? 1) < COOLANT_CRITICAL ? 'bad' : (c.coolant ?? 1) < COOLANT_LOW ? 'mid' : ''}" title="water">C</i><i class="${v.stats.noDrive || (c.gearbox ?? 1) < 0.25 ? 'bad' : (c.gearbox ?? 1) < 0.5 ? 'mid' : ''}" title="gearbox">G</i>${v.health.burning ? '<i class="bad">🔥</i>' : ''}`,
      );
    } else if (p.state === 'foot' || p.state === 'entering' || p.state === 'downed' || p.state === 'dead') {
      h.setText('vname', p.state === 'dead' ? 'DOWN FOR GOOD' : 'ON FOOT');
      // Stamina shows only while it is being used, so a rested survivor has a clean corner.
      const wind = p.stamina.value / STAMINA.max;
      h.setStyle('stambar', 'display', p.state === 'foot' && (wind < 0.995 || p.stamina.winded) ? 'block' : 'none');
      h.setStyle('stamfill', 'width', `${wind * 100}%`);
      h.setClass('stambar', p.stamina.winded ? 'stam winded' : 'stam');
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
      h.el('speed').innerHTML = `${Math.round(p.moveSpeed * 3.6)}<small>km/h</small>`;
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
        h.el('ammo').innerHTML = `${camp.ammo}<small> rds</small>`;
      } else if (v.def.weapon === 'bedMG') {
        h.setText('wname', 'BED MG · PARTNER GUNS');
        h.el('ammo').innerHTML = `${camp.ammo}<small> rds</small>`;
      } else {
        h.setText('wname', 'UNARMED');
        h.el('ammo').innerHTML = `—`;
      }
      h.setHtml('equip', `<span class="on">${btnLabel(slot, 'X')} HORN</span><span>${btnLabel(slot, 'B')} LIGHTS</span>`);
    } else if (p.state === 'gunner' && v) {
      h.setText('wname', 'BED MG');
      h.el('ammo').innerHTML = `${camp.ammo}<small> rds</small>`;
      h.setHtml('equip', '');
    } else if (p.carry) {
      h.setText('wname', 'CARRYING');
      h.el('ammo').innerHTML = `<small>${escapeHtml(carriedName(p.carry))}</small>`;
      h.setHtml('equip', `<span class="on">HANDS FULL</span>`);
    } else {
      const eq = p.equip;
      h.setText('wname', p.reloadT > 0 ? 'RELOADING' : p.heldName().toUpperCase());
      const worn = eq === 'gun' || eq === 'melee' ? heldItem(p.gear) : null;
      const cond = worn && wearOf(worn.cond) < 0.6 ? `<small class="${wearOf(worn.cond) < 0.3 ? 'bad' : 'warn'}"> ${wearLabel(worn.cond).toUpperCase()}</small>` : '';
      if (eq === 'gun') h.el('ammo').innerHTML = `${p.mag}<small>/${camp.ammo}</small>${cond}`;
      else if (eq === 'melee') h.el('ammo').innerHTML = `<small>${Math.round(p.meleeDamage())} DMG</small>${cond}`;
      else if (eq === 'wrench') h.el('ammo').innerHTML = `<small>${whole(camp.stocks.scrap)} SCRAP · ${whole(camp.stocks.parts)} PARTS</small>`;
      else if (eq === 'crowbar') h.el('ammo').innerHTML = `<small>${camp.inventory.length}/${camp.inventoryCap} PARTS</small>`;
      else if (eq === 'jerrycan') h.el('ammo').innerHTML = `<small>${camp.stocks.fuel.toFixed(1)} FU PETROL · ${camp.items.diesel.toFixed(1)} DIESEL · ${(camp.items.oil * 3).toFixed(1)} L OIL · ${camp.items.water.toFixed(0)} L WATER</small>`;
      else h.el('ammo').innerHTML = `<small>${p.utility === 'horn' ? '∞' : camp.items[p.utility as 'flare']}</small>`;
      // The belt: what is in each hand slot, with the one in hand lit, then the throwable.
      const belt = p.gear.belt.map((it, i) => (it ? `<span class="${eq !== 'utility' && p.gear.sel === i ? 'on' : ''}">${gearDef(it.id).short}</span>` : '')).join('');
      h.setHtml('equip', `${belt}<span class="${eq === 'utility' ? 'on' : ''}">${p.utility.toUpperCase()}</span>`);
    }
    h.setText(
      'stocks',
      `FUEL ${camp.stocks.fuel.toFixed(0)}${camp.items.diesel > 0.05 ? ` · DIESEL ${camp.items.diesel.toFixed(0)}` : ''} · OIL ${(camp.items.oil * 3).toFixed(1)} L · WATER ${camp.items.water.toFixed(0)} L · RATIONS ${whole(camp.stocks.rations)} · SCRAP ${whole(camp.stocks.scrap)} · PARTS ${whole(camp.stocks.parts)}`,
    );

    // The vehicle you are standing next to: what it is and what is wrong with it.
    h.setHtml('vread', this.vehicleReadout(p, scene));

    // Notes
    h.setHtml('notes', p.notes.slice(-3).map((n) => `<div class="note ${n.kind}">${escapeHtml(n.text)}</div>`).join(''));

    // Prompt
    const pr = p.prompt;
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
    const showRet = (p.state === 'foot' && p.equip === 'gun' && !p.carry) || p.state === 'gunner';
    h.setStyle('reticle', 'display', showRet ? 'block' : 'none');
    h.setStyle('reticle', 'transform', `scale(${((1 + (1 - p.ads) * 0.4) * (1 + p.bloom * 0.5)).toFixed(3)})`);

    // Damage / downed overlays
    const hurt = clamp(1 - p.hp / p.maxHp, 0, 1);
    h.setStyle('vig', 'opacity', String(p.state === 'foot' ? hurt * 0.9 * (p.sinceHit < 0.6 ? 1 : 0.55) : p.state === 'driving' && v ? clamp(1 - v.hpFrac, 0, 1) * 0.6 : 0));
    h.setClass('gray', p.state === 'downed' || p.state === 'dead' ? 'on' : '');

    // Center messages
    if (p.state === 'downed') {
      h.setStyle('cmsg', 'display', 'block');
      h.setText('cbig', 'YOU ARE DOWN');
      h.setText('csmall', `Partner: hold ${btnLabel(slot === null ? null : null, 'A')} next to you to revive`);
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
    this.updateSheet(h, p, scene, leg);
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
    h.setText('tempval', T >= T_OVERHEAT ? 'OVERHEATING' : T >= T_HOT ? 'HOT' : 'TEMP');
  }

  /** The oil bar under the fuel bar: shown for a convoy vehicle with an engine that burns it. */
  private oilGauge(h: PlayerHud, v: Vehicle | null) {
    const show = !!v && !v.wreck && v.faction === 'convoy' && v.def.physics.kind !== 'boat';
    h.setStyle('oilrow', 'display', show ? 'flex' : 'none');
    if (!show || !v) return;
    const o = v.health.comp.oil;
    h.setStyle('oilfill', 'width', `${clamp(o, 0, 1) * 100}%`);
    h.setClass('oilbar', o < OIL_CRITICAL ? 'oil crit' : o < OIL_LOW ? 'oil low' : 'oil');
    h.setText('oilval', `OIL ${Math.round(o * 100)}`);
  }

  /** The cooling-system bar: shown with the oil bar, for a convoy vehicle with a radiator to fill. */
  private waterGauge(h: PlayerHud, v: Vehicle | null) {
    const show = !!v && !v.wreck && v.convoyEngine && v.def.physics.kind !== 'boat';
    h.setStyle('waterrow', 'display', show ? 'flex' : 'none');
    if (!show || !v) return;
    const w = v.health.comp.coolant ?? 1;
    h.setStyle('waterfill', 'width', `${clamp(w, 0, 1) * 100}%`);
    h.setClass('waterbar', w < COOLANT_CRITICAL ? 'water crit' : w < COOLANT_LOW ? 'water low' : 'water');
    h.setText('waterval', `WATER ${Math.round(w * 100)}`);
  }

  /** A card for the nearest vehicle when on foot: name, owner, and condition chips so it is clear what needs doing. */
  private vehicleReadout(p: Player, scene: Scene): string {
    if (p.state !== 'foot' || p.buildMode || p.action) return '';
    const v = p.nearestVehicle(6.5, (q) => q.kind !== 'crew' && (q.faction !== 'raider' || q.wreck));
    if (!v) return '';
    const c = v.health.comp;
    const tag = scene.cars.describe(v);
    const chip = (txt: string, cls = '') => `<span class="chip ${cls}">${txt}</span>`;
    const parts: string[] = [];
    if (v.wreck) {
      const left = SALVAGE_STAGES.length - v.salvaged;
      parts.push(chip(left > 0 ? `${left} STAGE${left > 1 ? 'S' : ''} TO STRIP` : 'NOTHING LEFT', left > 0 ? 'good' : ''));
    } else {
      parts.push(c.engine < 0.1 ? chip('ENGINE DEAD', 'bad') : c.engine < 0.999 ? chip(`ENGINE ${Math.round(c.engine * 100)}%`, c.engine < 0.5 ? 'warn' : '') : chip('ENGINE OK'));
      const flats = c.tires.filter((x) => x <= 0.001).length;
      parts.push(flats ? chip(`${flats} FLAT`, 'bad') : chip('TYRES OK'));
      if (v.convoyEngine && v.stats.noEngine) parts.push(chip('NO ENGINE', 'bad'));
      parts.push(chip(`${v.fuelType.toUpperCase()} ${Math.round((v.fuel / Math.max(0.01, v.tankMax)) * 100)}%`, v.fuel < 0.5 ? 'bad' : v.fuel / v.tankMax < 0.25 ? 'warn' : ''));
      if (this.wrongFuel(v)) parts.push(chip(`ENGINE WANTS ${v.stats.fuel.toUpperCase()}`, 'bad'));
      if (v.convoyEngine && v.temp >= T_HOT) parts.push(chip(v.temp >= T_OVERHEAT ? 'OVERHEATED' : 'HOT', v.temp >= T_OVERHEAT ? 'bad' : 'warn'));
      if (c.oil < OIL_LOW) parts.push(chip(c.oil < OIL_CRITICAL ? 'OIL DRY' : 'OIL LOW', c.oil < OIL_CRITICAL ? 'bad' : 'warn'));
      else parts.push(chip(`OIL ${Math.round(c.oil * 100)}%`));
      const water = c.coolant ?? 1;
      if (v.convoyEngine) parts.push(water < COOLANT_LOW ? chip(water < COOLANT_CRITICAL ? 'WATER DRY' : 'WATER LOW', water < COOLANT_CRITICAL ? 'bad' : 'warn') : chip(`WATER ${Math.round(water * 100)}%`));
      if (v.convoyEngine && v.stats.noDrive) parts.push(chip('NO GEARBOX', 'bad'));
      else if (v.convoyEngine && (c.gearbox ?? 1) < 0.5) parts.push(chip(`GEARBOX ${Math.round((c.gearbox ?? 1) * 100)}%`, (c.gearbox ?? 1) < 0.25 ? 'bad' : 'warn'));
      if (v.stats.overload > 1.08) parts.push(chip('SAGGING', 'warn'));
      if (v.stats.tyresGone) parts.push(chip(`${v.stats.tyresGone} BARE WHEEL${v.stats.tyresGone > 1 ? 'S' : ''}`, 'bad'));
      if (v.stats.hoodOff) parts.push(chip('NO BONNET', 'warn'));
      if (v.stats.doorsOff) parts.push(chip(`${v.stats.doorsOff} DOOR${v.stats.doorsOff > 1 ? 'S' : ''} OFF`, 'warn'));
      parts.push(chip(`BODY ${Math.round(v.hpFrac * 100)}%`, v.hpFrac < 0.35 ? 'bad' : v.hpFrac < 0.65 ? 'warn' : ''));
      const bent = v.bodywork.dentLevel();
      if (bent > 0.5) parts.push(chip('CRUMPLED', 'warn'));
      else if (bent > 0.06) parts.push(chip('DENTED'));
      const off = v.bodywork.missing();
      if (off) parts.push(chip(`${off} PANEL${off > 1 ? 'S' : ''} OFF`, 'warn'));
      if (v.health.leaking) parts.push(chip('LEAKING', 'bad'));
      if (v.health.burning) parts.push(chip('ON FIRE', 'bad'));
    }
    const fitted = v.build ? Object.keys(v.build.fit).length : 0;
    if (fitted) parts.push(chip(`${fitted} PART${fitted > 1 ? 'S' : ''} FITTED`));
    return `<div class="vcard"><b>${escapeHtml(v.def.name.toUpperCase())}</b> <em>${tag}</em></div><div class="chips">${parts.join('')}</div>`;
  }

  private updateWheel(h: PlayerHud, p: Player, slot: Slot | null) {
    if (!p.commandWheel) {
      h.setStyle('wheel', 'display', 'none');
      return;
    }
    h.setStyle('wheel', 'display', 'block');
    const names = ['PING', 'FOLLOW', 'REGROUP', 'SPREAD', 'HOLD'];
    const pos = [[50, 6], [88, 38], [74, 86], [26, 86], [12, 38]];
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
    if (!p.beltOpen) {
      h.setStyle('belt', 'display', 'none');
      return;
    }
    const items = scene.campaign.items;
    const sel = p.quickSel;
    const slots = QUICK.map((id) => {
      const q = quickDef(id);
      const n = items[id];
      return `<div class="slot${id === sel ? ' sel' : ''}${n <= 0 ? ' none' : ''}" style="--dc:${q.color}"><b>${q.glyph}</b><i>${n}</i></div>`;
    }).join('');
    const def = quickDef(sel);
    const hint = p.state === 'driving' ? `hold to cycle · release, then tap ${btnLabel(slot, 'Down')} to take` : `◀ ▶ to choose · release to close · tap ${btnLabel(slot, 'Down')} to take`;
    h.setHtml('belt', `<div class="slots">${slots}</div><div class="slotname" style="color:${def.color}">${def.name} ×${items[sel]}</div><div class="slotblurb">${def.blurb}</div><div class="slothint">${hint}</div>`);
    h.setStyle('belt', 'display', 'flex');
  }

  private updateSheet(h: PlayerHud, p: Player, scene: Scene, leg: LegScene | null) {
    if (!p.sheet) {
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
    const items = `FLARES ${c.items.flare} · MOLOTOVS ${c.items.molotov} · CHARGES ${c.items.charge} · MEDKITS ${c.items.medkit} · STIMS ${c.items.stim} · PAINKILLERS ${c.items.painkiller} · ADRENALINE ${c.items.adrenaline} · HAZE ${c.items.haze} · AMMO ${c.ammo}`;
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

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

void t;

/** What a quick-belt slot shows: dressings are ours, everything else is a drug. */
function quickDef(id: QuickId): { name: string; glyph: string; color: string; blurb: string } {
  if (id === 'bandage') return { name: 'Bandage', glyph: '✚', color: '#e8e0c8', blurb: 'Stops bleeding and mends a little. Quick: your hands are busy for under a second.' };
  if (id === 'medkit') return { name: 'Medkit', glyph: '✜', color: '#ff6f5f', blurb: 'Stops bleeding and heals 60. Your hands are busy for over a second.' };
  return DRUGS[id];
}
function quickName(id: QuickId): string {
  return quickDef(id).name;
}
