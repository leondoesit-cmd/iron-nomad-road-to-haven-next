import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEROES, isHero, nextHero } from '../src/data/heroes';
import { Campaign, heroLoadout } from '../src/game/campaign';
import { HERO_LOOKS, RIG_HEIGHT } from '../src/render/heroLooks';
import { Humanoid } from '../src/render/humanoid';
import { identityOf, lookOf } from '../src/render/outfit';
import { UdudLounger } from '../src/render/udud';
import { newGear } from '../src/sim/gear';

const palette = () => ({ ...identityOf(0), hero: 'udud' as const, look: lookOf(heroLoadout('udud').worn) });
const person = () => new Humanoid(palette());
const glasses = (h: Humanoid) => h.head.getObjectByName('udud-prescription-glasses')!;
const temple = (h: Humanoid) => {
  const s = HERO_LOOKS.udud.portrait.shape;
  return h.head.localToWorld(new THREE.Vector3(-s.eyeX - 0.018, s.eyeY + 0.006, s.eyeZ + 0.035));
};
const hand = (h: Humanoid) => h.hand.getWorldPosition(new THREE.Vector3());
function step(l: UdudLounger, seconds: number) {
  for (let time = 0; time < seconds - 1e-8; time += 1 / 60) l.update(Math.min(1 / 60, seconds - time));
  l.group.updateMatrixWorld(true);
}

describe('Udud', () => {
  it('can play solo or in either seat, preserving his name, supplied measurements and grey shirt in saves', () => {
    expect(isHero('udud')).toBe(true);
    expect(nextHero('nuhat')).toBe('udud');
    expect(nextHero('udud')).toBe('chinsky');
    expect(HEROES.udud).toEqual({ id: 'udud', name: 'Udud', height: 1.76, weight: 82 });
    for (const pair of [['udud', 'leo'], ['chinsky', 'udud']] as const) {
      const c = Campaign.deserialize(JSON.parse(JSON.stringify(new Campaign(pair).serialize())));
      const p = c.players.find(p => p.hero === 'udud')!;
      expect(p.name).toBe('Udud');
      expect(p.gear.worn.body).toBeUndefined();
      expect(p.gear.worn.face).toBeUndefined();
      expect(p.gear.bag.map(i => i.id)).toEqual(expect.arrayContaining(['b_jacket', 'f_bandana']));
    }
    expect(new Campaign(['udud', 'leo'], true).players[0].hero).toBe('udud');
    const h = person();
    expect(h.root.scale.y * RIG_HEIGHT).toBeCloseTo(1.76, 6);
    expect(h.head.localToWorld(new THREE.Vector3(0, HERO_LOOKS.udud.portrait.shape.top, 0)).y).toBeCloseTo(1.76, 5);
    expect(HERO_LOOKS.udud.girth).toBeGreaterThan(HERO_LOOKS.leo.girth);
    h.dispose();
  });

  it('leans back while sitting and periodically reaches the spectacles, pushes them up and lowers his hand smoothly', () => {
    const h = person(), l = new UdudLounger(h);
    step(l, 7);
    const bounds = new THREE.Box3().setFromObject(l.group, true);
    expect(bounds.min.y).toBeGreaterThan(-0.03);
    expect(bounds.min.y).toBeLessThan(0.04);
    expect(h.torso.rotation.x).toBeLessThan(-0.28);
    expect(hand(h).distanceTo(temple(h))).toBeGreaterThan(0.25);
    const previous = hand(h);
    let largestStep = 0;
    for (let i = 0; i < 105; i++) {
      l.update(1 / 60);
      const current = hand(h);
      largestStep = Math.max(largestStep, previous.distanceTo(current));
      previous.copy(current);
    }
    expect(largestStep).toBeLessThan(0.035);
    expect(hand(h).distanceTo(temple(h))).toBeLessThan(0.045);
    expect(glasses(h).position.y).toBeLessThan(-0.001);
    step(l, 0.5);
    expect(glasses(h).position.y).toBeCloseTo(0, 6);
    step(l, 1.1);
    expect(hand(h).distanceTo(temple(h))).toBeGreaterThan(0.25);
    step(l, 13.55);
    expect(hand(h).distanceTo(temple(h))).toBeLessThan(0.045);
    expect(l.group.getObjectByName('udud-lounge-chair')).toBeDefined();
    h.dispose();
  });

  it('keeps the seated personality on the ground and interrupts the gesture when aiming, holding gear or walking', () => {
    const h = person();
    h.update(8.9, 'sit', 0, 0, 0);
    expect(h.hips.position.y).toBeCloseTo(0.13);
    expect(h.torso.rotation.x).toBeLessThan(-0.28);
    expect(hand(h).distanceTo(temple(h))).toBeLessThan(0.045);
    h.update(0.1, 'sit', 0, 1, 0);
    expect(glasses(h).position.y).toBe(0);
    expect(hand(h).distanceTo(temple(h))).toBeGreaterThan(0.25);
    h.setWeapon('pistol');
    h.update(8.9, 'sit', 0, 0, 0);
    expect(hand(h).distanceTo(temple(h))).toBeGreaterThan(0.25);
    h.setWeapon('none');
    h.update(0.2, 'stand', 1.4, 0, 0);
    const stride = h.legL.rotation.x;
    h.update(0.2, 'stand', 1.4, 0, 0);
    expect(Math.abs(h.legL.rotation.x - stride)).toBeGreaterThan(0.1);
    expect(h.torso.rotation.x).toBeGreaterThan(-0.1);
    expect(glasses(h).position.y).toBe(0);
    h.dispose();
  });

  it('hides spectacles for first person and incompatible face gear, and removes them on redressing or disposal', () => {
    const h = person();
    const old = glasses(h);
    h.setFirstPerson(true);
    expect(old.visible).toBe(false);
    h.update(8.9, 'seat', 0, 0, 0);
    expect(old.visible).toBe(false);
    h.setFirstPerson(false);
    expect(old.visible).toBe(true);
    const loadout = heroLoadout('udud');
    loadout.worn.face = newGear('f_goggles');
    h.dress({ ...palette(), look: lookOf(loadout.worn) });
    expect(old.parent).toBeNull();
    expect(glasses(h).visible).toBe(false);
    h.update(8.9, 'sit', 0, 0, 0);
    expect(hand(h).distanceTo(temple(h))).toBeGreaterThan(0.25);
    h.dress(palette());
    const fresh = glasses(h);
    h.update(0.016, 'sit', 0, 0, 0);
    h.root.updateMatrixWorld(true);
    h.root.traverse(o => {
      expect(o.matrixWorld.elements.every(Number.isFinite)).toBe(true);
      if (o instanceof THREE.Mesh) expect(Array.from(o.geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true);
    });
    h.dress({ ...identityOf(0), hero: 'leo', look: lookOf(heroLoadout('leo').worn) });
    expect(fresh.parent).toBeNull();
    expect(h.head.getObjectByName('udud-prescription-glasses')).toBeUndefined();
    const other = person(), owned = glasses(other);
    other.dispose();
    expect(owned.parent).toBeNull();
    h.dispose();
  });
});
