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

/** Where a bullet lands on a car, for what it can break there. */
export type HitZone = 'engine' | 'wheel' | 'tank' | 'body';

/**
 * Small arms against a car. A round holes a panel and goes on through: it takes a great many of them to shoot a car to
 * pieces, and what one breaks is what it lands on. Only this share of a round's damage goes into the hull (scaled again by
 * how hard the round is on sheet metal).
 */
export const BULLET_HULL = 0.3;
/**
 * The share of its hit points that bullets alone never take off a car. Shot down to it, the engine dies and the car smokes,
 * but it does not blow up: that takes a blast, a crash or a fire.
 */
export const BULLET_FLOOR = 0.1;

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
  /**
   * A bullet, with how hard its round is on sheet metal (about 1 for a rifle round, a third for a pistol's). It holes the
   * panel rather than wrecking the car, and never finishes one off; what it breaks depends on `zone`.
   */
  bullet?: number;
  /** Where the bullet landed. Without it a bullet rolls for what it broke like anything else does, but seldom. */
  zone?: HitZone;
}

/** Applies a hit with armor, facing and component damage. Returns what happened for HUD and audio. */
export function applyHit(h: VehicleHealth, raw: number, o: HitOpts): { dealt: number; events: DamageEvent[] } {
  const events: DamageEvent[] = [];
  if (h.destroyed) return { dealt: 0, events };
  const plating = 0.4 + 0.6 * h.comp.plates; // damaged plates protect less
  const bonus = h.armorBonus?.[o.facing] ?? 0;
  const red = armorReduction(h.armor * plating + bonus, o.facing) * (o.ram ? 0.6 : 1);
  const bullet = o.bullet !== undefined;
  // What gets past the armour, and of that, what the hull takes.
  const through = raw * (1 - red);
  const dealt = bullet ? through * BULLET_HULL * o.bullet! : through;
  const floor = bullet ? Math.min(h.hp, h.maxHp * BULLET_FLOOR) : 0;
  h.hp = Math.max(floor, h.hp - dealt);
  h.comp.plates = Math.max(0, h.comp.plates - dealt / (h.maxHp * 1.6));

  // Component damage: bigger hits are more likely to break something. A bullet breaks what it lands on.
  const chance = clamp(dealt / (h.maxHp * 0.25), 0, 0.5) * (bullet ? 0.3 : 1);
  if (bullet && o.zone) bulletParts(h, through, o, events);
  else if (o.roll() < chance) {
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
  // Shot to pieces: the engine has taken one round too many and quits. The car is left standing.
  if (bullet && h.hp <= h.maxHp * BULLET_FLOOR + 1e-6 && h.comp.engine > 0) {
    h.comp.engine = 0;
    events.push({ kind: 'engine' });
  }
  if (h.hp <= 0) {
    h.destroyed = true;
    events.push({ kind: 'destroyed' });
  }
  return { dealt, events };
}

/**
 * What a bullet breaks where it lands, by how hard it got through the armour. A wheel's tyre goes easily; the engine bay is
 * mostly block, hoses and radiator, and takes a few rounds to stop; the tank leaks. Through a door or a wing it does nothing
 * that matters.
 */
function bulletParts(h: VehicleHealth, through: number, o: HitOpts, events: DamageEvent[]) {
  const r = o.roll();
  if (o.zone === 'wheel') {
    const w = o.wheel;
    if (w !== undefined && h.comp.tires[w] > 0 && r < clamp(through / 40, 0.2, 0.85)) {
      h.comp.tires[w] = 0;
      events.push({ kind: 'tire', wheel: w });
    }
  } else if (o.zone === 'engine') {
    // With the bonnet off there is no panel in the way.
    if (r < clamp((through / 110) * (h.engineExposed ? 1.6 : 1), 0.04, 0.6)) {
      h.comp.engine = Math.max(0, h.comp.engine - 0.25);
      h.comp.oil = Math.max(0, h.comp.oil - 0.12);
      h.comp.radiator = Math.max(0, (h.comp.radiator ?? 1) - 0.25);
      events.push({ kind: 'engine' });
    }
  } else if (o.zone === 'tank') {
    if (r < clamp(through / 70, 0.1, 0.6)) {
      if (!h.leaking) events.push({ kind: 'leak' });
      h.leaking = true;
      h.comp.tank = Math.max(0, h.comp.tank - 0.3);
    }
  }
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
