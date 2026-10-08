import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { chassisDef, legById, partDef } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn, NAV } from '../src/input/intents';
import { installPart, newBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { openPanel, standAt } from './helpers/access';
import { fakeServices } from './helpers/sim';
import { needHints, openStorage, storageEntries, storageOf, sortEntries } from '../src/game/storage';
import { carLookOf } from '../src/game/carLook';
import { bootDeck, bootSpot } from '../src/render/bootDeck';
import { carData, carFigures, figureRows, fmt, judgeSpare, partFacts, stockFigures, stockTyres, swapDeltas, swapGain, type OwnCar } from '../src/ui/carStats';
import { breakdownCar, breakdownHtml } from '../src/ui/breakdown';
import { cardHtml } from '../src/ui/carCard';
import type { Vehicle } from '../src/game/vehicle';
import type { PartSlot } from '../src/data';
import { socketFor } from '../src/render/sockets';
import { anchorWorld } from '../src/game/access';

// The car screens: reading a part with the crosshair, a car's storage, fitting from the boot, and the numbers behind them.
vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

function leg(solo = false) {
  const h = fakeServices({ solo });
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  return { h, sc, c: h.campaign };
}

function pose(sc: LegScene) {
  for (const v of sc.vehicles) v.syncVisual(1, DT);
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) {
    sc.tick(DT);
    if (i % 10 === 0) pose(sc);
  }
  pose(sc);
}

function tap(h: ReturnType<typeof fakeServices>, sc: LegScene, who: number, btn: number) {
  const it = h.intents[who];
  it.device = 'keyboard';
  it.held |= 1 << btn;
  it.pressed = 1 << btn;
  sc.tick(DT);
  it.held &= ~(1 << btn);
  it.pressed = 0;
  it.released = 1 << btn;
  sc.tick(DT);
  it.released = 0;
  sc.tick(DT);
}

/** One tick of a menu direction, the way the input manager reports a key going down. */
function nav(h: ReturnType<typeof fakeServices>, sc: LegScene, who: number, dir: number) {
  const it = h.intents[who];
  it.device = 'keyboard';
  it.nav = dir;
  sc.tick(DT);
  it.nav = 0;
  sc.tick(DT);
}

function ownCar(sc: LegScene, chassis = 'hatch', dx = 9): Vehicle {
  const p = sc.players[0];
  p.exitVehicle(false);
  const st = sc.src.layout.start;
  const x = st.x + dx;
  const z = st.z + 8;
  const b = newBuild(chassis, { seed: 31, fuel: 0.2 });
  const v = sc.spawnVehicle({ build: b, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: 0, faction: 'convoy' });
  sc.campaign.adopt(b);
  run(sc, 1.5);
  const d = v.doorPos(1);
  p.placeAt(d[0], d[2], v.yaw);
  return v;
}

/** Stow parts in a car's boot as a player would, tagged to it. */
function stow(sc: LegScene, v: Vehicle, ids: string[]) {
  for (const id of ids) {
    const it = newPart(id, 0.9);
    it.on = v.build!.uid;
    sc.campaign.inventory.push(it);
  }
}

// ------------------------------------------------------------------------------------------------ numbers

