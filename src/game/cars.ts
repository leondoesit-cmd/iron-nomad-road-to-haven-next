import * as THREE from 'three';
import { modelKey } from '../render/workFx';
import { sitePos } from './hauling';
import { newPart, partName, type PartItem } from '../sim/parts';
import { colorName } from '../sim/paint';
import { rollCar, type CarStatus } from '../sim/cars';
import { SALVAGE_STAGES, lootText, salvageLoot, type SalvageCtx, type SalvageKind } from '../sim/salvage';
import { newAabbId, type Aabb, type CarSpawn } from '../world/layout';
import type { VehicleBuild } from '../sim/garage';
import type { Ctx } from './ctx';
import type { Player } from './player';
import type { Vehicle } from './vehicle';

/** A world car that may or may not currently be a live vehicle. */
interface CarState {
  spawn: CarSpawn;
  build: VehicleBuild;
  status: CarStatus;
  /** Salvage stages already stripped. */
  salvaged: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  live: Vehicle | null;
}

/** Cars appear as the convoy approaches and are put away again, with their state, once it has moved on. */
const SPAWN_R = 175;
const DESPAWN_R = 250;

/**
 * Every abandoned car in the world. They are spawned as real vehicles near the players (so they can be driven,
 * shot, rammed and repaired) and stored as plain state when far away, so the world can hold hundreds.
 * Also owns the shared car interactions: claiming, stripping for parts, and the obstacle boxes parked cars leave behind.
 */
export class CarField {
  states = new Map<string, CarState>();
  private obstacles = new Map<Vehicle, { a: Aabb; x: number; z: number; yaw: number }>();
  private t = 0;
  private obsT = 0;
  /** Spawn everything at once, for the small fixed camp arena. */
  everything = false;

  constructor(private ctx: Ctx) {}

  add(spawn: CarSpawn) {
    if (this.states.has(spawn.id)) return;
    const roll = rollCar(spawn.seed, { biome: this.ctx.biome, chassis: spawn.chassis, status: spawn.status });
    this.states.set(spawn.id, { spawn, build: roll.build, status: roll.status, salvaged: 0, x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw, live: null });
  }

  /** A car that has been claimed leaves the world's care: the convoy owns it now. */
  private forget(v: Vehicle) {
    const st = this.states.get(v.carId);
    if (st) this.states.delete(v.carId);
    v.carId = '';
  }

  stateOf(v: Vehicle): CarState | null {
    return v.carId ? (this.states.get(v.carId) ?? null) : null;
  }

  update(dt: number) {
    this.t -= dt;
    this.obsT -= dt;
    if (this.t <= 0) {
      this.t = 0.4;
      this.stream();
    }
    if (this.obsT <= 0) {
      this.obsT = 0.25;
      this.syncObstacles();
    }
  }

  private stream() {
    const ctx = this.ctx;
    const pts = ctx.players.map((p) => (p.vehicle ? p.vehicle.position : p.pos));
    for (const st of this.states.values()) {
      let d = Infinity;
      for (const p of pts) d = Math.min(d, Math.hypot(p.x - st.x, p.z - st.z));
      if (!st.live) {
        if ((this.everything || d < SPAWN_R) && (ctx.colliderReady?.(st.x, st.z) ?? true)) this.spawn(st);
      } else if (!this.everything && d > DESPAWN_R && !st.live.driver && !st.live.passenger) this.despawn(st);
    }
  }

  private spawn(st: CarState) {
    const ctx = this.ctx;
    const v = ctx.spawnVehicle({ build: st.build, x: st.x, y: st.y, z: st.z, yaw: st.yaw, ownerIndex: -1, faction: 'neutral', hulk: st.status === 'hulk' });
    v.carId = st.spawn.id;
    v.salvaged = st.salvaged;
    st.live = v;
  }

  private despawn(st: CarState) {
    const v = st.live;
    if (!v) return;
    // Claimed or reclassified in the meantime: not ours to put away.
    if (v.faction !== 'neutral') {
      st.live = null;
      return;
    }
    if (v.wreck) st.status = 'hulk';
    else v.commit();
    const p = v.position;
    st.x = p.x;
    st.y = p.y;
    st.z = p.z;
    st.yaw = v.yaw;
    st.salvaged = v.salvaged;
    this.dropObstacle(v);
    const i = this.ctx.vehicles.indexOf(v);
    if (i >= 0) this.ctx.vehicles.splice(i, 1);
    v.destroy();
    st.live = null;
  }

