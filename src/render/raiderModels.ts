import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { partMeta, partTag } from './bodyParts';
import { C } from './palette';
import { Humanoid } from './humanoid';
import type { VehicleDef } from '../data';
import { exhaust, heavyGun, plate, rivets, shock, signPlate, spareTyre, strap } from './parts';
import { acquireShell, releaseShell, type Shell } from './shellCache';
import { addWheelSet, blank, bodyMat, headlamp, lightMat, lightOffMat, taillight, type VehicleVisual, type WheelStyle } from './vehicleKit';
import { drawMark, rnd } from './carTrimKit';

/**
 * Raider cars, each one welded together by somebody different: the dune buggy and the battle-wagon keep their frame, cab,
 * seats and gun where the crew and the hit zones expect them (see game/raiders.ts), and everything hung on that frame is
 * rolled from the vehicle's own seed: the war paint, scrap plates and road signs welded over the cage, the spikes, the
 * ram, the cage over the driver, the stacks, the banner and its mark, sand paddles on the back wheels. Shells are cached
 * by the variant, so a war party of six shares a few.
 */

/** What one raider car has hung on it. */
export interface RaiderLook {
  paint: number;
  trim: number;
  nose: 'teeth' | 'jaw' | 'ram' | 'skull';
  plates: number;
  spikes: number;
  cage: boolean;
  flag: 'pennant' | 'banner' | 'bones' | 'whip';
  flagColor: number;
  stacks: number;
  paddles: boolean;
  lights: boolean;
  mark: number;
}

const PAINTS = [C.raiderRed, 0x2a2622, 0xc8b8a0, 0x8a4b2d, 0x5a5a3a, 0x3a3f48];
const FLAGS = [C.raiderFlag, 0x1a1a1a, 0xd8d0b8, 0xb8321e];

/** The look of a raider car from its seed. */
export function raiderLook(seed: number): RaiderLook {
  const r = rnd((seed ^ 0x5eed5a1d) >>> 0);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length) % a.length];
  return {
    paint: pick(PAINTS),
    trim: pick([0x1a1a1a, 0xe2dccb, C.raiderRed, 0xe0be1a]),
    nose: pick(['teeth', 'jaw', 'ram', 'skull'] as const),
    plates: Math.floor(r() * 4),
    spikes: 3 + Math.floor(r() * 5),
    cage: r() < 0.5,
    flag: pick(['pennant', 'banner', 'bones', 'whip'] as const),
    flagColor: pick(FLAGS),
    stacks: 1 + Math.floor(r() * 2),
    paddles: r() < 0.35,
    lights: r() < 0.4,
    mark: Math.floor(r() * 6),
  };
}

const lookKey = (l: RaiderLook) => [l.paint.toString(16), l.trim.toString(16), l.nose, l.plates, l.spikes, l.cage ? 'c' : '', l.flag, l.flagColor.toString(16), l.stacks, l.paddles ? 'p' : '', l.lights ? 'l' : '', l.mark].join('.');

type Rec = { lamps: Shell['lamps']; tails: Shell['tails'] };
const lamp = (rec: Rec, b: MeshBuilder, x: number, y: number, z: number, r: number) => {
  rec.lamps.push({ x, y, z, r, bucket: true });
  b.frustum(x, y, z - r * 0.45, r * 1.12, r * 0.7, r * 0.9, S.chrome(0xc8ccd0), Math.PI / 2, 0, 0, 16);
  b.torus(x, y, z, r * 1.08, r * 0.1, S.chrome(), 0, 0, 0, 6, 20);
};

