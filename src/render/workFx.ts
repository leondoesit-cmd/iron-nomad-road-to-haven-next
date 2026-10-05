import * as THREE from 'three';
import { partDef } from '../data';
import type { PartItem } from '../sim/parts';
import { partModelKey } from '../sim/carry';
import { shared } from './dispose';
import type { Particles } from './particles';
import { glowTexture, makeCarryModel } from './props';
import { MARK_PX, Mark, compactLines, focusLines, makeTextSprite, type TagLine, type TextSprite } from './markers';

/**
 * The look of working on a vehicle: a part lifted out of the hands to hover over its mount while the bolts go in,
 * snapping home with a burst, the old one flung out to the trunk, loot flying to whoever pried it off, a callout rising
 * from the spot, a stream of oil or fuel into the filler. Everything here is cosmetic and runs on render time; the
 * rules (what fits, what it costs) have already happened by the time any of it plays.
 */

/** Where on a vehicle a job happens. */
export type Site = 'hood' | 'wheel' | 'flank' | 'roof' | 'rear' | 'front' | 'gun' | 'under' | 'cabin';

/** Where each part slot is drawn. */
export const SLOT_SITE: Record<string, Site> = {
  engine: 'hood',
  cooling: 'front',
  hood: 'hood',
  doorL: 'flank',
  doorR: 'flank',
  gearbox: 'under',
  exhaust: 'rear',
  suspension: 'wheel',
  brakes: 'wheel',
  wheels: 'wheel',
  armor: 'flank',
  weapon: 'gun',
  utility: 'roof',
  front: 'front',
  roof: 'roof',
  rear: 'rear',
  side: 'flank',
  seatD: 'cabin',
  seatP: 'cabin',
  seatR: 'cabin',
  steer: 'cabin',
  dash: 'cabin',
};

/** Sparks and glow by part quality: common, uncommon, rare. */
const MK_RGB: [number, number, number][] = [
  [1, 0.85, 0.5],
  [0.9, 0.85, 0.65],
  [0.55, 0.95, 0.55],
  [1, 0.72, 0.3],
];
export const MK_CSS = ['#ffd27a', '#e6dcc0', '#7ddc7a', '#ffb454'];

export const modelKey = (it: PartItem) => `part:${it.id}`;
const mkOf = (it: PartItem) => Math.min(3, Math.max(1, partDef(it.id).mk));

interface Tween {
  obj: THREE.Object3D;
  t: number;
  delay: number;
  dur: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  arc: number;
  spin: number;
  s0: number;
  s1: number;
  done?: () => void;
}

interface Hover {
  obj: THREE.Group;
  glow: THREE.Sprite;
  pos: THREE.Vector3;
  hand: THREE.Vector3;
  anchor: THREE.Vector3;
  p: number;
  seen: number;
  back: boolean;
  age: number;
}

interface Label {
  sprite: THREE.Sprite;
  t: number;
  life: number;
  y0: number;
  rise: number;
}

/** The mount markers shown to a player holding a tool or a part over their own vehicle. */
interface Focus {
  group: THREE.Group;
  dots: Mark[];
  ring: Mark;
  label: TextSprite | null;
  text: string;
  ok: boolean;
  seen: number;
  on: number;
}

export interface FocusTarget {
  pos: THREE.Vector3;
  text: string;
  css: string;
  /** False: the thing in hand cannot do anything here (shown red). */
  ok: boolean;
}

/** A floating text block that stays while something keeps asking for it (an inspect tag, a socket prompt). */
interface Tag {
  label: TextSprite;
  text: string;
  seen: number;
  /** 0..1 fade in and out. */
  a: number;
}

/** How a socket outline is drawn: waiting, aimed at and in reach, or aimed at but out of reach. */
export type GhostState = 'idle' | 'aimed' | 'blocked';

export interface GhostAnchor {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  /** Full size along the box's own x, y and z. */
  size: [number, number, number];
  /** A wheel is drawn as a drum on its x axis, anything else as a box. */
  shape?: 'box' | 'drum';
}