  /** Put every live car away (end of a scene): their state is kept so a save mid-leg would not lose a stripped car. */
  clear() {
    for (const st of this.states.values()) if (st.live) this.despawn(st);
    for (const o of this.obstacles.values()) this.ctx.obs.remove(o.a);
    this.obstacles.clear();
  }

  // ------------------------------------------------------------------ obstacles

  /** Parked and wrecked vehicles block zombies and cover shots, like the old car props did. */
  private syncObstacles() {
    const ctx = this.ctx;
    const live = new Set<Vehicle>();
    for (const v of ctx.vehicles) {
      if (v.faction === 'raider' && !v.wreck) continue;
      if (v.kind === 'crew') continue;
      // Only cars and wrecks leave obstacle boxes behind; a moored boat does not.
      if (!v.build && !v.wreck) continue;
      const parked = !v.driver && !v.passenger && Math.abs(v.speed) < 0.6 && v.body.grounded > 0;
      if (!parked) continue;
      live.add(v);
      const p = v.position;
      const yaw = v.yaw;
      const e = this.obstacles.get(v);
      if (e && Math.hypot(e.x - p.x, e.z - p.z) < 0.35 && Math.abs(e.yaw - yaw) < 0.12) continue;
      if (e) ctx.obs.remove(e.a);
      const s = Math.abs(Math.sin(yaw));
      const c = Math.abs(Math.cos(yaw));
      const hl = v.def.length / 2 - 0.1;
      const hw = v.def.width / 2 - 0.05;
      const hx = s * hl + c * hw;
      const hz = c * hl + s * hw;
      const a: Aabb = { id: newAabbId(), minX: p.x - hx, maxX: p.x + hx, minZ: p.z - hz, maxZ: p.z + hz, y0: 0, y1: Math.min(2.2, v.def.physics.halfExtents[1] * 2 + 0.9), kind: 'car', hp: 9999 };
      ctx.obs.add(a);
      this.obstacles.set(v, { a, x: p.x, z: p.z, yaw });
    }
    for (const [v, e] of this.obstacles) {
      if (live.has(v)) continue;
      ctx.obs.remove(e.a);
      this.obstacles.delete(v);
    }
  }

  private dropObstacle(v: Vehicle) {
    const e = this.obstacles.get(v);
    if (!e) return;
    this.ctx.obs.remove(e.a);
    this.obstacles.delete(v);
  }

  // ------------------------------------------------------------------ claiming

  /** Sitting down in an abandoned car makes it yours. */
  claim(v: Vehicle, p: Player) {
    if (v.faction !== 'neutral' || !v.build || v.wreck) return;
    const name = v.def.name;
    this.forget(v);
    v.claim(p.index);
    this.dropObstacle(v);
    this.ctx.campaign.adopt(v.build);
    p.note(`${name} joins the convoy`, 'good');
    this.ctx.radio(`${p.name} takes a ${name.toLowerCase()}.`);
  }

  // ------------------------------------------------------------------ salvage

  /** Is there anything left to strip, and may this vehicle be stripped at all? */
  canSalvage(v: Vehicle): boolean {
    if (v.salvaged >= SALVAGE_STAGES.length) return false;
    if (v.faction === 'convoy' && !v.wreck) return false;
    if (v.faction === 'raider' && !v.wreck) return false;
    return v.faction === 'neutral' || v.wreck;
  }

  nextStage(v: Vehicle) {
    return SALVAGE_STAGES[v.salvaged] ?? null;
  }

  private kindOf(v: Vehicle): SalvageKind {
    if (v.faction === 'raider') return v.kind === 'wagon' ? 'wagon' : 'raider';
    if (v.faction === 'convoy') return 'convoy';
    return 'car';
  }