/** A flag on a pole from (x, y, z) up `h`: a pennant, a banner with the gang's mark, crossed bones, or a whip of streamers. */
function flag(b: MeshBuilder, l: RaiderLook, x: number, y: number, z: number, h: number, w: number) {
  const pole = S.metal(0x2a2a2a);
  b.rod(x, y, z, x, y + h, z - 0.05, 0.018, pole, 6);
  const top = y + h - 0.02;
  const cloth = S.cloth(l.flagColor, 0.6);
  if (l.flag === 'whip') {
    for (let i = 0; i < 4; i++) b.rod(x, top - i * 0.08, z - 0.05, x + 0.25 + i * 0.05, top - 0.35 - i * 0.12, z - 0.2, 0.012, S.cloth(i % 2 ? l.flagColor : 0xe0be1a, 0.6), 4);
    return;
  }
  if (l.flag === 'bones') {
    b.add('sphere16', x, top + 0.08, z - 0.05, 0.16, 0.18, 0.14, S.paint(0xe2dccb, 0.6));
    for (const s of [1, -1]) b.rod(x - 0.18, top - 0.12, z - 0.05 + s * 0.02, x + 0.18, top + 0.02, z - 0.05 - s * 0.02, 0.018, S.paint(0xe2dccb, 0.6), 6);
    return;
  }
  const key = l.flag === 'banner' ? 'raiderBanner' : 'raiderFlag';
  b.extrude(
    `${key}:${w.toFixed(2)}`,
    () => {
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      if (l.flag === 'banner') {
        s.lineTo(w, 0);
        s.lineTo(w, -w * 0.8);
        s.lineTo(w * 0.5, -w * 0.62);
        s.lineTo(0, -w * 0.8);
      } else {
        s.lineTo(w, -w * 0.15);
        s.lineTo(w * 0.82, -w * 0.36);
        s.lineTo(w * 1.04, -w * 0.62);
        s.lineTo(0, -w * 0.72);
      }
      s.closePath();
      return s;
    },
    0.015,
    0,
    x,
    top,
    z - 0.05,
    cloth,
    0,
    -0.15,
    0,
  );
  if (l.flag === 'banner') {
    // The gang's mark painted on both faces.
    const c = Math.cos(-0.15);
    const sn = Math.sin(-0.15);
    for (const f of [1, -1]) {
      const n = new THREE.Vector3(sn * f, 0, c * f);
      const o = new THREE.Vector3(x + c * w * 0.5, top - w * 0.38, z - 0.05).addScaledVector(n, 0.012);
      drawMark(b, { o, right: new THREE.Vector3(c * f, 0, -sn * f), up: new THREE.Vector3(0, 1, 0) }, l.mark, w * 0.5, S.paint(l.flagColor === 0x1a1a1a ? 0xe2dccb : 0x1a1a1a, 0.6));
    }
  }
}

// ---------------------------------------------------------------- dune buggy

