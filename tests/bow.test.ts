import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { GUN_MODELS, gearDef, legById, validateData } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Humanoid } from '../src/render/humanoid';
import { identityOf } from '../src/render/outfit';
import { ViewModel } from '../src/render/viewmodel';
import { BRACE, BowRig } from '../src/render/bow';
import { ARCHERY, arrowSurvives, canLoose, embedDepth, holdShake, loosePower, newDraw, slack, sticks, stepDraw } from '../src/sim/archery';
import { AMMO, ammoForGun, dropAt, throughFlesh, throughSlab } from '../src/sim/ballistics';
import { HANDLING } from '../src/sim/handling';
import { MUZZLE, TRACER, flashes } from '../src/sim/weaponfx';
import { DROPS_MAG, GUN_POINTS } from '../src/sim/weaponanim';
import { newGear } from '../src/sim/gear';
import { slotsOfGun } from '../src/sim/gunmods';
import { RECIPES } from '../src/sim/resources';
import { fakeServices } from './helpers/sim';

vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

// ------------------------------------------------------------------ the rules

describe('the bow as data', () => {
  it('is a quiet, slotless gun that draws, holds one arrow and shoots arrows', () => {
    expect(validateData()).toEqual([]);
    const d = gearDef('w_bow');
    const g = d.gun!;
    expect(d.kind).toBe('gun');
    expect(g.model).toBe('bow');
    expect(g.draw).toBeGreaterThan(0.3);
    expect(g.mag).toBe(1);
    expect(g.noise).toBeLessThan(gearDef('w_crossbow').gun!.noise);
    expect(slotsOfGun(d)).toEqual([]);
    expect(ammoForGun('bow')).toBe('arrow');
    expect(HANDLING.bow.eject).toBe('none');
    expect(DROPS_MAG.bow).toBeNull();
    // Strings throw no flame, and an arrow is drawn as itself, not as a streak.
    expect(flashes('bow')).toBe(false);
    expect(flashes('crossbow')).toBe(false);
    expect(flashes('pistol')).toBe(true);
    expect(MUZZLE.bow.light).toBe(0);
    expect(TRACER.arrow.chance).toBe(0);
    // Arrows are made at camp.
    expect(RECIPES.find((r) => r.yields.arrow)?.yields.arrow).toBeGreaterThan(0);
  });

  it('an arrow is slow and arcs, sticks in a body rather than going through, and goes through glass but not a plank wall', () => {
    const a = AMMO.arrow;
    expect(a.speed).toBeLessThan(AMMO.bolt.speed);
    expect(dropAt(a, 40)).toBeGreaterThan(dropAt(AMMO.rifle, 40) * 10);
    expect(dropAt(a, 40)).toBeGreaterThan(0.8);
    expect(throughFlesh(a, a.speed)).toBe(0);
    expect(throughSlab(a, a.speed, 'glass', 0.01)).toBeGreaterThan(0);
    expect(throughSlab(a, a.speed, 'wood', 0.1)).toBe(0);
    expect(throughSlab(a, a.speed, 'sheet', 0.002)).toBe(0);
  });
});