describe('the numbers in plain words', () => {
  it('formats power, weight, speed and changes with their units', () => {
    expect(fmt.power(100)).toBe('100 kW (134 hp)');
    expect(fmt.kg(1234.4)).toBe('1234 kg');
    expect(fmt.kmh(118.6)).toBe('119 km/h');
    expect(fmt.signed(0.08)).toBe('+8%');
    expect(fmt.signed(-0.125)).toBe('−13%');
    expect(fmt.delta(-40, 'kg')).toBe('−40 kg');
  });

  it('an engine reads by output, size, fuel and weight; a tyre by grip; torque only when the model has it', () => {
    const v6 = partFacts(partDef('eng_v6'));
    expect(v6[0]).toMatchObject({ label: 'Power' });
    expect(v6[0].text).toMatch(/kW \(\d+ hp\)/);
    expect(v6.some((f) => f.label === 'Weight' && /kg$/.test(f.text))).toBe(true);
    expect(v6.some((f) => f.label === 'Torque')).toBe(false);
    const mt = partFacts(partDef('whl_mt'));
    expect(mt.find((f) => f.label === 'Grip')).toMatchObject({ text: '+10%', tone: 'good' });
    // Wire a torque figure in and it shows, in Nm.
    const was = carData.engineTorque;
    carData.engineTorque = (e) => e.kw * 2;
    try {
      expect(partFacts(partDef('eng_v6')).find((f) => f.label === 'Torque')?.text).toMatch(/ Nm$/);
    } finally {
      carData.engineTorque = was;
    }
  });

  it('the totals compare with the factory car, and a stronger engine shows as more power and top speed', () => {
    const def = chassisDef('hatch');
    const stock = stockFigures(def);
    const b = newBuild('hatch', { seed: 2 });
    installPart(b, newPart('eng_v6', 1));
    const now = carFigures(def, b.fit, b.tyres);
    expect(now.powerKw).toBeGreaterThan(stock.powerKw);
    expect(now.topKmh).toBeGreaterThan(stock.topKmh);
    expect(now.massKg).toBeGreaterThan(stock.massKg!);
    expect(stock.accelS).toBeGreaterThan(2);
    expect(stock.accelS).toBeLessThan(30);
    const rows = figureRows(now, stock);
    const power = rows.find((r) => r.key === 'power')!;
    expect(power.vsStock).toBe(1);
    expect(rows.find((r) => r.key === 'mass')!.vsStock).toBe(-1);
    // No torque model yet: no torque row.
    expect(rows.some((r) => r.key === 'torque')).toBe(false);
    expect(rows.map((r) => r.label)).toEqual(expect.arrayContaining(['Grip: road', 'Grip: sand', 'Range', 'Armour']));
  });

  it('a swap says what it changes, and a spare is judged against what is fitted', () => {
    const def = chassisDef('hatch');
    const b = newBuild('hatch', { seed: 3 });
    const mt = newPart('whl_mt', 1);
    const deltas = swapDeltas(def, b.fit, b.tyres, mt);
    expect(deltas.some((d) => /grip/.test(d.text) && d.good)).toBe(true);
    expect(swapGain(def, b.fit, b.tyres, mt, 0)).toBeGreaterThan(0);
    const car: OwnCar = { uid: b.uid, name: 'Hatch', def, fit: b.fit, tyres: b.tyres };
    const v = judgeSpare(mt, car, [car]);
    expect(v).toMatchObject({ fitsHere: true, junk: false, word: 'grip' });
    expect(v.gain).toBeGreaterThan(0.03);
    // A motorcycle wheel fits no hub on a hatchback, and no other car the convoy owns: junk.
    const moto = judgeSpare(newPart('tyre_trike', 1), car, [car]);
    expect(moto.fitsHere).toBe(false);
    expect(moto.junk).toBe(true);
    // A worse tyre than the one on is a step down on the car's grip.
    installPart(b, newPart('whl_bl', 1));
    expect(judgeSpare(newPart('whl_road', 1), car, [car]).gain).toBeLessThan(0);
  });

  it('the breakdown lists every component with its wear and the totals with the factory figures', () => {
    const b = newBuild('sedan', { seed: 4 });
    installPart(b, newPart('eng_v6', 0.62));
    b.comp.engine = 0.62;
    const html = breakdownHtml(breakdownCar(b, "Leo's Sedan"), { focus: { slot: 'engine' } });
    expect(html).toMatch(/Tuned V6/);
    expect(html).toMatch(/62%/);
    expect(html).toMatch(/Front left tyre/);
    expect(html).toMatch(/Factory/);
    expect(html).toMatch(/Top speed/);
    // The focused component opens up to its own numbers.
    expect(html).toMatch(/bk-r on[^]*Power <b>/);
    const other = newBuild('pickup', { seed: 5 });
    expect(breakdownHtml(breakdownCar(b, 'Sedan'), { compare: breakdownCar(other, 'Pickup') })).toMatch(/vs Pickup/);
  });
});

