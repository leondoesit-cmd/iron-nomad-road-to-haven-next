import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HEROES, type HeroId } from '../data';
import { AmiratGarden } from '../render/amiratGarden';
import { disposeTree } from '../render/dispose';
import { PartyCast } from '../render/partyCast';
import { BUZZER, BUZZ_DELAY, DRIVEWAY, GATE, GARDEN_BOUNDS, GARDEN_LAYOUT, HOUSE_NAME, PARTY, gateLeafBox, houseBoxes, houseLocal, houseWorld, inGarden, type HousePlace } from '../world/ududHouse';
import { GROUPS } from '../physics/physics';
import type { Collider } from '@dimforge/rapier3d-compat';
import { clamp, damp } from '../core/math';
import { STORY_FLAG } from './story';
import type { CompassPin } from './scene';
import type { LegScene } from './legScene';
import type { Player } from './player';

/**
 * Mission two: get Nar from his yard to Udud and Nuhat's house at the north end of Petah Tikva, where the family is having a
 * barbecue. It takes over from mission one (`game/story.ts`) once `story.m1` is set: the objective and a compass pin point
 * the way; when the trike (or anyone) reaches the house, `story.house` is set, Nar gets out and joins the party (the story
 * director stops drawing him in the cab) and everyone waves. The gate is shut: ring the buzzer on its post, the intercom
 * crackles, and five seconds later the gate is buzzed open. Walk round to the garden and Iati, on his chair by the way in,
 * takes a long drag and blows the smoke over you: a blessing, and a dose of weed (the player's own drug system), and while
 * it lasts the party gets strange (`PartyCast.high`, `AmiratGarden.high`). Being blessed, saying hello to anyone or walking
 * up onto the patio finishes the mission (`story.m2`).
 *
 * The house and the party are there in every run, story or not: this also streams the garden model (`render/amiratGarden.ts`,
 * its static parts merged into one mesh per material) and the cast (`render/partyCast.ts`) in when someone comes within a few
 * hundred metres, and gives everyone at the party something to say. The house's colliders are the layout's
 * (`LegLayoutImpl.buildHouse`).
 */

export const PARTY_FLAG = { house: STORY_FLAG.house, m2: 'story.m2', seen: 'map.house', gate: 'house.gate' } as const;

/** Show the house within this far of a player; drop it again beyond the second. */
const SHOW = 340;
const HIDE = 420;
/** How close to the gate counts as having got there. */
const ARRIVE = 16;
/** Draw and animate the people at the party within this far. */
const PEOPLE = 140;
/** How close to Iati someone has to come for him to bless them, and how far round the cloud reaches. */
const BLESS_REACH = 4.2;
const CLOUD = 2.2;
/** How long the gate takes to swing open. */
const SWING = 1.4;

/** What each of them says when you talk to them, in turn. */
const LINES: Record<HeroId, string[]> = {
  amirat: [
    'Amirat: Just in time. The steaks are nearly there, grab a plate.',
    'Amirat: The secret is the coals. You never rush the coals.',
    'Amirat: Kebabs next. Tell Lag to leave room.',
  ],
  lag: [
    'Lag: Mmf... the cake. You have to try the cake.',
    'Lag: Third slice. Don\'t tell Nuhat.',
    'Lag: I brought my own spoons. Big ones.',
  ],
  ro: [
    'Ro: Ha! You came all the way on that trike? From the flat?',
    'Ro: Beers are in the little fridge by the fence.',
    'Ro: Don\'t get between my brother and that cake.',
  ],
  nuhat: [
    'Nuhat: You made it! Sit, sit, eat something.',
    'Nuhat: There\'s tea, there\'s tahini, there\'s Amirat\'s meat. Help yourself.',
    'Nuhat: Udud hasn\'t left that chair since noon.',
  ],
  udud: [
    'Udud: Good to see you. Pull up a chair.',
    'Udud: Petah Tikva\'s quiet today. Quiet is good.',
    'Udud: Nar looks better already. That\'s Amirat\'s cooking.',
  ],
  iati: [
    'Iati: Easy, brother. Today is a day off.',
    'Iati: Best seat in the garden, right here by the way in. I see everyone first.',
    'Iati: The road can wait till morning. Breathe.',
  ],
  nar: [
    'Nar: I told you the trike would make it.',
    'Nar: Tea with mint. Now I\'m alive again.',
    'Nar: Thank you for bringing me. I mean it.',
  ],
  chinsky: [
    'Chinsky: Took you long enough.',
    'Chinsky: Udud\'s telling the generator story again. Sit down, it\'s a good one.',
  ],
  leo: [
    'Leo: You have to try the hummus.',
    'Leo: Sit down, you look like you\'ve been driving all day.',
  ],
};