describe('drawing and loosing', () => {
  it('the string comes back over the draw time, is held, and eases down when let go', () => {
    const d = newDraw();
    for (let i = 0; i < 30; i++) stepDraw(d, true, 1, DT);
    expect(d.k).toBeCloseTo(0.5, 2);
    expect(d.held).toBe(0);
    for (let i = 0; i < 60; i++) stepDraw(d, true, 1, DT);
    expect(d.k).toBe(1);
    expect(d.held).toBeGreaterThan(0.4);
    stepDraw(d, false, 1, DT);
    expect(d.k).toBeLessThan(1);
    expect(d.held).toBe(0);
    for (let i = 0; i < 60; i++) stepDraw(d, false, 1, DT);
    expect(d.k).toBe(0);
    d.k = 0.8;
    slack(d);
    expect(d.k).toBe(0);
  });

  it('too little draw only eases the string down; the harder the draw, the faster and harder the arrow', () => {
    expect(canLoose(ARCHERY.minLoose - 0.01)).toBe(false);
    expect(canLoose(ARCHERY.minLoose)).toBe(true);
    expect(loosePower(1)).toEqual({ vel: 1, dmg: 1 });
    const half = loosePower(0.5);
    const quarter = loosePower(0.25);
    expect(half.vel).toBeLessThan(1);
    expect(quarter.vel).toBeLessThan(half.vel);
    expect(quarter.dmg).toBeLessThan(half.dmg);
    expect(quarter.vel).toBeGreaterThan(0.3);
  });

  it('a full draw held too long shakes, up to a limit', () => {
    expect(holdShake(0)).toBe(1);
    expect(holdShake(ARCHERY.holdFree)).toBe(1);
    expect(holdShake(ARCHERY.holdFree + 1)).toBeGreaterThan(1.5);
    expect(holdShake(60)).toBe(ARCHERY.shakeMax);
  });

  it('arrows break more on stone and steel than in earth, wood and flesh, and bury deeper in soft things', () => {
    const survived = (s: Parameters<typeof arrowSurvives>[0]) => {
      let n = 0;
      for (let i = 0; i < 100; i++) if (arrowSurvives(s, 1, (i + 0.5) / 100)) n++;
      return n;
    };
    expect(survived('dirt')).toBeGreaterThan(85);
    expect(survived('flesh')).toBeGreaterThan(80);
    expect(survived('stone')).toBeLessThan(50);
    expect(survived('steel')).toBeLessThan(survived('concrete'));
    expect(sticks('dirt') && sticks('wood') && sticks('flesh')).toBe(true);
    expect(sticks('steel') || sticks('concrete') || sticks('glass')).toBe(false);
    expect(embedDepth('dirt', 1)).toBeGreaterThan(embedDepth('wood', 1));
    expect(embedDepth('flesh', 1)).toBeGreaterThan(embedDepth('flesh', 0.3));
  });
});

// ------------------------------------------------------------------ what you see

