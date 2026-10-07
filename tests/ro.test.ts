import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEROES, HERO_IDS, isHero, nextHero } from '../src/data/heroes';
import { Campaign } from '../src/game/campaign';
import { BITES, BOTTLE_H, BURGER_RADIUS, BurgerEater, bitePoint, burgerGeometry } from '../src/render/burger';
import { HERO_LOOKS, RIG_HEIGHT, RO_BITE, RO_LAUGH } from '../src/render/heroLooks';
import { Humanoid } from '../src/render/humanoid';
import { identityOf, lookOf } from '../src/render/outfit';
import { FacePainter, portraitGeometry, portraitMaterial } from '../src/render/portrait';

const person = (hero: 'ro' | 'lag' | 'amirat' = 'ro') => new Humanoid({ ...identityOf(0), look: lookOf({}), hero });

describe('Ro Karab', () => {
  it('is selectable, 1.75 m and 88 kg: heavier set than his brother Lag at the same height', () => {
    expect(isHero('ro')).toBe(true);
    expect(nextHero(HERO_IDS[HERO_IDS.indexOf('ro') - 1])).toBe('ro');
    expect(HEROES.ro).toMatchObject({ name: 'Ro Karab', height: 1.75, weight: 88 });
    expect(HERO_LOOKS.ro.scale * RIG_HEIGHT).toBeCloseTo(1.75, 3);
    expect(HERO_LOOKS.ro.girth).toBeGreaterThan(HERO_LOOKS.lag.girth);
    expect(HERO_LOOKS.ro.belly).toBeGreaterThan(HERO_LOOKS.lag.belly);
    const c = Campaign.deserialize(JSON.parse(JSON.stringify(new Campaign(['ro', 'lag']).serialize())));
    expect(c.players.map((p) => p.name)).toEqual(['Ro Karab', 'Lag Karab']);
  });

  it('wears a charcoal hoodie with long sleeves and no drawstrings', () => {
    const colours = (h: Humanoid) => {
      const torso = h.torso.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
      const col = torso.geometry.getAttribute('color');
      let orange = 0;
      for (let i = 0; i < col.count; i++) if (col.getX(i) > 0.6 && col.getY(i) > 0.2 && col.getY(i) < 0.45 && col.getZ(i) < 0.15) orange++;
      return orange;
    };
    // Amirat's hoodie has the orange cords; Ro's has none.
    expect(colours(person('amirat'))).toBeGreaterThan(0);
    expect(colours(person())).toBe(0);
    expect(HERO_LOOKS.ro.rolledSleeves).toBeFalsy();
  });

  it('laughs with the top and bottom teeth showing, and bites with only the top ones', () => {
    const paint = (spec: typeof RO_LAUGH, y: number) => {
      const s = spec.shape;
      const out = new Float32Array(4);
      new FacePainter(spec).paint(0.003, s.eyeY + s.mouth.y + y, s.eyeZ + s.mouth.z, 0, 1, out);
      return out[0] + out[1] + out[2];
    };
    for (const spec of [RO_LAUGH, RO_BITE]) {
      const o = spec.shape.mouth.open!;
      expect(paint(spec, o / 2 - 0.004), `${spec.id} top`).toBeGreaterThan(1.7);
      expect(Number.isFinite(portraitGeometry(spec, 'full').getAttribute('position').getX(0))).toBe(true);
    }
    const o = RO_LAUGH.shape.mouth.open!;
    expect(paint(RO_LAUGH, -o / 2 + 0.003)).toBeGreaterThan(1.4);
    expect(paint(RO_BITE, -RO_BITE.shape.mouth.open! / 2 + 0.003)).toBeLessThan(1.2);
  });
});

