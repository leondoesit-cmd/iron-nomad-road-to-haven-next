import { GameRenderer, QUALITY, type QualityPreset } from '../render/renderer';
import { InputManager } from '../input/input';
import { Btn, isHeld, wasPressed } from '../input/intents';
import { AudioEngine } from '../audio/audio';
import { Hud } from '../ui/hud';
import { FocusUI } from '../ui/focus';
import { Campaign } from './campaign';
import { LegScene } from './legScene';
import { WorldMemory, type WorldPose } from './worldMemory';
import { Scene, type SceneResult, type SceneServices } from './scene';
import { initPhysics, FIXED_STEP } from '../physics/physics';
import { LEGS, legById, t, validateData } from '../data';
import { Overlays } from '../ui/overlays';
import { CampScene } from './campScene';
import { DelveScene, carryOf } from './delveScene';
import type { DelveSite } from '../world/delveSites';
import { applyEncounterEffects } from './encounterFx';
import { saveCampaign, loadCampaign } from '../save/save';
import { PLAYER_PAINT, newBuild } from '../sim/garage';
import { Workbench } from '../ui/garage';
import { InventoryScreen } from '../ui/inventory';
import type { Player } from './player';
import type { Vehicle } from './vehicle';

export type Phase =
  | 'boot'
  | 'title'
  | 'leg'
  | 'vote'
  | 'camp'
  | 'report'
  | 'ledger'
  | 'fail'
  | 'end';

const MAX_STEPS = 5;

/** Owns the loop, the scene, input and every overlay. One instance per page. */
export class Game {
  R: GameRenderer;
  audio = new AudioEngine();
  input: InputManager;
  hud: Hud;
  focus = new FocusUI();
  overlays: Overlays;
  campaign = new Campaign();
  scene: Scene | null = null;
  phase: Phase = 'boot';
  paused = false;
  pausedBy = -1;
  private acc = 0;
  private last = 0;
  private time = 0;
  private hudAcc = 0;
  debug = false;
  fps = 0;
  private fpsEma = 60;
  private frameMs = 16;
  private wheelHold: [number, number] = [0, 0];
  /** Test and tooling hook. */
  hooks: { onTick?: (g: Game) => void } = {};
  slowMo = 1;
  /** Seconds during which Start is ignored, so the press that began a scene doesn't also pause it. */
  private startLock = 0;
  /** True while the title screen is showing a live autopilot convoy behind the menu. */
  private attract = false;
  private aimHint!: HTMLElement;
  /** The title screen's choice, and the mode of the run in progress: one player, full screen. */
  solo = false;

  constructor() {
    this.debug = new URLSearchParams(location.search).has('debug');
    const canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.R = new GameRenderer(canvas);
    this.input = new InputManager(window);
    const halves = [document.getElementById('half0')!, document.getElementById('half1')!];
    this.hud = new Hud(halves);
    this.hud.setLayout(this.R.layout);
    this.overlays = new Overlays(this);
    this.input.onEscape = () => (this.inventory ? this.inventory.close() : this.togglePause(-1));
    // Mouse aim: click the canvas to capture the pointer. Esc (or alt-tab) releases it, which pauses.
    this.input.attachMouse(canvas);
    this.input.onChange = () => this.saveSettings();
    this.input.canCapture = () => !this.paused && !this.attract && (this.phase === 'leg' || this.phase === 'camp');
    this.input.onPointerLost = () => {
      if (!this.paused && !this.attract && (this.phase === 'leg' || this.phase === 'camp')) this.setPause(true, this.input.mouseSeat());
    };
    this.aimHint = document.createElement('div');
    this.aimHint.id = 'aimhint';
    this.aimHint.textContent = 'Click to capture the mouse · move to aim · left click fire · right click aim';
    document.getElementById('ui')!.appendChild(this.aimHint);
    this.input.onDisconnect = (p) => {
      this.hud.disconnected[p] = true;
      if (this.phase === 'leg' || this.phase === 'camp') this.setPause(true, p);
    };
    this.input.onReconnect = (p) => {
      this.hud.disconnected[p] = false;
    };
    // Browsers need a gesture before audio can start.
    const wake = () => this.audio.init();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    window.addEventListener('gamepadconnected', wake);
    this.R.onContextRestored = () => {
      /* geometry lives in the scene graph; three rebuilds GPU buffers lazily */
    };
    window.addEventListener('resize', () => this.layout());
    this.applySettings();
  }

