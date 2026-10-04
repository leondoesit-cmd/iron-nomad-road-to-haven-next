import * as THREE from 'three';
import { gearDef } from '../data/gear';
import { bagCap, type GearItem } from '../sim/gear';
import { disposeTree, shared } from '../render/dispose';
import { gearModel, type GearModel } from '../render/gearModels';
import type { Scene } from './scene';

/**
 * Gear lying in the world. A gun on a rack, a pistol on a counter, what a search, a chest, a dead raider or a stripped wreck puts
 * down: each is its real 3D model (the gun with its add-ons fitted, an armour piece folded, a blade, a tool) at rest on the floor,
 * shelf or rack with a fixed heading and no bobbing, spinning or hovering. Walk up and hold A to take it. A small name tag shows
 * only when someone stands close, at a fixed size on screen. A full bag leaves it where it is.
 */

const RARITY_CSS = ['#9a9684', '#d8d0b0', '#5fd35a', '#ffb02e'] as const;
const MAX_DROPS = 60;
const REACH = 1.9;
/** How close a player must be for the name tag to show. */
export const TAG_DIST = 4;

/** Where an item lies: a fixed spot, heading and (for a gun) whether it is on its side or belly down. */
export interface LiePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** On its flank (the ground) or belly down (a rack, a bench). Default: on its flank. */
  flat?: boolean;
  /** A little roll or pitch so it does not look laid by a ruler. */
  tilt?: [number, number];
  /** A stable key for things the world made (a rack's guns): taking one is recorded and it never comes back. */
  key?: string;
}

interface Drop {
  item: GearItem;
  x: number;
  y: number;
  z: number;
  yaw: number;
  root: THREE.Group;
  model: GearModel;
  tag: THREE.Sprite | null;
  key?: string;
  /** Rare finds keep a short, steady glow-post beside them. */
  beam: THREE.Mesh | null;
}

// Tag textures and the beam are shared by every drop and every scene.
const tags = new Map<string, THREE.Texture>();
const beams = new Map<number, { geo: THREE.CylinderGeometry; mat: THREE.MeshBasicMaterial }>();

/** The name tag for an item: its name in small text on a dark plate edged in its rarity colour. Null where there is no canvas (tests). */
function tagTexture(item: GearItem): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const d = gearDef(item.id);
  const text = d.name + (d.rarity > 1 ? ' ' + '◆'.repeat(d.rarity - 1) : '');
  const hit = tags.get(text + d.rarity);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 40;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = 'rgba(18,15,11,0.78)';
  g.strokeStyle = RARITY_CSS[d.rarity];
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(2, 2, 252, 36, 8);
  g.fill();
  g.stroke();
  g.font = '600 20px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#efe8d4';
  g.fillText(text, 128, 21, 238);
  const tex = shared(new THREE.CanvasTexture(c));
  tex.colorSpace = THREE.SRGBColorSpace;
  tags.set(text + d.rarity, tex);
  return tex;
}

function beamOf(rarity: number) {
  let b = beams.get(rarity);
  if (!b) {
    b = {
      geo: shared(new THREE.CylinderGeometry(0.015, 0.03, 1.8, 8, 1, true)),
      mat: shared(new THREE.MeshBasicMaterial({ color: RARITY_CSS[rarity], transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })),
    };
    beams.set(rarity, b);
  }
  return b;
}

export class GroundGearField {
  private drops = new Map<string, Drop>();

  /** Called with a placed item's key when it is taken, so the world can remember it. */
  onTaken: ((key: string) => void) | null = null;

  constructor(private scene: Scene) {}

  get count() {
    return this.drops.size;
  }

  list(): { item: GearItem; x: number; y: number; z: number; yaw: number; key?: string }[] {
    return [...this.drops.values()].map((d) => ({ item: d.item, x: d.x, y: d.y, z: d.z, yaw: d.yaw, key: d.key }));
  }

  /** The model standing for an item (tests look at it). */
  modelOf(uid: string): GearModel | null {
    return this.drops.get(uid)?.model ?? null;
  }

  /** Put an item on the ground near (x, z), a step off so it does not sit under whoever found it. `y` is the floor it lies on, when it is not the terrain. */
  add(item: GearItem, x: number, z: number, y?: number) {
    const sc = this.scene;
    const a = sc.rng.next() * Math.PI * 2;
    const r = 0.8 + sc.rng.next() * 0.6;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    this.place(item, { x: px, y: y ?? sc.groundAt(px, pz), z: pz, yaw: sc.rng.next() * Math.PI * 2, tilt: [(sc.rng.next() - 0.5) * 0.05, (sc.rng.next() - 0.5) * 0.05] });
    sc.audio.play('loot', px, pz, 0.6);
  }