function raiderBuggyShell(def: VehicleDef, wheelLocal: [number, number, number][], l: RaiderLook, seed: number): Shell {
  const rec: Rec = { lamps: [], tails: [] };
  const b = new MeshBuilder();
  b.jitter = 0.04;
  b.roundSeg = 2;
  b.seed(44 + seed);
  const r = rnd(seed + 3);
  const paint = S.paint(l.paint, 0.8);
  const black = S.paint(0x1a1a1a, 0.6);
  const tube = S.paint(0x3a2a22, 0.8);
  const trim = S.paint(l.trim, 0.7);
  const steelS = S.steel(0x8a8e92, 0.55);
  const wy = wheelLocal[0][1] - def.physics.suspension.rest;
  const wx = Math.abs(wheelLocal[0][0]);
  const fz = wheelLocal[0][2];
  const rz = wheelLocal[2][2];
  // Pan and nose cone.
  b.box(0, -0.25, 0, 1.0, 0.06, 2.4, S.steel(0x3a3c3e, 0.8));
  b.extrude('raiderNose', () => {
    const s = new THREE.Shape();
    s.moveTo(-0.55, -0.15);
    s.lineTo(0.55, -0.15);
    s.lineTo(0.4, 0.22);
    s.lineTo(-0.4, 0.22);
    s.closePath();
    return s;
  }, 1.0, 0.03, 0, -0.05, 0.95, paint, 0, 0, 0);
  b.rbox(0, 0.18, 0.95, 0.82, 0.04, 0.95, 0.015, black);
  // The nose: painted teeth, a welded jaw of blades, a scrap ram plate, or a skull bolted on.
  if (l.nose === 'teeth') {
    for (let i = 0; i < 6; i++) b.add('cone6', -0.3 + i * 0.12, -0.02, 1.46, 0.06, 0.12, 0.02, S.paint(0xe8e2d0, 0.7), Math.PI, 0, 0);
  } else if (l.nose === 'jaw') {
    for (let i = 0; i < 7; i++) b.add('cone6', -0.36 + i * 0.12, 0.05 + (i % 2) * 0.04, 1.5, 0.05, 0.22, 0.05, steelS, Math.PI / 2 + 0.2, 0, 0);
    b.box(0, -0.06, 1.47, 0.86, 0.05, 0.06, S.steel(0x3a3c3e));
  } else if (l.nose === 'ram') {
    plate(b, 0, 0.02, 1.52, 1.1, 0.36, 0.035, S.rust(0x6a3a22), -0.35, 0, 0);
  } else {
    b.add('sphere16', 0, 0.12, 1.45, 0.26, 0.24, 0.2, S.paint(0xe2dccb, 0.6));
    for (const sx of [1, -1]) b.cyl(sx * 0.06, 0.15, 1.54, 0.06, 0.02, 0.06, S.paint(0x101010, 0.5), Math.PI / 2, 0, 0, 8);
    b.box(0, 0.03, 1.52, 0.14, 0.05, 0.04, S.paint(0xe2dccb, 0.6));
  }
  // War paint: a stripe down the nose in the trim colour.
  b.box(0, 0.205, 0.95, 0.16, 0.006, 0.9, trim);
  // Tube frame and roll cage.
  for (const sx of [1, -1]) {
    b.pipe([[sx * 0.5, -0.22, 1.4], [sx * 0.55, 0.15, 0.55], [sx * 0.6, 1.15, 0.2], [sx * 0.6, 1.15, -0.55], [sx * 0.55, -0.2, -0.9]], 0.035, tube, 8);
    b.rod(sx * 0.55, 0.15, 0.55, sx * 0.55, 0.2, -0.85, 0.03, tube, 8);
    for (const wz of [fz, rz]) shock(b, [sx * (wx - 0.12), wy + 0.04, wz], [sx * 0.5, 0.2, wz + (wz > 0 ? -0.1 : 0.1)], 0x2a2a2a, 0.05);
  }
  b.rod(0.6, 1.15, 0.2, -0.6, 1.15, 0.2, 0.035, tube, 8);
  b.rod(0.6, 1.15, -0.55, -0.6, 1.15, -0.55, 0.035, tube, 8);
  b.rod(0.6, 1.15, -0.55, -0.6, 1.15, 0.2, 0.03, tube, 8);
  // Scrap welded over the cage sides: road signs and rusty sheet, a different lot on each.
  const SIGNS = [C.signYellow, 0xc2402e, 0x2a5a9a, 0xe8e4d8];
  for (let i = 0; i < l.plates; i++) {
    const sx = i % 2 ? -1 : 1;
    const zc = -0.15 + (r() - 0.5) * 0.3;
    if (r() < 0.5) signPlate(b, sx * 0.62, 0.62 + r() * 0.15, zc, 0.55, 0.36, SIGNS[Math.floor(r() * SIGNS.length)], 0, sx * Math.PI / 2, (r() - 0.5) * 0.3);
    else plate(b, sx * 0.62, 0.6 + r() * 0.15, zc, 0.6, 0.38, 0.02, r() < 0.5 ? S.rust(0x6a3a22) : S.steel(0x5a5e60, 0.8), 0, sx * Math.PI / 2, (r() - 0.5) * 0.2);
  }
  // A bar cage over the driver's head on some.
  if (l.cage) for (let i = 0; i < 5; i++) b.rod(-0.5 + i * 0.25, 1.17, 0.2, -0.5 + i * 0.25, 1.17, -0.55, 0.012, S.steel(0x2a2c2e), 6);
  // Bucket seat and wheel.
  b.rbox(0, 0.0, 0.0, 0.5, 0.12, 0.5, 0.05, S.leather(0x1c1a18, 0.5));
  b.rbox(0, 0.35, -0.24, 0.5, 0.6, 0.1, 0.05, S.leather(0x1c1a18, 0.5), 0.2, 0, 0);
  b.torus(0, 0.45, 0.42, 0.15, 0.016, S.leather(0x111111), -0.9, 0, 0, 8, 18);
  // Exposed rear engine with stacks, a blower on the hot ones.
  b.rbox(0, 0.08, -0.95, 0.6, 0.42, 0.55, 0.05, S.metal(0x55524d, 0.75));
  for (let i = 0; i < 4; i++) b.cyl(-0.18 + i * 0.12, 0.34, -0.95, 0.07, 0.12, 0.07, S.metal(0x8a8478, 0.6), 0, 0, 0, 10);
  if (l.stacks === 2) {
    b.rbox(0, 0.42, -0.95, 0.3, 0.16, 0.36, 0.03, S.metal(0xc4c8cc, 0.3));
    b.cyl(0, 0.55, -0.95, 0.24, 0.1, 0.24, S.steel(0x1c1e20), 0, 0, 0, 12);
  }
  for (const sx of [1, -1]) exhaust(b, [[sx * 0.2, 0.1, -1.1], [sx * 0.3, 0.2, -1.3], [sx * 0.32, 0.45 + l.stacks * 0.2, -1.35]], 0.03, 0.05);
  // Spikes on the front and down the flanks.
  for (let i = 0; i < l.spikes; i++) b.add('cone12', -0.5 + (i * 1.0) / Math.max(1, l.spikes - 1), -0.12, 1.6, 0.07, 0.3, 0.07, steelS, Math.PI / 2, 0, 0);
  for (const sx of [1, -1]) for (let i = 0; i < 3; i++) b.add('cone12', sx * 0.6, 0.15, 0.4 - i * 0.45, 0.05, 0.22, 0.05, steelS, 0, 0, -sx * Math.PI / 2);
  flag(b, l, -0.5, 0.2, -0.85, 2.3, 0.75);
  // Mounted MG on the cage.
  const gun = new MeshBuilder();
  heavyGun(gun, 0.85, false);
  b.appendMatrix(gun, new THREE.Matrix4().compose(new THREE.Vector3(0, 1.32, 0.12), new THREE.Quaternion(), new THREE.Vector3(0.8, 0.8, 0.8)));
  lamp(rec, b, 0.38, 0.22, 1.42, 0.07);
  lamp(rec, b, -0.38, 0.22, 1.42, 0.07);
  if (l.lights) {
    b.rbox(0, 1.22, 0.24, 0.8, 0.08, 0.1, 0.02, S.plastic(0x1a1a1a));
    for (const x of [-0.28, 0, 0.28]) lamp(rec, b, x, 1.22, 0.3, 0.045);
  }
  rec.tails.push({ x: 0.3, y: 0.1, z: -1.24 }, { x: -0.3, y: 0.1, z: -1.24 });
  const geo = b.build();
  geo.computeBoundingSphere();
  return { geo, lamps: rec.lamps, tails: rec.tails, muzzle: [0, 1.32, 0.86] };
}

