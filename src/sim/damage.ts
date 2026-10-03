import { VEHICLES } from '../data';
import { clamp, wrapAngle } from '../core/math';
import { oilPower } from './oil';

export type Facing = 'front' | 'side' | 'rear';

/** Direction of a hit relative to the vehicle's heading: within 60 deg of the nose is front, behind 120 deg is rear. */
export function facingOf(hitFromYaw: number, vehicleYaw: number): Facing {
  const a = Math.abs(wrapAngle(hitFromYaw - vehicleYaw));
  if (a < Math.PI / 3) return 'front';
  if (a > (Math.PI * 2) / 3) return 'rear';
  return 'side';
}

/** Armor reduces damage by its percentage, scaled by facing. Front 100%, side 80%, rear 60%. */
export function armorReduction(armor: number, facing: Facing): number {
  return clamp(armor * VEHICLES.armorFacing[facing], 0, 0.95);
}

export interface Components {
  engine: number; // 0..1
  tires: number[]; // per wheel 0..1
  tank: number; // 0..1
  mount: number; // weapon mount 0..1
  plates: number; // armor plates 0..1 (loses protection as it falls)
  /** Engine oil in the sump, 0..1. */
  oil: number;
  /** Radiator condition, 0..1: a holed core sheds less heat. */
  radiator: number;
  /** Gearbox condition, 0..1. */
  gearbox: number;
  /** Water in the cooling system, 0..1. */
  coolant: number;
}

export interface VehicleHealth {
  hp: number;
  maxHp: number;
  armor: number;
  comp: Components;
  leaking: boolean;
  burning: boolean;
  destroyed: boolean;
  /** Extra armour from bolt-on parts, by the side the hit lands on (bull bar, side plates). */
  armorBonus?: { front: number; side: number; rear: number };
  /** The bonnet is off: the engine is out in the open and takes more of what lands on the front. */
  engineExposed?: boolean;
}

export function newHealth(maxHp: number, armor: number, wheels: number): VehicleHealth {
  return {
    hp: maxHp,
    maxHp,
    armor,
    comp: { engine: 1, tires: new Array(wheels).fill(1), tank: 1, mount: 1, plates: 1, oil: 1, radiator: 1, gearbox: 1, coolant: 1 },
    leaking: false,
    burning: false,
    destroyed: false,
  };
}

export type DamageEvent =
  | { kind: 'engine' }
  | { kind: 'tire'; wheel: number }
  | { kind: 'leak' }
  | { kind: 'fire' }
  | { kind: 'mount' }
  | { kind: 'destroyed' };

export interface HitOpts {
  facing: Facing;
  /** 0..1 deterministic rolls so replays reproduce the same component damage. */
  roll: () => number;
  /** Explosive or fire damage can ignite a leaking tank. */
  incendiary?: boolean;
  /** Raw kinetic ram damage ignores plating only partially. */
  ram?: boolean;
  /** Which wheel to target, if known (spikes, rear tire shots). */
  wheel?: number;
}

/** Applies a hit with armor, facing and component damage. Returns what happened for HUD and audio. */
export function applyHit(h: VehicleHealth, raw: number, o: HitOpts): { dealt: number; events: DamageEvent[] } {
  const events: DamageEvent[] = [];
  if (h.destroyed) return { dealt: 0, events };
  const plating = 0.4 + 0.6 * h.comp.plates; // damaged plates protect less
  const bonus = h.armorBonus?.[o.facing] ?? 0;
  const red = armorReduction(h.armor * plating + bonus, o.facing) * (o.ram ? 0.6 : 1);
  const dealt = raw * (1 - red);
  h.hp = Math.max(0, h.hp - dealt);
  h.comp.plates = Math.max(0, h.comp.plates - dealt / (h.maxHp * 1.6));

  // Component damage: bigger hits are more likely to break something.
  const chance = clamp(dealt / (h.maxHp * 0.25), 0, 0.5);
  if (o.roll() < chance) {
    const r = o.roll();
    // With the bonnet off the engine sits right behind whatever hits the front.
    const eT = h.engineExposed && o.facing === 'front' ? 0.5 : 0.3;
    if (o.wheel !== undefined && h.comp.tires[o.wheel] > 0) {
      h.comp.tires[o.wheel] = 0;
      events.push({ kind: 'tire', wheel: o.wheel });
    } else if (r < eT) {
      h.comp.engine = Math.max(0, h.comp.engine - 0.35);
      // A holed block bleeds its oil, and the shrapnel finds the radiator too.
      h.comp.oil = Math.max(0, h.comp.oil - 0.2);
      h.comp.radiator = Math.max(0, (h.comp.radiator ?? 1) - 0.25);
      events.push({ kind: 'engine' });
    } else if (r < eT + 0.3) {
      const w = Math.floor(o.roll() * h.comp.tires.length);
      if (h.comp.tires[w] > 0) {
        h.comp.tires[w] = 0;
        events.push({ kind: 'tire', wheel: w });
      }
    } else if (r < eT + 0.5) {
      if (!h.leaking) events.push({ kind: 'leak' });
      h.leaking = true;
      h.comp.tank = Math.max(0, h.comp.tank - 0.3);
    } else {
      h.comp.mount = Math.max(0, h.comp.mount - 0.5);
      events.push({ kind: 'mount' });
    }
  }
  if (o.incendiary && (h.leaking || o.roll() < 0.35) && !h.burning) {
    h.burning = true;
    events.push({ kind: 'fire' });
  }
  if (h.hp <= 0) {
    h.destroyed = true;
    events.push({ kind: 'destroyed' });
  }
  return { dealt, events };
}

