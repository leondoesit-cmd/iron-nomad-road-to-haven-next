import * as THREE from 'three';
import { partDef } from '../data';
import type { PartItem } from '../sim/parts';
import { shared } from './dispose';
import type { Particles } from './particles';
import { glowTexture, makeCarryModel } from './props';

/**
 * The look of working on a vehicle: a part lifted out of the hands to hover over its mount while the bolts go in,
 * snapping home with a burst, the old one flung out to the trunk, loot flying to whoever pried it off, a callout rising
 * from the spot, a stream of oil or fuel into the filler. Everything here is cosmetic and runs on render time; the
 * rules (what fits, what it costs) have already happened by the time any of it plays.
 */

/** Where on a vehicle a job happens. */
export type Site = 'hood' | 'wheel' | 'flank' | 'roof' | 'rear' | 'front' | 'gun' | 'under';

/** Where each part slot is drawn. */
export const SLOT_SITE: Record<string, Site> = {
  engine: 'hood',
  wheels: 'wheel',
  armor: 'flank',
  weapon: 'gun',
  utility: 'roof',
  front: 'front',
  roof: 'roof',
  rear: 'rear',
  side: 'flank',
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
  dots: THREE.Sprite[];
  ring: THREE.Sprite;
  label: THREE.Sprite;
  canvas: HTMLCanvasElement | null;
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

const ease = (k: number) => 1 - (1 - k) * (1 - k);
const GLOW_MATS = new Map<number, THREE.SpriteMaterial>();

function glowMat(mk: number) {
  let m = GLOW_MATS.get(mk);
  if (!m) {
    const [r, g, b] = MK_RGB[mk];
    m = shared(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(r, g, b), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    GLOW_MATS.set(mk, m);
  }
  return m;
}

let RING_TEX: THREE.CanvasTexture | null = null;
/** A hollow ring with a soft glow, for marking the mount you are working at. */
function ringTexture(): THREE.Texture {
  if (RING_TEX) return RING_TEX;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 20, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0.12)');
  grad.addColorStop(0.78, 'rgba(255,255,255,1)');
  grad.addColorStop(0.88, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  RING_TEX = new THREE.CanvasTexture(c);
  return RING_TEX;
}

let DOT_MAT: THREE.SpriteMaterial | null = null;
const RING_MATS = new Map<boolean, THREE.SpriteMaterial>();
function dotMat() {
  return (DOT_MAT ??= shared(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(1, 0.95, 0.8), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false })));
}
function ringMat(ok: boolean) {
  let m = RING_MATS.get(ok);
  if (!m) {
    m = shared(new THREE.SpriteMaterial({ map: ringTexture(), color: ok ? new THREE.Color(1, 0.8, 0.32) : new THREE.Color(1, 0.3, 0.25), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    RING_MATS.set(ok, m);
  }
  return m;
}

/** Draw a callout onto a canvas: bold outlined text, centred. */
function paintLabel(c: HTMLCanvasElement, text: string, css: string) {
  const g = c.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, c.width, c.height);
  g.font = '700 40px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(10,8,6,0.9)';
  g.lineJoin = 'round';
  g.strokeText(text, 256, 50);
  g.fillStyle = css;
  g.fillText(text, 256, 50);
}

export class WorkFx {
  readonly root = new THREE.Group();
  private tweens: Tween[] = [];
  private hovers = new Map<number, Hover>();
  private labels: Label[] = [];
  private focuses = new Map<number, Focus>();
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
      landed = taken ? 0.13 : 0.3;
      this.fly(obj, start, o.anchor, {
        dur: landed,
        arc: taken ? 0 : 0.5,
        spin: taken ? 0 : 5,
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
      const ring = new THREE.Sprite(ringMat(true));
      ring.renderOrder = 48;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false }));
      label.renderOrder = 51;
      group.add(ring, label);
      this.root.add(group);
      f = { group, dots: [], ring, label, canvas: null, text: '', ok: true, seen: 0, on: 0 };
      this.focuses.set(key, f);
    }
    f.seen = 0;
    while (f.dots.length < mounts.length) {
      const d = new THREE.Sprite(dotMat());
      d.renderOrder = 47;
      f.group.add(d);
      f.dots.push(d);
    }
    f.dots.forEach((d, i) => {
      d.visible = i < mounts.length && !(target && mounts[i].distanceToSquared(target.pos) < 0.01);
      if (d.visible) d.position.copy(mounts[i]);
    });
    f.ring.visible = f.label.visible = !!target;
    if (!target) return;
    f.ring.position.copy(target.pos);
    if (f.ok !== target.ok) {
      f.ok = target.ok;
      f.ring.material = ringMat(target.ok);
    }
    f.label.position.set(target.pos.x, target.pos.y + 0.6, target.pos.z);
    const text = `${target.css}|${target.text}`;
    if (text !== f.text && typeof document !== 'undefined') {
      f.text = text;
      if (!f.canvas) {
        f.canvas = document.createElement('canvas');
        f.canvas.width = 512;
        f.canvas.height = 96;
        const tex = new THREE.CanvasTexture(f.canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        (f.label.material as THREE.SpriteMaterial).map = tex;
        (f.label.material as THREE.SpriteMaterial).needsUpdate = true;
      }
      paintLabel(f.canvas, target.text, target.css);
      const m = (f.label.material as THREE.SpriteMaterial).map;
      if (m) m.needsUpdate = true;
      f.label.scale.set(2.6, 0.49, 1);
    }
  }

  private dropFocus(key: number) {
    const f = this.focuses.get(key);
    if (!f) return;
    const m = f.label.material as THREE.SpriteMaterial;
    m.map?.dispose();
    m.dispose();
    f.group.removeFromParent();
    this.focuses.delete(key);
  }

  // ------------------------------------------------------------------ labels

  /** A callout that rises from a point and fades. Needs a canvas, so it does nothing outside a browser. */
  label(text: string, css: string, at: THREE.Vector3) {
    if (typeof document === 'undefined') return;
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 96;
    paintLabel(c, text, css);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.6, 0.49, 1);
    sprite.position.copy(at);
    sprite.renderOrder = 50;
    this.root.add(sprite);
    this.labels.push({ sprite, t: 0, life: 2, y0: at.y, rise: 0.9 });
  }

  // ------------------------------------------------------------------ frame

  update(dt: number) {
    this.clock += dt;
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
        const ty = h.anchor.y + 0.6 + Math.sin(this.clock * 4) * 0.04;
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
      const pulse = 0.85 + Math.sin(this.clock * 6) * 0.1;
      f.ring.scale.setScalar(pulse * f.on);
      for (const d of f.dots) d.scale.setScalar((0.34 + Math.sin(this.clock * 3 + d.position.x * 3) * 0.04) * f.on);
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