describe('the bow in the hands', () => {
  it('the string comes back with the draw, the limbs bend, and the arrow is only there when nocked', () => {
    const rig = new BowRig();
    rig.set(0, true);
    expect(rig.nock.z).toBeCloseTo(-BRACE, 5);
    const arrow = rig.group.children[rig.group.children.length - 1];
    expect(arrow.visible).toBe(true);
    const tipAt = () => {
      const top = rig.group.children[1];
      top.updateMatrix();
      return new THREE.Vector3(0, 0.44, -0.255).applyMatrix4(top.matrix);
    };
    const restTip = tipAt();
    rig.set(1, true);
    expect(rig.nock.z).toBeCloseTo(-BRACE - rig.drawLen, 5);
    // The top limb's tip comes back toward the archer and in.
    const drawnTip = tipAt();
    expect(drawnTip.z).toBeLessThan(restTip.z - 0.03);
    expect(drawnTip.y).toBeLessThan(restTip.y);
    rig.set(0.5, false);
    expect(arrow.visible).toBe(false);
  });

  it('every gun, the bow included, poses in first person without throwing, sights up or down', () => {
    for (const m of GUN_MODELS) {
      const h = new Humanoid(identityOf(0));
      h.setWeapon(m);
      const vm = new ViewModel(identityOf(0));
      for (const k of [0, 1]) {
        vm.motion.ads = k;
        h.bowDraw = k;
        expect(() => vm.pose(0.016, h), m).not.toThrow();
      }
    }
  });

  /** The first-person bow drawn `k` of the way, on a level camera at the origin looking down -z. */
  function firstPerson(k: number) {
    const h = new Humanoid(identityOf(0));
    h.setWeapon('bow');
    h.bowDraw = k;
    const vm = new ViewModel(identityOf(0));
    (vm as unknown as { t: number }).t = 0;
    vm.pose(0.016, h);
    const cam = new THREE.PerspectiveCamera(66, 1.78, 0.2, 100);
    cam.updateMatrixWorld();
    vm.place(cam);
    const riser = vm.weaponMesh!;
    riser.updateWorldMatrix(true, false);
    const shelf = riser.localToWorld(new THREE.Vector3(...GUN_POINTS.bow.muzzle));
    const rig = (vm as unknown as { bow: BowRig }).bow;
    const nock = rig.group.localToWorld(rig.nock.clone());
    const handR = vm.root.children[4] as THREE.Mesh;
    handR.updateWorldMatrix(true, false);
    return { shelf, nock, hand: new THREE.Vector3().setFromMatrixPosition(handR.matrixWorld) };
  }

  it('drawn in first person, the arrow runs in from low on the right to just under the crosshair, the draw hand on the nock', () => {
    const { shelf, nock, hand } = firstPerson(1);
    // Seen from the eye: the arrow leaves the shelf a few degrees from the middle of the view, below it...
    const angle = (v: THREE.Vector3) => Math.atan2(Math.hypot(v.x, v.y), -v.z);
    expect(angle(shelf)).toBeLessThan(0.1);
    expect(shelf.y).toBeLessThan(0);
    // ...and comes from the nock low on the right, which is clear of the camera's near plane.
    expect(nock.x).toBeGreaterThan(shelf.x + 0.05);
    expect(nock.y).toBeLessThan(shelf.y);
    expect(nock.z).toBeLessThan(-0.21);
    expect(hand.distanceTo(nock)).toBeLessThan(0.08);
    // Lowered, it is off to the side and down.
    const low = firstPerson(0);
    expect(low.shelf.y).toBeLessThan(shelf.y - 0.08);
  });

  it('a partner sees the bow raised along the aim in the left hand and the draw hand on the string', () => {
    const h = new Humanoid(identityOf(0));
    h.setWeapon('bow');
    h.bowDraw = 1;
    h.update(DT, 'stand', 0, 1, 0, 0);
    h.root.updateMatrixWorld(true);
    const rig = h.handL.children[0];
    expect(rig).toBeDefined();
    const nock = rig.localToWorld(new THREE.Vector3(GUN_POINTS.bow.muzzle[0], GUN_POINTS.bow.muzzle[1], -BRACE - 0.46));
    const shelf = rig.localToWorld(new THREE.Vector3(...GUN_POINTS.bow.muzzle));
    const aim = shelf.clone().sub(nock).normalize();
    // Level and straight ahead (+z, the way the body faces).
    expect(aim.z).toBeGreaterThan(0.95);
    expect(Math.abs(aim.y)).toBeLessThan(0.2);
    // Bow at shoulder height, out in front; the draw hand at the nock.
    expect(shelf.y).toBeGreaterThan(1.2);
    expect(shelf.z).toBeGreaterThan(0.35);
    const hand = new THREE.Vector3().setFromMatrixPosition(h.hand.matrixWorld);
    expect(hand.distanceTo(nock)).toBeLessThan(0.06);
    // Looking up, the bow follows.
    h.update(DT, 'stand', 0, 1, 0, 0.5);
    h.root.updateMatrixWorld(true);
    const up = rig.localToWorld(new THREE.Vector3(...GUN_POINTS.bow.muzzle)).sub(rig.localToWorld(new THREE.Vector3(GUN_POINTS.bow.muzzle[0], GUN_POINTS.bow.muzzle[1], -0.3))).normalize();
    expect(up.y).toBeGreaterThan(0.35);
  });
});

// ------------------------------------------------------------------ in a real scene

function scene() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  for (const p of sc.players) p.exitVehicle(false);
  for (let i = 0; i < 18; i++) sc.tick(DT);
  sc.zombies.list.length = 0;
  sc.wildlife.list.length = 0;
  h.intents[0].device = 'pad';
  return { h, sc, p: sc.players[0] };
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

/** A bow on belt slot 3, in hand and up (the draw from the belt done). */
function bow(p: LegScene['players'][number]) {
  const it = newGear('w_bow');
  p.gear.belt[3] = it;
  p.gear.sel = 3;
  p.refreshGear();
  p.fireCd = 0;
  p.drawT = 0;
  return it;
}

