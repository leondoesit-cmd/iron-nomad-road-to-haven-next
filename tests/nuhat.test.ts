import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEROES, isHero, nextHero } from '../src/data/heroes';
import { Campaign, heroLoadout } from '../src/game/campaign';
import { HERO_LOOKS, RIG_HEIGHT } from '../src/render/heroLooks';
import { Humanoid } from '../src/render/humanoid';
import { identityOf, lookOf, shortSleeves } from '../src/render/outfit';
import { bagCap, newGear } from '../src/sim/gear';

const palette = () => ({ ...identityOf(0), hero: 'nuhat' as const, look: lookOf(heroLoadout('nuhat').worn) });
const person = () => new Humanoid(palette());
const faceOf = (h: Humanoid) => h.head.children.find(o => o instanceof THREE.Mesh && o.geometry.getAttribute('surf') && o.geometry.getAttribute('position').count > 20000) as THREE.Mesh;

describe('Nuhat', () => {
  it('can be selected in either seat and keeps her supplied height, weight and outfit in saves', () => {
    expect(isHero('nuhat')).toBe(true);
    expect(nextHero('ro')).toBe('nuhat');
    expect(HEROES.nuhat).toEqual({ id: 'nuhat', name: 'Nuhat', height: 1.7, weight: 73 });
    for (const pair of [['nuhat', 'leo'], ['chinsky', 'nuhat']] as const) {
      const campaign = Campaign.deserialize(JSON.parse(JSON.stringify(new Campaign(pair).serialize())));
      const p = campaign.players.find(p => p.hero === 'nuhat')!;
      expect(p.name).toBe('Nuhat');
      expect(p.gear.worn.body).toBeUndefined();
      expect(p.gear.worn.face).toBeUndefined();
      expect(p.gear.bag.length).toBeLessThanOrEqual(bagCap(p.gear));
    }
    expect(new Campaign(['nuhat', 'leo'], true).players[0].name).toBe('Nuhat');
    const h = person();
    expect(h.root.scale.y * RIG_HEIGHT).toBeCloseTo(1.7, 6);
    expect(h.head.localToWorld(new THREE.Vector3(0, HERO_LOOKS.nuhat.portrait.shape.top, 0)).y).toBeCloseTo(1.7, 5);
    expect(shortSleeves(palette().look.body, HERO_LOOKS.nuhat)).toBe(false);
    h.dispose();
  });

  it('moves her mouth through speech, lifts a smile and raises a wondering expression on separate instances', () => {
    const h = person(), other = person();
    h.expression = 'talking';
    const openings: number[] = [];
    for (let i = 0; i < 120; i++) {
      h.update(1 / 60, 'stand', 0, 0, 0);
      openings.push(faceOf(h).morphTargetInfluences![0]);
    }
    expect(Math.max(...openings) - Math.min(...openings)).toBeGreaterThan(0.35);
    expect(faceOf(other).morphTargetInfluences).toBeUndefined();
    h.expression = 'smiling';
    for (let i = 0; i < 90; i++) h.update(1 / 60, 'sit', 0, 0, 0);
    expect(faceOf(h).morphTargetInfluences![1]).toBeGreaterThan(0.99);
    expect(h.hips.position.y).toBeCloseTo(0.13);
    h.expression = 'wondering';
    for (let i = 0; i < 90; i++) h.update(1 / 60, 'seat', 0, 0, 0);
    expect(faceOf(h).morphTargetInfluences![2]).toBeGreaterThan(0.99);
    expect(h.head.rotation.z).toBeGreaterThan(0.1);
    expect(h.hips.position.y * h.root.scale.y).toBeCloseTo(0.4);
    // Every intermediate expression stays a convex combination, with no negative base texture weight.
    h.expression = 'talking';
    for (let i = 0; i < 60; i++) {
      h.update(1 / 60, 'stand', 0, 0, 0);
      const amounts = faceOf(h).morphTargetInfluences!;
      expect(amounts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1.000001);
      expect(amounts.every(v => v >= 0 && Number.isFinite(v))).toBe(true);
    }
    h.dispose(); other.dispose();
  });

  it('keeps speech during walking, preserves the gait and hides the braids for the owner camera', () => {
    const h = person();
    h.expression = 'talking';
    h.update(0.3, 'stand', 1.4, 0, 0);
    const thigh = h.legL.rotation.x;
    h.update(0.3, 'stand', 1.4, 0, 0);
    expect(Math.abs(h.legL.rotation.x - thigh)).toBeGreaterThan(0.1);
    expect(Math.abs(h.legL.rotation.x + h.legR.rotation.x)).toBeLessThan(1e-6);
    expect(faceOf(h).morphTargetInfluences![0]).toBeGreaterThan(0);
    const hair = h.root.getObjectByName('nuhat-box-braids')!;
    const box = new THREE.Box3().setFromObject(hair);
    expect(box.max.y - box.min.y).toBeGreaterThan(0.7);
    h.setFirstPerson(true);
    expect(hair.visible).toBe(false);
    h.setFirstPerson(false);
    expect(hair.visible).toBe(true);
    for (const pose of ['stand', 'sit', 'seat'] as const) {
      h.update(0.016, pose, 0, 0, 0);
      h.root.updateMatrixWorld(true);
      h.root.traverse(o => {
        expect(o.matrixWorld.elements.every(Number.isFinite)).toBe(true);
        if (o instanceof THREE.Mesh) expect(Array.from(o.geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true);
      });
    }
    h.dispose();
    expect(hair.parent).toBeNull();
  });

  it('replaces her blouse with armour, rebuilds expressions after dressing and removes her hair when changing hero', () => {
    const h = person();
    h.expression = 'smiling';
    h.update(0.1, 'stand', 0, 0, 0);
    const oldHair = h.root.getObjectByName('nuhat-box-braids')!;
    const loadout = heroLoadout('nuhat');
    expect(loadout.bag.map(i => i.id)).toEqual(expect.arrayContaining(['b_jacket', 'f_bandana', 'h_scrap']));
    loadout.worn.body = newGear('b_plate');
    loadout.worn.head = newGear('h_scrap');
    const oldTorso = (h.torso.children[0] as THREE.Mesh).geometry;
    h.dress({ ...palette(), look: lookOf(loadout.worn) });
    h.update(0.1, 'stand', 0, 0, 0);
    expect((h.torso.children[0] as THREE.Mesh).geometry).not.toBe(oldTorso);
    expect(oldHair.parent).toBeNull();
    expect(faceOf(h).morphTargetInfluences![1]).toBeGreaterThan(0);
    h.dress({ ...identityOf(0), hero: 'leo', look: lookOf(heroLoadout('leo').worn) });
    expect(h.root.getObjectByName('nuhat-box-braids')).toBeUndefined();
    h.dispose();
  });
});