/** Raider dune buggy: exposed tube frame, rear engine, war paint, scrap and spikes, all rolled from `seed`. */
export function buildRaiderBuggy(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], seed = 0): VehicleVisual {
  const l = raiderLook(seed);
  const key = `raider|${def.id}|${lookKey(l)}|${seed % 4}`;
  const shell = acquireShell(key, () => raiderBuggyShell(def, wheelLocal, l, seed % 4));
  const v = finishShared(def, shell, key);
  const front: WheelStyle = { tread: 'knobby', rim: 'steel', rimColor: l.trim === 0xe2dccb ? 0xe2dccb : 0x7a1c14 };
  const back: WheelStyle = l.paddles ? { tread: 'paddle', rim: 'steel', rimColor: front.rimColor } : front;
  addWheelSet(v, def, wheelLocal, steered, wheelLocal.map((_, i) => ({ width: i < 2 ? 0.3 : l.paddles ? 0.42 : 0.3, style: i < 2 ? front : back })));
  const driver = new Humanoid({ jacket: l.paint === C.raiderRed ? C.raiderRed : 0x3a2a22, trim: 0x1a1a1a, helmet: 0x111111, mask: true });
  driver.root.position.set(0, -0.15, 0.05);
  v.inner.add(driver.root);
  v.driver = driver;
  v.smoke.position.set(0.32, 0.45 + l.stacks * 0.2, -1.35);
  v.inner.add(v.smoke);
  return v;
}

// ---------------------------------------------------------------- battle-wagon

