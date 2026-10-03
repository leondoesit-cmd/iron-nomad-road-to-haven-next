import * as THREE from 'three';
import { gearDef } from '../data/gear';
import { bagCap, type GearItem } from '../sim/gear';
import { shared } from '../render/dispose';
import { gearIcon } from '../ui/gearIcons';
import type { Scene } from './scene';

/**
 * Gear lying in the world. A search, a chest, a dead raider or a stripped wreck puts what it holds on the ground as a card
 * floating over a light beam; walk up and hold A to take it. A full bag leaves it where it is.
 */

const RARITY_CSS = ['#9a9684', '#d8d0b0', '#5fd35a', '#ffb02e'] as const;
const MAX_DROPS = 40;
const REACH = 1.9;

interface Drop {
  item: GearItem;
  x: number;
  y: number;
  z: number;
  root: THREE.Group;
  card: THREE.Sprite;
  phase: number;
  age: number;
}

// Textures and the beam are shared by every drop and every scene.
const cards = new Map<string, THREE.Texture>();
const beams = new Map<number, { geo: THREE.CylinderGeometry; mat: THREE.MeshBasicMaterial }>();

/** The card for an item: its picture on a dark plate edged in its rarity colour. Null where there is no canvas (tests). */
function cardTexture(id: string): THREE.Texture | null {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const hit = cards.get(id);
  if (hit) return hit;
  const d = gearDef(id);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (!g) return null;
  const edge = RARITY_CSS[d.rarity];
  g.fillStyle = 'rgba(20,16,12,0.86)';
  g.strokeStyle = edge;
  g.lineWidth = 6;
  g.beginPath();
  g.roundRect(5, 5, 118, 118, 16);
  g.fill();
  g.stroke();
  const tex = shared(new THREE.CanvasTexture(c));
  tex.colorSpace = THREE.SRGBColorSpace;
  // The picture arrives a moment later: an SVG has to be decoded as an image first.
  const img = new Image();
  img.onload = () => {
    g.drawImage(img, 16, 16, 96, 96);
    tex.needsUpdate = true;
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(gearIcon(d, 0).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" '))}`;
  cards.set(id, tex);
  return tex;
}

function beamOf(rarity: number) {
  let b = beams.get(rarity);
  if (!b) {
    b = {
      geo: shared(new THREE.CylinderGeometry(0.06, 0.1, 7, 8, 1, true)),
      mat: shared(new THREE.MeshBasicMaterial({ color: RARITY_CSS[rarity], transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })),
    };
    beams.set(rarity, b);
  }
  return b;
}

export class GroundGearField {
  private drops = new Map<string, Drop>();

  constructor(private scene: Scene) {}

  get count() {
    return this.drops.size;
  }

  list(): { item: GearItem; x: number; z: number }[] {
    return [...this.drops.values()].map((d) => ({ item: d.item, x: d.x, z: d.z }));
  }

  /** Put an item on the ground near (x, z), a step off so it does not sit under whoever found it. */
  add(item: GearItem, x: number, z: number) {
    const sc = this.scene;
    if (this.drops.size >= MAX_DROPS) this.remove(this.drops.keys().next().value!);
    const a = sc.rng.next() * Math.PI * 2;
    const r = 0.8 + sc.rng.next() * 0.6;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    const py = sc.groundAt(px, pz);
    const d = gearDef(item.id);

    const root = new THREE.Group();
    root.position.set(px, py, pz);
    const beam = beamOf(d.rarity);
    const col = new THREE.Mesh(beam.geo, beam.mat);
    col.position.y = 3.5;
    root.add(col);
    const tex = cardTexture(item.id);
    const card = new THREE.Sprite(new THREE.SpriteMaterial({ ...(tex ? { map: tex } : {}), color: tex ? 0xffffff : RARITY_CSS[d.rarity], transparent: true, depthWrite: false, fog: false }));
    card.scale.set(0.75, 0.75, 1);
    card.position.y = 0.85;
    root.add(card);
    sc.root.add(root);

    const drop: Drop = { item, x: px, y: py, z: pz, root, card, phase: sc.rng.next() * 6.28, age: 0 };
    this.drops.set(item.uid, drop);
    const tag = '◆'.repeat(d.rarity);
    const ix = sc.interact.add({
      id: `gear:${item.uid}`,
      x: px,
      z: pz,
      r: REACH,
      prompt: '',
      dur: 0.4,
      priority: 3,
      enabled: (p) => {
        if (p.state !== 'foot') return false;
        ix.prompt = p.gear.bag.length < bagCap(p.gear) ? `Pick up ${d.name} ${tag}` : `${d.name} ${tag}: bag full, make room first`;
        return true;
      },
      run: (p) => this.take(item.uid, p),
    });
    sc.audio.play('loot', px, pz, 0.6);
  }

  private take(uid: string, p: Scene['players'][number]) {
    const drop = this.drops.get(uid);
    if (!drop) return void p.note('Someone got there first', 'info');
    if (p.gear.bag.length >= bagCap(p.gear)) {
      p.note(`Your bag is full: scrap, wear or give something away, then pick up the ${gearDef(drop.item.id).name}`, 'warn');
      this.scene.audio.play('deny', drop.x, drop.z, 0.6);
      return;
    }
    this.remove(uid);
    // There is room, so it goes in their own bag, with the note, the tip and the radio call.
    this.scene.addGear(p, drop.item);
  }

  private remove(uid: string) {
    const d = this.drops.get(uid);
    if (!d) return;
    d.root.removeFromParent();
    (d.card.material as THREE.Material).dispose();
    this.drops.delete(uid);
    this.scene.interact.remove(`gear:${uid}`);
  }

  update(dt: number) {
    for (const d of this.drops.values()) {
      d.age += dt;
      d.card.position.y = 0.85 + Math.sin(d.age * 2.2 + d.phase) * 0.07;
      const pop = Math.min(1, d.age * 4);
      d.card.scale.setScalar(0.75 * (0.4 + 0.6 * pop));
    }
  }

  dispose() {
    for (const uid of [...this.drops.keys()]) this.remove(uid);
  }
}