describe('shooting a bow', () => {
  it('holding the trigger draws, letting go looses a full-draw arrow, and the next one goes on from the quiver', () => {
    const { h, sc, p } = scene();
    bow(p);
    sc.campaign.items.arrow = 5;
    const shoot = vi.spyOn(sc.combat, 'shoot');
    h.intents[0].rt = 1;
    run(sc, 0.4);
    expect(p.bowDraw).toBeGreaterThan(0.3);
    expect(p.bowDraw).toBeLessThan(1);
    expect(shoot).not.toHaveBeenCalled();
    run(sc, 0.5);
    expect(p.bowDraw).toBe(1);
    h.intents[0].rt = 0;
    run(sc, DT);
    expect(shoot).toHaveBeenCalledTimes(1);
    const o = shoot.mock.calls[0][6];
    expect(o).toMatchObject({ ammo: 'arrow', vel: 1 });
    expect(o.damage).toBeCloseTo(gearDef('w_bow').gun!.dmg, 5);
    expect(o.seen).toHaveLength(3);
    expect(p.mag).toBe(0);
    expect(p.bowDraw).toBe(0);
    // It is in the air as an arrow, not a tracer, and drawn as one.
    sc.renderFrame(1, DT);
    expect(sc.combat.bullets.some((b) => b.kind === 'arrow')).toBe(true);
    expect(sc.arrows.mesh.count).toBeGreaterThan(0);
    // The next arrow comes out of the quiver and onto the string.
    run(sc, 0.8);
    expect(p.mag).toBe(1);
    expect(sc.campaign.items.arrow).toBe(4);
  });

  it('a snatched half draw is a weaker, slower arrow; a tap only eases the string down', () => {
    const { h, sc, p } = scene();
    bow(p);
    sc.campaign.items.arrow = 5;
    const shoot = vi.spyOn(sc.combat, 'shoot');
    h.intents[0].rt = 1;
    run(sc, 0.05);
    h.intents[0].rt = 0;
    run(sc, 0.3);
    expect(shoot).not.toHaveBeenCalled();
    expect(p.mag).toBe(1);
    h.intents[0].rt = 1;
    run(sc, 0.35);
    h.intents[0].rt = 0;
    run(sc, DT);
    expect(shoot).toHaveBeenCalledTimes(1);
    const o = shoot.mock.calls[0][6];
    expect(o.vel!).toBeLessThan(0.8);
    expect(o.damage).toBeLessThan(gearDef('w_bow').gun!.dmg * 0.8);
  });

  it('with no arrows left there is nothing to draw', () => {
    const { h, sc, p } = scene();
    const it = bow(p);
    it.mag = 0;
    sc.campaign.items.arrow = 0;
    const shoot = vi.spyOn(sc.combat, 'shoot');
    h.intents[0].rt = 1;
    run(sc, 1);
    h.intents[0].rt = 0;
    run(sc, 0.2);
    expect(shoot).not.toHaveBeenCalled();
    expect(p.bowDraw).toBe(0);
  });

  it('a full draw held too long tires the arm and shakes the aim, and when the wind is gone the string comes down', () => {
    const { h, sc, p } = scene();
    bow(p);
    sc.campaign.items.arrow = 5;
    const shoot = vi.spyOn(sc.combat, 'shoot');
    h.intents[0].rt = 1;
    run(sc, 1 + ARCHERY.holdFree);
    const wind = p.stamina.value;
    run(sc, 1);
    expect(p.stamina.value).toBeLessThan(wind - 5);
    p.stamina.value = 0.5;
    run(sc, 0.5);
    expect(p.stamina.winded).toBe(true);
    expect(p.bowDraw).toBeLessThan(0.5);
    h.intents[0].rt = 0;
    run(sc, 0.1);
    expect(shoot).not.toHaveBeenCalled();
  });

  it('a full-draw arrow drops a walker, stays in it while it stands, and falls out where it goes down', () => {
    const { sc, p } = scene();
    const x = p.pos.x + 14;
    const z = p.pos.z + 4;
    const zb = sc.zombies.spawn('walker', x, z + 12, true);
    zb.yaw = 0;
    zb.y = sc.groundAt(x, z + 12);
    zb.hp = 500;
    vi.spyOn(sc.arrows as unknown as { roll: () => number }, 'roll').mockReturnValue(0.99);
    sc.combat.shoot(x, zb.y + 1.2, z, 0, 0, 1, { side: 'convoy', ammo: 'arrow', damage: 58, range: 160, headshots: false });
    run(sc, 0.4);
    expect(zb.hp).toBeLessThan(500);
    expect(sc.arrows.stuck).toHaveLength(1);
    const m = new THREE.Matrix4();
    const at = () => {
      sc.arrows.sync(sc.combat.bullets, 1);
      sc.arrows.mesh.getMatrixAt(0, m);
      return new THREE.Vector3().setFromMatrixPosition(m);
    };
    const a0 = at();
    expect(a0.distanceTo(new THREE.Vector3(zb.x, zb.y + 1.2, zb.z))).toBeLessThan(0.6);
    // It walks on with the arrow in it, and turns with it.
    zb.x += 2;
    const a1 = at();
    expect(a1.x - a0.x).toBeCloseTo(2, 3);
    zb.yaw = Math.PI;
    const a2 = at();
    expect(a2.z - zb.z).toBeCloseTo(-(a1.z - zb.z), 2);
    // Nobody can pull it out of a living body.
    p.pos.set(a2.x, zb.y, a2.z);
    const before = sc.campaign.items.arrow;
    sc.arrows.update(DT);
    expect(sc.campaign.items.arrow).toBe(before);
    // Down it goes, and the arrow lies on the ground beside it, where it can be picked up.
    p.pos.set(zb.x + 8, zb.y, zb.z);
    zb.dead = true;
    sc.arrows.update(DT);
    expect(sc.arrows.stuck[0].host).toBeNull();
    const lying = at();
    expect(lying.y).toBeLessThan(zb.y + 0.3);
    p.pos.set(lying.x, zb.y, lying.z);
    sc.arrows.update(DT);
    expect(sc.campaign.items.arrow).toBe(before + 1);
    expect(sc.arrows.stuck).toHaveLength(0);
    expect(sc.arrows.recovered).toBe(1);
  });

  it('an arrow shot into the ground sticks there at the angle it came down, and walking up to it pulls it out', () => {
    const { sc, p } = scene();
    vi.spyOn(sc.arrows as unknown as { roll: () => number }, 'roll').mockReturnValue(0.99);
    const x = p.pos.x + 12;
    const z = p.pos.z + 6;
    const y = sc.groundAt(x, z) + 1.4;
    sc.combat.shoot(x, y, z, 0, -0.35, 0.94, { side: 'convoy', ammo: 'arrow', damage: 58, range: 160 });
    run(sc, 1);
    expect(sc.arrows.stuck).toHaveLength(1);
    const s = sc.arrows.stuck[0];
    expect(s.host).toBeNull();
    expect(s.dy).toBeLessThan(-0.2);
    // The point is buried below the ground, the tail stands above it.
    expect(s.y).toBeLessThan(sc.groundAt(s.x, s.z) + 0.05);
    expect(s.y - s.dy * 0.74).toBeGreaterThan(sc.groundAt(s.x, s.z));
    // From across the way it stays; walk up to it and it comes out.
    const arrows = sc.campaign.items.arrow;
    p.pos.set(s.x + 5, p.pos.y, s.z);
    sc.arrows.update(DT);
    expect(sc.arrows.stuck).toHaveLength(1);
    p.pos.set(s.x, sc.groundAt(s.x, s.z), s.z - 0.3);
    sc.arrows.update(DT);
    expect(sc.arrows.stuck).toHaveLength(0);
    expect(sc.campaign.items.arrow).toBe(arrows + 1);
  });

  it('some arrows break when they land, and none is left behind then', () => {
    const { sc } = scene();
    vi.spyOn(sc.arrows as unknown as { roll: () => number }, 'roll').mockReturnValue(0.01);
    sc.arrows.landed('stone', 0, 0, 0, 0, 1, 0, 0, -1, 0, 1);
    expect(sc.arrows.stuck).toHaveLength(0);
    expect(sc.arrows.broken).toBe(1);
  });

  it('finding a bow brings a quiver of arrows with it', () => {
    const { sc, p } = scene();
    sc.campaign.items.arrow = 0;
    sc.addGear(p, newGear('w_bow'));
    expect(sc.campaign.items.arrow).toBe(ARCHERY.quiver);
    expect(p.gear.bag.some((g) => g.id === 'w_bow')).toBe(true);
  });

  it('the arrow stock is saved with the campaign, and an old save starts with none', () => {
    const { sc } = scene();
    sc.campaign.items.arrow = 7;
    const saved = JSON.parse(JSON.stringify(sc.campaign.serialize()));
    const C = sc.campaign.constructor as unknown as { deserialize: (d: unknown) => typeof sc.campaign };
    expect(C.deserialize(saved).items.arrow).toBe(7);
    delete saved.items.arrow;
    expect(C.deserialize(saved).items.arrow).toBe(0);
  });
});
