import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { GUN_MODELS, type GunModel } from '../src/data/gear';
import { LegScene } from '../src/game/legScene';
import { equipFromBag, newGear } from '../src/sim/gear';
import { Btn } from '../src/input/intents';
import { CHANS, offGrip, drillPose } from '../src/sim/gunDrills';
import { ACTS, CROSSBOW_STRING, CYLINDER, PARTS, PROPS, movePoint, propSpot } from '../src/sim/gunActions';
import { CYCLES, RELOADS, STAGE, TACTICAL_GUNS, byRound, propAt, type Reload } from '../src/sim/reloads';
import { TACTICAL, reloadPlan } from '../src/sim/weaponfx';
import { Humanoid, weaponRig } from '../src/render/humanoid';
import { REVOLVER, CANNON } from '../src/render/weapons/handguns';
import { identityOf } from '../src/render/outfit';
import { ViewModel } from '../src/render/viewmodel';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
const GUNS = GUN_MODELS.filter((m) => m !== 'bow');

/** Every routine there is: the reloads (and their stages) and the actions worked after a shot, with the gun they are for. */
const ALL: [GunModel, Reload][] = [];
for (const m of GUNS) {
  const s = RELOADS[m]!;
  for (const r of [s.tac, s.empty, s.byHand, s.open, s.each, s.close, s.closeEmpty]) if (r && !ALL.some(([, q]) => q === r)) ALL.push([m, r]);
  const c = CYCLES[m];
  if (c) ALL.push([m, c]);
}