  /** Strip one stage: take its loot and leave the car visibly worse. Returns the toast text. */
  salvage(v: Vehicle, p: Player): string {
    const ctx = this.ctx;
    const stage = v.salvaged;
    const b = v.build;
    const c: SalvageCtx = {
      seed: b?.seed ?? v.id * 977,
      kind: this.kindOf(v),
      chassis: v.def.id,
      burnt: v.wreck,
      fit: b ? { ...b.fit } : undefined,
      tyres: b ? [...b.tyres] : undefined,
      comp: b?.comp,
      progress: ctx.gearProgress,
    };
    const loot = salvageLoot(stage, c);
    const stocks = { ...loot.stocks };
    if (Object.keys(stocks).length) ctx.addLoot(stocks, 'salvage');
    if (loot.ammo) ctx.campaign.ammo += loot.ammo;
    const kept: PartItem[] = [];
    let scrapped = 0;
    for (const it of loot.items) {
      const r = ctx.campaign.addPart(it);
      if (r.stored) kept.push(it);
      else scrapped += r.scrap;
    }
    const oil = loot.oil > 0 ? ctx.campaign.stowOil(loot.oil) : 0;
    if (loot.water) ctx.campaign.stowWater(loot.water);
    let text = lootText({ ...loot, items: kept, oil }, partName);
    if (scrapped) text += `${text === 'Nothing worth taking' ? '' : ', '}${scrapped} Scrap (no room for the rest)`;
    p.note(text, kept.length || scrapped ? 'good' : 'info');
    if (loot.gear) ctx.addGear(p, loot.gear);
    if (loot.paint) {
      // A spray can rolls out of the glovebox and lands at the searcher's feet.
      ctx.loose?.drop(p.pos.x + Math.sin(p.yaw) * 1.3, p.pos.z + Math.cos(p.yaw) * 1.3, { kind: 'paint', color: loot.paint.color, charges: loot.paint.charges });
      p.note(`A spray can (${colorName(loot.paint.color)}): pick it up and paint a panel`, 'good');
    }
    {
      const site = sitePos(v, (['wheel', 'hood', 'flank', 'rear'] as const)[Math.min(3, stage)]);
      const hand = new THREE.Vector3(p.pos.x, p.pos.y + 1, p.pos.z);
      ctx.work.burst(site, 1, 0.9);
      if (kept.length) ctx.work.spill(kept.map(modelKey), site, hand);
      if (text !== 'Nothing worth taking') ctx.work.label(text, '#ffd27a', site.clone().add(new THREE.Vector3(0, 0.9, 0)));
    }
    // What the car loses.
    if (b) {
      if (stage === 0) {
        // Every tyre is off: bare hubs.
        b.tyres = b.tyres.map(() => newPart('tyre_none', 1));
        v.health.comp.tires = v.health.comp.tires.map(() => 0);
      } else if (stage === 1) {
        for (const [slot, none] of [['gearbox', 'gbx_none'], ['exhaust', 'exh_none']] as const) b.fit[slot] = newPart(none, 1);
        v.health.comp.gearbox = 0;
        // The engine is out: the bay is empty, not back to a factory motor that was never there.
        b.fit.engine = newPart('eng_none', 1);
        v.health.comp.engine = 0;
        v.engineOn = false;
      } else if (stage === 2) {
        for (const s of ['armor', 'weapon', 'utility', 'front', 'roof', 'rear', 'side'] as const) delete b.fit[s];
        // And the radiator behind the grille comes out with the front end.
        b.fit.cooling = newPart('rad_none', 1);
        v.health.comp.radiator = 0;
        v.health.comp.coolant = 0;
        for (const [slot, none] of [['hood', 'hood_none'], ['doorL', 'door_none'], ['doorR', 'door_none'], ['suspension', 'sus_none'], ['brakes', 'brk_none']] as const) {
          if ((v.def.slots ?? []).includes(slot)) b.fit[slot] = newPart(none, 1);
        }
        v.health.hp = Math.min(v.health.hp, v.health.maxHp * 0.12);
        v.health.comp.plates = 0.1;
      }
      if (stage <= 2) v.refit();
    }
    v.salvaged = stage + 1;
    const st = this.stateOf(v);
    if (st) st.salvaged = v.salvaged;
    const pos = v.position;
    ctx.fx.spark(pos.x, pos.y + 0.8, pos.z, 8, 5);
    ctx.audio.play('crash', pos.x, pos.z, 0.5);
    if (v.salvaged >= SALVAGE_STAGES.length) p.note('Nothing left but the shell', 'info');
    return text;
  }

  /** For the HUD: what a vehicle is, in a few words. */
  describe(v: Vehicle): string {
    if (v.wreck) return v.salvaged >= SALVAGE_STAGES.length ? 'STRIPPED HULK' : 'WRECK';
    if (v.faction === 'neutral') return 'ABANDONED';
    if (v.faction === 'raider') return 'RAIDER';
    return 'CONVOY';
  }
}