function wagonShell(def: VehicleDef, wheelLocal: [number, number, number][], l: RaiderLook, seed: number): Shell {
  const rec: Rec = { lamps: [], tails: [] };
  const b = new MeshBuilder();
  b.jitter = 0.04;
  b.roundSeg = 2;
  b.seed(55 + seed);
  const r = rnd(seed + 9);
  const armour = S.steel(0x4e4c48, 0.9);
  const rust = S.rust(C.rust2);
  const red = S.paint(l.paint === 0x2a2622 ? C.raiderRed : l.paint, 0.9);
  const wy = wheelLocal[0][1] - def.physics.suspension.rest;
  const wx = Math.abs(wheelLocal[0][0]);
  // Chassis and hull.
  for (const sx of [1, -1]) b.rbox(sx * 0.7, -0.35, 0, 0.16, 0.22, 4.6, 0.02, S.steel(0x2e3032));
  b.rbox(0, 0.32, 0.1, 2.2, 1.05, 3.4, 0.06, rust);
  // Overlapping armour plates along each flank, riveted: a different mix of rust, bare and painted plate on each wagon.
  for (const sx of [1, -1]) {
    for (let i = 0; i < 4; i++) {
      const q = r();
      const col = q < 0.4 ? armour : q < 0.7 ? rust : red;
      b.mark(partTag('sign', `${sx}:${i}`), partMeta({ kind: 'sign', side: sx as 1 | -1, pivot: [sx * 1.1, 0.35, -1.25 + i * 0.85] }));
      plate(b, sx * 1.13, 0.35 + (r() - 0.5) * 0.08, -1.25 + i * 0.85, 0.95, 0.85, 0.05, col, 0, sx * Math.PI / 2, (r() - 0.5) * 0.1);
      b.end();
    }
    // Spikes along the hull.
    for (let i = 0; i < l.spikes; i++) b.add('cone12', sx * 1.32, 0.48 + (i % 2) * 0.22, -1.6 + (i * 3.3) / Math.max(1, l.spikes - 1), 0.12, 0.6, 0.12, S.steel(0x8a8e92, 0.5), 0, 0, -sx * Math.PI / 2);
    // Wheel arches.
    for (const wz of [wheelLocal[0][2], wheelLocal[2][2]]) {
      b.extrude('wagonArch', () => {
        const s = new THREE.Shape();
        s.absarc(0, 0, 0.72, 0.05, Math.PI - 0.05, false);
        s.absarc(0, 0, 0.64, Math.PI - 0.05, 0.05, true);
        s.closePath();
        return s;
      }, 0.5, 0.02, sx * (wx + 0.02), wy, wz, armour, 0, Math.PI / 2, 0);
    }
  }
  // Cab with slit visors, a bar cage over it on some.
  b.rbox(0, 1.1, 0.75, 2.0, 0.6, 1.5, 0.08, armour);
  b.box(0, 1.2, 1.51, 1.6, 0.08, 0.02, S.glass(0x0c0f12));
  b.box(0, 1.05, 1.51, 1.6, 0.06, 0.02, S.glass(0x0c0f12));
  plate(b, 0, 1.12, 1.53, 1.9, 0.5, 0.04, rust, -0.1, 0, 0);
  if (l.cage) {
    for (let i = 0; i < 6; i++) b.rod(-0.9 + i * 0.36, 1.42, 1.5, -0.9 + i * 0.36, 1.42, 0.05, 0.02, S.steel(0x2a2c2e), 6);
    for (const z of [1.5, 0.05]) b.rod(-0.95, 1.42, z, 0.95, 1.42, z, 0.025, S.steel(0x2a2c2e), 6);
  }
  // The ram: an angled plow with teeth, a spiked log, or a wall of welded rails.
  if (l.nose === 'jaw' || l.nose === 'teeth') {
    plate(b, 0, 0.35, 2.12, 2.3, 0.75, 0.06, S.steel(0x6a6e72, 0.8), -0.45, 0, 0);
    for (let i = 0; i < 7; i++) b.add('cone12', -1.05 + i * 0.35, 0.05, 2.38, 0.14, 0.55, 0.14, S.steel(0x9a9ea2, 0.4), Math.PI / 2, 0, 0);
  } else if (l.nose === 'ram') {
    b.cyl(0, 0.35, 2.22, 0.5, 2.4, 0.5, S.wood(0x5c4529, 0.8), 0, 0, Math.PI / 2, 12);
    for (let i = 0; i < 9; i++) {
      const a = (i % 3) * 2.1;
      b.add('cone12', -1.0 + i * 0.25, 0.35 + Math.sin(a) * 0.25, 2.22 + Math.cos(a) * 0.25, 0.08, 0.32, 0.08, S.steel(0x9a9ea2, 0.4), Math.PI / 2 - a, 0, 0);
    }
    for (const sx of [1, -1]) b.rod(sx * 0.7, 0.0, 1.7, sx * 0.7, 0.3, 2.2, 0.06, armour, 8);
  } else {
    for (let i = 0; i < 4; i++) b.rod(-1.15, 0.05 + i * 0.22, 2.15 - i * 0.05, 1.15, 0.05 + i * 0.22, 2.15 - i * 0.05, 0.05, S.steel(0x5a5e60, 0.7), 8);
    for (const sx of [1, -1]) b.rod(sx * 0.9, -0.05, 2.18, sx * 0.9, 0.75, 2.0, 0.05, armour, 8);
    b.add('sphere16', 0, 0.75, 2.05, 0.4, 0.42, 0.34, S.paint(0xe2dccb, 0.6));
  }
  // Smokestacks, roof cage, banner pole.
  for (let i = 0; i < l.stacks; i++) {
    const x = 0.8 - i * 1.6;
    exhaust(b, [[x, 0.9, 0.2], [x, 1.6, 0.15], [x, 2.2, 0.1]], 0.08, 0.1);
  }
  b.pipe([[0.9, 1.4, -0.2], [0.9, 1.75, -0.5], [-0.9, 1.75, -0.5], [-0.9, 1.4, -0.2]], 0.04, S.steel(0x2a2c2e), 8);
  flag(b, l, -0.2, 1.4, -0.4, 1.9, 1.0);
  // War stripe and skull plate on the cab.
  b.box(0, 0.75, 1.52, 2.0, 0.12, 0.02, red);
  b.add('sphere16', 0, 0.62, 1.58, 0.3, 0.3, 0.12, S.paint(0xe2dccb, 0.6));
  b.box(0, 0.5, 1.6, 0.18, 0.1, 0.06, S.paint(0xe2dccb, 0.6));
  // Rear deck: barrels, or a scrap pile and a spare.
  b.box(0, 0.88, -1.2, 2.0, 0.08, 1.4, S.steel(0x3a3c3e));
  if (seed % 2 === 0) {
    b.cyl(0.6, 1.25, -1.3, 0.55, 0.75, 0.55, S.paint(0x3a5f8a, 0.9), 0, 0, 0, 16);
    b.cyl(0.0, 1.25, -1.4, 0.55, 0.75, 0.55, S.paint(C.rust, 0.9), 0, 0, 0, 16);
  } else {
    spareTyre(b, 0.45, 1.05, -1.35, 0.42, 0.26, 0, 0);
    b.rbox(-0.45, 1.1, -1.25, 0.8, 0.36, 0.9, 0.04, S.rust(0x5a3a22), 0, 0.3, 0.1);
    strap(b, [[-0.9, 0.92, -1.25], [-0.45, 1.3, -1.25], [0.0, 0.92, -1.25]]);
  }
  rivets(b, [-0.95, 1.38, 1.5], [0.95, 1.38, 1.5], 9);
  lamp(rec, b, 0.8, 0.8, 1.56, 0.12);
  lamp(rec, b, -0.8, 0.8, 1.56, 0.12);
  if (l.lights) for (const x of [-0.5, 0, 0.5]) lamp(rec, b, x, 1.5, 1.4, 0.07);
  rec.tails.push({ x: 0.8, y: 0.2, z: -1.62, w: 0.16, h: 0.1 }, { x: -0.8, y: 0.2, z: -1.62, w: 0.16, h: 0.1 });
  const geo = b.build();
  geo.computeBoundingSphere();
  return { geo, lamps: rec.lamps, tails: rec.tails, muzzle: [0, 1.6, 1.6] };
}