describe('the routines', () => {
  it('every gun but the bow has its own reload, a magazine gun two (with rounds left, and run dry)', () => {
    for (const m of GUNS) {
      const s = RELOADS[m];
      expect(s, m).toBeDefined();
      expect(!!(s!.tac && s!.empty) || byRound(m), m).toBe(true);
    }
    for (const m of TACTICAL_GUNS) expect(RELOADS[m]!.tac, m).not.toBe(RELOADS[m]!.empty);
    // Rounds at a time: the pumps, the lever gun and the bolt rifle; every other gun takes its load at once.
    expect(GUNS.filter(byRound).sort()).toEqual(['combat', 'lever', 'pump', 'rifle']);
    // The actions worked by hand after a shot.
    expect(Object.keys(CYCLES).sort()).toEqual(['lever', 'pump', 'rifle', 'sniper']);
  });

  it('every routine has its keys in order and names only spots, parts and things that exist', () => {
    for (const [m, r] of ALL) {
      const tag = `${m} ${r.id}`;
      for (const c of CHANS) {
        const keys = r.gun[c];
        if (!keys) continue;
        expect(keys[0][0], `${tag} ${c}`).toBe(0);
        expect(keys[keys.length - 1][0], `${tag} ${c}`).toBe(1);
        for (let i = 1; i < keys.length; i++) expect(keys[i][0], `${tag} ${c} ${i}`).toBeGreaterThanOrEqual(keys[i - 1][0]);
      }
      for (const hand of [r.l, r.r]) {
        if (!hand) continue;
        expect(hand[0][0], tag).toBe(0);
        expect(hand[hand.length - 1][0], tag).toBe(1);
        for (let i = 1; i < hand.length; i++) expect(hand[i][0], `${tag} hand key ${i}`).toBeGreaterThanOrEqual(hand[i - 1][0]);
        for (const [, spot] of hand) if (spot !== 'grip') expect(r.spots?.[spot], `${tag} ${spot}`).toBeDefined();
      }
      for (const [a, keys] of Object.entries(r.act ?? {})) {
        expect(ACTS, tag).toContain(a);
        expect(keys![0][0], `${tag} ${a}`).toBe(0);
        expect(keys![keys!.length - 1][0], `${tag} ${a}`).toBe(1);
        for (let i = 1; i < keys!.length; i++) expect(keys![i][0], `${tag} ${a} ${i}`).toBeGreaterThanOrEqual(keys![i - 1][0]);
      }
      for (const [name, keys] of Object.entries(r.props ?? {})) {
        expect(PROPS[m]?.[name], `${tag} ${name}`).toBeDefined();
        for (let i = 1; i < keys.length; i++) expect(keys[i][0], `${tag} ${name} ${i}`).toBeGreaterThanOrEqual(keys[i - 1][0]);
        // What a hand carries, it carries from a spot: the hand holding it is off its grip.
        for (const [t, where] of keys) {
          if (where !== 'l' && where !== 'r') continue;
          const p = drillPose(r, Math.min(1, t + 0.002));
          const h = where === 'l' ? p.l : p.r;
          expect(h.from !== 'grip' || h.to !== 'grip', `${tag} ${name} in hand at ${t}`).toBe(true);
        }
      }
      for (const [at] of r.cues ?? []) expect(at > 0 && at < 1, tag).toBe(true);
    }
  });

  it('a reload taken in one go, and the last stage of one taken by the round, ends at rest with both hands on the gun', () => {
    for (const [m, r] of ALL) {
      if (r.id.endsWith('-open') || r.id.endsWith('-shell') || r.id.endsWith('-round')) continue;
      const p = drillPose(r, 1);
      const tag = `${m} ${r.id}`;
      for (const c of CHANS) expect(Math.abs(p[c]), `${tag} ${c}`).toBeLessThan(1e-9);
      expect(offGrip(r, p.l) + offGrip(r, p.r), tag).toBe(0);
      const p0 = drillPose(r, 0);
      if (!r.id.endsWith('-settle') && !r.id.endsWith('-chamber') && !r.id.endsWith('-close')) expect(offGrip(r, p0.l) + offGrip(r, p0.r), `${tag} start`).toBe(0);
    }
    // A stage taken by the round starts where the one before it ended, the gun held the same.
    for (const m of GUNS.filter(byRound)) {
      const s = RELOADS[m]!;
      const end = (r: Reload) => drillPose(r, 1);
      const start = (r: Reload) => drillPose(r, 0);
      for (const [a, b] of [[s.open!, s.each!], [s.each!, s.each!], [s.each!, s.close!], [s.each!, s.closeEmpty!]]) {
        const x = end(a);
        const y = start(b);
        for (const c of CHANS) expect(Math.abs(x[c] - y[c]), `${m} ${a.id} -> ${b.id} ${c}`).toBeLessThan(1e-6);
        expect(x.l.to, `${m} ${a.id} -> ${b.id} left`).toBe(y.l.from);
        expect(x.r.to, `${m} ${a.id} -> ${b.id} right`).toBe(y.r.from);
      }
    }
  });

  it('run dry, the gun is made ready: a slide let go, a catch slapped, a handle run back, a bolt worked', () => {
    const racked = (r: Reload) => (r.cues ?? []).some(([, c]) => c === 'rack');
    for (const m of TACTICAL_GUNS) {
      expect(racked(RELOADS[m]!.empty!), m).toBe(true);
      // With rounds in it, no: the old magazine is kept, and nothing is made ready.
      expect(racked(RELOADS[m]!.tac!), m).toBe(false);
      expect(RELOADS[m]!.tac!.props!.oldMag.some(([, w]) => w === 'drop'), m).toBe(false);
    }
    // A pistol run dry has its slide locked back from the start, and it goes home at the end.
    const e = RELOADS.pistol!.empty!;
    expect(e.act!.slide![0][1]).toBe(1);
    expect(e.act!.slide![e.act!.slide!.length - 1][1]).toBe(0);
    // The roller gun's handle is locked back before the magazine comes out.
    const hk = RELOADS.smg2!.empty!;
    const out = hk.props!.oldMag.find(([, w]) => w !== 'gun')![0];
    expect(hk.act!.notch!.find(([, v]) => v === 1)![0]).toBeLessThan(out);
  });

  it('the empty magazine falls (or is thrown) early, the full one is in and slapped home before the gun is made ready', () => {
    for (const m of TACTICAL_GUNS) {
      const r = RELOADS[m]!.empty!;
      const old = r.props!.oldMag;
      const drop = old.find(([, w]) => w === 'drop')![0];
      expect(drop, m).toBeLessThan(0.45);
      const nw = r.props!.newMag;
      const home = nw[nw.length - 1];
      expect(home[1], m).toBe('gun');
      expect(Math.hypot(...(home[2] ?? [0, 0, 0])), m).toBeLessThan(1e-9);
      const rack = r.cues!.filter(([, c]) => c === 'rack').map(([t]) => t);
      expect(Math.min(...rack), m).toBeGreaterThan(home[0] - 1e-9);
    }
  });

  it('a carried thing is where its keys say: in the gun shifted from its seat, in a hand, falling, away', () => {
    const keys = RELOADS.ar!.empty!.props!.newMag;
    expect(propAt(keys, 0).where).toBe('off');
    const inHand = keys.find(([, w]) => w === 'l')![0];
    expect(propAt(keys, inHand + 0.01).where).toBe('l');
    const last = keys[keys.length - 1];
    const a = propAt(keys, (keys[keys.length - 2][0] + last[0]) / 2);
    expect(a.where).toBe('gun');
    expect(Math.hypot(...a.off)).toBeGreaterThan(0);
    expect(Math.hypot(...propAt(keys, 1).off)).toBe(0);
  });

  it('the hands go to the pouch for the next magazine, shell or round, below the picture', () => {
    for (const [m, r] of ALL) {
      const pouched = Object.values(r.spots ?? {}).some((s) => 'cam' in s);
      const fetches = Object.values(r.props ?? {}).some((k) => k[0][1] === 'off' && k.some(([, w]) => w === 'l' || w === 'r'));
      if (fetches) expect(pouched, `${m} ${r.id}`).toBe(true);
      for (const s of Object.values(r.spots ?? {})) if ('cam' in s) expect(s.cam[1], `${m} ${r.id}`).toBeLessThan(-0.4);
    }
  });
});

