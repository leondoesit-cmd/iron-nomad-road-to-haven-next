import { GameRenderer, QUALITY, type QualityPreset } from '../render/renderer';
import { InputManager } from '../input/input';
import { Btn, isHeld, wasPressed } from '../input/intents';
import { AudioEngine } from '../audio/audio';
import { Hud } from '../ui/hud';
import { FocusUI } from '../ui/focus';
import { Campaign, GOD_BAG_SLOTS, grantAllWeapons } from './campaign';
import { setExtraBagSlots } from '../sim/gear';
import { StoryVoice } from '../audio/storyVoice';
import { LegScene } from './legScene';
import { WorldMemory, type WorldPose } from './worldMemory';
import { Scene, type SceneResult, type SceneServices } from './scene';
import { initPhysics, FIXED_STEP } from '../physics/physics';
import { LEGS, legById, t, validateData } from '../data';
import { Overlays } from '../ui/overlays';
import { CampScene } from './campScene';
import type { CampLand } from '../render/campArena';
import { forestAt, lushAt, woodsAt } from '../world/hydro';
import { DelveScene, carryOf } from './delveScene';
import type { DelveSite } from '../world/delveSites';
import { applyEncounterEffects } from './encounterFx';
import { resolveTravellerRequest } from './travellerFx';
import { saveCampaign, loadCampaign } from '../save/save';
import { PLAYER_PAINT, newBuild } from '../sim/garage';
import { Workbench } from '../ui/garage';
import { InventoryScreen } from '../ui/inventory';
import { TutorialDirector, TRAINING_STEPS } from './tutorial';
import { setupStoryCampaign } from './story';
import { CoachUI } from '../ui/coach';
import type { Player } from './player';
import type { Vehicle } from './vehicle';
import { BenchmarkRun, type BenchmarkReport } from './benchmark';
import { Rng } from '../core/rng';