  /** Lay an item exactly where `pose` says. Returns false if something with the same key already lies here. */
  place(item: GearItem, pose: LiePose): boolean {
    const sc = this.scene;
    if (pose.key && [...this.drops.values()].some((d) => d.key === pose.key)) return false;
    if (this.drops.size >= MAX_DROPS) {
      // The oldest set-down thing is tidied away, never one the world made (those are streamed in and out with their building).
      const old = [...this.drops.entries()].find(([, d]) => !d.key);
      if (old) this.remove(old[0]);
    }
    const d = gearDef(item.id);
    const model = gearModel(item, { flat: pose.flat ?? true });
    const root = new THREE.Group();
    root.position.set(pose.x, pose.y, pose.z);
    // One fixed heading and a natural tilt; nothing here is ever animated.
    root.rotation.set(pose.tilt?.[0] ?? 0, pose.yaw, pose.tilt?.[1] ?? 0, 'YXZ');
    root.add(model.group);
    let beam: THREE.Mesh | null = null;
    if (d.rarity >= 3) {
      const bm = beamOf(d.rarity);
      beam = new THREE.Mesh(bm.geo, bm.mat);
      beam.position.y = 0.9;
      root.add(beam);
    }
    let tag: THREE.Sprite | null = null;
    const tex = tagTexture(item);
    if (tex) {
      tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false, sizeAttenuation: false }));
      tag.scale.set(0.15, 0.15 * (40 / 256), 1);
      tag.position.y = model.top + 0.22;
      tag.renderOrder = 20;
      tag.visible = false;
      root.add(tag);
    }
    root.updateMatrixWorld(true);
    sc.root.add(root);

    const drop: Drop = { item, x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, root, model, tag, key: pose.key, beam };
    this.drops.set(item.uid, drop);
    const mark = '◆'.repeat(d.rarity);
    const ix = sc.interact.add({
      id: `gear:${item.uid}`,
      x: pose.x,
      z: pose.z,
      r: REACH,
      prompt: '',
      dur: 0.4,
      priority: 3,
      enabled: (p) => {
        if (p.state !== 'foot') return false;
        ix.prompt = p.gear.bag.length < bagCap(p.gear) ? `Pick up ${d.name} ${mark}` : `${d.name} ${mark}: bag full, make room first`;
        return true;
      },
      run: (p) => this.take(item.uid, p),
    });
    return true;
  }

  private take(uid: string, p: Scene['players'][number]) {
    const drop = this.drops.get(uid);
    if (!drop) return void p.note('Someone got there first', 'info');
    if (p.gear.bag.length >= bagCap(p.gear)) {
      p.note(`Your bag is full: scrap, wear or give something away, then pick up the ${gearDef(drop.item.id).name}`, 'warn');
      this.scene.audio.play('deny', drop.x, drop.z, 0.6);
      return;
    }
    const key = drop.key;
    this.remove(uid);
    if (key) this.onTaken?.(key);
    // There is room, so it goes in their own bag, with the note, the tip and the radio call.
    this.scene.addGear(p, drop.item);
  }

  /** Take an item away without anyone picking it up (a rack streamed out with its building). */
  removeKey(key: string) {
    for (const [uid, d] of this.drops) if (d.key === key) this.remove(uid);
  }

  private remove(uid: string) {
    const d = this.drops.get(uid);
    if (!d) return;
    if (d.tag) (d.tag.material as THREE.Material).dispose();
    d.root.removeFromParent();
    disposeTree(d.root);
    this.drops.delete(uid);
    this.scene.interact.remove(`gear:${uid}`);
  }

  /** Only the name tags change: each shows while someone is near. The things themselves never move. */
  update(_dt: number) {
    const ps = this.scene.players;
    for (const d of this.drops.values()) {
      if (!d.tag) continue;
      let near = false;
      for (const p of ps) if (Math.hypot(p.pos.x - d.x, p.pos.z - d.z) < TAG_DIST && Math.abs(p.pos.y - d.y) < 3) near = true;
      d.tag.visible = near;
    }
  }

  dispose() {
    for (const uid of [...this.drops.keys()]) this.remove(uid);
  }
}