describe('the parts and the props', () => {
  it('the close-up model has every moving part and every carried thing the routines need', () => {
    for (const m of GUNS) {
      const rig = weaponRig(m);
      for (const name of Object.keys(PARTS[m] ?? {})) expect(rig.parts[name], `${m} ${name}`).toBeDefined();
      for (const [name, def] of Object.entries(PROPS[m] ?? {})) expect(rig.parts[def.geo], `${m} ${name}`).toBeDefined();
    }
    // Built whole for everyone else, nothing is missing from the one mesh.
    expect(weaponRig('pistol').body.attributes.position.count).toBeGreaterThan(1000);
  });

  it('a slide runs straight back, a bolt turns up and comes back, a cylinder swings out to the left, barrels drop', () => {
    const sl: [number, number, number] = [0, 0.035, 0.03];
    const back = movePoint('pistol', 'slide', { slide: 1 }, sl);
    expect(back[2]).toBeLessThan(sl[2] - 0.025);
    expect(back[1]).toBeCloseTo(sl[1], 9);
    const knob: [number, number, number] = [-0.062, 0.002, 0.034];
    const up = movePoint('rifle', 'bolt', { boltUp: 1 }, knob);
    expect(up[1]).toBeGreaterThan(knob[1] + 0.04);
    expect(up[0]).toBeLessThan(0);
    const drawn = movePoint('rifle', 'bolt', { boltUp: 1, boltBack: 1 }, knob);
    expect(drawn[2]).toBeLessThan(up[2] - 0.07);
    const cy = movePoint('revolver', 'cyl', { swing: 1 }, [0, 0.0285, 0.076]);
    expect(cy[0]).toBeGreaterThan(0.02);
    // The extractor star rides on the cylinder and is pushed back along it.
    const star = movePoint('revolver', 'star', { swing: 1, eject: 1 }, [0, 0.0285, 0.056]);
    expect(star[0]).toBeCloseTo(movePoint('revolver', 'cyl', { swing: 1 }, [0, 0.0285, 0.056])[0], 6);
    expect(star[2]).toBeLessThan(0.04);
    const muzzle = movePoint('sawn', 'barrels', { open: 1 }, [0, 0.035, 0.335]);
    expect(muzzle[1]).toBeLessThan(-0.1);
  });

  it('the model and the rules agree on the revolver\'s cylinder and the crossbow\'s string', () => {
    for (const [d, m] of [[REVOLVER, 'revolver'], [CANNON, 'cannon']] as const) {
      expect(d.c0).toBe(CYLINDER[m].c0);
      expect(d.c1).toBe(CYLINDER[m].c1);
      expect(d.pitch).toBe(CYLINDER[m].pitch);
      expect(d.ch).toBe(CYLINDER[m].ch);
    }
    const g = weaponRig('crossbow').parts.string;
    g.computeBoundingBox();
    expect(g.boundingBox!.max.x).toBeCloseTo(CROSSBOW_STRING.tips[0][0], 2);
    expect(g.boundingBox!.max.z).toBeCloseTo(CROSSBOW_STRING.tips[0][2], 2);
    expect(g.boundingBox!.min.z).toBeLessThan(CROSSBOW_STRING.cocked[2] + 0.01);
  });

  it('a prop held at its own spot sits in its seat: what the hand brings is where the gun takes it', () => {
    for (const m of GUNS) {
      for (const [name, def] of Object.entries(PROPS[m] ?? {})) {
        const h = propSpot(m, name, [0, 0, 0]);
        expect(h.p, `${m} ${name}`).toEqual(def.on ? movePoint(m, def.on, {}, def.hold.p) : def.hold.p);
      }
    }
  });
});