export type Phase =
  | 'boot'
  | 'title'
  | 'benchmark'
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
  /** God mode (a setting, on by default): every weapon in the game from the start, with room and ammo for them. */
  godMode = true;
  /** Reads the story's subtitles aloud with the browser's speech synthesis (a setting, on by default). */
  storyVoice = new StoryVoice();
  phase: Phase = 'boot';
  paused = false;
  pausedBy = -1;
  private acc = 0;
  private last = 0;
  private time = 0;
  private hudAcc = 0;
  debug = false;
  private simulationMs = 0;
  private renderCpuMs = 0;
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
  /** Set while Training is running: the lessons, played in a quiet copy of the open world. */
  tutorial: TutorialDirector | null = null;
  benchmark: BenchmarkRun | null = null;
  benchmarkReport: BenchmarkReport | null = null;
  private benchmarkMeta: Omit<BenchmarkReport, 'results'> | null = null;
  private benchmarkRestore: { solo: boolean; layout: GameRenderer['layout']; slots: InputManager['slots']; campaign: Campaign; volume: number; scale: number; slowMo: number } | null = null;
  private benchmarkRng = new Rng(4242);

  constructor() {
    this.debug = new URLSearchParams(location.search).has('debug');
    const canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.R = new GameRenderer(canvas);
    this.input = new InputManager(window);
    const halves = [document.getElementById('half0')!, document.getElementById('half1')!];
    this.hud = new Hud(halves);
    this.hud.setLayout(this.R.layout);
    this.overlays = new Overlays(this);
    this.input.onEscape = () => this.benchmark ? this.stopBenchmark() : (this.inventory ? this.inventory.close() : this.togglePause(-1));
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
    const wake = () => { this.audio.init(); this.audio.userMusic.unlock(); };
    void this.audio.userMusic.load();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    window.addEventListener('gamepadconnected', wake);
    this.R.onContextRestored = () => {
      /* geometry lives in the scene graph; three rebuilds GPU buffers lazily */
    };
    window.addEventListener('resize', () => {
      if (this.benchmark) this.stopBenchmark('Window size changed. Run again at a fixed window size.');
      this.layout();
    });
    document.addEventListener('visibilitychange', () => {
      if (this.benchmark && document.hidden) {
        this.benchmark.restartCurrent();
        this.overlays.updateBenchmarkProgress(true);
      }
    });
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
    // ?training goes straight into the lessons, the way ?leg skips to a map.
    if (new URLSearchParams(location.search).has('training')) {
      this.input.autoJoinKeyboard();
      this.startTraining();
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
    this.setGodMode(this.godMode);
    try {
      const raw = localStorage.getItem('ironnomad.settings');
      if (!raw) return;
      const s = JSON.parse(raw) as { quality?: QualityPreset; ui?: number; layout?: 'horizontal' | 'vertical'; vol?: number; music?: number; gameMusicEnabled?: boolean; userMusicEnabled?: boolean; userMusicVolume?: number; tts?: boolean; god?: boolean; voice?: boolean; mouse?: number; solo?: boolean; input?: unknown };
      if (s.solo) this.setSolo(true);
      if (s.quality && QUALITY[s.quality]) this.R.setQuality(s.quality);
      if (s.ui) this.hud.setScale(s.ui);
      if (s.layout) this.R.setLayout(s.layout);
      if (s.vol !== undefined) this.audio.setVolume(s.vol);
      if (s.music !== undefined) this.audio.setMusicVolume(s.music);
      if (s.gameMusicEnabled !== undefined) this.audio.setGameMusicEnabled(s.gameMusicEnabled);
      if (s.userMusicEnabled !== undefined) this.audio.setUserMusicEnabled(s.userMusicEnabled);
      if (s.userMusicVolume !== undefined) this.audio.setUserMusicVolume(s.userMusicVolume);
      if (s.tts !== undefined) this.audio.setTtsEnabled(s.tts);
      if (s.god !== undefined) this.setGodMode(s.god);
      if (s.voice !== undefined) this.storyVoice.enabled = s.voice;
      if (s.mouse) this.input.settings.mouseSens = s.mouse;
      // Control settings: bindings, sensitivities, view. Saved since the first version only kept the mouse speed.
      this.input.importSettings(s.input);
    } catch {
      /* private mode or corrupt settings */
    }
  }

  saveSettings() {
    if (this.benchmark) return;
    try {
      localStorage.setItem(
        'ironnomad.settings',
        JSON.stringify({ quality: this.R.quality, ui: this.hud.uiScale, layout: this.R.layout, vol: this.audio.volume, music: this.audio.musicVolume, gameMusicEnabled: this.audio.gameMusicEnabled, userMusicEnabled: this.audio.userMusicEnabled, userMusicVolume: this.audio.userMusicVolume, tts: this.audio.ttsEnabled, god: this.godMode, voice: this.storyVoice.enabled, mouse: this.input.settings.mouseSens, solo: this.solo, input: this.input.exportSettings() }),
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
      onSubtitle: (text, secs) => {
        this.hud.showSub(text, secs ?? Math.max(3.5, Math.min(8, text.length / 13)));
        this.storyVoice.volume = this.audio.muted ? 0 : this.audio.volume;
        this.storyVoice.speak(text);
      },
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
    // One listener on one centred bus; otherwise every sound leans to player one's side of the stereo field.
    this.audio.setSolo(solo);
  }

  private attractWorld: WorldMemory | null = null;
  /** The open world's memory: kept from one dawn to the next, saved at each Ledger. */
  world: WorldMemory | null = null;

  newCampaign() {
    this.world = null;
    this.setSolo(this.solo);
    this.campaign = new Campaign(this.overlays.heroes(), this.solo);
    this.campaign.seed = (Math.random() * 1e6) | 0;
    if (this.godMode) grantAllWeapons(this.campaign);
  }

  /** Turning it on arms the run in progress too; turning it off keeps what is carried, but the bag shrinks back. */
  setGodMode(on: boolean) {
    this.godMode = on;
    setExtraBagSlots(on ? GOD_BAG_SLOTS : 0);
    if (on && this.phase !== 'boot' && this.phase !== 'title') grantAllWeapons(this.campaign);
  }

  startNewGame() {
    this.input.autoJoinKeyboard();
    this.newCampaign();
    this.beginLeg(this.campaign.legId);
  }

  /**
   * Story mode: a new run that begins in Nar's yard on the salt flat, on foot, with Nar out cold on his mattress and the
   * rickshaw trike in pieces round him (`game/story.ts`).
   */
  startStory() {
    this.input.autoJoinKeyboard();
    this.newCampaign();
    setupStoryCampaign(this.campaign);
    this.beginLeg(LEGS.route.start, undefined, true);
  }

  continueGame() {
    const c = loadCampaign();
    if (!c) return this.startNewGame();
    this.setSolo(c.solo);
    this.input.autoJoinKeyboard();
    this.campaign = c;
    if (this.godMode) grantAllWeapons(c);
    this.world = c.worldSave ? WorldMemory.restore(c.worldSave) : null;
    // Resume at the Ledger that was saved at dawn.
    this.beginLedger();
  }

  /** The leg that is waiting, hidden, while a delve has the screen. */
  private delveParent: LegScene | null = null;

  disposeScene() {
    this.attract = false;
    this.storyVoice.stop();
    if (this.tutorial) {
      this.tutorial.dispose(this.scene instanceof LegScene ? this.scene : null);
      this.tutorial = null;
    }
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

  beginLeg(legId: string, start?: WorldPose, story = false) {
    this.disposeScene();
    this.overlays.hideAll();
    this.campaign.legId = legId;
    const leg = legById(legId);
    this.R.resize();
    if (leg.open) this.world ??= new WorldMemory();
    const sc = new LegScene(this.services(), leg, leg.open ? { memory: this.world!, start, story: story && !!leg.open.yard } : {});
    sc.onResult = (r) => this.onSceneResult(r);
    sc.openWorkbench = (p, v) => this.openWorkbench(p, v);
    sc.openInventory = (p) => this.openInventory(p);
    this.scene = sc;
    this.phase = 'leg';
    this.paused = false;
    this.hud.setVisible(true);
    this.focus.active = false;
    if (story) this.hud.showBanner('NAR\'S FLAT', 'Mission one', 5);
    else this.hud.showBanner(leg.name.toUpperCase(), start ? `Day ${this.campaign.day}` : leg.subtitle, 5);
    this.audio.setMusic('travel');
    this.startLock = 0.5;
  }

  /** Training: the lessons, in a quiet copy of the open world that never touches a save or the run's own world. */
  startTraining() {
    this.input.autoJoinKeyboard();
    this.disposeScene();
    this.overlays.hideAll();
    this.setSolo(this.solo);
    this.campaign = new Campaign(this.overlays.heroes(), this.solo);
    this.campaign.seed = 4242;
    this.campaign.flags.training = true;
    const leg = legById('W');
    this.R.resize();
    const svc = this.services();
    svc.onTip = () => {};
    const sc = new LegScene(svc, leg, { memory: new WorldMemory(), training: true });
    sc.onResult = (r) => {
      // Nothing out here ends the lesson but the Dusk Bell's camp: caves, encounters and the rest are not part of it.
      if (r.type === 'dusk') this.tutorial?.note('camp', 0);
    };
    sc.openWorkbench = (p, v) => this.openWorkbench(p, v);
    sc.openInventory = (p) => {
      this.tutorial?.note('inventory', p.index);
      this.openInventory(p);
    };
    this.scene = sc;
    this.phase = 'leg';
    this.paused = false;
    this.hud.setVisible(true);
    this.focus.active = false;
    const halves = [document.getElementById('half0')!, document.getElementById('half1')!];
    const tut = new TutorialDirector(new CoachUI(halves));
    tut.onFinish = () => this.finishTraining();
    this.tutorial = tut;
    this.hud.showBanner('TRAINING', 'Follow the lesson card', 5);
    this.audio.setMusic('travel');
    this.startLock = 0.5;
  }

  private finishTraining() {
    const sc = this.scene;
    if (!(sc instanceof LegScene)) return;
    this.phase = 'vote';
    sc.paused = true;
    this.overlays.showTrainingDone(TRAINING_STEPS);
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
    if (r.type === 'traveller' && this.scene instanceof LegScene) {
      const sc = this.scene;
      const tv = sc.travellers.byId(r.id);
      if (!tv) return sc.resumeAfterTalk();
      this.phase = 'vote';
      sc.paused = true;
      const finish = () => {
        sc.paused = false;
        sc.resumeAfterTalk();
        this.phase = 'leg';
        this.overlays.hideAll();
      };
      if (r.mode === 'trade') {
        this.overlays.showTrade(tv, () => {
          sc.travellers.endTalk(tv);
          finish();
        });
      } else {
        this.overlays.showRequest(tv, (helped, overridden) => {
          resolveTravellerRequest(sc, tv, helped, overridden);
          finish();
        });
      }
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
    let land: CampLand | undefined;
    if (this.scene instanceof LegScene && leg.open) {
      // The world remembers the day; the Ledger knows which hub, if any, the convoy is camped at.
      this.campaign.hub = this.scene.hubNearby();
      if (this.world) this.scene.capture(this.world);
      land = campLand(this.scene);
    } else this.campaign.hub = leg.endHub ?? null;
    this.disposeScene();
    this.overlays.hideAll();
    this.campaign.hotCamp = hot;
    const camp = new CampScene(this.services(), leg, siteId, hot, false, land);
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
    const c = new Campaign(this.overlays.heroes(), this.solo);
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

  /** Title-only, disposable scenes: never writes campaign or settings saves. */
  startBenchmark(duration: 'quick' | 'standard' = 'standard') {
    if (this.phase !== 'title' || this.benchmark) return;
    this.benchmarkRestore = {
      solo: this.solo, layout: this.R.layout, slots: [...this.input.slots], campaign: this.campaign,
      volume: this.audio.volume, scale: this.R.renderScale, slowMo: this.slowMo,
    };
    this.disposeScene();
    this.photo = null;
    this.paused = false;
    this.slowMo = 1;
    this.acc = 0;
    this.audio.setVolume(0);
    this.audio.setMusic('none');
    this.input.release();
    this.R.setRenderScale(1);
    this.benchmark = new BenchmarkRun(duration);
    const gl = this.R.gl.getContext();
    this.benchmarkMeta = {
      version: 1, createdAt: new Date().toISOString(), duration, seed: 4242,
      quality: this.R.quality, width: this.R.width, height: this.R.height,
      pixelRatio: this.R.renderPixelRatio(), renderScale: 1, post: this.R.usePost,
      browser: navigator.userAgent, renderer: String(gl.getParameter(gl.RENDERER)),
      warmupMs: this.benchmark.warmupMs, measureMs: this.benchmark.measureMs,
    };
    this.phase = 'benchmark';
    this.hud.setVisible(false);
    this.overlays.showBenchmarkRunning();
  }

  private loadBenchmarkCase() {
    const run = this.benchmark!;
    this.disposeScene();
    const test = run.current;
    this.setSolo(test.seats === 1);
    this.R.setLayout(test.layout);
    this.layout();
    this.campaign = new Campaign(undefined, this.solo);
    this.campaign.seed = 4242;
    this.campaign.legId = test.scenario.leg;
    this.benchmarkRng = new Rng(4242);
    const svc = this.services();
    svc.onRadio = () => {};
    svc.onTip = () => {};
    svc.onBanner = () => {};
    const sc = new LegScene(svc, legById(test.scenario.leg));
    sc.pendingResult = true;
    sc.onResult = () => {};
    sc.clock.elapsed = sc.clock.dayLength * (test.scenario.night ? 1.05 : 0.4);
    sc.clock.frozen = true;
    for (const p of sc.players) { p.autopilot = { speed: test.scenario.speed }; p.invuln = 3600; }
    if (test.scenario.effects) {
      const p = sc.players[0].pos;
      for (let i = 0; i < 96; i++) {
        const a = i * Math.PI * 2 / 96;
        const r = 16 + (i % 4) * 5;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        if (sc.src.layout.blockedAt(x, z, 1)) continue;
        const zombie = sc.zombies.spawn(i % 5 === 0 ? 'runner' : 'walker', x, z, false, 4242);
        // Stable cosmetic phase as well as the seeded layout and effect emitter.
        zombie.yaw = a; zombie.phase = i % 6; zombie.walkPhase = zombie.phase;
        zombie.variant = i % 3; zombie.aiT = 0;
      }
    }
    this.scene = sc;
    this.acc = 0;
    this.last = performance.now();
    run.loaded();
  }

  stopBenchmark(error?: string) {
    if (!this.benchmark) return;
    const run = this.benchmark;
    if (run.stage === 'complete' && this.benchmarkMeta) {
      this.benchmarkReport = { ...this.benchmarkMeta, results: run.results };
    }
    const restore = this.benchmarkRestore!;
    this.benchmark = null;
    this.benchmarkMeta = null;
    this.benchmarkRestore = null;
    this.disposeScene();
    this.setSolo(restore.solo);
    this.R.setLayout(restore.layout);
    this.input.slots = restore.slots;
    this.campaign = restore.campaign;
    this.audio.setVolume(restore.volume);
    this.R.setRenderScale(restore.scale);
    this.slowMo = restore.slowMo;
    this.acc = 0;
    this.last = performance.now();
    this.toTitle();
    // startAttract changes seats; restore both joined devices after its setup too.
    this.input.slots = restore.slots;
    this.overlays.showBenchmark(error ?? (run.stage === 'complete' ? undefined : 'Run cancelled.'));
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
    if (this.benchmark) {
      if (this.R.contextLost) this.stopBenchmark('Graphics context was lost. Run again after it recovers.');
      else if (document.hidden) {
        this.benchmark.restartCurrent();
        this.last = now;
        this.overlays.updateBenchmarkProgress(true);
        requestAnimationFrame(n => this.frame(n));
        return;
      } else if (this.benchmark.stage === 'loading') {
        try { this.loadBenchmarkCase(); }
        catch (error) { console.error('Benchmark setup failed', error); this.stopBenchmark('Could not load this scenario. See the browser console for details.'); }
        this.overlays.updateBenchmarkProgress();
        requestAnimationFrame(n => this.frame(n));
        return;
      }
    }
    const benchmarkFrameMs = Math.max(0.0001, now - this.last);
    const raw = Math.min(0.25, Math.max(0.0001, (now - this.last) / 1000));
    this.last = now;
    this.frameMs = raw * 1000;
    this.fpsEma += (1 / Math.max(raw, 1e-4) - this.fpsEma) * 0.05;
    this.fps = this.fpsEma;
    let dt = raw * this.slowMo;
    // The fixed-step accumulator is clamped to 5 steps so a slow frame cannot spiral.
    this.acc += dt;
    let steps = 0;
    const measuring = this.debug || !!this.benchmark;
    const simulationStart = measuring ? performance.now() : 0;
    const frameScene = this.scene;
    frameScene?.beginFrame();
    while (this.acc >= FIXED_STEP && steps < MAX_STEPS) {
      this.fixed(FIXED_STEP);
      this.acc -= FIXED_STEP;
      steps++;
    }
    frameScene?.endFrame();
    if (measuring) this.simulationMs = performance.now() - simulationStart;
    const droppedSteps = (steps === MAX_STEPS ? Math.floor(this.acc / FIXED_STEP) : 0)
      + Math.floor(Math.max(0, benchmarkFrameMs / 1000 - raw) / FIXED_STEP);
    if (steps === MAX_STEPS) this.acc = 0;
    this.render(this.acc / FIXED_STEP, raw);
    this.storyVoice.setPaused(this.paused || document.hidden);
    if (this.benchmark) {
      const info = this.R.gl.info.render;
      this.benchmark.record({ frameMs: benchmarkFrameMs, simulationMs: this.simulationMs, renderCpuMs: this.renderCpuMs,
        calls: info.calls, triangles: info.triangles, steps, droppedSteps });
      if (this.benchmark.stage === 'complete') this.stopBenchmark();
      else this.overlays.updateBenchmarkProgress();
    }
    requestAnimationFrame((n) => this.frame(n));
  }

  private fixed(step: number) {
    this.audio.updateUserMusic(!this.attract && (this.phase === 'leg' || this.phase === 'camp') && !!this.scene?.players.some(p => p.inVehicle));
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
    if (this.benchmark) {
      // Menu input can cancel the run, but held controls must not change the scripted workload.
      for (const it of this.input.intents) { it.held = 0; it.pressed = 0; it.released = 0; it.move = [0, 0]; it.look = [0, 0]; }
      sc.tick(step);
      if (this.benchmark.current.scenario.effects) {
        const p = sc.players[0].pos, rng = this.benchmarkRng;
        for (let i = 0; i < 8; i++) {
          const x = p.x + rng.range(-12, 12), z = p.z + rng.range(3, 22), y = sc.groundAt(x, z) + 0.5;
          sc.fx.smoke.emit(x, y, z, rng.range(-1, 1), 1.5, 0, 2.5, 1.5, 5, 0.18, 0.16, 0.13, 0.5);
          sc.fx.glow.emit(x, y, z, 0, 1.2, 0, 0.7, 0.8, 0.1, 1, 0.5, 0.1, 0.9);
        }
      }
      return;
    }
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
        if (this.tutorial && sc instanceof LegScene) this.tutorial.tick(sc, step);
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
    const renderStart = this.debug || this.benchmark ? performance.now() : 0;
    const sc = this.scene;
    if (sc && (this.phase === 'benchmark' || this.phase === 'leg' || this.phase === 'camp' || this.phase === 'ledger' || this.phase === 'vote' || this.phase === 'report' || (this.phase === 'title' && this.attract))) {
      sc.renderFrame(this.paused ? 0 : alpha, dt);
      this.applyPhoto();
      if (!this.attract) sc.updateAudio(dt);
      if (!this.benchmark) this.R.adapt(this.frameMs);
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
      if (!this.attract && !this.benchmark) this.hud.update(sc, dt, this.input.slots, { legProgress: () => null });
    } else {
      // Title: slow orbit around an empty ground plane is not needed; clear to the sky colour.
      this.R.gl.setScissorTest(false);
      this.R.gl.setClearColor(0x0b0907, 1);
      this.R.gl.clear();
    }
    if (this.debug || this.benchmark) this.renderCpuMs = performance.now() - renderStart;
    if (this.debug) {
      this.overlays.debugLine(`${this.fps.toFixed(0)} fps · CPU sim ${this.simulationMs.toFixed(1)} / draw ${this.renderCpuMs.toFixed(1)} ms · ${this.R.gl.info.render.calls} calls · ${(this.R.gl.info.render.triangles / 1000).toFixed(0)}k tris · scale ${this.R.renderScale.toFixed(2)}${sc ? ` · zombies ${sc.zombies.aliveCount} · veh ${sc.vehicles.length}` : ''}`);
    }
  }
}

void LEGS;

/**
 * The land round the spot where the convoy made camp, if it is on the green: the meadow under it, and the thickest wood within
 * 70 m (the camp's basin is ringed by it). Undefined in the dust, so a desert camp stays as it always was.
 */
function campLand(sc: LegScene): CampLand | undefined {
  const T = sc.terrain;
  const p = sc.campPose;
  if (!T?.hydro || !p) return undefined;
  let lush = 0;
  let wood = 0;
  for (let k = 0; k < 9; k++) {
    const a = (k / 8) * Math.PI * 2;
    const r = k === 8 ? 0 : 25;
    lush += lushAt(T, p.x + Math.cos(a) * r, p.z + Math.sin(a) * r) / 9;
    wood = Math.max(wood, forestAt(T, p.x + Math.cos(a) * 70, p.z + Math.sin(a) * 70));
  }
  if (lush < 0.2) return undefined;
  return { lush, wood, woods: woodsAt(T, p.x, p.z) };
}
