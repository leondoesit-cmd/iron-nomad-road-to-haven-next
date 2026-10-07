import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { GUN_MODELS, type GunModel } from '../src/data/gear';
import { LegScene } from '../src/game/legScene';
import { equipFromBag, heldItem, newGear } from '../src/sim/gear';
import { CHANS, FAULTS, HABIT, HABITS, drillPose, offGrip, pickFault, pickHabit, type Drill } from '../src/sim/gunDrills';
import { jamChance } from '../src/sim/vitals';
import { Humanoid } from '../src/render/humanoid';
import { identityOf } from '../src/render/outfit';
import { ViewModel } from '../src/render/viewmodel';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
const MELEE = ['knife', 'bat', 'machete', 'axe', 'pipe', 'sledge', 'katana', 'wrench', 'crowbar', 'flare', 'jerrycan'] as const;

/** Every drill there is, with the weapon it is for. */
const ALL: [string, Drill][] = [
  ...Object.entries(HABITS).flatMap(([m, list]) => list.map((d) => [m, d] as [string, Drill])),
  ...Object.entries(FAULTS).flatMap(([m, list]) => list.map((f) => [m, f.drill] as [string, Drill])),
];

describe('the drills', () => {
  it('every weapon has habits, and every gun but the bow a misfire and its own way of clearing it', () => {
    for (const m of [...GUN_MODELS, ...MELEE]) expect(HABITS[m].length, m).toBeGreaterThanOrEqual(2);
    for (const m of GUN_MODELS) {
      if (m === 'bow') {
        expect(FAULTS.bow).toEqual([]);
        continue;
      }
      expect(FAULTS[m][0].kind, m).toBe('misfire');
      expect(FAULTS[m][0].note.length, m).toBeGreaterThan(4);
    }
    // The actions clear differently: a pistol taps and racks, a revolver turns to the next chamber, a pump is run again,
    // a break-action is opened, a bolt gun has its bolt worked, a lever gun its lever.
    const first = (m: GunModel) => FAULTS[m][0].drill.id;
    expect(new Set(['pistol', 'revolver', 'pump', 'sawn', 'rifle', 'lever', 'smg2', 'carbine', 'lmg', 'crossbow'].map((m) => first(m as GunModel))).size).toBe(10);
  });

  it('every drill starts and ends at rest with both hands on their grips, its keys in order', () => {
    for (const [m, d] of ALL) {
      const tag = `${m} ${d.id}`;
      expect(d.secs, tag).toBeGreaterThan(0.4);
      expect(d.secs, tag).toBeLessThan(3.2);
      for (const c of CHANS) {
        const keys = d.gun[c];
        if (!keys) continue;
        expect(keys[0][0], `${tag} ${c}`).toBe(0);
        expect(keys[keys.length - 1][0], `${tag} ${c}`).toBe(1);
        for (let i = 1; i < keys.length; i++) expect(keys[i][0], `${tag} ${c}`).toBeGreaterThanOrEqual(keys[i - 1][0]);
      }
      for (const hand of [d.l, d.r]) {
        if (!hand) continue;
        expect(hand[0], tag).toEqual([0, 'grip']);
        expect(hand[hand.length - 1], tag).toEqual([1, 'grip']);
        for (let i = 1; i < hand.length; i++) expect(hand[i][0], tag).toBeGreaterThanOrEqual(hand[i - 1][0]);
        for (const [, spot] of hand) if (spot !== 'grip') expect(d.spots?.[spot], `${tag} ${spot}`).toBeDefined();
      }
      for (const t of [0, 1]) {
        const p = drillPose(d, t);
        for (const c of CHANS) {
          // A full turn in the fingers is back where it started.
          const v = c === 'spin' ? Math.sin(p[c] / 2) : p[c];
          expect(Math.abs(v), `${tag} ${c} at ${t}`).toBeLessThan(1e-9);
        }
        expect(offGrip(d, p.l) + offGrip(d, p.r), `${tag} hands at ${t}`).toBe(0);
        expect(p.l.open + p.r.open, `${tag} fingers at ${t}`).toBe(0);
      }
      for (const [at] of d.cues ?? []) expect(at > 0 && at < 1, tag).toBe(true);
      for (const at of d.eject ?? []) expect(at > 0 && at < 1, tag).toBe(true);
    }
  });

  it('halfway through, something is happening', () => {
    for (const [m, d] of ALL) {
      let most = 0;
      for (let t = 0.05; t < 1; t += 0.05) {
        const p = drillPose(d, t);
        const move = Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z) + 0.1 * (Math.abs(p.rx) + Math.abs(p.ry) + Math.abs(p.rz) + Math.abs(p.spin));
        most = Math.max(most, move + 0.05 * (offGrip(d, p.l) + offGrip(d, p.r) + p.l.open + p.r.open));
      }
      expect(most, `${m} ${d.id}`).toBeGreaterThan(0.01);
    }
  });

  it('a sound gun mostly throws a dud, a worn-out one jams for real; a crossbow keeps its bolt', () => {
    let sound = 0;
    let worn = 0;
    for (let i = 0; i < 100; i++) {
      const r = (i + 0.5) / 100;
      if (pickFault('pistol', 1, r, 0.5)!.kind === 'jam') sound++;
      if (pickFault('pistol', 0.1, r, 0.5)!.kind === 'jam') worn++;
    }
    expect(sound).toBeLessThan(20);
    expect(worn).toBeGreaterThan(50);
    // Which jam, from the second roll.
    expect(pickFault('pistol', 0.1, 0.99, 0)!.drill.id).toBe('stovepipe');
    expect(pickFault('pistol', 0.1, 0.99, 0.99)!.drill.id).toBe('double-feed');
    // A gun with no jam of its own only ever misfires.
    expect(pickFault('sawn', 0, 0.99, 0.99)!.kind).toBe('misfire');
    expect(pickFault('bow', 0, 0.5, 0.5)).toBeNull();
    expect(FAULTS.crossbow[0].cost).toBe(0);
    expect(FAULTS.pistol[0].cost).toBe(1);
  });

  it('habits take turns', () => {
    const a = pickHabit('pistol', 0)!;
    const b = pickHabit('pistol', 0, a.id)!;
    expect(b.id).not.toBe(a.id);
    expect(pickHabit('none', 0.5)).toBeNull();
  });

  it('a gun in fine fettle still throws a dud now and then', () => {
    expect(jamChance(undefined)).toBeGreaterThan(0);
  });
});