export class PartyMission {
  readonly place: HousePlace | null;
  /** The house and garden, in the world (null while nobody is near). */
  private house: THREE.Group | null = null;
  private garden: AmiratGarden | null = null;
  private cast: PartyCast | null = null;
  /** Who was left out of the cast it was built with, to rebuild it when that changes (Nar arriving). */
  private castKey = '';
  private said = new Map<HeroId, number>();
  private announced = false;
  private hinted = false;
  private look = new THREE.Vector3();
  /** Lines queued to be said, on the mission's own clock. */
  private lines: { at: number; text: string; secs: number }[] = [];
  private clock = 0;
  /** When the buzzer was rung (the gate opens `BUZZ_DELAY` after), or -1. */
  private rungAt = -1;
  /** How far the gate has swung open, 0..1, and the collider that bars the way while it is shut. */
  private gateT = 0;
  private gateCollider: Collider | null = null;
  /** Iati has blessed whoever came in this visit; and how high the party looks, 0..1. */
  private blessedHere = false;
  private blessWho: Player | null = null;
  private high = 0;
  private tmp = new THREE.Vector3();

  constructor(private sc: LegScene) {
    this.place = sc.src.layout.house ?? null;
    if (!this.place) return;
    this.gateT = this.flags[PARTY_FLAG.gate] ? 1 : 0;
    this.registerTalk();
    this.registerBuzzer();
    this.refresh();
  }

  private get flags() {
    return this.sc.campaign.flags;
  }

  /** A story run between leaving Nar's yard and saying hello at the house. */
  get active(): boolean {
    const f = this.flags;
    return !!f.story && !!f[STORY_FLAG.m1] && !f[PARTY_FLAG.m2];
  }

  /** Does the map show the house: once someone has seen it, or while mission two is heading there. */
  get onMap(): boolean {
    return !!this.place && (!!this.flags[PARTY_FLAG.seen] || this.active);
  }

  /** The heroes out on the road (the players), and Nar while he's still riding in the trike: nobody draws them at the party. */
  private absent(): Set<HeroId> {
    const c = this.sc.campaign;
    const out = new Set<HeroId>([c.players[0].hero]);
    if (!c.solo) out.add(c.players[1].hero);
    if (c.flags.story && !c.flags[STORY_FLAG.house]) out.add('nar');
    return out;
  }

  // ------------------------------------------------------------------ the mission, every tick