describe('the first-person arms play the routines', () => {
  type Rig = { upperR: THREE.Mesh; upperL: THREE.Mesh; foreR: THREE.Mesh; foreL: THREE.Mesh; handR: THREE.Mesh; handL: THREE.Mesh; gun: THREE.Group; props: { name: string; mesh: THREE.Mesh; state: string }[] };
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
  const posed = (m: GunModel, r: Reload, t: number, empty = false, vm = new ViewModel(identityOf(0)), h = new Humanoid(identityOf(0))) => {
    h.setWeapon(m);
    h.reload = { r, t, w: 1 };
    h.gunEmpty = empty;
    (vm as unknown as { t: number }).t = 0;
    vm.pose(DT, h);
    const c = cam();
    vm.place(c);
    return { vm, cam: c, h };
  };

  it('through every routine of every gun the arms hold together, and a hand in the picture stays clear of the lens', () => {
    for (const [m, r] of ALL) {
      for (let t = 0; t <= 1.0001; t += 0.04) {
        const { vm, cam: c } = posed(m, r, t);
        const g = rig(vm);
        const tag = `${m} ${r.id} at ${t.toFixed(2)}`;
        for (const [upper, fore, hand] of [
          [g.upperR, g.foreR, g.handR],
          [g.upperL, g.foreL, g.handL],
        ] as const) {
          expect(down(upper, 0.27).distanceTo(world(fore)), tag).toBeLessThan(0.003);
          expect(down(fore, 0.27).distanceTo(world(hand, new THREE.Vector3(0, 0.06, -0.036))), tag).toBeLessThan(0.003);
          const p = c.worldToLocal(world(hand));
          expect(Number.isFinite(p.x + p.y + p.z), tag).toBe(true);
          // Past the near plane (0.2 m) with the knuckles, or down at the belt below the bottom of the picture.
          expect(p.z < -0.19 || p.y < 0.65 * p.z - 0.06, `${tag} hand at ${p.toArray().map((v) => v.toFixed(3))}`).toBe(true);
        }
      }
    }
  });

  it('what a hand brings to the gun goes in without a jump, and the gun keeps it', () => {
    for (const [m, r] of ALL) {
      for (const [name, keys] of Object.entries(r.props ?? {})) {
        for (let i = 1; i < keys.length; i++) {
          const [t, where] = keys[i];
          const was = keys[i - 1][1];
          if (where !== 'gun' || (was !== 'l' && was !== 'r')) continue;
          const at = (tt: number) => {
            const { vm } = posed(m, r, tt);
            const pr = rig(vm).props.find((q) => q.name === name)!;
            const bb = new THREE.Box3().setFromObject(pr.mesh);
            return { c: bb.getCenter(new THREE.Vector3()), state: pr.state };
          };
          const a = at(t - 0.0005);
          const b = at(t + 0.0005);
          const tag = `${m} ${r.id} ${name} at ${t}`;
          expect(a.state, tag).toBe(was);
          expect(b.state, tag).toBe('gun');
          expect(a.c.distanceTo(b.c), tag).toBeLessThan(0.012);
        }
      }
    }
  });

  it('a pistol run dry shows its slide locked back, and a shot crossbow its string down and no bolt', () => {
    const slideZ = (empty: boolean) => {
      const h = new Humanoid(identityOf(0));
      h.setWeapon('pistol');
      h.gunEmpty = empty;
      const vm = new ViewModel(identityOf(0));
      vm.pose(DT, h);
      return vm.act.slide;
    };
    expect(slideZ(true)).toBe(1);
    expect(slideZ(false)).toBe(0);
    // A shot blows the slide back for its moment.
    const hs = new Humanoid(identityOf(0));
    hs.setWeapon('pistol');
    hs.muzzle(1);
    const vs = new ViewModel(identityOf(0));
    vs.pose(DT, hs);
    expect(vs.act.slide).toBeGreaterThan(0.9);
    const h = new Humanoid(identityOf(0));
    h.setWeapon('crossbow');
    h.gunEmpty = true;
    const vm = new ViewModel(identityOf(0));
    vm.pose(DT, h);
    expect(vm.act.cock).toBe(0);
    expect(rig(vm).props.find((p) => p.name === 'quarrel')!.mesh.visible).toBe(false);
  });

  it('an empty magazine let go falls out of the picture and is handed to the world', () => {
    const r = RELOADS.pistol!.empty!;
    const drop = r.props!.oldMag.find(([, w]) => w === 'drop')![0];
    const vm = new ViewModel(identityOf(0));
    const h = new Humanoid(identityOf(0));
    h.setWeapon('pistol');
    h.gunEmpty = true;
    const c = cam();
    const secs = 1.3;
    let fell = 0;
    let seen = false;
    for (let t = 0; t < drop + 0.5 / secs; t += DT / secs) {
      h.reload = { r, t, w: 1 };
      vm.pose(DT, h);
      vm.place(c);
      const old = rig(vm).props.find((p) => p.name === 'oldMag')!;
      if (t > drop && old.mesh.visible) seen = true;
      fell += vm.takeFallen().length;
    }
    // Seen falling, then handed over once.
    expect(seen).toBe(true);
    expect(fell).toBe(1);
  });
});