describe('burger and beer', () => {
  const lips = (h: Humanoid) => {
    const s = HERO_LOOKS.ro.portrait.shape;
    return h.head.localToWorld(new THREE.Vector3(0, s.eyeY + s.mouth.y, s.eyeZ + s.mouth.z));
  };
  const step = (e: BurgerEater, to: number) => {
    while (e.t < to - 1e-6) e.update(Math.min(1 / 60, to - e.t));
    e.group.updateMatrixWorld(true);
  };
  const face = (h: Humanoid) => (h.head.children[1] as THREE.Mesh).material;

  it('loses a crescent from the front with each bite, the back left whole', () => {
    const box = (k: number) => new THREE.Box3().setFromBufferAttribute(burgerGeometry(k).getAttribute('position') as THREE.BufferAttribute);
    let front = box(0).min.z;
    expect(front).toBeLessThan(-BURGER_RADIUS);
    for (let k = 1; k < BITES; k++) {
      const b = box(k);
      expect(b.min.z).toBeGreaterThan(front);
      expect(b.max.z).toBeGreaterThan(BURGER_RADIUS * 0.95);
      front = b.min.z;
    }
  });

  it('sits, bites with both hands on the burger, puts it down, drinks, laughs, and goes again', () => {
    const h = person();
    const e = new BurgerEater(h);
    expect(h.hips.getWorldPosition(new THREE.Vector3()).y).toBeLessThan(0.5);
    // Up at the mouth just before the teeth meet, the bite face on, a hand to each side of the bun.
    step(e, 1.5);
    const bite = e.burger.localToWorld(bitePoint(e.eaten));
    expect(bite.distanceTo(lips(h))).toBeLessThan(0.03);
    expect(face(h)).toBe(portraitMaterial(RO_BITE));
    const bun = e.burger.localToWorld(new THREE.Vector3(0, 0.05, 0));
    for (const hand of [h.hand, h.handL]) expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(bun)).toBeLessThan(0.16);
    step(e, 1.6);
    expect(e.eaten).toBe(1);
    // Back on the plate, then the beer at the lips, in the right hand.
    step(e, 3.5);
    expect(e.burger.position.distanceTo(e.plateAt)).toBeLessThan(1e-6);
    expect(face(h)).toBe(portraitMaterial(HERO_LOOKS.ro.portrait));
    step(e, 5.6);
    const mouth = e.bottle.localToWorld(new THREE.Vector3(0, BOTTLE_H, 0));
    expect(mouth.distanceTo(lips(h))).toBeLessThan(0.03);
    expect(h.hand.getWorldPosition(new THREE.Vector3()).distanceTo(e.bottle.localToWorld(new THREE.Vector3(0, 0.08, 0)))).toBeLessThan(0.12);
    // The laugh, then the beer back where it stood.
    step(e, 8);
    expect(face(h)).toBe(portraitMaterial(RO_LAUGH));
    expect(e.bottle.position.distanceTo(e.bottleAt)).toBeLessThan(1e-6);
    step(e, 11.5);
    expect(face(h)).toBe(portraitMaterial(HERO_LOOKS.ro.portrait));
    for (const v of [h.hand, h.handL]) expect(Number.isFinite(v.getWorldPosition(new THREE.Vector3()).length())).toBe(true);
    h.dispose();
  });

  it('finishes the burger a bite a loop, then a new one is on the plate', () => {
    const h = person();
    const e = new BurgerEater(h);
    for (let i = 0; i < 60 * (12.5 * 4 + 1.6); i++) e.update(1 / 60);
    expect(e.eaten).toBe(BITES);
    expect(e.burger.visible).toBe(false);
    for (let i = 0; i < 60 * 11.5; i++) e.update(1 / 60);
    expect(e.eaten).toBe(0);
    expect(e.burger.visible).toBe(true);
    h.dispose();
  });

  it('pulls no faces on a hero without them', () => {
    const h = person('lag');
    const e = new BurgerEater(h);
    const own = face(h);
    for (let i = 0; i < 60 * 12.5; i++) {
      e.update(1 / 60);
      expect(face(h)).toBe(own);
    }
    h.dispose();
  });
});
