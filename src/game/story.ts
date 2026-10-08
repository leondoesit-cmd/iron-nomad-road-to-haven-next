import * as THREE from 'three';
import { HEROES } from '../data';
import { Humanoid } from '../render/humanoid';
import { identityOf, lookOf } from '../render/outfit';
import { heroLoadout, type Campaign } from './campaign';
import { PLAYER_PAINT, newBuild, tyreIdAt } from '../sim/garage';
import { newPart } from '../sim/parts';
import { YARD_FIRE, YARD_ITEMS, YARD_NAR, YARD_TRIKE, YARD_WAKE, yardWorld, yardYaw, type YardItem, type YardPlace } from '../world/narYard';
import { isOwnRide } from './access';
import type { Carried } from '../sim/carry';
import type { CompassPin } from './scene';
import type { LegScene } from './legScene';
import type { Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * Story mode, mission one. It begins on a cracked salt flat east of Dustwell, in the ruin of a scrap yard: your uncle Nar
 * Divad lies out cold on his mattress under the torn roof ("Nar — is he alive?"), and the rickshaw trike he was building
 * stands in pieces round him. See to Nar, put the trike together with your own hands (engine, front wheel, the two small back
 * wheels, the cab), fill its tank, help Nar into the cab and drive out of the yard. That sets `story.m1`, and mission two
 * (`game/partyMission.ts`, another file) takes over the objective from there; Nar keeps riding in the cab.
 *
 * Progress lives in `campaign.flags` (`story.*`), so it is saved and survives the nights. The director owns Nar (a humanoid
 * that lies on his mattress, then rides in the cab) and, until mission one is done, the objective on the HUD
 * (`LegScene.objective`) and the story's compass pins.
 */

/** What the HUD shows for the story: a heading, a checklist, and a line of advice. */
export interface Objective {
  title: string;
  steps?: { text: string; done: boolean }[];
  hint?: string;
}

/** Where the story stands. */
type Beat = 'wake' | 'build' | 'fuel' | 'help' | 'leave' | 'done';

/** The story's saved progress. `m1` is the hand-off to mission two. */
export const STORY_FLAG = {
  checked: 'story.checked',
  built: 'story.built',
  aboard: 'story.aboard',
  m1: 'story.m1',
  /** Set by mission two at Udud and Nuhat's house: from then on Nar is the party's, not the cab's. */
  house: 'story.house',
} as const;
const FLAG = STORY_FLAG;

/** How close the trike has to be to Nar's mattress to help him in, and how far from the yard it counts as gone. */
const HELP_REACH = 14;
const LEAVE = 32;

/** Make a story run: one rickshaw trike in pieces in the garage, an empty tank, and the story flag. */
export function setupStoryCampaign(c: Campaign) {
  c.flags.story = true;
  const b = newBuild('trike', { paint: PLAYER_PAINT[0], seed: 594, fuel: 0, hp: 0.82 });
  b.fit.engine = newPart('eng_none', 1);
  b.tyres = b.tyres.map(() => newPart('tyre_none', 1));
  b.comp.tires = b.tyres.map(() => 0);
  c.garage = [b];
  c.players[0].vehicle = b.uid;
  c.players[1].vehicle = b.uid;
  // What fuel there is, is in the can in the yard.
  c.stocks.fuel = 0;
}

/** The trike's state, as the checklist reads it. */
function trikeParts(v: Vehicle | null) {
  const b = v?.build;
  const engine = !!b && !!b.fit.engine && b.fit.engine.id !== 'eng_none';
  const front = !!b && !!tyreIdAt(b, 0);
  const backs = b ? [1, 2].filter((i) => !!tyreIdAt(b, i)).length : 0;
  const cab = b?.fit.rear?.id === 'rr_rickshaw';
  return { engine, front, backs, cab, done: engine && front && backs === 2 && cab };
}

export class StoryDirector {
  /** Nar Divad: on his mattress, then in the cab. */
  nar: Humanoid | null = null;
  beat: Beat = 'wake';
  private t = 0;
  private lines: { at: number; text: string; secs: number }[] = [];
  private clock = 0;
  private yard: YardPlace | null;
  private narPos = new THREE.Vector3();
  private narYaw = 0;
  private codexShown = false;
  /** Nar already said the trike was done: no second line for it. */
  private quietBuilt = false;

  constructor(
    private sc: LegScene,
    opening: boolean,
  ) {
    this.yard = sc.terrain?.yard ?? null;
    const f = this.flags;
    if (f[FLAG.m1]) this.beat = 'done';
    else if (f[FLAG.aboard]) this.beat = 'leave';
    else if (f[FLAG.built]) this.beat = 'help';
    else if (f[FLAG.checked]) this.beat = 'build';
    if (this.yard && !f[FLAG.house]) this.makeNar();
    if (opening) this.open();
    this.registerInteractions();
    this.refreshObjective();
  }

  private get flags() {
    return this.sc.campaign.flags;
  }

  /** The story's trike, if it is in the world. */
  trike(): Vehicle | null {
    return this.sc.vehicles.find((v) => v.build?.chassis === 'trike' && isOwnRide(v)) ?? null;
  }

  // ------------------------------------------------------------------ the first morning

  /** Lay out the yard's loose parts and kit, and start the first lines. */
  private open() {
    const y = this.yard;
    if (!y) return;
    for (const it of YARD_ITEMS) {
      const p = yardWorld(y, it.x, it.z);
      this.sc.placeLoose(carriedOf(it), p.x, p.z, it.y !== undefined ? y.y + it.y : undefined, yardYaw(y, it.yaw));
    }
    const me = HEROES[this.sc.campaign.players[0].hero].name.split(' ')[0];
    // The first thing anyone says: is he alive?
    this.say(0.8, 'Nar — is he alive?', 4.5);
    this.say(5.6, `${me}: Nar... Nar! Can you hear me?`, 4);
  }

  /** Queue a subtitle `at` seconds from now. */
  private say(at: number, text: string, secs = 4.5) {
    this.lines.push({ at: this.clock + at, text, secs });
    this.lines.sort((a, b) => a.at - b.at);
  }

  // ------------------------------------------------------------------ Nar

  private makeNar() {
    // His own shirt and trousers, not the convoy's starter jacket.
    const l = heroLoadout('nar');
    delete l.worn.body;
    delete l.worn.face;
    const pal = { ...identityOf(0), look: lookOf(l.worn), hero: 'nar' as const };
    const h = new Humanoid(pal);
    // Laid out flat on his back on the pallet, arms at his sides.
    h.lieFlat = true;
    h.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    this.nar = h;
    this.sc.root.add(h.root);
    this.placeNarOnMattress();
  }

  /** Lying on his back on the mattress: the root is at his soles and the body runs back from there toward his head. */
  private placeNarOnMattress() {
    const y = this.yard;
    if (!y || !this.nar) return;
    const head = yardYaw(y, YARD_NAR.yaw);
    const hips = yardWorld(y, YARD_NAR.x, YARD_NAR.z);
    const sx = hips.x - Math.sin(head) * 0.92;
    const sz = hips.z - Math.cos(head) * 0.92;
    this.narPos.set(sx, y.y + YARD_NAR.y, sz);
    this.narYaw = head + Math.PI;
  }

  /** Where Nar's hips are now, in the world (for the hold-to-help prompt). */
  private narAt(): { x: number; z: number } {
    const y = this.yard;
    if (!y) return { x: 0, z: 0 };
    return yardWorld(y, YARD_NAR.x, YARD_NAR.z);
  }

  private registerInteractions() {
    const sc = this.sc;
    const at = this.narAt();
    sc.interact.add({
      id: 'story:nar',
      x: at.x,
      z: at.z,
      r: 2.2,
      prompt: 'Check on Nar',
      dur: 1.6,
      priority: 3,
      direct: true,
      enabled: (p) => p.state === 'foot' && !p.carry && !this.flags[FLAG.aboard] && (this.beat === 'wake' || this.beat === 'help'),
      run: (p) => (this.beat === 'wake' ? this.checkNar(p) : this.helpNar(p)),
    });
  }

  /** Kneel by him: he's alive, just out cold. He tells you what to do. */
  private checkNar(p: Player) {
    if (this.flags[FLAG.checked]) return;
    this.flags[FLAG.checked] = true;
    this.lines = [];
    this.say(0.2, 'He\'s breathing. Out cold, but breathing.', 4);
    if (trikeParts(this.trike()).done) {
      // The trike was put together before anyone looked in on him.
      this.quietBuilt = true;
      this.say(4.4, 'Nar: Mm... you finished the trike? Good. Fill her up, and get me in that cab.', 6);
    } else {
      this.say(4.4, 'Nar: Mm... is the trike done? ...Finish the trike. It\'s all here: the engine, the wheels, the cab.', 6);
      this.say(10.6, 'Nar: Wake me when it runs.', 3.5);
    }
    this.sc.audio.play('pickup', p.pos.x, p.pos.z, 0.2);
    this.beat = 'build';
    this.refreshObjective();
  }

  /** Get him up and half-carry him to the cab. */
  private helpNar(p: Player) {
    const v = this.trike();
    if (!v || !this.nar) return;
    if (Math.hypot(v.position.x - p.pos.x, v.position.z - p.pos.z) > HELP_REACH) {
      p.note('Bring the trike closer first', 'warn');
      return;
    }
    this.flags[FLAG.aboard] = true;
    this.lines = [];
    this.say(0.2, 'Up you get, Nar. Easy.', 3.5);
    this.say(3.9, 'Nar: Mind the bumps.', 3);
    this.beat = 'leave';
    this.refreshObjective();
  }

  // ------------------------------------------------------------------ every tick

  tick(dt: number) {
    this.clock += dt;
    this.t += dt;
    this.burnFire();
    while (this.lines.length && this.lines[0].at <= this.clock) {
      const l = this.lines.shift()!;
      this.sc.subtitle(l.text, l.secs);
    }
    const v = this.trike();
    const parts = trikeParts(v);
    if (this.beat === 'build' && parts.done) {
      this.flags[FLAG.built] = true;
      this.beat = v && v.fuel < 0.5 ? 'fuel' : 'help';
      if (!this.quietBuilt) this.say(0.6, 'That\'s it. She\'s whole.', 3.5);
      if (!this.codexShown) {
        this.codexShown = true;
        this.sc.toast('NEW CONTENT UNLOCKED IN HOW TO PLAY: HANDS ON');
      }
    }
    // A reload after the build lands on 'help' (no flag records the tank): an empty tank still comes first.
    if (this.beat === 'help' && v && v.fuel < 0.5) this.beat = 'fuel';
    if (this.beat === 'fuel' && v && v.fuel >= 0.5) {
      this.beat = 'help';
      this.say(0.4, 'Fuel\'s in. Now Nar.', 3);
    }
    if (this.beat === 'leave' && v && this.yard && Math.hypot(v.position.x - this.yard.x, v.position.z - this.yard.z) > LEAVE) this.leaveYard();
    this.refreshObjective(parts);
    this.offerLook();
    // The hold at the mattress says what it will do now.
    const at = this.sc.interact.list.find((i) => i.id === 'story:nar');
    if (at) at.prompt = this.beat === 'help' ? 'Help Nar into the cab' : 'Check on Nar';
  }

  /**
   * Nar on his pallet can be looked at: "Nar - is he alive?" until someone has seen to him, then "out cold". Once he is in the
   * cab he is just a passenger.
   */
  private offerLook() {
    const sc = this.sc;
    sc.lookables = sc.lookables.filter((l) => !l.lines[0]?.text.startsWith('Nar'));
    const y = this.yard;
    if (!y || !this.nar || this.flags[FLAG.aboard] || this.flags[FLAG.house]) return;
    const head = yardYaw(y, YARD_NAR.yaw);
    const hips = yardWorld(y, YARD_NAR.x, YARD_NAR.z);
    const hy = y.y + YARD_NAR.y + 0.14;
    const a: [number, number, number] = [hips.x - Math.sin(head) * 0.85, hy, hips.z - Math.cos(head) * 0.85];
    const b: [number, number, number] = [hips.x + Math.sin(head) * 0.75, hy + 0.04, hips.z + Math.cos(head) * 0.75];
    const checked = !!this.flags[FLAG.checked];
    const lines = checked ? [{ text: 'Nar - out cold' }, { text: 'Breathing', css: '#d8f4cc' }] : [{ text: 'Nar - is he alive?' }];
    sc.lookables.push({ a, b, r: 0.3, lines, act: this.beat === 'help' ? 'Help' : !checked ? 'Check' : undefined });
  }

  /** The fire in the rusty basin out in front of Nar's lean-to burns whenever anyone is near enough to see it. */
  private burnFire() {
    const y = this.yard;
    if (!y) return;
    const f = yardWorld(y, YARD_FIRE.x, YARD_FIRE.z);
    if (!this.sc.players.some((p) => Math.hypot(p.pos.x - f.x, p.pos.z - f.z) < 90)) return;
    const fx = this.sc.fx;
    const gy = y.y + 0.2;
    // Low flames licking up off the coals, a hand or two high, and the glow they throw on the yard.
    if (this.sc.fires) {
      this.sc.fires.hold(YARD_FIRE, { x: f.x, y: y.y + 0.14, z: f.z, r: 0.26, fuel: 'wood', heat: 0.6, bed: false, smoke: 0.5 });
      if (Math.random() < 0.1) fx.wisp(f.x, gy + 0.55, f.z, 1.4);
      return;
    }
    for (let i = 0; i < 2; i++) {
      const deep = Math.random() < 0.45;
      fx.glow.emit(f.x + (Math.random() - 0.5) * 0.4, gy, f.z + (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.15, 0.45 + Math.random() * 0.55, (Math.random() - 0.5) * 0.15, 0.35 + Math.random() * 0.3, 0.5, 0.08, 1.0, deep ? 0.32 : 0.6, deep ? 0.06 : 0.16, deep ? 0.75 : 0.9, -0.3, 1.2);
    }
    if (Math.random() < 0.1) fx.wisp(f.x, gy + 0.55, f.z, 1.4);
  }

  /** Out of the yard with Nar in the cab: mission one is done, and mission two has the road from here. */
  private leaveYard() {
    this.flags[FLAG.m1] = true;
    this.beat = 'done';
    this.sc.banner('MISSION ONE COMPLETE', 'Nar\'s Flat');
  }

  /** Every drawn frame: Nar lies on his mattress, or sits in the cab of the trike. */
  frame(dt: number) {
    const h = this.nar;
    if (!h) return;
    // At the house mission two draws him in the garden: he is out of the cab for good.
    if (this.flags[FLAG.house]) {
      h.root.removeFromParent();
      h.dispose();
      this.nar = null;
      return;
    }
    const v = this.trike();
    if (this.flags[FLAG.aboard] && v) {
      // In the cab, on the bench, slumped against the side. Re-seated whenever the trike's model is rebuilt.
      const inner = v.visual.inner;
      if (h.root.parent !== inner) inner.add(h.root);
      h.lieFlat = false;
      h.update(dt, 'seat', 0, 0, 0);
      const s = v.visual.gunSeat;
      h.root.position.set(s[0] + 0.3, s[1], s[2]);
      h.root.rotation.set(0, 0, 0);
      // The cab sits him on its bench, feet on the floor, keeping him to one side of it.
      v.visual.seat?.('passenger', h, 0);
      h.root.visible = !v.wreck;
      return;
    }
    if (h.root.parent !== this.sc.root) this.sc.root.add(h.root);
    h.update(dt, 'lie', 0, 0, 0);
    h.root.position.copy(this.narPos);
    h.root.rotation.y = this.narYaw;
    h.root.visible = true;
  }

  // ------------------------------------------------------------------ what the HUD shows

  private refreshObjective(parts = trikeParts(this.trike())) {
    const sc = this.sc;
    switch (this.beat) {
      case 'wake':
        sc.objective = { title: 'Check on Nar', hint: 'He is lying on the mattress under the roof' };
        break;
      case 'build':
        sc.objective = {
          title: 'Build the trike',
          steps: [
            { text: 'Engine', done: parts.engine },
            { text: 'Front wheel', done: parts.front },
            { text: `Back wheels ${parts.backs}/2`, done: parts.backs === 2 },
            { text: 'Cab', done: parts.cab },
          ],
          hint: 'Look at a part to see what it is · grab it, hold it to its place on the frame, attach',
        };
        break;
      case 'fuel':
        sc.objective = { title: 'Fill the tank', hint: 'There is a can of petrol by the skip: carry it to the trike and pour it in' };
        break;
      case 'help':
        sc.objective = { title: 'Help Nar into the cab', hint: 'Stow the dog food in the cab for the road' };
        break;
      case 'leave':
        sc.objective = { title: 'Drive out of the yard', hint: 'Nar is in the cab: take it easy over the flat' };
        break;
      case 'done':
        // Mission two (or the open road) owns the objective now: leave whatever it set.
        break;
    }
  }

  /** Markers for the compass and the map. */
  pins(): CompassPin[] {
    const o = this.sc.terrain?.open;
    if (this.beat === 'wake' || this.beat === 'help') {
      const a = this.narAt();
      return [{ x: a.x, z: a.z, kind: 'exit', label: 'NAR' }];
    }
    if (this.beat === 'build' || this.beat === 'fuel') {
      const v = this.trike();
      return v ? [{ x: v.position.x, z: v.position.z, kind: 'ride', label: 'TRIKE' }] : [];
    }
    void o;
    return [];
  }

  dispose() {
    this.sc.interact.remove('story:nar');
    this.sc.lookables = this.sc.lookables.filter((l) => !l.lines[0]?.text.startsWith('Nar'));
    if (this.nar) {
      this.nar.root.removeFromParent();
      this.nar.dispose();
      this.nar = null;
    }
  }
}

/** The loose thing a yard item is. */
function carriedOf(it: YardItem): Carried {
  const w = it.what;
  if ('part' in w) return { kind: 'part', item: newPart(w.part, w.cond) };
  if ('fuel' in w) return { kind: 'fuel', amount: w.fuel, fuel: 'petrol' };
  if ('oil' in w) return { kind: 'oil', amount: w.oil };
  return { kind: 'food', food: w.food };
}

/** Where the story puts everyone on the first morning: by the mattress, looking at Nar. */
export function storyWake(y: YardPlace, i: number): { x: number; z: number; yaw: number } {
  const p = yardWorld(y, YARD_WAKE.x + i * 1.1, YARD_WAKE.z + i * 0.7);
  return { x: p.x, z: p.z, yaw: yardYaw(y, YARD_WAKE.yaw) };
}

/** Where the trike's frame stands on its stand. */
export function storyTrike(y: YardPlace): { x: number; z: number; yaw: number } {
  const p = yardWorld(y, YARD_TRIKE.x, YARD_TRIKE.z);
  return { x: p.x, z: p.z, yaw: yardYaw(y, YARD_TRIKE.yaw) };
}