describe('the first-person arms play the drills', () => {
  type Rig = { upperR: THREE.Mesh; upperL: THREE.Mesh; foreR: THREE.Mesh; foreL: THREE.Mesh; handR: THREE.Mesh; handL: THREE.Mesh; gun: THREE.Group };
  const rig = (vm: ViewModel) => vm as unknown as Rig;
  const world = (m: THREE.Object3D, p = new THREE.Vector3()) => m.localToWorld(p.clone());
  const down = (m: THREE.Object3D, len: number) => world(m, new THREE.Vector3(0, -len, 0));

  const cam = () => {
    const c = new THREE.PerspectiveCamera(66, 1.78, 0.1, 100);
    c.position.set(0, 1.62, 0);
    c.lookAt(0, 1.62, 10);
    c.updateMatrixWorld();
    return c;
  };

  const posedIn = (m: string, d: Drill, t: number) => {
    const h = new Humanoid(identityOf(0));
    h.setWeapon(m as Parameters<Humanoid['setWeapon']>[0]);
    h.drill = { r: d, t, w: 1 };
    const vm = new ViewModel(identityOf(0));
    (vm as unknown as { t: number }).t = 0;
    vm.pose(DT, h);
    const c = cam();
    vm.place(c);
    return { vm, cam: c, h };
  };

  it('through every drill of every weapon the arms hold together and the hands stay clear of the lens', () => {
    for (const [m, d] of ALL) {
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const { vm, cam: c } = posedIn(m, d, t);
        const r = rig(vm);
        const tag = `${m} ${d.id} at ${t.toFixed(2)}`;
        for (const [upper, fore, hand] of [
          [r.upperR, r.foreR, r.handR],
          [r.upperL, r.foreL, r.handL],
        ] as const) {
          expect(down(upper, 0.27).distanceTo(world(fore)), tag).toBeLessThan(0.003);
          expect(down(fore, 0.27).distanceTo(world(hand, new THREE.Vector3(0, 0.06, -0.036))), tag).toBeLessThan(0.003);
          const p = hand.position;
          expect(Number.isFinite(p.x + p.y + p.z), tag).toBe(true);
          // In front of the eye, past the near plane (0.2 m) with the knuckles.
          expect(c.worldToLocal(world(hand)).z, tag).toBeLessThan(-0.19);
        }
      }
    }
  });

  it('a hand at a spot is on that spot: the palm under the magazine for a tap, on the slide to rack it', () => {
    const d = FAULTS.pistol[0].drill;
    const at = (name: string) => d.l!.find(([, s]) => s === name)![0];
    for (const [name, gap] of [
      ['hit', 0.012],
      ['grab', 0.012],
    ] as const) {
      const { vm } = posedIn('pistol', d, at(name));
      const r = rig(vm);
      const spot = d.spots![name] as { p: [number, number, number] };
      const want = r.gun.localToWorld(new THREE.Vector3(...spot.p));
      expect(world(r.handL).distanceTo(want), name).toBeLessThan(gap);
    }
    // The palm slapping the magazine is open; racking, the hand is closed round the slide.
    const geo = (t: number) => rig(posedIn('pistol', d, t).vm).handL.geometry;
    const rest = geo(0);
    expect(geo(at('hit'))).not.toBe(rest);
    expect(geo(at('grab'))).not.toBe(geo(at('hit')));
  });

  it('a knife rolled in the fingers turns the blade, not the hand', () => {
    const roll = HABITS.knife.find((d) => d.id === 'knife-roll')!;
    const a = posedIn('knife', roll, 0.2);
    const b = posedIn('knife', roll, 0.45);
    // The hand barely moves while the blade turns about the handle.
    expect(world(rig(a.vm).handR).distanceTo(world(rig(b.vm).handR))).toBeLessThan(0.01);
    const tip = (x: typeof a) => x.vm.weaponMesh!.localToWorld(new THREE.Vector3(0, 0.03, 0.25));
    expect(tip(a).distanceTo(tip(b))).toBeGreaterThan(0.02);
  });

  it('a drill fading out (the hands needed) eases the arms back to rest', () => {
    const d = HABITS.pistol[0];
    const h = new Humanoid(identityOf(0));
    h.setWeapon('pistol');
    const vm = new ViewModel(identityOf(0));
    (vm as unknown as { t: number }).t = 0;
    const handAt = (w: number) => {
      h.drill = { r: w > 0 ? d : null, t: 0.4, w };
      vm.pose(DT, h);
      vm.place(cam());
      return world(rig(vm).handL);
    };
    const rest = handAt(0);
    const full = handAt(1).distanceTo(rest);
    const half = handAt(0.5).distanceTo(rest);
    expect(full).toBeGreaterThan(0.02);
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(0);
  });

  it('a partner sees the support arm leave the gun as the jam is cleared', () => {
    const h = new Humanoid(identityOf(0));
    h.setWeapon('pistol');
    const d = FAULTS.pistol[0].drill;
    h.update(DT, 'stand', 0, 1, 0, 0);
    const restL = h.armL.rotation.x;
    h.drill = { r: d, t: 0.24, w: 1 };
    h.update(DT, 'stand', 0, 1, 0, 0);
    expect(Math.abs(h.armL.rotation.x - restL)).toBeGreaterThan(0.05);
  });
});

