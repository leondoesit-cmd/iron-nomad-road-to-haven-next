import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEROES, HERO_IDS, isHero, legById, nextHero } from '../src/data';
import { Campaign, heroLoadout } from '../src/game/campaign';
import { LegScene } from '../src/game/legScene';
import { initPhysics } from '../src/physics/physics';
import { HERO_LOOKS, RIG_HEIGHT } from '../src/render/heroLooks';
import { Humanoid } from '../src/render/humanoid';
import { identityOf, lookOf } from '../src/render/outfit';
import { bagCap, newGear } from '../src/sim/gear';
import { fakeServices } from './helpers/sim';

beforeAll(initPhysics);

const person = () => new Humanoid({ ...identityOf(0), hero: 'iati', look: lookOf(heroLoadout('iati').worn) });

describe('Iati', () => {
  it('is selectable in either seat and survives a save, including his own outfit', () => {
    expect(isHero('iati')).toBe(true);
    expect(nextHero(HERO_IDS[HERO_IDS.indexOf('iati') - 1])).toBe('iati');
    for (const pair of [['iati', 'leo'], ['chinsky', 'iati']] as const) {
      const c = Campaign.deserialize(JSON.parse(JSON.stringify(new Campaign(pair).serialize())));
      const p = c.players.find(p => p.hero === 'iati')!;
      expect(p.name).toBe('Iati');
      expect(p.gear.worn.legs?.id).toBe('l_iati');
      expect(p.gear.worn.body).toBeUndefined();
      expect(p.gear.bag.length).toBeLessThanOrEqual(bagCap(p.gear));
    }
    expect(new Campaign(['iati', 'leo'], true).players[0].name).toBe('Iati');
  });

  it('stands 179 cm tall at the crown, with a bare crown and a full dark beard', () => {
    const h = person();
    const look = HERO_LOOKS.iati;
    expect(HEROES.iati.height).toBe(1.79);
    expect(h.root.scale.y * RIG_HEIGHT).toBeCloseTo(1.79, 6);
    const crown = h.head.localToWorld(new THREE.Vector3(0, look.portrait.shape.top, 0));
    expect(crown.y).toBeCloseTo(1.79, 5);
    expect(look.portrait.hair.crownDensity).toBeLessThan(0.05);
    expect(look.portrait.beard.depth).toBeGreaterThan(0.02);
    h.dispose();
  });

  it('keeps protection in the bag and replaces his shirt only when a body item is worn', () => {
    const l = heroLoadout('iati');
    expect(l.bag.map(i => i.id)).toEqual(expect.arrayContaining(['h_scrap', 'g_work', 'b_jacket', 'f_bandana']));
    const h = person();
    const torso = h.torso.children.find(c => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const bare = torso.geometry;
    const colors = bare.getAttribute('color');
    expect(new Set(Array.from(colors.array).map(v => Math.round(v * 255))).size).toBeGreaterThan(30);
    l.worn.body = newGear('b_plate');
    h.dress({ ...identityOf(0), hero: 'iati', look: lookOf(l.worn) });
    expect(torso.geometry).not.toBe(bare);
    expect(h.root.scale.y).toBeCloseTo(HERO_LOOKS.iati.scale);
    h.dispose();
  });

  it('brings the bottle mouth or joint filter to his lips and keeps the hands on the props', () => {
    for (const mode of ['drink', 'smoke'] as const) {
      const h = person();
      h.leisure = mode;
      h.update(1.6, 'stand', 0, 0, 0);
      h.root.updateMatrixWorld(true);
      const shape = HERO_LOOKS.iati.portrait.shape;
      const lips = h.head.localToWorld(new THREE.Vector3(0, shape.eyeY + shape.mouth.y, shape.eyeZ + shape.mouth.z + 0.005));
      const prop = h.root.getObjectByName(mode === 'drink' ? 'drink-bottle' : 'cannabis-joint')!;
      const tip = prop.localToWorld(mode === 'drink' ? new THREE.Vector3(0, 0.115, 0) : new THREE.Vector3(0, 0, -0.018));
      expect(prop.visible).toBe(true);
      expect(tip.distanceTo(lips)).toBeLessThan(0.015);
      const hand = mode === 'drink' ? h.hand : h.handL;
      expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(prop.getWorldPosition(new THREE.Vector3()))).toBeLessThan(0.05);
      expect(h.root.getObjectByName('leisure-props')!.visible).toBe(true);
      h.leisure = null;
      h.update(0.016, 'stand', 4, 1, 0);
      expect(h.root.getObjectByName('leisure-props')!.visible).toBe(false);
      h.dispose();
    }
  });

  it('has both props and smoke while relaxing, and hides them in the owner view and when downed', () => {
    const h = person();
    h.leisure = 'relax';
    h.update(0.1, 'stand', 0, 0, 0);
    const props = h.root.getObjectByName('leisure-props')!;
    expect(props.getObjectByName('drink-bottle')!.visible).toBe(true);
    expect(props.getObjectByName('cannabis-joint')!.visible).toBe(true);
    expect(props.children.some(c => c.name === 'joint-smoke' && (c as THREE.Sprite).isSprite)).toBe(true);
    h.setFirstPerson(true);
    expect(props.visible).toBe(false);
    h.setFirstPerson(false);
    expect(props.visible).toBe(true);
    h.update(0.016, 'downed', 0, 0, 0);
    expect(props.visible).toBe(false);
    h.dispose();
    expect(h.torso.getObjectByName('leisure-props')).toBeUndefined();
  });

  it('keeps the shirt in front of the skin at the chest corners and sides', () => {
    const h = person();
    h.root.updateMatrixWorld(true);
    const torso = h.torso.children.find(c => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const material = torso.geometry.getAttribute('surf');
    for (const y of [0.27, 0.31, 0.35, 0.40, 0.44]) for (const x of [-0.18, -0.16, 0.16, 0.18]) {
      const from = h.torso.localToWorld(new THREE.Vector3(x * HERO_LOOKS.iati.girth, y, 0.4));
      const ray = new THREE.Raycaster(from, new THREE.Vector3(0, 0, -1));
      const first = ray.intersectObject(torso)[0];
      expect(first, `${x}, ${y}`).toBeDefined();
      // Skin roughness is .55; the first visible surface here must be the .95 cloth, including its printed motifs.
      expect(material.getX(first.face!.a), `${x}, ${y}`).toBeGreaterThan(0.9);
    }
    h.dispose();
  });

  it('exhales a cloud wider than his shoulders, then fades it before the next puff', () => {
    const h = person();
    h.leisure = 'smoke';
    h.update(5, 'stand', 0, 0, 0);
    const props = h.root.getObjectByName('leisure-props')!;
    const puffs = props.children.filter(c => c.name === 'joint-smoke') as THREE.Sprite[];
    const left = Math.min(...puffs.filter(p => p.visible).map(p => p.position.x - p.scale.x / 2));
    const right = Math.max(...puffs.filter(p => p.visible).map(p => p.position.x + p.scale.x / 2));
    expect(right - left).toBeGreaterThan(0.65);
    expect(puffs.some(p => p.visible && p.scale.x > 0.5 && (p.material as THREE.SpriteMaterial).opacity > 0.15)).toBe(true);
    h.update(3.9, 'stand', 0, 0, 0);
    expect(puffs.some(p => p.visible && p.scale.x > 0.5)).toBe(false);
    h.dispose();
  });

  it('idles without dosing the simulation, yields to combat, and uses the existing stocks when taking weed', () => {
    const host = fakeServices({ solo: true });
    host.svc.campaign = new Campaign(['iati', 'leo'], true);
    host.svc.campaign.seed = 4242;
    const sc = new LegScene(host.svc, legById('L1'));
    const p = sc.players[0];
    p.exitVehicle(false);
    p.grounded = true;
    const stocks = { ...host.svc.campaign.items };
    for (let i = 0; i < 240; i++) p.syncVisual(1, 1 / 60);
    expect(p.human.leisure).toBe('relax');
    expect(host.svc.campaign.items).toEqual(stocks);
    expect(p.drugs.active).toHaveLength(0);
    p.ads = 1;
    p.syncVisual(1, 1 / 60);
    expect(p.human.leisure).toBeNull();
    p.ads = 0;
    host.svc.campaign.items.weed = 1;
    expect(p.takeDrug('weed')).toBe(true);
    p.syncVisual(1, 1 / 60);
    expect(p.human.leisure).toBe('smoke');
    expect(host.svc.campaign.items.weed).toBe(0);
    expect(p.drugs.active.some(d => d.id === 'weed')).toBe(true);
    sc.dispose();
  }, 60000);
});