/** A see-through copy of a carried part, snapped onto the mount it would go on. */
interface Preview {
  key: string;
  objs: THREE.Group[];
  targets: THREE.Vector3[];
  from: THREE.Vector3;
  state: GhostState;
  age: number;
  seen: number;
  a: number;
}

interface Ghost {
  group: THREE.Group;
  /** Outline of each socket box: one line set seen through everything, faintly, and one at full strength where it is in view. */
  boxes: THREE.LineSegments[];
  /** [in view, behind things] */
  edgeMat: [THREE.LineBasicMaterial, THREE.LineBasicMaterial];
  state: GhostState;
  shapes: string;
  seen: number;
  a: number;
}

const GHOST_RGB: Record<GhostState, number> = { idle: 0xf2f1e8, aimed: 0x8cf08c, blocked: 0xff8a6a };
const edgeGeo = shared(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)));
const drumFill = new THREE.CylinderGeometry(0.5, 0.5, 1, 28).rotateZ(Math.PI / 2);
const drumEdge = shared(new THREE.EdgesGeometry(drumFill, 40));
/** An outline is thin and crisp: strong where it is in view, a hint of it where it is behind the bodywork. No fill. */
const GHOST_EDGE = 0.95;
const GHOST_BEHIND = 0.22;
const ease = (k: number) => 1 - (1 - k) * (1 - k);
/** Colours of the mount dots and the ring: amber to do, red when this cannot be done here. */
const FOCUS_RGB = { dot: 0xfff2c8, ok: 0xffcc52, bad: 0xff5a42 };
const GLOW_MATS = new Map<number, THREE.SpriteMaterial>();
const PREVIEW_MATS = new Map<GhostState, THREE.MeshBasicMaterial>();

/** The see-through look of a part previewed on its mount: one shared material per state, faded by the preview itself. */
function previewMat(state: GhostState) {
  let m = PREVIEW_MATS.get(state);
  if (!m) {
    m = shared(new THREE.MeshBasicMaterial({ color: GHOST_RGB[state === 'idle' ? 'aimed' : state], transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false }));
    PREVIEW_MATS.set(state, m);
  }
  return m;
}