describe('in a real scene', () => {
  function leg(gunId = 'w_pistol') {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    for (const p of sc.players) p.exitVehicle(false);
    run(sc, 0.6);
    const p = sc.players[0];
    if (gunId !== 'w_pistol') equip(p, gunId);
    return { sc, p, ...h };
  }
  /** Put a weapon in the player's hands. */
  function equip(p: LegScene['players'][number], id: string) {
    const item = newGear(id);
    p.gear.bag.push(item);
    equipFromBag(p.gear, item.uid);
    p.gear.sel = p.gear.belt.findIndex((b) => b?.uid === item.uid);
    p.refreshGear();
  }
  type P = { mag: number; reloadT: number; notes: { text: string }[]; human: Humanoid; habitIn: number; gun(): { mag: number } };

  it('a worn-out gun fails, the drill clears it without filling the magazine, and the next pull fires', () => {
    const h = leg();
    const p = h.p as unknown as P;
    const gun = heldItem(h.p.gear)!;
    gun.cond = 0;
    h.campaign.ammo = 0;
    const it = h.intents[0];
    let faults = 0;
    let seenDrill = false;
    let lastNotes = 0;
    let rose = false;
    let prevMag = p.mag;
    it.rt = 1;
    run(h.sc, 12, () => {
      if (p.notes.length !== lastNotes) {
        lastNotes = p.notes.length;
        if (p.notes.some((n) => /Jammed|Misfire/.test(n.text))) faults++;
      }
      h.sc.renderFrame(1, DT);
      if (p.human.drill.r && p.reloadT > 0) seenDrill = true;
      // With no ammo to load, clearing a fault never puts a round back.
      if (p.mag > prevMag) rose = true;
      prevMag = p.mag;
    });
    it.rt = 0;
    expect(faults).toBeGreaterThan(0);
    expect(seenDrill).toBe(true);
    expect(rose).toBe(false);
    h.sc.dispose();
  }, 60000);

  it('at rest the hands find something to do, and let it go the moment the trigger is pulled', () => {
    const h = leg();
    const p = h.p as unknown as P;
    const it = h.intents[0];
    p.habitIn = 0;
    let started = false;
    run(h.sc, HABIT.settle + 0.6, () => {
      h.sc.renderFrame(1, DT);
      if (p.human.drill.r) started = true;
    });
    expect(started).toBe(true);
    expect(p.human.drill.w).toBeGreaterThan(0.5);
    // A shot: the habit fades out within a few frames and stays gone while there is shooting.
    it.rt = 1;
    run(h.sc, 0.3, () => h.sc.renderFrame(1, DT));
    expect(p.human.drill.r === null || p.human.drill.w < 0.05).toBe(true);
    it.rt = 0;
    h.sc.dispose();
  }, 60000);

  it('every gun can play its habits and clear its faults in the scene without a hitch', () => {
    const h = leg();
    const p = h.p as unknown as P & { gunModel(): GunModel; startFault(g: unknown): boolean; gun(): unknown };
    for (const id of ['w_revolver', 'w_pump', 'w_sawn', 'w_rifle', 'w_lever', 'w_ar', 'w_lmg', 'w_crossbow']) {
      equip(h.p, id);
      run(h.sc, 0.5, () => h.sc.renderFrame(1, DT));
      p.mag = 3;
      expect(p.startFault(p.gun()), id).toBe(true);
      expect(p.reloadT, id).toBeGreaterThan(0);
      run(h.sc, 3.5, () => h.sc.renderFrame(1, DT));
      expect(p.reloadT, id).toBeLessThanOrEqual(0);
      expect(p.mag, id).toBeLessThanOrEqual(3);
    }
    h.sc.dispose();
  }, 90000);
});