/** Speed and acceleration lost to a damaged engine and flat tires. */
export function performance(h: VehicleHealth): { power: number; grip: number } {
  const flats = h.comp.tires.filter((t) => t <= 0).length;
  const frac = h.comp.tires.length ? flats / h.comp.tires.length : 0;
  return {
    power: (0.45 + 0.55 * h.comp.engine) * (1 - 0.35 * frac) * oilPower(h.comp.oil ?? 1),
    grip: 1 - 0.55 * frac,
  };
}

/** Fire adds damage over time until repaired (or it burns out). */
export function tickHazards(h: VehicleHealth, dt: number): { fuelLeak: number; fireDamage: number } {
  let fireDamage = 0;
  if (h.burning && !h.destroyed) {
    fireDamage = 6 * dt;
    h.hp = Math.max(0, h.hp - fireDamage);
    if (h.hp <= 0) h.destroyed = true;
  }
  return { fuelLeak: h.leaking && !h.destroyed ? 0.15 * dt : 0, fireDamage };
}

/** Field repair: 10% HP plus one component fix. Fire and leaks first, then tires, then engine, then the mount. */
export function repairStep(h: VehicleHealth): string {
  if (h.destroyed) return 'none';
  h.hp = Math.min(h.maxHp, h.hp + h.maxHp * 0.1);
  h.comp.plates = Math.min(1, h.comp.plates + 0.1);
  if (h.burning) {
    h.burning = false;
    return 'fire';
  }
  if (h.leaking) {
    h.leaking = false;
    h.comp.tank = 1;
    return 'leak';
  }
  const flat = h.comp.tires.findIndex((t) => t <= 0);
  if (flat >= 0) {
    h.comp.tires[flat] = 1;
    return 'tire';
  }
  if (h.comp.engine < 1) {
    h.comp.engine = Math.min(1, h.comp.engine + 0.5);
    return 'engine';
  }
  if ((h.comp.radiator ?? 1) < 1) {
    h.comp.radiator = Math.min(1, (h.comp.radiator ?? 1) + 0.6);
    return 'radiator';
  }
  if ((h.comp.gearbox ?? 1) < 1) {
    h.comp.gearbox = Math.min(1, (h.comp.gearbox ?? 1) + 0.6);
    return 'gearbox';
  }
  if (h.comp.mount < 1) {
    h.comp.mount = 1;
    return 'mount';
  }
  return 'hp';
}

/** Fix one broken component without touching HP. Returns what was fixed, or 'none'. */
export function fixOneComponent(h: VehicleHealth): string {
  if (h.destroyed) return 'none';
  if (h.burning) {
    h.burning = false;
    return 'fire';
  }
  if (h.leaking) {
    h.leaking = false;
    h.comp.tank = 1;
    return 'leak';
  }
  const flat = h.comp.tires.findIndex((t) => t <= 0);
  if (flat >= 0) {
    h.comp.tires[flat] = 1;
    return 'tire';
  }
  if (h.comp.engine < 1) {
    h.comp.engine = Math.min(1, h.comp.engine + 0.5);
    return 'engine';
  }
  if ((h.comp.radiator ?? 1) < 1) {
    h.comp.radiator = Math.min(1, (h.comp.radiator ?? 1) + 0.6);
    return 'radiator';
  }
  if ((h.comp.gearbox ?? 1) < 1) {
    h.comp.gearbox = Math.min(1, (h.comp.gearbox ?? 1) + 0.6);
    return 'gearbox';
  }
  if (h.comp.mount < 1) {
    h.comp.mount = 1;
    return 'mount';
  }
  return 'none';
}

export function needsRepair(h: VehicleHealth) {
  return (
    h.hp < h.maxHp - 0.5 ||
    h.burning ||
    h.leaking ||
    h.comp.engine < 1 ||
    (h.comp.radiator ?? 1) < 0.7 ||
    (h.comp.gearbox ?? 1) < 0.7 ||
    h.comp.mount < 1 ||
    h.comp.tires.some((t) => t <= 0)
  );
}

/** Collision damage by relative speed and mass ratio. Returns damage for the lighter-weighted side. */
export function collisionDamage(relSpeed: number, selfMass: number, otherMass: number): number {
  if (relSpeed < 6) return 0;
  const ratio = otherMass / (selfMass + otherMass);
  return Math.max(0, (relSpeed - 6) * 3.2 * (0.3 + ratio * 1.4));
}
