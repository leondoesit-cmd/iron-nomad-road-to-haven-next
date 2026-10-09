import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { GROUND_CELL } from '../src/game/fires';
import { FIRE, FIRE_MAX, aimFireShadow, fireShadowLight, installFireShadowFilter, keepFireShadow } from '../src/render/fireLight';
import { FUELS, fireLight, flameHeight, flameLean, heatRelease, plumeInflow, plumeRise, rainCooling, SPREAD_PACE, spreadRate, spreadSpeed, stepHeat, waterFate } from '../src/sim/combustion';
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

  it('spreads a grass fire as fast as real grassland burns: a creep in still air, a walk at the head in a breeze', () => {
    // Bone dry, thick grass.
    // The game runs at 40% of the measured pace (CSIRO: about 0.015 m/s calm, 0.57 m/s at the head in a 1.6 m/s breeze).
    expect(SPREAD_PACE).toBe(0.4);
    const calm = spreadSpeed(1, 1, 0, 0);
    expect(calm).toBeGreaterThan(0.003);
    expect(calm).toBeLessThan(0.015);
    // The game's everyday breeze (1.6 m/s): the head walks at about a fifth of a metre a second.
    const head = spreadSpeed(1, 1, 1.6, 1);
    expect(head).toBeGreaterThan(0.15);
    expect(head).toBeLessThan(0.4);
    // The flanks widen at a tenth of that, the back creeps into the wind slower still.
    const flank = spreadSpeed(1, 1, 1.6, 0);
    const back = spreadSpeed(1, 1, 1.6, -1);
    expect(flank).toBeLessThan(head * 0.15);
    expect(back).toBeLessThan(flank);
    expect(back).toBeGreaterThan(0);
    // A gale runs it at metres a second.
    expect(spreadSpeed(1, 1, 8, 1)).toBeGreaterThan(1);
    // Damp or thin, it slows; nothing to burn, or too wet, it stops.
    expect(spreadSpeed(1, 0.6, 1.6, 1)).toBeLessThan(head * 0.4);
    expect(spreadSpeed(0.3, 1, 1.6, 1)).toBeLessThan(head * 0.6);
    expect(spreadSpeed(0, 1, 1.6, 1)).toBe(0);
    expect(spreadSpeed(1, 0, 1.6, 1)).toBe(0);
    // As odds a second to light the next patch: speed over distance, once the burning patch is hot enough.
    expect(spreadRate(1, 1, 1, 1.6, 1, 2.5)).toBeCloseTo(head / 2.5, 6);
    expect(spreadRate(0.15, 1, 1, 1.6, 1, 2.5)).toBe(0);
  });

  it('draws air in toward a fire: a breath by a campfire, a wind by a big grass fire', () => {
    const camp = heatRelease('wood', 0.45, 1);
    const front = heatRelease('grass', 1.55, 1) * 8;
    expect(camp).toBeGreaterThan(150);
    expect(camp).toBeLessThan(400);
    expect(plumeInflow(camp, 0.5, 0.45)).toBeGreaterThan(0.3);
    expect(plumeInflow(camp, 2, 0.45)).toBeLessThan(0.2);
    const near = plumeInflow(front, 4, 5);
    expect(near).toBeGreaterThan(0.5);
    expect(near).toBeLessThan(4);
    // It falls off with distance, and cancels toward the middle of the fire.
    expect(plumeInflow(front, 20, 5)).toBeLessThan(near * 0.4);
    expect(plumeInflow(front, 0.5, 5)).toBeLessThan(near * 0.2);
    // The smoke leaves the top at the plume's own updraft: a campfire's a couple of metres a second, a big fire's more.
    expect(plumeRise(camp)).toBeGreaterThan(1.5);
    expect(plumeRise(camp)).toBeLessThan(4);
    expect(plumeRise(front)).toBeGreaterThan(plumeRise(camp) * 1.5);
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

  it('in the everyday breeze a grass fire walks downwind at the pace of a real one, and makes its own wind', () => {
    const { sc } = open();
    const { x, z } = here(sc);
    sc.fires.fuelAt = () => 0.85;
    const sx = x + 40;
    expect(sc.fires.igniteGround(sx, z)).toBe(true);
    burn(sc, 30, [1.6, 0], { heat: 1 });
    let east = 0;
    let west = 0;
    for (const f of sc.fires.sources) {
      if (!f.cell) continue;
      east = Math.max(east, f.x - sx);
      west = Math.max(west, sx - f.x);
    }
    // About a fifth of a metre a second at the head (the first rate ran it 35 m in this time); the back has barely moved.
    expect(east).toBeLessThan(11);
    expect(east).toBeGreaterThan(GROUND_CELL);
    expect(west).toBeLessThan(GROUND_CELL * 1.5);
    // The burning ground draws the air in: just upwind of the fire the wind is the breeze plus an inflow toward it, just
    // downwind it is held back.
    const up = sc.fires.windAt(sx - 6, z);
    const down = sc.fires.windAt(sx + east + 6, z);
    expect(up[0]).toBeGreaterThan(1.6);
    expect(down[0]).toBeLessThan(1.6);
    sc.dispose();
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

  it('the nearest fire on open ground casts shadows at night; a burning wreck does not, nor any fire by day or on Low', () => {
    const { sc } = open();
    const { x, z } = here(sc);
    const R = sc.R as unknown as { quality: string };
    R.quality = 'medium';
    const fx = x + 6;
    sc.fires.start({ x: fx, y: sc.groundAt(fx, z), z, r: 0.45, fuel: 'wood', burn: Infinity, heat: 1 });
    // A wreck burning nearer the camera, and brighter: its light sits inside its hull, which would shadow all round it.
    const key = {};
    const wreck = () => sc.fires.hold(key, { x: x - 5, y: sc.groundAt(x - 5, z) + 0.6, z, r: 1.2, fuel: 'rubber', heat: 1, bed: false });
    for (let k = 0; k < 60; k++) {
      wreck();
      burn(sc, 0.05);
    }
    const cam = sc.R.views[0].camera;
    cam.position.set(x, sc.groundAt(x, z) + 2, z);
    sc.night = 1;
    const light = fireShadowLight();
    wreck();
    sc.fires.frame(1 / 60);
    sc.fires.beforeView(0, cam);
    // Both light the view; the campfire casts, first in the list, and the shadow's light stands where its light does.
    expect(FIRE.info.x).toBe(2);
    expect(FIRE.info.w).toBe(1);
    expect(Math.hypot(FIRE.pos[0] - fx, FIRE.pos[2] - z)).toBeLessThan(1);
    expect(light.position.x).toBeCloseTo(FIRE.pos[0], 5);
    expect(light.position.y).toBeCloseTo(FIRE.pos[1], 5);
    expect(light.position.z).toBeCloseTo(FIRE.pos[2], 5);
    expect(light.distance).toBeGreaterThan(5);
    expect(light.shadow.needsUpdate).toBe(true);
    // None on Low, and none by day, when the sun swamps firelight.
    R.quality = 'low';
    sc.fires.beforeView(0, cam);
    expect(FIRE.info.w).toBe(0);
    R.quality = 'medium';
    sc.night = 0;
    wreck();
    sc.fires.frame(1 / 60);
    sc.fires.beforeView(0, cam);
    expect(FIRE.info.w).toBe(0);
    sc.dispose();
    expect(FIRE.info.w).toBe(0);
  });

  it('keeps the shadows on the fire casting them until another outshines it twice over', () => {
    const { sc } = open();
    const { x, z } = here(sc);
    (sc.R as unknown as { quality: string }).quality = 'medium';
    for (const fx of [x - 8, x + 8]) sc.fires.start({ x: fx, y: sc.groundAt(fx, z), z, r: 0.45, fuel: 'wood', burn: Infinity, heat: 1 });
    burn(sc, 2);
    sc.night = 1;
    const cam = sc.R.views[0].camera;
    const caster = (cx: number) => {
      cam.position.set(cx, sc.groundAt(cx, z) + 2, z);
      sc.time += 1 / 30;
      sc.fires.frame(1 / 30);
      sc.fires.beforeView(0, cam);
      expect(FIRE.info.w).toBe(1);
      return FIRE.pos[0] < x ? 'west' : 'east';
    };
    expect(caster(x - 3)).toBe('west');
    // Halfway between, the two flicker past each other: the shadows stay put.
    for (let i = 0; i < 60; i++) expect(caster(x)).toBe('west');
    // Beside the other fire, it takes them.
    expect(caster(x + 6)).toBe('east');
    sc.dispose();
  });

  it('redraws the shadow cube every other frame, once for both halves of a split screen', () => {
    const { sc } = open();
    const { x, z } = here(sc);
    (sc.R as unknown as { quality: string }).quality = 'high';
    sc.fires.start({ x: x + 6, y: sc.groundAt(x + 6, z), z, r: 0.45, fuel: 'wood', burn: Infinity, heat: 1 });
    burn(sc, 2);
    sc.night = 1;
    const cam = sc.R.views[0].camera;
    cam.position.set(x, sc.groundAt(x, z) + 2, z);
    const s = fireShadowLight().shadow;
    const drawn = () => {
      // As the renderer would: a cube asked for is drawn, and the ask cleared.
      const asked = s.needsUpdate;
      s.needsUpdate = false;
      return asked;
    };
    const frames: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      sc.time += 1 / 60;
      sc.fires.frame(1 / 60);
      sc.fires.beforeView(0, cam);
      frames.push(drawn());
      // The other half looks at the same fire: it shares this frame's cube.
      sc.fires.beforeView(1, cam);
      expect(drawn()).toBe(false);
      expect(FIRE.info.w).toBe(1);
    }
    expect(frames).toEqual([true, false, true, false]);
    expect(s.mapSize.x).toBe(512);
    sc.dispose();
  });
});

describe('the fire shadow cube', () => {
  it('leaves out a batch with no member near the fire, and never touches what the views draw', () => {
    const drawn: THREE.Object3D[] = [];
    const gl = { renderBufferDirect: (_c: unknown, _s: unknown, _g: unknown, _m: unknown, o: THREE.Object3D) => drawn.push(o) };
    installFireShadowFilter(gl as unknown as THREE.WebGLRenderer);
    const draw = (cam: THREE.Camera, o: THREE.Mesh) => gl.renderBufferDirect(cam, null, o.geometry, o.material, o);
    const cube = fireShadowLight().shadow.camera;
    aimFireShadow(0, 1, 0, 20);
    // A herd drawn wherever it is, all of it far off: not in the cube, whose faces would each draw it whole.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const herd = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 4);
    herd.frustumCulled = false;
    const m = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) herd.setMatrixAt(i, m.makeTranslation(200 + i * 3, 0, 0));
    herd.updateMatrixWorld();
    draw(cube, herd);
    draw(cube, herd);
    expect(drawn.length).toBe(0);
    // The views still draw it.
    draw(new THREE.PerspectiveCamera(), herd);
    expect(drawn.length).toBe(1);
    // One of them wanders up to the fire: the batch is in the next drawing of the cube.
    herd.setMatrixAt(2, m.makeTranslation(5, 0, 2));
    draw(cube, herd);
    expect(drawn.length).toBe(1);
    aimFireShadow(0, 1, 0, 20);
    draw(cube, herd);
    expect(drawn.length).toBe(2);
    // A lone mesh drawn without bounds goes in only within reach.
    const far = new THREE.Mesh(geo, herd.material);
    far.frustumCulled = false;
    far.position.set(0, 0, 60);
    far.updateMatrixWorld();
    draw(cube, far);
    expect(drawn.length).toBe(2);
    far.position.set(0, 0, 10);
    far.updateMatrixWorld();
    aimFireShadow(0, 1, 0, 20);
    draw(cube, far);
    expect(drawn.length).toBe(3);
    keepFireShadow(0);
  });
});