describe('reload times', () => {
  it('a magazine gun with rounds left reloads quicker; one loaded by the round takes a full load in about its reload time', () => {
    for (const m of TACTICAL_GUNS) expect(reloadPlan(m, 2, 30, 4).first, m).toBeCloseTo(2 * TACTICAL, 9);
    for (const m of ['revolver', 'sawn', 'crossbow'] as const) expect(reloadPlan(m, 2, 6, 2).first, m).toBe(2);
    for (const m of GUNS.filter(byRound)) {
      const p = reloadPlan(m, 3, 6, 0);
      expect(p.first + 6 * p.each + p.close, m).toBeCloseTo(3 * (1 + STAGE.closeEmpty - STAGE.close), 9);
      expect(reloadPlan(m, 3, 6, 2).close, m).toBeCloseTo(3 * STAGE.close, 9);
    }
  });
});

describe('in a real scene', () => {
  function leg(gunId?: string) {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    for (const p of sc.players) p.exitVehicle(false);
    run(sc, 0.6);
    const p = sc.players[0];
    if (gunId) equip(p, gunId);
    return { sc, p, ...h };
  }
  function equip(p: LegScene['players'][number], id: string) {
    const item = newGear(id);
    p.gear.bag.push(item);
    equipFromBag(p.gear, item.uid);
    p.gear.sel = p.gear.belt.findIndex((b) => b?.uid === item.uid);
    p.refreshGear();
  }
  type P = { mag: number; reloadT: number; human: Humanoid; gun(): { mag: number } };

  it('every gun reloads from dry and from part-full with its own routine, and ends up full', () => {
    const h = leg();
    const p = h.p as unknown as P;
    h.campaign.ammo = 999;
    for (const id of ['w_pistol', 'w_revolver', 'w_smg', 'w_sawn', 'w_pump', 'w_rifle', 'w_smg2', 'w_carbine', 'w_ar', 'w_sniper', 'w_lever', 'w_crossbow', 'w_coach', 'w_lmg', 'w_combat']) {
      for (const start of [0, 1]) {
        equip(h.p, id);
        if (start >= p.gun().mag) continue;
        run(h.sc, 0.8, () => h.sc.renderFrame(1, DT));
        p.mag = start;
        const it = h.intents[0];
        const ids = new Set<string>();
        let t = 0;
        // X reloads: press it once.
        it.device = 'keyboard';
        it.pressed = 1 << Btn.X;
        it.held = 1 << Btn.X;
        h.sc.tick(DT);
        it.pressed = 0;
        it.held = 0;
        while (p.reloadT > 0 && t < 12) {
          h.sc.tick(DT);
          h.sc.renderFrame(1, DT);
          if (p.human.reload.r) ids.add(p.human.reload.r.id);
          t += DT;
        }
        const tag = `${id} from ${start}`;
        expect(p.reloadT, tag).toBeLessThanOrEqual(0);
        expect(p.mag, tag).toBe(p.gun().mag);
        expect(ids.size, tag).toBeGreaterThan(0);
        for (const rid of ids) expect(rid.startsWith(`${id.slice(2)}-`), `${tag} ${rid}`).toBe(true);
      }
    }
    h.sc.dispose();
  }, 180000);
});