// ------------------------------------------------------------------------------------------------ the boot

describe('storage', () => {
  it('each stowed thing has its own spot on the boot floor, inside the car', () => {
    const def = chassisDef('hatch');
    const deck = bootDeck(def);
    const pts = [0, 1, 2, 3, 4, 5].map((i) => bootSpot(deck, i));
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2])).toBeGreaterThan(0.2);
    for (const [x, , z] of pts) {
      expect(Math.abs(x)).toBeLessThan(def.width / 2);
      expect(z).toBeLessThan(0);
      expect(z).toBeGreaterThan(-def.length / 2);
    }
    // Panniers either side of a bike's tail.
    const moped = bootDeck(chassisDef('moped'));
    expect(Math.sign(bootSpot(moped, 0)[0])).toBe(-Math.sign(bootSpot(moped, 1)[0]));
  });

  it("a car's spots in the world are spread out, one per item", () => {
    const { sc } = leg();
    const v = ownCar(sc);
    stow(sc, v, ['whl_mt', 'arm_sheet', 'eng_i4']);
    const spots = v.deckSpots().filter((s) => s.kind === 'part');
    expect(spots.length).toBe(3);
    for (let i = 0; i < spots.length; i++) {
      expect(spots[i].world.distanceTo(v.position)).toBeLessThan(v.def.length / 2 + 0.5);
      for (let j = i + 1; j < spots.length; j++) expect(spots[i].world.distanceTo(spots[j].world)).toBeGreaterThan(0.2);
    }
  });

  it("lists what each car carries: its own spares, loose spares, the reserves and the load outside, and not another car's", () => {
    const { sc, c } = leg();
    const a = ownCar(sc, 'hatch', 9);
    const b = ownCar(sc, 'sedan', 16);
    stow(sc, a, ['whl_mt']);
    stow(sc, b, ['arm_sheet']);
    c.inventory.push(newPart('rad_alu', 1));
    c.stocks.fuel = 12;
    c.items.oil = 1;
    a.cargoRig.add({ kind: 'fuel', amount: 3, fuel: 'diesel' }, 'roof');
    const la = storageEntries(a);
    const lb = storageEntries(b);
    const ids = (l: typeof la) => l.filter((e) => e.kind === 'part').map((e) => e.item!.id).sort();
    expect(ids(la)).toEqual(['rad_alu', 'whl_mt']);
    expect(ids(lb)).toEqual(['arm_sheet', 'rad_alu']);
    expect(la.some((e) => e.kind === 'fuel' && e.amount === '12.0 FU')).toBe(true);
    expect(la.some((e) => e.kind === 'oil')).toBe(true);
    expect(la.some((e) => e.kind === 'cargo' && e.where === 'roof')).toBe(true);
    expect(lb.some((e) => e.kind === 'cargo')).toBe(false);
    // The tyre is judged for this car: it fits, and it is better than the factory tyres.
    const mt = la.find((e) => e.item?.id === 'whl_mt')!;
    expect(mt.verdict).toMatchObject({ fitsHere: true, junk: false });
    expect(mt.verdict!.gain).toBeGreaterThan(0);
    // By value, the biggest upgrade for this car comes first.
    const byValue = sortEntries(la, 'value').filter((e) => e.kind === 'part');
    expect(byValue[0].verdict!.gain!).toBeGreaterThanOrEqual(byValue[1].verdict!.gain!);
  });

  it('X at the boot opens the panel on that car; the chosen item (not the first) comes out into the hands', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    stow(sc, v, ['arm_sheet', 'whl_mt', 'rad_alu']);
    standAt(sc, v, 'trunk');
    run(sc, 0.2);
    expect(p.promptAlt?.text ?? p.prompt?.text).toMatch(/Storage · 3 items/);
    p.equip = 'crowbar';
    tap(h, sc, 0, Btn.X);
    const s = storageOf(p)!;
    expect(s).toBeTruthy();
    // The lid came up as the panel opened.
    expect(v.open.trunk).toBe(true);
    s.setSort('slot');
    // Walk the pick to the radiator with the menu keys; the feet stay put.
    const at = p.pos.clone();
    const want = s.entries.findIndex((e) => e.item?.id === 'rad_alu');
    s.select(0);
    for (let i = 0; i < want; i++) nav(h, sc, 0, NAV.down);
    expect(s.current?.item?.id).toBe('rad_alu');
    expect(p.pos.distanceTo(at)).toBeLessThan(0.05);
    tap(h, sc, 0, Btn.A);
    expect(p.carry).toMatchObject({ kind: 'part', item: { id: 'rad_alu' } });
    expect(storageOf(p)).toBeNull();
    expect(c.inventory.map((i) => i.id).sort()).toEqual(['arm_sheet', 'whl_mt']);
    // Opening it again lands on what was picked last time on this car, if it is still there; else the first row.
    p.carry = null;
    tap(h, sc, 0, Btn.X);
    expect(storageOf(p)).toBeTruthy();
    tap(h, sc, 0, Btn.B);
    expect(storageOf(p)).toBeNull();
  });

  it('the panel takes only the opener\'s controls: the other player keeps moving', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    const q = sc.players[1];
    q.exitVehicle(false);
    stow(sc, v, ['whl_mt']);
    standAt(sc, v, 'trunk');
    p.equip = 'crowbar';
    tap(h, sc, 0, Btn.X);
    expect(storageOf(p)).toBeTruthy();
    const from = q.pos.clone();
    h.intents[1].device = 'keyboard';
    h.intents[1].move = [0, 1];
    h.intents[0].move = [0, 1];
    const mine = p.pos.clone();
    run(sc, 0.6);
    h.intents[1].move = [0, 0];
    h.intents[0].move = [0, 0];
    expect(q.pos.distanceTo(from)).toBeGreaterThan(0.5);
    expect(p.pos.distanceTo(mine)).toBeLessThan(0.05);
    expect(storageOf(q)).toBeNull();
  });

  it('fit now: with a wrench on the belt a spare tyre goes straight onto the flat wheel, and the old one goes in the boot', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    v.health.comp.tires[2] = 0;
    stow(sc, v, ['whl_mt']);
    expect(needHints(v).some((n) => /Spare tyre in the boot/.test(n.text))).toBe(true);
    standAt(sc, v, 'trunk');
    p.equip = 'crowbar';
    tap(h, sc, 0, Btn.X);
    const s = storageOf(p)!;
    // The panel opens on the spare the flat needs.
    expect(s.current?.item?.id).toBe('whl_mt');
    expect(s.secondLabel(s.current)?.text).toMatch(/Fit now · rear left/);
    tap(h, sc, 0, Btn.X);
    expect(s.job).toBeTruthy();
    expect(p.equip).toBe('wrench');
    run(sc, 3.2);
    expect(s.job).toBeNull();
    expect(v.build!.tyres[2]?.id).toBe('whl_mt');
    expect(v.health.comp.tires[2]).toBeGreaterThan(0.8);
    // The flat factory tyre came off into the boot, on this car.
    const old = c.inventory.find((i) => i.id === 'tyre_hatch');
    expect(old?.on).toBe(v.build!.uid);
    expect(old?.cond).toBe(0);
    expect(p.carry).toBeNull();
  });

  it('fit now is refused without a wrench, and for a part this car has no mount for', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    stow(sc, v, ['whl_mt', 'tyre_trike']);
    p.gear.belt = p.gear.belt.map((it) => (it && /wrench/.test(it.id) ? null : it));
    standAt(sc, v, 'trunk');
    p.equip = 'crowbar';
    tap(h, sc, 0, Btn.X);
    const s = storageOf(p)!;
    const mt = s.entries.find((e) => e.item?.id === 'whl_mt')!;
    expect(s.fitBlock(mt)).toMatch(/wrench/);
    const moto = s.entries.find((e) => e.item?.id === 'tyre_trike')!;
    expect(s.fitBlock(moto)).toMatch(/does not go on/);
    expect(moto.verdict?.junk).toBe(true);
  });

  it('fuel from the reserve fills the tank from the panel', () => {
    const { sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    c.stocks.fuel = 20;
    v.fuel = 1;
    standAt(sc, v, 'trunk');
    openPanel(v, 'trunk');
    expect(openStorage(p, v)).toBe(true);
    const s = storageOf(p)!;
    const row = s.entries.findIndex((e) => e.kind === 'fuel');
    s.second(row);
    expect(v.fuel).toBeGreaterThan(5);
    expect(c.stocks.fuel).toBeLessThan(20);
  });
});