function glowMat(mk: number) {
  let m = GLOW_MATS.get(mk);
  if (!m) {
    const [r, g, b] = MK_RGB[mk];
    m = shared(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(r, g, b), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    GLOW_MATS.set(mk, m);
  }
  return m;
}

export class WorkFx {
  readonly root = new THREE.Group();
  private tweens: Tween[] = [];
  private hovers = new Map<number, Hover>();
  private labels: Label[] = [];
  private focuses = new Map<number, Focus>();
  private tags = new Map<string, Tag>();
  private ghosts = new Map<string, Ghost>();
  private previews = new Map<number, Preview>();
  private clock = 0;

  constructor(private fx: Particles) {}

  // ------------------------------------------------------------------ bursts

  /** The impact of something locking home: flash, a ring of sparks, a puff of dust. `mk` tints it by part quality. */
  burst(p: THREE.Vector3, mk = 1, size = 1) {
    const fx = this.fx;
    const [r, g, b] = MK_RGB[mk];
    fx.flash(p.x, p.y, p.z, 1.8 * size);
    fx.spark(p.x, p.y, p.z, Math.round(14 * size), 5);
    const n = Math.round(12 * size);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      fx.glow.emit(p.x, p.y, p.z, Math.cos(a) * 3.4 * size, 0.5, Math.sin(a) * 3.4 * size, 0.5, 0.26, 0.04, r, g, b, 1, 1, 2.2);
    }
    for (let i = 0; i < 3; i++) fx.puff(p.x, p.y - 0.1, p.z, 0.72, 0.66, 0.56, 1.1 * size, 0.7);
  }

  /** A stream pouring from a can into a filler. */
  pour(from: THREE.Vector3, to: THREE.Vector3, rgb: [number, number, number]) {
    const T = 0.32;
    const g = 9;
    this.fx.smoke.emit(from.x, from.y, from.z, (to.x - from.x) / T, (to.y - from.y) / T + 0.5 * g * T, (to.z - from.z) / T, T, 0.07, 0.05, rgb[0], rgb[1], rgb[2], 0.95, g, 0.2);
  }

  // ------------------------------------------------------------------ flights

  private fly(obj: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, o: { dur: number; delay?: number; arc?: number; spin?: number; s0?: number; s1?: number; done?: () => void }) {
    obj.position.copy(from);
    obj.visible = o.delay ? false : true;
    this.root.add(obj);
    this.tweens.push({ obj, t: 0, delay: o.delay ?? 0, dur: o.dur, from: from.clone(), to: to.clone(), arc: o.arc ?? 0, spin: o.spin ?? 0, s0: o.s0 ?? 1, s1: o.s1 ?? 1, done: o.done });
  }

  private model(key: string) {
    const m = makeCarryModel(key);
    m.rotation.y = Math.random() * 6;
    return m;
  }

  /** Hand to trunk: something put away at the vehicle. */
  stow(key: string, from: THREE.Vector3, to: THREE.Vector3, done?: () => void) {
    this.fly(this.model(key), from, to, { dur: 0.42, arc: 0.7, spin: 7, s1: 0.2, done });
  }

  /** Loot pried off a vehicle jumping to whoever took it. */
  spill(items: string[], from: THREE.Vector3, to: THREE.Vector3) {
    items.forEach((key, i) => {
      const at = from.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4));
      this.fly(this.model(key), at, to, { dur: 0.5, delay: 0.12 * i, arc: 1.1, spin: 9, s0: 1.1, s1: 0.25, done: () => this.fx.spark(to.x, to.y, to.z, 3, 2) });
    });
  }

  /**
   * A part going on or coming off. `fresh` snaps onto `anchor` (from the hover if this player held one over it, otherwise
   * from `from`, otherwise dropping in from above); `old` is flung out toward `out`. `hit` runs when the new part lands.
   */
  swap(o: { key?: number; anchor: THREE.Vector3; from?: THREE.Vector3; out: THREE.Vector3; fresh?: PartItem; old?: PartItem; hit?: () => void }) {
    const taken = o.key !== undefined ? this.takeHover(o.key) : null;
    let landed = 0;
    if (o.fresh) {
      const mk = mkOf(o.fresh);
      const obj = taken?.obj ?? this.model(modelKey(o.fresh));
      if (taken) obj.remove(taken.glow);
      const start = taken ? taken.pos : (o.from ?? o.anchor.clone().add(new THREE.Vector3(0, 1.4, 0)));
      // From the arms (or a hover) the part is already at the spot: it only snaps the last stretch home.
      const direct = taken || o.from;
      landed = direct ? 0.13 : 0.3;
      this.fly(obj, start, o.anchor, {
        dur: landed,
        arc: direct ? 0 : 0.5,
        spin: direct ? 0 : 5,
        s0: taken ? 1.1 : 1,
        s1: 0.45,
        done: () => {
          this.burst(o.anchor, mk);
          o.hit?.();
        },
      });
    } else {
      this.burst(o.anchor, 1, 0.6);
      o.hit?.();
    }
    if (o.old) {
      this.fly(this.model(modelKey(o.old)), o.anchor, o.out, { dur: 0.6, delay: landed, arc: 1.2, spin: 8, s0: 0.5, s1: 0.2, done: () => this.fx.puff(o.out.x, o.out.y, o.out.z, 0.6, 0.55, 0.5, 0.8, 0.5) });
    }
  }

  // ------------------------------------------------------------------ hover

  /**
   * Called every tick while a part is being fitted: it lifts out of the hands, floats over the mount and spins up as the
   * hold fills. If the calls stop (the hold was let go or interrupted) it flies back to the hands.
   */
  hold(key: number, part: PartItem, hand: THREE.Vector3, anchor: THREE.Vector3, progress: number) {
    let h = this.hovers.get(key);
    if (!h) {
      const obj = new THREE.Group();
      obj.add(this.model(modelKey(part)));
      const glow = new THREE.Sprite(glowMat(mkOf(part)));
      glow.position.y = 0.2;
      obj.add(glow);
      obj.position.copy(hand);
      this.root.add(obj);
      h = { obj, glow, pos: hand.clone(), hand: hand.clone(), anchor: anchor.clone(), p: 0, seen: 0, back: false, age: 0 };
      this.hovers.set(key, h);
    }
    h.hand.copy(hand);
    h.anchor.copy(anchor);
    h.p = progress;
    h.seen = 0;
    h.back = false;
  }

  /** True while this player's part is out of their hands (so the arms' copy is hidden). */
  holding(key: number) {
    return this.hovers.has(key);
  }

  private takeHover(key: number) {
    const h = this.hovers.get(key);
    if (!h) return null;
    this.hovers.delete(key);
    return h;
  }

  /**
   * Eject: a part comes off its mount and flies into the hands of whoever unbolted it. The arms' copy stays hidden until
   * it lands (`holding`).
   */
  eject(key: number, part: PartItem, from: THREE.Vector3, hand: THREE.Vector3) {
    this.takeHover(key)?.obj.removeFromParent();
    const obj = new THREE.Group();
    obj.add(this.model(modelKey(part)));
    const glow = new THREE.Sprite(glowMat(mkOf(part)));
    glow.position.y = 0.2;
    glow.scale.setScalar(1.6);
    obj.add(glow);
    obj.position.copy(from);
    this.root.add(obj);
    this.hovers.set(key, { obj, glow, pos: from.clone(), hand: hand.clone(), anchor: from.clone(), p: 0, seen: 0.2, back: true, age: 0 });
  }

  // ------------------------------------------------------------------ mount markers

  /**
   * Called every tick while a player has a tool or a part over their own vehicle. Draws a dot on every mount point and a
   * pulsing ring with a callout on the one in reach. If the calls stop the markers shrink away.
   */
  focus(key: number, mounts: THREE.Vector3[], target: FocusTarget | null) {
    let f = this.focuses.get(key);
    if (!f) {
      const group = new THREE.Group();
      const ring = new Mark('ring', MARK_PX.ring, FOCUS_RGB.ok, 48);
      group.add(ring.group);
      this.root.add(group);
      f = { group, dots: [], ring, label: null, text: '', ok: true, seen: 0, on: 0 };
      this.focuses.set(key, f);
    }
    f.seen = 0;
    while (f.dots.length < mounts.length) {
      const d = new Mark('dot', MARK_PX.dot, FOCUS_RGB.dot, 46);
      f.group.add(d.group);
      f.dots.push(d);
    }
    f.dots.forEach((d, i) => {
      d.visible = i < mounts.length && !(target && mounts[i].distanceToSquared(target.pos) < 0.01);
      if (d.visible) d.setPos(mounts[i]);
    });
    f.ring.visible = !!target;
    if (!target) {
      if (f.label) f.label.sprite.visible = false;
      return;
    }
    f.ring.setPos(target.pos);
    if (f.ok !== target.ok) {
      f.ok = target.ok;
      f.ring.setColor(target.ok ? FOCUS_RGB.ok : FOCUS_RGB.bad);
    }
    const lines = focusLines(target.text, target.css);
    const text = lines.map((l) => `${l.css ?? ''}|${l.text}`).join('\n');
    if (text !== f.text) {
      f.text = text;
      f.label?.dispose();
      f.label = makeTextSprite(lines, 51);
      if (f.label) f.group.add(f.label.sprite);
    }
    if (f.label) {
      f.label.sprite.visible = true;
      f.label.sprite.position.set(target.pos.x, target.pos.y + 0.12, target.pos.z);
    }
  }

  private dropFocus(key: number) {
    const f = this.focuses.get(key);
    if (!f) return;
    f.label?.dispose();
    f.ring.dispose();
    for (const d of f.dots) d.dispose();
    f.group.removeFromParent();
    this.focuses.delete(key);
  }

  // ------------------------------------------------------------------ labels

  /** A callout that rises from a point and fades: one short line. Needs a canvas, so it does nothing outside a browser. */
  label(text: string, css: string, at: THREE.Vector3) {
    const t = makeTextSprite(compactLines([{ text, css }], 34), 50);
    if (!t) return;
    t.sprite.position.copy(at);
    this.root.add(t.sprite);
    this.labels.push({ sprite: t.sprite, t: 0, life: 2, y0: at.y, rise: 0.9 });
  }

  // ------------------------------------------------------------------ preview

  /**
   * Kept alive by calling this every tick while a player carries a part within reach of the place it goes: a see-through
   * copy of the part slides out of the hands and settles on each of `at` (one for most parts, every wheel for a set of
   * tyres), green when it can go on and red when it cannot. Stops showing when the calls stop.
   */
  preview(key: number, part: PartItem, hand: THREE.Vector3, at: THREE.Vector3[], state: GhostState) {
    const id = `${modelKey(part)}|${at.length}`;
    let pv = this.previews.get(key);
    if (pv && pv.key !== id) {
      this.dropPreview(key);
      pv = undefined;
    }
    if (!pv) {
      const objs = at.map(() => {
        const g = this.model(modelKey(part));
        g.rotation.y = 0;
        g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.material = previewMat(state);
            m.castShadow = false;
          }
        });
        g.visible = false;
        this.root.add(g);
        return g;
      });
      pv = { key: id, objs, targets: at.map((q) => q.clone()), from: hand.clone(), state, age: 0, seen: 0, a: 0 };
      this.previews.set(key, pv);
    }
    if (pv.state !== state) {
      pv.state = state;
      for (const g of pv.objs) g.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).material = previewMat(state)) : undefined));
    }
    at.forEach((q, i) => pv!.targets[i].copy(q));
    pv.from.copy(hand);
    pv.seen = 0;
  }

  /** True while a part preview is showing for this player. */
  previewing(key: number) {
    return this.previews.has(key);
  }

  private dropPreview(key: number) {
    const pv = this.previews.get(key);
    if (!pv) return;
    for (const g of pv.objs) g.removeFromParent();
    this.previews.delete(key);
  }

  // ------------------------------------------------------------------ tags and ghosts

  /** Socket outlines currently showing (for tests and the debug readout). */
  get ghostCount(): number {
    return this.ghosts.size;
  }

  /** The state of one player's outline, or null if none is showing. */
  ghostState(id: string): GhostState | null {
    return this.ghosts.get(id)?.state ?? null;
  }

  /**
   * A block of text hanging in the world at `at`, kept alive by calling this every tick: the part you are looking at,
   * the socket you are about to fill. Each line is white caps; `hot` lines are tinted. Stops showing when the calls stop.
   */
  tag(id: string, lines: TagLine[], at: THREE.Vector3) {
    if (typeof document === 'undefined') return;
    const two = compactLines(lines);
    const text = two.map((l) => `${l.css ?? ''}|${l.text}`).join('\n');
    let t = this.tags.get(id);
    if (!t || t.text !== text) {
      const a = t?.a ?? 0;
      if (t) this.dropTag(id);
      const label = makeTextSprite(two, 60);
      if (!label) return;
      this.root.add(label.sprite);
      t = { label, text, seen: 0, a };
      this.tags.set(id, t);
    }
    // Callers hang it 0.9 m over the part; with its own constant screen size it sits closer and stays out of the way.
    t.label.sprite.position.set(at.x, at.y - 0.45, at.z);
    t.seen = 0;
  }

  private dropTag(id: string) {
    const t = this.tags.get(id);
    if (!t) return;
    t.label.dispose();
    this.tags.delete(id);
  }

  /**
   * Outlines at the attach points of a socket, kept alive by calling this every tick. White while waiting, green and
   * filled when it is the one in reach, red when it is the right place but too far to reach.
   */
  ghost(id: string, anchors: GhostAnchor[], state: GhostState) {
    let g = this.ghosts.get(id);
    const shapes = anchors.map((a) => a.shape ?? 'box').join();
    if (!g || g.shapes !== shapes) {
      if (g) this.dropGhost(id);
      const group = new THREE.Group();
      const mk = (front: boolean) => new THREE.LineBasicMaterial({ color: GHOST_RGB[state], transparent: true, opacity: 0, depthTest: front, depthWrite: false, fog: false });
      const edgeMat: [THREE.LineBasicMaterial, THREE.LineBasicMaterial] = [mk(true), mk(false)];
      const boxes: THREE.LineSegments[] = [];
      for (const a of anchors) {
        const geo = a.shape === 'drum' ? drumEdge : edgeGeo;
        const behind = new THREE.LineSegments(geo, edgeMat[1]);
        const front = new THREE.LineSegments(geo, edgeMat[0]);
        behind.renderOrder = 54;
        front.renderOrder = 55;
        group.add(behind, front);
        boxes.push(behind, front);
      }
      this.root.add(group);
      g = { group, boxes, edgeMat, state, shapes, seen: 0, a: 0 };
      this.ghosts.set(id, g);
    }
    if (g.state !== state) {
      g.state = state;
      for (const m of g.edgeMat) m.color.setHex(GHOST_RGB[state]);
    }
    anchors.forEach((a, i) => {
      for (const o of [g!.boxes[i * 2], g!.boxes[i * 2 + 1]]) {
        o.position.copy(a.pos);
        o.quaternion.copy(a.quat);
        o.scale.set(a.size[0], a.size[1], a.size[2]);
      }
    });
    g.seen = 0;
  }

  private dropGhost(id: string) {
    const g = this.ghosts.get(id);
    if (!g) return;
    for (const m of g.edgeMat) m.dispose();
    g.group.removeFromParent();
    this.ghosts.delete(id);
  }

  // ------------------------------------------------------------------ frame

  update(dt: number) {
    this.clock += dt;
    for (const [id, t] of this.tags) {
      t.seen += dt;
      t.a = t.seen > 0.12 ? Math.max(0, t.a - dt * 6) : Math.min(1, t.a + dt * 8);
      (t.label.sprite.material as THREE.SpriteMaterial).opacity = t.a;
      if (t.a <= 0 && t.seen > 0.12) this.dropTag(id);
    }
    for (const [id, g] of this.ghosts) {
      g.seen += dt;
      g.a = g.seen > 0.12 ? Math.max(0, g.a - dt * 6) : Math.min(1, g.a + dt * 8);
      g.group.visible = g.a > 0.02;
      // Waiting outlines sit still and a little dim; the one in reach breathes, gently.
      const pulse = g.state === 'idle' ? 0.7 : 0.88 + 0.12 * Math.sin(this.clock * 4);
      g.edgeMat[0].opacity = GHOST_EDGE * g.a * pulse;
      g.edgeMat[1].opacity = GHOST_BEHIND * g.a * pulse;
      if (g.a <= 0 && g.seen > 0.12) this.dropGhost(id);
    }
    for (const [key, pv] of this.previews) {
      pv.seen += dt;
      pv.age += dt;
      const gone = pv.seen > 0.12 || this.hovers.has(key);
      pv.a = gone ? Math.max(0, pv.a - dt * 7) : Math.min(1, pv.a + dt * 8);
      if (pv.a <= 0 && gone) {
        this.dropPreview(key);
        continue;
      }
      // Out of the hands and onto the mount in a quick snap, then it breathes there.
      const k = ease(Math.min(1, pv.age / 0.22));
      const pulse = 1 + Math.sin(this.clock * 5) * 0.03;
      pv.objs.forEach((g, i) => {
        g.visible = true;
        g.position.lerpVectors(pv.from, pv.targets[i], k);
        g.position.y += Math.sin(k * Math.PI) * 0.25;
        g.scale.setScalar((0.55 + 0.45 * k) * pulse);
      });
      previewMat(pv.state).opacity = (pv.state === 'blocked' ? 0.3 : 0.42) * pv.a * (0.8 + 0.2 * Math.sin(this.clock * 6));
    }
    for (const [key, h] of this.hovers) {
      h.seen += dt;
      h.age += dt;
      if (h.seen > 0.15) h.back = true;
      if (h.back) {
        h.pos.lerp(h.hand, 1 - Math.exp(-14 * dt));
        h.obj.scale.setScalar(Math.max(0.3, h.obj.scale.x - dt * 2));
        if (h.pos.distanceTo(h.hand) < 0.2 || h.seen > 0.7) {
          h.obj.removeFromParent();
          this.hovers.delete(key);
        }
      } else {
        // Out of the arms and up over the mount, bobbing; it shakes as the last bolts go in.
        const tx = h.anchor.x;
        // It floats just over the mount and sinks onto it as the bolts go in.
        const ty = h.anchor.y + (0.1 + 0.4 * (1 - h.p)) + Math.sin(this.clock * 4) * 0.03 * (1 - h.p);
        const tz = h.anchor.z;
        const k = 1 - Math.exp(-9 * dt);
        h.pos.x += (tx - h.pos.x) * k;
        h.pos.y += (ty - h.pos.y) * k;
        h.pos.z += (tz - h.pos.z) * k;
        h.obj.rotation.y += dt * (1.5 + h.p * 7);
        h.obj.scale.setScalar(1 + h.p * 0.12);
        const m = h.glow.material as THREE.SpriteMaterial;
        h.glow.scale.setScalar(1.2 + h.p * 1.4);
        void m;
      }
      const shake = h.back ? 0 : Math.max(0, h.p - 0.75) * 0.05;
      h.obj.position.set(h.pos.x + (Math.random() - 0.5) * shake, h.pos.y + (Math.random() - 0.5) * shake, h.pos.z + (Math.random() - 0.5) * shake);
    }
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const w = this.tweens[i];
      if (w.delay > 0) {
        w.delay -= dt;
        if (w.delay > 0) continue;
        w.obj.visible = true;
      }
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      const e = ease(k);
      w.obj.position.lerpVectors(w.from, w.to, e);
      w.obj.position.y += Math.sin(k * Math.PI) * w.arc;
      w.obj.rotation.y += w.spin * dt;
      w.obj.scale.setScalar(w.s0 + (w.s1 - w.s0) * e);
      if (k >= 1) {
        w.obj.removeFromParent();
        this.tweens.splice(i, 1);
        w.done?.();
      }
    }
    for (const [key, f] of this.focuses) {
      f.seen += dt;
      if (f.seen > 0.25) {
        this.dropFocus(key);
        continue;
      }
      f.on = Math.min(1, f.on + dt * 8);
      // A subtle breath on the ring, and the dots out of step with one another.
      f.ring.k = 1 + Math.sin(this.clock * 5) * 0.06;
      f.ring.setAlpha(f.ring.visible ? f.on : 0);
      f.dots.forEach((d, i) => {
        d.k = 1 + Math.sin(this.clock * 3 + i * 1.7) * 0.08;
        if (d.visible) d.setAlpha(f.on * 0.95);
      });
      if (f.label) (f.label.sprite.material as THREE.SpriteMaterial).opacity = f.on;
    }
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const l = this.labels[i];
      l.t += dt;
      const k = l.t / l.life;
      l.sprite.position.y = l.y0 + ease(Math.min(1, k)) * l.rise;
      const m = l.sprite.material as THREE.SpriteMaterial;
      m.opacity = k < 0.15 ? k / 0.15 : k > 0.65 ? Math.max(0, 1 - (k - 0.65) / 0.35) : 1;
      if (k >= 1) {
        l.sprite.removeFromParent();
        m.map?.dispose();
        m.dispose();
        this.labels.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const id of [...this.tags.keys()]) this.dropTag(id);
    for (const id of [...this.ghosts.keys()]) this.dropGhost(id);
    for (const key of [...this.previews.keys()]) this.dropPreview(key);
    for (const l of this.labels) {
      const m = l.sprite.material as THREE.SpriteMaterial;
      m.map?.dispose();
      m.dispose();
    }
    this.labels.length = 0;
    for (const key of [...this.focuses.keys()]) this.dropFocus(key);
    this.tweens.length = 0;
    this.hovers.clear();
    this.root.removeFromParent();
  }
}