/** Spiked battle-wagon: an armour-plated truck with a ram, side spikes, smokestacks and a war banner, rolled from `seed`. */
export function buildWagon(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], seed = 0): VehicleVisual {
  const l = raiderLook(seed + 1);
  const key = `wagon|${def.id}|${lookKey(l)}|${seed % 4}`;
  const shell = acquireShell(key, () => wagonShell(def, wheelLocal, l, seed % 4));
  const v = finishShared(def, shell, key);
  addWheelSet(v, def, wheelLocal, steered, [{ width: 0.5, style: { tread: 'knobby', lug: 'crawler', rim: 'steel', rimColor: 0x3a3a3a } }]);
  v.smoke.position.set(0.8, 2.2, 0.1);
  v.inner.add(v.smoke);
  return v;
}

/** A visual over a cached shell: the body mesh, its lamps and tails replayed, released (not disposed) when it goes. */
function finishShared(def: VehicleDef, shell: Shell, key: string): VehicleVisual {
  const v = blank(def);
  v.body = new THREE.Mesh(shell.geo, bodyMat);
  v.body.castShadow = true;
  v.body.receiveShadow = true;
  v.inner.add(v.body);
  for (const l of shell.lamps) headlamp(v, new MeshBuilder(), l.x, l.y, l.z, l.r, false, l.w, l.h);
  for (const t of shell.tails) taillight(v, t.x, t.y, t.z, t.w, t.h, t.amber);
  if (shell.muzzle) {
    v.muzzle.position.set(...shell.muzzle);
    v.inner.add(v.muzzle);
  }
  v.setHeadlights = (on: boolean) => {
    for (const h of v.headlights) h.material = on ? lightMat : lightOffMat;
  };
  v.damageTint = () => {};
  v.dispose = () => releaseShell(key);
  return v;
}