  tick(dt: number) {
    const p = this.place;
    if (!p) return;
    this.clock += dt;
    while (this.lines.length && this.lines[0].at <= this.clock) {
      const l = this.lines.shift()!;
      this.sc.subtitle(l.text, l.secs);
    }
    const near = this.nearest();
    if (near.d < 150) this.flags[PARTY_FLAG.seen] = true;
    // The first time anyone comes up the road to the house, its name.
    if (!this.announced && near.d < 70) {
      this.announced = true;
      if (!this.active) this.sc.banner(HOUSE_NAME.toUpperCase(), 'A barbecue at the north end of Petah Tikva');
    }
    // Buzzed in: the gate's catch lets go five seconds after the buzzer.
    if (this.rungAt >= 0 && this.clock - this.rungAt >= BUZZ_DELAY) {
      this.rungAt = -1;
      this.openGate();
    }
    this.watchForBlessing();
    if (!this.active) {
      if (this.flags.story && this.flags[PARTY_FLAG.m2]) this.clearObjective();
      return;
    }
    if (!this.hinted) {
      this.hinted = true;
      if (!this.flags[STORY_FLAG.house]) {
        this.sc.subtitle('Nar: Udud and Nuhat\'s... the north end of Petah Tikva, up the boulevard. Amirat said he\'s grilling today.', 5.5);
      }
    }
    if (!this.flags[STORY_FLAG.house] && near.d < ARRIVE) this.arrive();
    // Saying hello: talking to someone (see `registerTalk`), or just walking up onto the patio.
    if (this.flags[STORY_FLAG.house] && !this.flags[PARTY_FLAG.m2]) {
      for (const pl of this.sc.players) {
        if (pl.state !== 'foot') continue;
        const l = houseLocal(p, pl.pos.x, pl.pos.z);
        if (l.z < GARDEN_BOUNDS.patio.maxZ + 0.6 && l.z > GARDEN_BOUNDS.patio.minZ && l.x > GARDEN_BOUNDS.patio.minX && l.x < GARDEN_BOUNDS.patio.maxX) this.complete();
      }
    }
    this.refresh();
  }

  /** They're here: Nar gets out and joins the others, and the garden says hello. */
  private arrive() {
    this.flags[STORY_FLAG.house] = true;
    this.sc.banner(HOUSE_NAME.toUpperCase(), 'North Petah Tikva');
    this.cast?.greet();
    if (!this.flags[PARTY_FLAG.gate]) this.say(0.4, 'Nar: This is it, number eighteen. Ring the buzzer, it\'s on the gate post.', 5);
    this.say(this.flags[PARTY_FLAG.gate] ? 0.4 : 6, 'Nar: Help me out of this thing. I can smell the meat from here.', 4.5);
  }

  /** Queue a subtitle `at` seconds from now. */
  private say(at: number, text: string, secs = 4.5) {
    this.lines.push({ at: this.clock + at, text, secs });
    this.lines.sort((a, b) => a.at - b.at);
  }

  /** Mission two is done. */
  private complete() {
    if (this.flags[PARTY_FLAG.m2]) return;
    this.flags[PARTY_FLAG.m2] = true;
    this.sc.banner('MISSION TWO COMPLETE', HOUSE_NAME);
    this.clearObjective();
  }

  private clearObjective() {
    if (this.sc.objective?.title.startsWith('Mission two')) this.sc.objective = null;
    this.sc.missionPins = this.sc.missionPins.filter((q) => q.label !== 'HOUSE');
  }

  /** The objective and the compass pin for where mission two stands. */
  private refresh() {
    const p = this.place;
    if (!p || !this.active) return;
    const at = this.flags[STORY_FLAG.house];
    const amirat = !this.absent().has('amirat');
    const open = !!this.flags[PARTY_FLAG.gate];
    this.sc.objective = at
      ? {
          title: 'Mission two: the barbecue',
          steps: [
            { text: 'Bring Nar to Udud and Nuhat\'s house', done: true },
            { text: 'Ring the buzzer at the gate', done: open },
            { text: amirat ? 'Join everyone in the garden (Amirat\'s at the grill)' : 'Join everyone in the garden', done: false },
          ],
          hint: open ? 'Through the gate and down the side passage to the garden' : this.rungAt >= 0 ? 'Wait for the gate to buzz' : 'The buzzer is on the gate\'s post, by the mailbox',
        }
      : {
          title: 'Mission two: Udud and Nuhat\'s house',
          steps: [
            { text: 'Drive up the boulevard into Petah Tikva', done: this.inCity() },
            { text: 'Bring Nar to the house at the north end', done: false },
          ],
          hint: 'Number 18, on the right of the boulevard in the last row of blocks before the city ends · follow HOUSE on the compass',
        };
    const gate = houseWorld(p, GATE.x, at ? GATE.z : (DRIVEWAY.minZ + DRIVEWAY.maxZ) / 2);
    const pin: CompassPin = { x: gate.x, z: gate.z, kind: 'end', label: 'HOUSE' };
    this.sc.missionPins = [...this.sc.missionPins.filter((q) => q.label !== 'HOUSE'), pin];
  }