  async start() {
    await initPhysics();
    if (this.debug) {
      const errs = validateData();
      if (errs.length) console.error('Data validation failed:', errs);
    }
    this.phase = 'title';
    this.hud.setVisible(false);
    this.overlays.showTitle();
    this.layout();
    this.startAttract();
    // Shortcut for checking a map without playing up to it: ?leg=L3P starts a fresh run on that leg.
    const jump = new URLSearchParams(location.search).get('leg');
    if (jump && LEGS.legs.some((l) => l.id === jump)) {
      this.input.autoJoinKeyboard();
      this.newCampaign();
      this.beginLeg(jump);
    }
    this.last = performance.now();
    requestAnimationFrame((n) => this.frame(n));
  }

  layout() {
    this.R.resize();
    const div = document.getElementById('divider')!;
    div.className = this.R.layout === 'horizontal' ? 'h' : 'v';
    this.hud.setLayout(this.R.layout);
  }

  applySettings() {
    try {
      const raw = localStorage.getItem('ironnomad.settings');
      if (!raw) return;
      const s = JSON.parse(raw) as { quality?: QualityPreset; ui?: number; layout?: 'horizontal' | 'vertical'; vol?: number; music?: number; tts?: boolean; mouse?: number; solo?: boolean; input?: unknown };
      if (s.solo) this.setSolo(true);
      if (s.quality && QUALITY[s.quality]) this.R.setQuality(s.quality);
      if (s.ui) this.hud.setScale(s.ui);
      if (s.layout) this.R.setLayout(s.layout);
      if (s.vol !== undefined) this.audio.setVolume(s.vol);
      if (s.music !== undefined) this.audio.setMusicVolume(s.music);
      if (s.tts !== undefined) this.audio.setTtsEnabled(s.tts);
      if (s.mouse) this.input.settings.mouseSens = s.mouse;
      // Control settings: bindings, sensitivities, view. Saved since the first version only kept the mouse speed.
      this.input.importSettings(s.input);
    } catch {
      /* private mode or corrupt settings */
    }
  }