// ------------------------------------------------------------------------------------------------ the crosshair

describe('reading a part with the crosshair', () => {
  /** The centre of a mount's box, in the world. */
  function mount(v: Vehicle, slot: PartSlot, i: number): THREE.Vector3 {
    return anchorWorld(v, socketFor(v.def, slot)!.anchors[i]);
  }

  /** Put the view's camera at the player's eyes, looking at a world point. */
  function look(sc: LegScene, at: THREE.Vector3) {
    const p = sc.players[0];
    const cam = sc.R.views[0].camera;
    cam.position.set(p.pos.x, p.pos.y + 1.6, p.pos.z);
    cam.lookAt(at);
    cam.updateMatrixWorld();
    sc.tick(DT);
  }

  it('the wheel under the crosshair is picked out and read, with its tyre, wear and what is behind it', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    v.health.comp.tires[0] = 0.55;
    standAt(sc, v, 'wheel', 0);
    look(sc, mount(v, 'wheels', 0));
    const L = carLookOf(p);
    expect(L?.part?.slot).toBe('wheels');
    expect(L?.card?.title).toMatch(/wheel/i);
    expect(L?.card?.name).toMatch(/Tyre/);
    expect(L?.card?.cond?.pct).toBe(55);
    expect(L?.card?.more.some((m) => /Brakes/.test(m))).toBe(true);
    sc.work.update(DT);
    expect(sc.work.highlighting(0)).toBe(true);
    const html = cardHtml(L!.card!);
    expect(html).toMatch(/55%/);
    expect(html).toMatch(/Details/);
  });

  it('a spare in the boot shows up as the thing to beat at that part', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    stow(sc, v, ['whl_mt']);
    standAt(sc, v, 'wheel', 1);
    look(sc, mount(v, 'wheels', 1));
    const card = carLookOf(p)?.card;
    expect(card?.vs?.head).toMatch(/Mud-Terrain Tyre in the boot/);
    expect(card?.vs?.items.some((d) => /grip/.test(d.text) && d.good)).toBe(true);
  });

  it('an engine is read only with the bonnet up; with it shut the bonnet says what is under it', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'sedan');
    const p = sc.players[0];
    standAt(sc, v, 'hood');
    look(sc, mount(v, 'hood', 0));
    const L = carLookOf(p);
    expect(L?.part?.slot).toBe('hood');
    expect(L?.card?.more.join(' ')).toMatch(/Under it:/);
    openPanel(v, 'hood');
    pose(sc);
    look(sc, mount(v, 'engine', 0));
    expect(['engine', 'cooling']).toContain(carLookOf(p)?.part?.slot);
  });

  it('looking at the car from across the yard reads the whole car, not a part', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.placeAt(v.position.x + 6.5, v.position.z, -Math.PI / 2);
    run(sc, 0.1);
    look(sc, new THREE.Vector3(v.position.x, v.position.y, v.position.z));
    const L = carLookOf(p);
    expect(L?.v).toBe(v);
    expect(L?.part).toBeNull();
  });
});

void stockTyres;