  /** Is anyone in the city's streets yet? */
  private inCity() {
    const ds = this.sc.terrain?.open?.districts ?? [];
    return this.sc.players.some((pl) => {
      const x = pl.vehicle?.position.x ?? pl.pos.x;
      const z = pl.vehicle?.position.z ?? pl.pos.z;
      return ds.some((d) => x > d.x0 && x < d.x1 && z > d.z0 && z < d.z1);
    });
  }

  /** The nearest player (or their vehicle) to the house's gate and driveway. */
  private nearest(): { d: number; who: Player | null } {
    const p = this.place!;
    let best = Infinity;
    let who: Player | null = null;
    for (const pl of this.sc.players) {
      const x = pl.vehicle?.position.x ?? pl.pos.x;
      const z = pl.vehicle?.position.z ?? pl.pos.z;
      const l = houseLocal(p, x, z);
      // Distance to the plot's rectangle (zero anywhere on it).
      const dx = Math.max(-7.3 - l.x, 0, l.x - 7.6);
      const dz = Math.max(DRIVEWAY.minZ - l.z, 0, l.z - GARDEN_BOUNDS.lawnEnd);
      const d = Math.hypot(dx, dz);
      if (d < best) {
        best = d;
        who = pl;
      }
    }
    return { d: best, who };
  }

  // ------------------------------------------------------------------ talking to people

  private registerTalk() {
    const p = this.place!;
    for (const s of PARTY) {
      // Speak from the side they face, a step in front of them (beside the grill for Amirat).
      const off = s.activity === 'grill' ? { x: GARDEN_LAYOUT.grill[0] + 0.9, z: GARDEN_LAYOUT.grill[1] - 0.6 } : { x: s.x + Math.sin(s.yaw) * 0.9, z: s.z + Math.cos(s.yaw) * 0.9 };
      const w = houseWorld(p, off.x, off.z);
      this.sc.interact.add({
        id: `party:${s.hero}`,
        x: w.x,
        z: w.z,
        r: 1.9,
        prompt: `Talk to ${HEROES[s.hero].name}`,
        dur: 0.25,
        priority: 2,
        direct: true,
        enabled: (pl) => pl.state === 'foot' && !pl.carry && this.present(s.hero),
        run: (pl) => this.talk(s.hero, pl),
      });
    }
  }

  /** Is this hero at the party right now? */
  private present(hero: HeroId) {
    if (this.absent().has(hero)) return false;
    return hero === 'amirat' ? !!this.garden?.amirat : !!this.cast?.has(hero);
  }

  private talk(hero: HeroId, who?: Player) {
    // Iati answers by blessing you again, unless you're still floating from the last one.
    if (hero === 'iati' && who && this.highOf(who) < 0.25 && this.bless(who)) return;
    const lines = LINES[hero];
    const i = this.said.get(hero) ?? 0;
    this.said.set(hero, i + 1);
    this.sc.subtitle(lines[i % lines.length], 4.5);
    if (this.active && this.flags[STORY_FLAG.house]) this.complete();
  }

  // ------------------------------------------------------------------ the buzzer and the gate

  private registerBuzzer() {
    const p = this.place!;
    const w = houseWorld(p, BUZZER.x, BUZZER.standZ);
    this.sc.interact.add({
      id: 'party:buzzer',
      x: w.x,
      z: w.z,
      r: 1.6,
      prompt: 'Ring the buzzer',
      dur: 0.3,
      priority: 3,
      direct: true,
      enabled: (pl) => pl.state === 'foot' && !this.flags[PARTY_FLAG.gate] && this.rungAt < 0,
      run: () => this.ring(),
    });
  }