  saveSettings() {
    try {
      localStorage.setItem(
        'ironnomad.settings',
        JSON.stringify({ quality: this.R.quality, ui: this.hud.uiScale, layout: this.R.layout, vol: this.audio.volume, music: this.audio.musicVolume, tts: this.audio.ttsEnabled, mouse: this.input.settings.mouseSens, solo: this.solo, input: this.input.exportSettings() }),
      );
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ services for scenes

  services(): SceneServices {
    return {
      R: this.R,
      audio: this.audio,
      input: this.input,
      campaign: this.campaign,
      onRadio: (text) => this.hud.showSub(text, Math.max(4, Math.min(9, text.length / 14))),
      onTip: (id) => this.hud.showTip(t(`tip.${id}`), 10),
      onBanner: (title, sub) => this.hud.showBanner(title, sub, 4),
    };
  }

  // ------------------------------------------------------------------ flow

  /** One seat and a full-screen view, or two seats and a split screen. Applies to the next run, and to the title demo. */
  setSolo(solo: boolean) {
    this.solo = solo;
    const n = solo ? 1 : 2;
    this.input.setSeats(n);
    this.R.setSeats(n);
    this.hud.setSeats(n);
    this.focus.seats = n;
    this.overlays.pauseFocus.seats = n;
  }

  private attractWorld: WorldMemory | null = null;
  /** The open world's memory: kept from one dawn to the next, saved at each Ledger. */
  world: WorldMemory | null = null;

  newCampaign() {
    this.world = null;
    this.setSolo(this.solo);
    this.campaign = new Campaign([this.overlays.callsign(0), this.overlays.callsign(1)], this.solo);
    this.campaign.seed = (Math.random() * 1e6) | 0;
  }

  startNewGame() {
    this.input.autoJoinKeyboard();
    this.newCampaign();
    this.beginLeg(this.campaign.legId);
  }

  continueGame() {
    const c = loadCampaign();
    if (!c) return this.startNewGame();
    this.setSolo(c.solo);
    this.input.autoJoinKeyboard();
    this.campaign = c;
    this.world = c.worldSave ? WorldMemory.restore(c.worldSave) : null;
    // Resume at the Ledger that was saved at dawn.
    this.beginLedger();
  }

  /** The leg that is waiting, hidden, while a delve has the screen. */
  private delveParent: LegScene | null = null;

  disposeScene() {
    this.attract = false;
    if (this.delveParent) {
      const parent = this.delveParent;
      this.delveParent = null;
      parent.dispose();
    }
    if (this.scene) {
      this.scene.dispose();
      this.scene = null;
    }
  }

  beginLeg(legId: string, start?: WorldPose) {
    this.disposeScene();
    this.overlays.hideAll();
    this.campaign.legId = legId;
    const leg = legById(legId);
    this.R.resize();
    if (leg.open) this.world ??= new WorldMemory();
    const sc = new LegScene(this.services(), leg, leg.open ? { memory: this.world!, start } : {});
    sc.onResult = (r) => this.onSceneResult(r);
    sc.openWorkbench = (p, v) => this.openWorkbench(p, v);
    sc.openInventory = (p) => this.openInventory(p);
    this.scene = sc;
    this.phase = 'leg';
    this.paused = false;
    this.hud.setVisible(true);
    this.focus.active = false;
    this.hud.showBanner(leg.name.toUpperCase(), start ? `Day ${this.campaign.day}` : leg.subtitle, 5);
    this.audio.setMusic('travel');
    this.startLock = 0.5;
  }

  /** Go down: the leg is put to sleep (kept whole, unseen and unticked) and a delve takes its place. */
  beginDelve(site: DelveSite) {
    const parent = this.scene;
    if (!(parent instanceof LegScene) || this.delveParent) return;
    const carry = parent.players.map(carryOf);
    parent.suspend();
    this.delveParent = parent;
    const sc = new DelveScene(this.services(), parent.leg, site, parent.delveRecord(site.id), carry);
    sc.parentTick = (dt) => parent.advanceOffscreen(dt);
    sc.onResult = (r) => this.onSceneResult(r);
    sc.openInventory = (p) => this.openInventory(p);
    this.scene = sc;
    this.paused = false;
    this.startLock = 0.5;
  }

  /** Come back up to the leg, at the way in. */
  endDelve(reason: 'climb' | 'lift' | 'rescue') {
    const sc = this.scene;
    const parent = this.delveParent;
    if (!(sc instanceof DelveScene) || !parent) return;
    const carry = sc.carry();
    const site = sc.site;
    sc.dispose();
    this.delveParent = null;
    this.scene = parent;
    parent.returnFromDelve(site, carry, reason);
    this.audio.setMusic('travel');
    this.paused = false;
    this.startLock = 0.5;
  }

  private onSceneResult(r: SceneResult) {
    if (r.type === 'fail') return this.fail(r.reason);
    if (r.type === 'delveEnter') return this.beginDelve(r.site);
    if (r.type === 'delveExit') return this.endDelve(r.reason);
    if (r.type === 'encounter' && this.scene instanceof LegScene) {
      this.phase = 'vote';
      this.scene.paused = true;
      this.overlays.showEncounter(r.id, (effects, overridden) => {
        const sc = this.scene as LegScene;
        applyEncounterEffects(sc, effects, overridden);
        sc.paused = false;
        sc.resumeAfterEncounter();
        this.phase = 'leg';
        this.overlays.hideAll();
      });
      return;
    }
    if ((r.type === 'dusk' || r.type === 'haven') && this.scene instanceof LegScene) {
      this.phase = 'vote';
      const sc = this.scene;
      sc.paused = true;
      if (sc.leg.open) {
        const hub = sc.hubNearby();
        this.overlays.showCampDecision(sc.leg, (siteId, hot) => this.beginCamp(siteId, hot), sc.campOptions(), hub);
      } else this.overlays.showCampDecision(sc.leg, (siteId, hot) => this.beginCamp(siteId, hot));
      return;
    }
    if (r.type === 'campDone') this.afterCamp();
  }

  beginCamp(siteId: string, hot: boolean) {
    const leg = this.scene instanceof LegScene ? this.scene.leg : legById(this.campaign.legId);
    // Carry over vehicle HP before the leg is torn down.
    this.snapshotVehicles();
    if (this.scene instanceof LegScene && leg.open) {
      // The world remembers the day; the Ledger knows which hub, if any, the convoy is camped at.
      this.campaign.hub = this.scene.hubNearby();
      if (this.world) this.scene.capture(this.world);
    } else this.campaign.hub = leg.endHub ?? null;
    this.disposeScene();
    this.overlays.hideAll();
    this.campaign.hotCamp = hot;
    const camp = new CampScene(this.services(), leg, siteId, hot);
    camp.onResult = (r) => this.onSceneResult(r);
    camp.openWorkbench = (p, v) => this.openWorkbench(p, v);
    camp.openInventory = (p) => this.openInventory(p);
    this.scene = camp;
    this.phase = 'camp';
    this.paused = false;
    this.startLock = 0.5;
    this.hud.showBanner('CAMP', camp.siteName, 5);
  }

  private workbench: Workbench | null = null;
  private inventory: InventoryScreen | null = null;
  /** Seconds the scene stays frozen after a menu closes, so the press that closed it is not also played. */
  private resumeLock = 0;

  /** Open one person's inventory. The game stands still while it is open. */
  openInventory(p: Player) {
    const sc = this.scene;
    if (!sc || this.inventory || this.workbench || (this.phase !== 'leg' && this.phase !== 'camp')) return;
    const back = this.phase;
    sc.paused = true;
    this.phase = 'vote';
    this.inventory = new InventoryScreen(this, this.overlays.root, () => {
      this.inventory = null;
      sc.paused = false;
      this.phase = back;
      this.startLock = 0.4;
      this.resumeLock = 0.2;
    });
    this.inventory.open(p);
  }

  /** Open the field workbench for one of the convoy's vehicles. The game stands still while it is open. */
  openWorkbench(p: Player, v: Vehicle) {
    const sc = this.scene;
    if (!sc || this.workbench || (this.phase !== 'leg' && this.phase !== 'camp')) return;
    const back = this.phase;
    sc.paused = true;
    this.phase = 'vote';
    const wb = new Workbench(this, this.overlays.root, () => {
      this.workbench = null;
      sc.paused = false;
      this.phase = back;
      this.startLock = 0.4;
    });
    this.workbench = wb;
    wb.open(v, p.index);
  }

  private snapshotVehicles() {
    const sc = this.scene;
    if (!sc) return;
    sc.commitFleet();
  }

  private afterCamp() {
    const camp = this.scene as CampScene;
    this.phase = 'report';
    camp.paused = true;
    this.overlays.showReport(camp, () => this.afterReport());
  }

  private afterReport() {
    this.beginLedger();
  }

  beginLedger() {
    this.phase = 'ledger';
    // The Ledger sits on top of the dawn camp so the convoy stays on screen.
    let camp = this.scene instanceof CampScene ? this.scene : null;
    if (!camp) {
      this.disposeScene();
      const leg = legById(this.campaign.legId);
      camp = new CampScene(this.services(), leg, leg.campSites[0], true, true);
      camp.onResult = (r) => this.onSceneResult(r);
      this.scene = camp;
    }
    camp.enterLedgerMode();
    this.hud.setVisible(false);
    this.campaign.worldSave = this.world ? this.world.serialize() : undefined;
    saveCampaign(this.campaign);
    this.overlays.showLedger(camp, (nextLegId) => this.rollOut(nextLegId));
  }

  /** Leave the Ledger for the next morning. In the open world that is wherever the convoy slept. */
  rollOut(nextLegId: string) {
    this.campaign.history.push(this.campaign.legId);
    this.campaign.legId = nextLegId;
    this.campaign.day++;
    this.hud.setVisible(true);
    this.beginLeg(nextLegId, legById(nextLegId).open ? (this.world?.camp ?? undefined) : undefined);
  }

  fail(reason: string) {
    if (this.phase === 'fail') return;
    this.phase = 'fail';
    this.overlays.showFail(reason, () => this.continueGame(), () => this.toTitle());
  }

  toTitle() {
    this.disposeScene();
    this.phase = 'title';
    this.hud.setVisible(false);
    this.overlays.showTitle();
    this.audio.setMusic('none');
    this.startAttract();
  }

  /** Rebuild the title demo, for when the number of seats changed under it. */
  restartAttract() {
    if (this.phase === 'title') this.startAttract();
  }

  /** A looping demo behind the title: one autopilot convoy per seat on the first road. */
  private startAttract() {
    this.disposeScene();
    this.setSolo(this.solo);
    const c = new Campaign(['Ash', 'Rook'], this.solo);
    for (const [i, chassis] of (this.solo ? [[0, 'buggy']] : [[0, 'buggy'], [1, 'quad']]) as readonly (readonly [0 | 1, string])[]) {
      const b = newBuild(chassis, { paint: PLAYER_PAINT[i], seed: 40 + i });
      c.addVehicle(b, i);
    }
    c.seed = (Math.random() * 1e6) | 0;
    this.campaign = c;
    const svc = this.services();
    svc.onRadio = () => {};
    svc.onTip = () => {};
    // The demo drives the open world's highway; one shared layout, so the demo can loop without rebuilding the map.
    this.attractWorld ??= new WorldMemory();
    const sc = new LegScene(svc, legById('W'), { memory: this.attractWorld });
    sc.onResult = () => {};
    sc.pendingResult = true; // no encounters or camp decisions in the demo
    sc.players[0].autopilot = { speed: 17 };
    if (sc.players[1]) sc.players[1].autopilot = { speed: 15 };
    this.scene = sc;
    this.attract = true;
  }

  // ------------------------------------------------------------------ pause

  togglePause(by: number) {
    if (this.phase !== 'leg' && this.phase !== 'camp') return;
    this.setPause(!this.paused, by);
  }

  setPause(on: boolean, by: number) {
    if (on === this.paused) return;
    this.paused = on;
    this.pausedBy = by;
    if (on) this.overlays.showPause(by);
    else this.overlays.hidePause();
  }

  // ------------------------------------------------------------------ loop

  private frame(now: number) {
    const raw = Math.min(0.25, Math.max(0.0001, (now - this.last) / 1000));
    this.last = now;
    this.frameMs = raw * 1000;
    this.fpsEma += (1 / Math.max(raw, 1e-4) - this.fpsEma) * 0.05;
    this.fps = this.fpsEma;
    let dt = raw * this.slowMo;
    // The fixed-step accumulator is clamped to 5 steps so a slow frame cannot spiral.
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_STEP && steps < MAX_STEPS) {
      this.fixed(FIXED_STEP);
      this.acc -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
    this.render(this.acc / FIXED_STEP, raw);
    requestAnimationFrame((n) => this.frame(n));
  }

  private fixed(step: number) {
    this.input.sample(step);
    this.time += step;
    // Menus and overlays run on the same tick so cursors feel identical to the sim.
    if (this.phase === 'title') {
      this.input.pollJoin();
      this.overlays.tickTitle(step);
    }
    // The pointer is only captured during live play; menus and overlays need the cursor back.
    const live = !this.paused && !this.attract && (this.phase === 'leg' || this.phase === 'camp');
    if (this.input.mouseLocked && !live) this.input.release();
    this.aimHint.style.display = live && this.input.mouseSeat() >= 0 && !this.input.mouseLocked ? 'block' : 'none';
    if (this.paused) {
      this.overlays.tickPause(step);
      return;
    }
    if (this.focus.active) this.focus.update(this.input);
    this.overlays.tick(step);
    const sc = this.scene;
    if (!sc) return;
    if (this.attract) {
      if (this.phase === 'title') {
        sc.tick(step);
        // Restart the demo when it runs long, or when the convoy has crashed out.
        const dead = sc.players.every((p) => !p.vehicle || p.vehicle.wreck);
        if (sc.time > 80 || dead) this.startAttract();
      }
      return;
    }
    if (this.phase === 'leg' || this.phase === 'camp') {
      // Pause with Start from either pad.
      this.startLock = Math.max(0, this.startLock - step);
      if (this.startLock <= 0) for (let p = 0; p < 2; p++) if (wasPressed(this.input.intents[p], Btn.Start)) this.togglePause(p);
      if (this.resumeLock > 0) this.resumeLock -= step;
      else if (!sc.paused) {
        this.handleCommandWheel(sc);
        sc.tick(step);
      }
    } else if (sc instanceof CampScene && this.phase === 'ledger') {
      sc.tickIdle(step);
    }
    this.hooks.onTick?.(this);
  }

  /** D-pad: tap = ping, hold = command wheel (Ping, Hold, Follow, Spread, Regroup). */
  private handleCommandWheel(sc: Scene) {
    for (let p = 0; p < 2; p++) {
      const it = this.input.intents[p];
      const pl = sc.players[p];
      if (!pl || pl.state === 'dead') continue;
      if (isHeld(it, Btn.Up)) {
        this.wheelHold[p] += FIXED_STEP;
        if (this.wheelHold[p] > 0.25) {
          // Select a slice with the right stick (or move keys for keyboard).
          const sx = it.device === 'keyboard' ? it.move[0] : it.look[0];
          const sy = it.device === 'keyboard' ? it.move[1] : it.look[1];
          if (Math.hypot(sx, sy) > 0.45) {
            const a = Math.atan2(sx, sy); // 0 = up, + = right
            const deg = (a * 180) / Math.PI;
            this.hud.wheelSel[p] = deg > -36 && deg <= 36 ? 0 : deg > 36 && deg <= 108 ? 1 : deg > 108 || deg <= -144 ? 2 : deg > -144 && deg <= -72 ? 3 : 4;
            if (deg > 108 && deg <= 180) this.hud.wheelSel[p] = 2;
          }
        }
      } else if (this.wheelHold[p] > 0) {
        const held = this.wheelHold[p];
        this.wheelHold[p] = 0;
        const sel = this.hud.wheelSel[p];
        this.hud.wheelSel[p] = -1;
        if (held <= 0.25 || sel === 0) this.doPing(sc, p);
        else {
          const cmd = (['ping', 'follow', 'regroup', 'spread', 'hold'] as const)[sel] ?? 'follow';
          sc.crew.command(cmd, p);
        }
      }
    }
  }

  private doPing(sc: Scene, p: number) {
    const pl = sc.players[p];
    const a = pl.computeAim(pl.vehicle ?? undefined);
    void a;
    const pt = pl.aimPoint;
    // Classify what the ping landed on.
    let vehicle = null as import('./vehicle').Vehicle | null;
    for (const v of sc.vehicles) {
      if (Math.hypot(v.position.x - pt.x, v.position.z - pt.z) < v.def.length * 0.6 + 1.2 && v.faction === 'convoy') vehicle = v;
    }
    sc.crew.command('ping', p, { x: pt.x, z: pt.z, vehicle });
    if (sc instanceof LegScene) sc.addPing(pt.x, pt.z, p);
  }

  /** Tooling: a fixed full-screen camera for screenshots. */
  private photo: { pos: [number, number, number]; look: [number, number, number]; fov: number } | null = null;

  /** Frame one full-screen shot from a fixed camera; pass null to return to the split screen. */
  setPhoto(p: { pos: [number, number, number]; look: [number, number, number]; fov?: number } | null) {
    this.photo = p ? { ...p, fov: p.fov ?? 50 } : null;
    if (!p) this.R.resize();
  }

  private applyPhoto() {
    const ph = this.photo;
    if (!ph) return;
    const R = this.R;
    const v = R.views[0];
    v.rect = { x: 0, y: 0, w: R.width, h: R.height };
    v.camera.aspect = R.width / R.height;
    v.camera.fov = ph.fov;
    v.camera.updateProjectionMatrix();
    v.camera.position.set(...ph.pos);
    v.camera.lookAt(...ph.look);
    v.camera.updateMatrixWorld();
    v.focus.set(...ph.look);
    R.views[1].active = false;
  }

  /**
   * Run the simulation for `seconds` of game time without waiting on requestAnimationFrame, then draw one frame.
   * Used by tests and tooling (and anywhere the tab is hidden and the browser throttles rAF).
   */
  advance(seconds: number, drawEvery = 0) {
    const n = Math.round(seconds / FIXED_STEP);
    for (let i = 0; i < n; i++) {
      this.fixed(FIXED_STEP);
      if (drawEvery && i % drawEvery === 0) this.render(0, FIXED_STEP * drawEvery);
    }
    // Cameras damp per rendered frame, so give the final frame enough time to settle on the new pose.
    this.render(0, drawEvery ? FIXED_STEP : Math.min(Math.max(seconds, FIXED_STEP), 0.5));
  }

  private render(alpha: number, dt: number) {
    const sc = this.scene;
    if (sc && (this.phase === 'leg' || this.phase === 'camp' || this.phase === 'ledger' || this.phase === 'vote' || this.phase === 'report' || (this.phase === 'title' && this.attract))) {
      sc.renderFrame(this.paused ? 0 : alpha, dt);
      this.applyPhoto();
      if (!this.attract) sc.updateAudio(dt);
      this.R.adapt(this.frameMs);
      // Particles scale with the viewport.
      for (let i = 0; i < 2; i++) {
        const v = this.R.views[i];
        this.R.onBeforeView[0] = (idx, cam) => {
          const rect = this.R.views[idx].rect;
          sc.fx.setViewScale(rect.h * this.R.renderPixelRatio(), cam.fov);
        };
        void v;
      }
      this.R.render(this.time);
      if (!this.attract) this.hud.update(sc, dt, this.input.slots, { legProgress: () => null });
    } else {
      // Title: slow orbit around an empty ground plane is not needed; clear to the sky colour.
      this.R.gl.setScissorTest(false);
      this.R.gl.setClearColor(0x0b0907, 1);
      this.R.gl.clear();
    }
    if (this.debug) this.overlays.debugLine(`${this.fps.toFixed(0)} fps · ${this.R.gl.info.render.calls} calls · ${(this.R.gl.info.render.triangles / 1000).toFixed(0)}k tris · scale ${this.R.renderScale.toFixed(2)}${sc ? ` · zombies ${sc.zombies.aliveCount} · veh ${sc.vehicles.length}` : ''}`);
  }
}

void LEGS;
