import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { GROUND_CELL } from '../src/game/fires';
import { FIRE, FIRE_MAX } from '../src/render/fireLight';
import { FUELS, fireLight, flameHeight, flameLean, rainCooling, spreadRate, stepHeat, waterFate } from '../src/sim/combustion';
import { groundFuel } from '../src/world/fuel';
import { fakeServices, run } from './helpers/sim';

// Fire: the combustion model bare, then the fire engine running in a real leg scene in Node.
vi.setConfig({ testTimeout: 180000 });

beforeAll(async () => {
  await initPhysics();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('how things burn', () => {
  it('leans a flame over in the wind by how small it is', () => {
    expect(flameLean(0, 0, 1)).toEqual([0, 0]);
    const [lx, lz] = flameLean(5, 0, 1);
    // A metre-tall flame in a 5 m/s breeze lies over by about fifty degrees, downwind.
    expect(lz).toBe(0);
    expect((Math.atan(lx) * 180) / Math.PI).toBeGreaterThan(45);
    expect((Math.atan(lx) * 180) / Math.PI).toBeLessThan(60);
    // A crown fire ten metres tall shrugs the same breeze off.
    expect(flameLean(5, 0, 10)[0]).toBeLessThan(lx * 0.5);
    // A gale never lays it flat.
    expect(flameLean(60, 0, 0.3)[0]).toBeLessThanOrEqual(1.9);
  });

  it('grows its flames with its size and heat, and a wide fire burns as many flames, not one tower', () => {
    expect(flameHeight('wood', 0.45, 1)).toBeGreaterThan(0.8);
    expect(flameHeight('wood', 0.45, 1)).toBeLessThan(1.6);
    expect(flameHeight('wood', 0.45, 0.3)).toBeLessThan(flameHeight('wood', 0.45, 1));
    expect(flameHeight('petrol', 3, 1)).toBeLessThanOrEqual(FUELS.petrol.tallMax);
    expect(flameHeight('grass', 1.5, 1)).toBeLessThanOrEqual(FUELS.grass.tallMax);
  });

  it('drowns grass in the rain, barely touches burning petrol, and never rains under a roof', () => {
    expect(rainCooling('grass', 1, 0.5, false)).toBeGreaterThan(rainCooling('wood', 1, 0.5, false));
    expect(rainCooling('wood', 1, 0.5, false)).toBeGreaterThan(rainCooling('petrol', 1, 0.5, false) * 3);
    expect(rainCooling('flare', 1, 0.5, false)).toBe(0);
    expect(rainCooling('wood', 1, 0.5, true)).toBe(0);
    // A tended fire in a downpour dims but keeps going; a grass fire in it is beaten well down.
    let wood = 1;
    let grass = 1;
    for (let k = 0; k < 600; k++) {
      wood = stepHeat(wood, 1, rainCooling('wood', 1, wood, false), 0.05);
      grass = stepHeat(grass, 1, rainCooling('grass', 1, grass, false), 0.05);
    }
    expect(wood).toBeGreaterThan(0.4);
    expect(wood).toBeLessThan(0.8);
    expect(grass).toBeLessThan(wood);
  });

  it('puts out a wood fire in water and floats burning fuel on it', () => {
    expect(waterFate('wood', 0)).toBe('dry');
    expect(waterFate('wood', 0.5)).toBe('out');
    expect(waterFate('petrol', 0.5)).toBe('floats');
    expect(waterFate('flare', 2)).toBe('floats');
  });

  it('runs a grass fire downwind and lets it creep back against the wind', () => {
    const still = spreadRate(1, 0.8, 0.8, 0);
    expect(spreadRate(1, 0.8, 0.8, 6)).toBeGreaterThan(still * 2.5);
    expect(spreadRate(1, 0.8, 0.8, -6)).toBeLessThan(still * 0.3);
    expect(spreadRate(1, 0.8, 0.8, -6)).toBeGreaterThan(0);
    expect(spreadRate(1, 0, 0.8, 0)).toBe(0);
    expect(spreadRate(1, 0.8, 0, 0)).toBe(0);
    // Wet land hardly carries it.
    expect(spreadRate(1, 0.8, 0.2, 0)).toBeLessThan(still * 0.1);
  });

  it('lights more the bigger it is, and only so far', () => {
    const camp = fireLight('wood', 0.45, 1, 1);
    const pool = fireLight('petrol', 2.8, 1, 1);
    expect(pool.power).toBeGreaterThan(camp.power * 5);
    expect(camp.range).toBeGreaterThan(10);
    expect(pool.range).toBeLessThanOrEqual(110);
    expect(fireLight('wood', 0.45, 0, 1).power).toBe(0);
    // Firelight is warm: far more red than blue.
    expect(camp.r).toBeGreaterThan(camp.b * 3);
  });
});

const leg = legById('W');

function open(day = 1, memory = new WorldMemory()) {
  const h = fakeServices();
  h.campaign.day = day;
  const sc = new LegScene(h.svc, leg, { memory });
  run(sc, 0.3);
  return { sc, memory, ...h };
}

/** The convoy's spot: fires are lit beside it. */
function here(sc: LegScene) {
  const p = sc.players[0];
  return { x: p.vehicle?.position.x ?? p.pos.x, z: p.vehicle?.position.z ?? p.pos.z };
}

/** Run only the fire engine, in a wind and a dryness the test sets. */
function burn(sc: LegScene, seconds: number, wind: [number, number] = [0, 0], o: { rain?: number; heat?: number } = {}) {
  const n = Math.round(seconds * 20);
  for (let i = 0; i < n; i++) {
    sc.weather.wind = wind;
    sc.weather.rain = o.rain ?? 0;
    sc.weather.wet = 0;
    sc.heat = o.heat ?? 1;
    sc.fires.tick(0.05);
  }
}

describe('the fire engine in play', () => {
  it('lights a campfire that grows, flickers, smokes and becomes a light in the view', () => {
    const { sc } = open();
    const { x, z } = here(sc);
    const fx = x + 6;
    const f = sc.fires.start({ x: fx, y: sc.groundAt(fx, z), z, r: 0.45, fuel: 'wood', burn: Infinity, heat: 0.2 });
    burn(sc, 6);
    expect(f.heat).toBeGreaterThan(0.9);
    expect(f.out).toBe(false);
    const cam = sc.R.views[0].camera;
    cam.position.set(x, sc.groundAt(x, z) + 2, z);
    sc.fires.frame(1 / 60);
    // Flames are drawn and a bed is not (a campfire's ring has its own embers only when asked).
    expect(sc.fires.view.flameCount).toBeGreaterThan(2);
    sc.fires.beforeView(0, cam);
    expect(FIRE.info.x).toBeGreaterThanOrEqual(1);
    expect(FIRE.info.x).toBeLessThanOrEqual(FIRE_MAX);
    // The light sits in the flames, warm, and reaches past where the camera stands.
    expect(Math.hypot(FIRE.pos[0] - fx, FIRE.pos[2] - z)).toBeLessThan(1);
    expect(FIRE.col[0]).toBeGreaterThan(FIRE.col[2] * 3);
    expect(FIRE.col[3]).toBeGreaterThan(6);
    // It flickers: the light is not the same twice.
    const a = FIRE.col[0];
    sc.time += 0.37;
    sc.fires.frame(1 / 60);
    sc.fires.beforeView(0, cam);
    expect(FIRE.col[0]).not.toBe(a);
    sc.dispose();
    expect(FIRE.info.x).toBe(0);
  });

  it('carries more lights than a view holds by keeping the brightest and nearest', () => {
    const { sc } = open();
    const { x, z } = here(sc);
    for (let k = 0; k < 14; k++) {
      const fx = x + 12 + k * 9;
      sc.fires.start({ x: fx, y: sc.groundAt(fx, z), z, r: 0.5, fuel: 'wood', burn: Infinity, heat: 1 });
    }
    burn(sc, 1);
    const cam = sc.R.views[0].camera;
    cam.position.set(x, sc.groundAt(x, z) + 2, z);
    // At night, when firelight counts.
    sc.night = 1;
    sc.fires.frame(1 / 60);
    sc.fires.beforeView(0, cam);
    expect(FIRE.info.x).toBe(FIRE_MAX);
    // The nearest is in the list.
    let nearest = Infinity;
    for (let i = 0; i < FIRE_MAX; i++) nearest = Math.min(nearest, FIRE.pos[i * 4] - x);
    expect(nearest).toBeLessThan(16);
    sc.dispose();
  });

  it('a held fire dies down once its holder lets it go', () => {
    const { sc } = open();
    const { x, z } = here(sc);
    const key = {};
    for (let k = 0; k < 40; k++) {
      sc.fires.hold(key, { x: x + 5, y: sc.groundAt(x + 5, z) + 0.5, z, r: 0.5, fuel: 'rubber', heat: 0.9, bed: false });
      burn(sc, 0.05);
    }
    const f = sc.fires.sources.find((s) => s.key === key)!;
    expect(f.heat).toBeGreaterThan(0.6);
    burn(sc, 4);
    expect(sc.fires.sources.includes(f)).toBe(false);
    sc.dispose();
  });

  it('rain beats a grass fire down; a tended fire dims but keeps burning', () => {
    const { sc } = open();
    const { x, z } = here(sc);
    sc.fires.fuelAt = () => 0;
    const camp = sc.fires.start({ x: x + 8, y: sc.groundAt(x + 8, z), z, r: 0.45, fuel: 'wood', burn: Infinity, heat: 1 });
    const grass = sc.fires.start({ x: x - 8, y: sc.groundAt(x - 8, z), z, r: 1.5, fuel: 'grass', burn: 200, heat: 1 });
    burn(sc, 30, [0, 0], { rain: 1 });
    expect(camp.out).toBe(false);
    expect(camp.heat).toBeGreaterThan(0.35);
    expect(camp.heat).toBeLessThan(0.85);
    expect(grass.heat).toBeLessThan(camp.heat);
    sc.dispose();
  });

  it('water puts a wood fire out with a hiss of steam, and burning fuel floats and drifts on it', () => {
    const { sc } = open();
    const lake = sc.terrain!.lakes[0];
    expect(lake).toBeTruthy();
    // Somewhere out on the open water.
    let wx = 0;
    let wz = 0;
    let found = false;
    for (let a = 0; a < 16 && !found; a++) {
      for (const k of [0.3, 0.5, 0.15]) {
        wx = lake.x + Math.cos(a) * lake.r * k;
        wz = lake.z + Math.sin(a) * lake.r * k;
        const w = sc.waterAt(wx, wz);
        if (w && w.depth > 0.8) {
          found = true;
          break;
        }
      }
    }
    expect(found).toBe(true);
    const water = sc.waterAt(wx, wz)!;
    const bed = water.level - water.depth;
    const wood = sc.fires.start({ x: wx, y: bed, z: wz, r: 0.5, fuel: 'wood', burn: Infinity, heat: 1 });
    const slick = sc.fires.start({ x: wx + 1, y: bed, z: wz, r: 1.5, fuel: 'petrol', burn: 30, heat: 1 });
    burn(sc, 1);
    expect(wood.out).toBe(true);
    expect(sc.fires.sources.includes(wood)).toBe(false);
    expect(slick.out).toBe(false);
    expect(slick.floating).toBe(true);
    expect(Math.abs(slick.y - sc.waterAt(slick.x, slick.z)!.level)).toBeLessThan(0.1);
    sc.dispose();
  });

  it('spreads a grass fire across dry ground, downwind fastest, and leaves it black and bare', () => {
    const { sc, memory } = open();
    const { x, z } = here(sc);
    // A flat sea of dry grass, a stiff wind out of the west.
    sc.fires.fuelAt = () => 0.85;
    const burnt: { x: number; z: number }[] = [];
    const prev = sc.fires.onBurnt;
    sc.fires.onBurnt = (bx, bz, r) => {
      burnt.push({ x: bx, z: bz });
      prev(bx, bz, r);
    };
    const sx = x + 40;
    expect(sc.fires.igniteGround(sx, z)).toBe(true);
    burn(sc, 40, [7, 0], { heat: 1 });
    const stats = sc.fires.groundStats();
    expect(stats.burning + stats.burnt).toBeGreaterThan(12);
    // Every patch on fire or burned, and how far it got each way from where it started.
    let east = 0;
    let west = 0;
    for (const f of sc.fires.sources) {
      if (!f.cell) continue;
      east = Math.max(east, f.x - sx);
      west = Math.max(west, sx - f.x);
    }
    for (const b of burnt) {
      east = Math.max(east, b.x - sx);
      west = Math.max(west, sx - b.x);
    }
    expect(east).toBeGreaterThan(west * 2);
    expect(east).toBeGreaterThan(GROUND_CELL * 4);
    // What burned is black and has nothing left on it.
    expect(burnt.length).toBeGreaterThan(0);
    expect(sc.fires.char.count).toBeGreaterThan(0);
    expect(sc.fires.groundBurnt(burnt[0].x, burnt[0].z)).toBe(true);
    expect(sc.fires.igniteGround(burnt[0].x, burnt[0].z)).toBe(false);
    // It stays black overnight.
    sc.capture(memory);
    expect(memory.scorched.length).toBeGreaterThan(0);
    const again = WorldMemory.restore(memory.serialize());
    sc.dispose();
    const h = fakeServices();
    const next = new LegScene(h.svc, leg, { memory: again });
    expect(next.fires.groundBurnt(burnt[0].x, burnt[0].z)).toBe(true);
    expect(next.fires.char.count).toBeGreaterThan(0);
    next.dispose();
  });

  it('will not start on wet ground, bare ground, or a road', () => {
    const { sc } = open();
    const { x, z } = here(sc);
    sc.fires.fuelAt = () => 0.9;
    // Soaked.
    sc.weather.wet = 1;
    sc.weather.rain = 1;
    sc.weather.wind = [0, 0];
    sc.fires.tick(0.05);
    expect(sc.fires.igniteGround(x + 30, z)).toBe(false);
    // Dry, but nothing there.
    burn(sc, 0.1);
    sc.fires.fuelAt = () => 0;
    expect(sc.fires.igniteGround(x + 60, z + 60)).toBe(false);
    // The real ground: lake water carries no fire.
    const lake = sc.terrain!.lakes[0];
    for (let a = 0; a < 16; a++) {
      const lx = lake.x + Math.cos(a) * lake.r * 0.3;
      const lz = lake.z + Math.sin(a) * lake.r * 0.3;
      if (sc.waterAt(lx, lz)) expect(groundFuel(sc.terrain!, lx, lz)).toBe(0);
    }
    sc.dispose();
  });

  it('a burning patch of grass burns whoever stands in it and sets the trees in it alight', () => {
    const { sc } = open();
    const { x, z } = here(sc);
    sc.fires.fuelAt = () => 0.9;
    const p = sc.players[0];
    if (p.vehicle) p.exitVehicle(false);
    run(sc, 0.3);
    const hp0 = p.hp;
    const gx = x + 20;
    sc.fires.igniteGround(gx, z);
    for (let k = 0; k < 120; k++) {
      p.pos.x = gx;
      p.pos.z = z;
      p.invuln = 0;
      burn(sc, 0.05);
    }
    expect(p.hp).toBeLessThan(hp0);
    sc.dispose();
  });

  it('a lightning-struck tree burns as a crown fire in the engine', () => {
    const { sc } = open(3);
    const near = (sc as unknown as { loadedTreesNear: (x: number, z: number, r: number) => { x: number; z: number }[] }).loadedTreesNear.bind(sc);
    const { x, z } = here(sc);
    let tree = null as ReturnType<typeof near>[number] | null;
    for (let r = 30; r < 500 && !tree; r += 30) tree = near(x, z, r)[0] ?? null;
    if (!tree) return;
    const f = sc.weather.fire.ignite(tree as never, 1)!;
    for (let k = 0; k < 100; k++) {
      sc.weather.fire.update(0.1, 0, 0.5, [0, 0]);
      sc.fires.tick(0.1);
    }
    const crown = sc.fires.sources.find((s) => s.key === f);
    expect(crown).toBeTruthy();
    expect(crown!.shape).toBe('crown');
    expect(crown!.heat).toBeGreaterThan(0.3);
    sc.dispose();
  });
});