  /** Press the buzzer: it buzzes, someone answers on the intercom, and five seconds on the gate is buzzed open. */
  private ring() {
    if (this.flags[PARTY_FLAG.gate] || this.rungAt >= 0) return;
    this.rungAt = this.clock;
    this.buzz(1.1, 0.9);
    const gone = this.absent();
    const host = !gone.has('nuhat') ? 'Nuhat' : !gone.has('udud') ? 'Udud' : 'Amirat';
    this.say(1.5, `${host} (on the intercom): Who is it?... Ah! You made it! Come in, come in, push when it buzzes!`, 3.4);
    this.refresh();
  }

  /** The gate's catch lets go: a buzz, a click, and it swings into the front garden. */
  private openGate() {
    this.flags[PARTY_FLAG.gate] = true;
    this.buzz(1.6, 0.8);
    const g = this.place ? houseWorld(this.place, GATE.x, GATE.z) : null;
    if (g) this.sc.audio.play('click', g.x, g.z, 0.8);
    this.removeGateCollider();
    this.say(1.8, 'Round the side, into the garden.', 3);
    this.refresh();
  }

  /** The intercom's buzz: a harsh mains-hum tone, synthesised (there is no sample for it), louder the nearer the gate. */
  private buzz(secs: number, vol: number) {
    const a = this.sc.audio;
    const ctx = a.ctx;
    if (!ctx || a.muted || !a.sfx || !this.place) return;
    const g = houseWorld(this.place, GATE.x, GATE.z);
    let d = Infinity;
    for (const pl of this.sc.players) d = Math.min(d, Math.hypot(pl.pos.x - g.x, pl.pos.z - g.z));
    const v = vol * 0.16 * clamp(1 - d / 30, 0, 1);
    if (v <= 0.001) return;
    const t0 = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(v, t0 + 0.02);
    gain.gain.setValueAtTime(v, t0 + secs - 0.05);
    gain.gain.linearRampToValueAtTime(0, t0 + secs);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.7;
    filter.connect(gain);
    gain.connect(a.sfx);
    for (const [type, f] of [['square', 100], ['sawtooth', 200.7], ['square', 301]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.connect(filter);
      o.start(t0);
      o.stop(t0 + secs);
    }
  }

  /** While the gate is shut, a box across the gateway: nobody walks or drives in. */
  private addGateCollider() {
    if (this.gateCollider || !this.place || this.flags[PARTY_FLAG.gate]) return;
    const b = houseBoxes(this.place, [gateLeafBox()])[0];
    this.gateCollider = this.sc.P.addStaticBox((b.minX + b.maxX) / 2, this.place.y + b.h / 2, (b.minZ + b.maxZ) / 2, (b.maxX - b.minX) / 2, b.h / 2, (b.maxZ - b.minZ) / 2, 0, GROUPS.furn);
  }

  private removeGateCollider() {
    if (!this.gateCollider) return;
    this.sc.P.removeCollider(this.gateCollider);
    this.gateCollider = null;
  }

  // ------------------------------------------------------------------ Iati's blessing

  /** The first time anyone on foot comes up to Iati's chair once the gate is open, he blesses them. */
  private watchForBlessing() {
    if (this.blessedHere || !this.flags[PARTY_FLAG.gate] || !this.cast?.has('iati')) return;
    const iati = PARTY.find((s) => s.hero === 'iati')!;
    for (const pl of this.sc.players) {
      if (pl.state !== 'foot') continue;
      const l = houseLocal(this.place!, pl.pos.x, pl.pos.z);
      if (Math.hypot(l.x - iati.x, l.z - iati.z) < BLESS_REACH && this.bless(pl)) return;
    }
  }

  /** Iati turns, takes a long drag and blows it over `who`. */
  private bless(who: Player): boolean {
    if (!this.cast || !this.place) return false;
    if (!this.cast.bless(this.headOf(who, this.tmp))) return false;
    this.blessedHere = true;
    this.blessWho = who;
    this.sc.subtitle('Iati: Welcome, brother! Come here, come here. A blessing, for the road.', 4);
    return true;
  }

  /** The cloud reaches them: everyone in it breathes it in. */
  private blessed() {
    const who = this.blessWho;
    this.blessWho = null;
    if (!who || !this.place) return;
    const at = this.headOf(who, this.tmp);
    for (const pl of this.sc.players) {
      if (pl.state !== 'foot' && pl !== who) continue;
      const l = houseLocal(this.place, pl.pos.x, pl.pos.z);
      if (pl !== who && Math.hypot(l.x - at.x, l.z - at.z) > CLOUD) continue;
      pl.drugs.dose('weed');
      this.sc.audio.play('toke', pl.pos.x, pl.pos.z, 0.7);
      pl.note('Weed: Iati\'s blessing. Slow, quiet, hungry... and the party is getting strange.', 'good');
    }
    this.say(1.2, 'Iati: Breathe it in. Now you can see them properly.', 4);
    if (this.cast?.has('lag')) this.say(9, 'Lag: Mmf... is this spoon getting bigger? It\'s getting bigger.', 4.5);
    if (this.cast?.has('udud')) this.say(15, 'Udud: Has anyone seen my glasses? They were just here.', 4);
    if (this.cast?.has('ro')) this.say(20, 'Ro: Ha! HA! Look at Lag\'s cake! Look at it!', 4);
    if (this.active && this.flags[STORY_FLAG.house]) this.complete();
  }

  /** Someone's head in the house's frame. */
  private headOf(who: Player, out: THREE.Vector3) {
    const l = houseLocal(this.place!, who.pos.x, who.pos.z);
    return out.set(l.x, 1.6, l.z);
  }

  /** How high a player is on weed, 0..1. */
  private highOf(pl: Player) {
    return clamp(pl.drugs.intensity('weed') * 1.25, 0, 1);
  }

  // ------------------------------------------------------------------ the model, every frame

  frame(dt: number) {
    const p = this.place;
    if (!p) return;
    // A redraw without time passing (a paused frame, a tool's capture) moves nobody.
    if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
    const near = this.nearest();
    if (!this.house && near.d < SHOW) this.show();
    else if (this.house && near.d > HIDE) this.hide();
    if (!this.house) return;
    const gone = this.absent();
    const key = [...gone].sort().join(',');
    if (key !== this.castKey) {
      // Amirat at the grill is the garden model's: it is built with him or without.
      if (!!this.garden?.amirat !== !gone.has('amirat')) {
        this.hide();
        this.show();
      } else this.buildCast();
    }
    // The gate swings open once it is buzzed; while it is shut it bars the way.
    if (this.flags[PARTY_FLAG.gate] && this.gateT < 1) this.gateT = Math.min(1, this.gateT + dt / SWING);
    this.garden?.setGate(this.gateT);
    // How high the party looks: as high as whoever is there (they all see it the same way, sharing the screen).
    let hi = 0;
    for (const pl of this.sc.players) if (Math.hypot(pl.pos.x - p.x, pl.pos.z - p.z) < 60) hi = Math.max(hi, this.highOf(pl));
    this.high = damp(this.high, hi, 1.2, dt);
    if (this.cast) this.cast.high = this.high;
    if (this.garden) this.garden.high = this.high;
    // Past this far the people are a few pixels: leave them out (and still) and keep only the house.
    const close = near.d < PEOPLE;
    if (this.cast) this.cast.group.visible = close;
    if (this.garden?.amirat) this.garden.amirat.root.visible = close;
    if (this.garden?.tongs) this.garden.tongs.visible = close;
    if (dt === 0 || !close) return;
    this.garden?.update(dt);
    // Whoever is nearest, their head in the house's frame, for the people at the party to look at.
    let look: THREE.Vector3 | null = null;
    if (near.who && near.d < 30) {
      const w = near.who.vehicle?.position ?? near.who.pos;
      const l = houseLocal(p, w.x, w.z);
      look = this.look.set(l.x, 1.55, l.z);
    }
    if (this.cast && this.blessWho) this.cast.blessTarget(this.headOf(this.blessWho, this.tmp));
    this.cast?.update(dt, look);
    if (this.cast?.blessHit) this.blessed();
  }

  /** Build the house (its static parts merged) and the party. */
  private show() {
    const p = this.place!;
    const root = new THREE.Group();
    root.name = 'udud-nuhat-house';
    root.position.set(p.x, p.y, p.z);
    root.rotation.y = p.yaw;
    const garden = new AmiratGarden({ amirat: !this.absent().has('amirat') });
    root.add(garden.root);
    const keep: THREE.Object3D[] = [];
    if (garden.tongs) keep.push(garden.tongs);
    if (garden.amirat) keep.push(garden.amirat.root);
    mergeStatic(garden.root, keep);
    this.garden = garden;
    this.house = root;
    this.sc.root.add(root);
    garden.setGate(this.gateT);
    this.addGateCollider();
    this.buildCast();
  }

  private buildCast() {
    if (!this.house) return;
    this.cast?.dispose();
    const absent = this.absent();
    this.castKey = [...absent].sort().join(',');
    this.cast = new PartyCast(absent);
    this.house.add(this.cast.group);
  }

  private hide() {
    this.removeGateCollider();
    this.cast?.dispose();
    this.cast = null;
    this.castKey = '';
    this.garden?.dispose();
    this.garden = null;
    if (this.house) {
      disposeTree(this.house);
      this.house.removeFromParent();
    }
    this.house = null;
  }

  /** Is this world point in the fenced garden? (For the weather, the camera and anything else that wants to know.) */
  inGarden(x: number, z: number): boolean {
    if (!this.place) return false;
    const l = houseLocal(this.place, x, z);
    return inGarden(l.x, l.z);
  }

  dispose() {
    for (const s of PARTY) this.sc.interact.remove(`party:${s.hero}`);
    this.sc.interact.remove('party:buzzer');
    this.clearObjective();
    this.hide();
  }
}

/**
 * Merge every static kit-material mesh under `root` into one mesh per material (the garden is a few hundred small meshes),
 * leaving alone anything under `keep`, anything marked `userData.dynamic`, transparent things and anything that isn't a
 * plain kit mesh.
 */
export function mergeStatic(root: THREE.Object3D, keep: THREE.Object3D[]) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const kept = new Set<THREE.Object3D>();
  for (const k of keep) k.traverse((o) => kept.add(o));
  const groups = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || kept.has(m) || m.userData.dynamic || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    let hidden = false;
    for (let q: THREE.Object3D | null = m; q; q = q.parent) {
      if (q.userData.dynamic || !q.visible) hidden = true;
      if (q === root) break;
    }
    if (hidden) return;
    const mat = m.material as THREE.Material;
    if (Array.isArray(m.material) || mat.transparent || !m.geometry.getAttribute('position')) return;
    if (!(mat as THREE.MeshStandardMaterial).vertexColors) return;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color' && name !== 'surf') g.deleteAttribute(name);
    g.morphAttributes = {};
    let e = groups.get(mat);
    if (!e) groups.set(mat, (e = { geos: [], meshes: [] }));
    e.geos.push(g);
    e.meshes.push(m);
  });
  for (const [mat, e] of groups) {
    // Only geometries with the same attribute set merge together.
    const sets = new Map<string, number[]>();
    e.geos.forEach((g, i) => {
      const k = Object.keys(g.attributes).sort().join(',');
      if (!sets.has(k)) sets.set(k, []);
      sets.get(k)!.push(i);
    });
    for (const idx of sets.values()) {
      if (idx.length < 2) {
        e.geos[idx[0]].dispose();
        continue;
      }
      const merged = mergeGeometries(idx.map((i) => e.geos[i]), false);
      for (const i of idx) e.geos[i].dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const out = new THREE.Mesh(merged, mat);
      out.name = 'house-merged';
      out.castShadow = true;
      out.receiveShadow = true;
      root.add(out);
      for (const i of idx) {
        const m = e.meshes[i];
        m.removeFromParent();
        m.geometry.dispose();
      }
    }
  }
}
