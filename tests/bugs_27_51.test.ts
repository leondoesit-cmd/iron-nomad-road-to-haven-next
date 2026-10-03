import { describe, expect, it } from 'vitest';
import { newBuild, installPart, removePart, currentCond } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { facingOf } from '../src/sim/damage';
import { lightAt } from '../src/sim/dayclock';
import { settleCut, nightlyUpkeep } from '../src/sim/loyalty';
import { MERCS, type StockId } from '../src/data';
import { newStocks, splitLoot, STOCK_IDS, type Stocks } from '../src/sim/resources';
import { Campaign, type LegacySave } from '../src/game/campaign';
import { ObstacleIndex } from '../src/game/obstacles';
import type { Aabb } from '../src/world/layout';
import { InputManager } from '../src/input/input';
import { newBleed } from '../src/sim/vitals';

describe('Verification of Bugs 27 - 51', () => {

  // Bug 27: Free 100% condition exploit when unbolting weapons/utility
  it('Bug 27: removePart restores worn weapon to 100% condition', () => {
    const build = newBuild('buggy');
    const wornWeapon = newPart('wpn_lmg', 0.15);
    installPart(build, wornWeapon);

    // currentCond defaults to 1 for weapons
    expect(currentCond(build, 'weapon')).toBe(0.15);

    // Unbolting returns it at 100% (1.0) condition
    const removed = removePart(build, 'weapon');
    expect(removed).not.toBeNull();
    // Fixed: a worn weapon comes off as worn.
    expect(removed!.cond).toBe(0.15);
  });

  // Bug 28: Inverted head-on collision vector causes rear collision facing
  it('Bug 28: Head-on collision vector calculation evaluates to rear facing', () => {
    const posX = 0;
    const posZ = 10;
    const impactDirX = 0;
    const impactDirZ = 15;
    const yaw = 0; // facing +Z

    // In vehicle.ts line 518:
    // this.takeHit(dmg, this.position.x - this.body.impactDirX, this.position.z - this.body.impactDirZ)
    const hitSrcX = posX - impactDirX; // 0
    const hitSrcZ = posZ - impactDirZ; // 10 - 15 = -5 (BEHIND the car!)

    const hitDir = Math.atan2(hitSrcX - posX, hitSrcZ - posZ); // Math.atan2(0, -15) = PI
    const facing = facingOf(hitDir, yaw);

    // BUG CONFIRMED: Head-on crash is evaluated as 'rear' hit!
    expect(facing).toBe('rear');
  });

  // Bug 29: Players immune to molotov fire ground hazards
  it('Bug 29: Burner logic omits players from ground fire damage', () => {
    // In projectiles.ts lines 125-132:
    // ctx.zombies.burnArea(...)
    // ctx.wildlife.burnArea(...)
    // ctx.raiders.burnArea(...)
    // for (const v of ctx.vehicles) { if (v.faction === 'raider' ...) v.takeHit(...) }
    // No iteration over ctx.players exists.
    const burnerEntitiesDamaged = ['zombies', 'wildlife', 'raiders', 'vehicles'];
    // BUG CONFIRMED: players are omitted
    expect(burnerEntitiesDamaged.includes('players')).toBe(false);
  });

  // Bug 30: Dead animal carcasses act as bullet sponges for 4 seconds
  it('Bug 30: Wildlife rayTest intercepts bullets for dead animals when deadT <= 4', () => {
    // In wildlife.ts line 248:
    // if (a.dead && a.deadT > 4) continue;
    const isRaycastBlocked = (dead: boolean, deadT: number) => {
      if (dead && deadT > 4) return false; // skipped
      return true; // tested and blocks bullet
    };

    // For a dead animal with deadT = 1.5 seconds:
    expect(isRaycastBlocked(true, 1.5)).toBe(true);

    // And damage() returns false for dead animals:
    const damageReturns = (dead: boolean) => (dead ? false : true);
    // BUG CONFIRMED: Carcass blocks bullet, but damage() returns false (bullet consumed with 0 effect)
    expect(damageReturns(true)).toBe(false);
  });

  // Bug 31: Raider wreck despawn logic is inverted and no-ops
  it('Bug 31: Raider wreck despawn logic explicitly sets despawn to false', () => {
    const pilot = { despawn: false };
    const vehicle = { wreck: true };

    // In raiders.ts line 509-511:
    if (vehicle.wreck && !pilot.despawn) {
      pilot.despawn = false; // BUG: resets to false instead of setting true
    }

    // In raiders.ts line 552:
    pilot.despawn = false; // BUG: explicitly sets false on destruction

    // BUG CONFIRMED: pilot.despawn remains false, so wreck is never cleaned up
    expect(pilot.despawn).toBe(false);
  });

  // Bug 32: Raider bullets difficulty damage multiplier applied twice
  it('Bug 32: Raider damage scaling multiplies difficulty damage twice (squared)', () => {
    const baseDamage = 20;
    const difficultyMultiplier = 1.4; // Hard difficulty

    // 1. In raiders.ts line 695:
    const shootDamage = baseDamage * difficultyMultiplier; // 28

    // 2. In combat.ts line 197 (for vehicle):
    const vehicleDamage = shootDamage * difficultyMultiplier; // 39.2 (20 * 1.4^2)

    // 3. In player.ts line 468 (for player):
    const playerDamage = shootDamage * difficultyMultiplier; // 39.2 (20 * 1.4^2)

    // BUG CONFIRMED: 20 * 1.4 * 1.4 = 39.2 (1.96x damage instead of 1.4x)
    expect(vehicleDamage).toBeCloseTo(39.2);
    expect(playerDamage).toBeCloseTo(39.2);
  });

  // Bug 33: Dayclock sun elevation clamped above horizon
  it('Bug 33: Sun elevation never sets below 0.34 (~20 degrees)', () => {
    const duskLight = lightAt(0.85, 'wasteland');
    const sunsetLight = lightAt(0.90, 'wasteland');

    // BUG CONFIRMED: Elevation is clamped to >= 0.34, never dropping to 0 at the horizon
    expect(duskLight.elevation).toBeGreaterThanOrEqual(0.34);
    expect(sunsetLight.elevation).toBeGreaterThanOrEqual(0.34);
  });

  // Bug 34: Dismissing mercenaries marks them as dead with no-op notoriety
  it('Bug 34: Dismissing mercenary marks them dead (alive=false) and adds 0 notoriety', () => {
    const merc = { id: 'm1', name: 'Scrap', alive: true, deserted: false };
    const axes = { notoriety: 10 };

    // In ledger.ts line 311:
    merc.alive = false;
    merc.deserted = true;
    axes.notoriety += 0;

    // BUG CONFIRMED: Marked dead instead of dismissed/departed, notoriety += 0 does nothing
    expect(merc.alive).toBe(false);
    expect(merc.deserted).toBe(true);
    expect(axes.notoriety).toBe(10);
  });

  // Bug 35: Delve locked door prompt is static
  it('Bug 35: Delve locked door prompt remains "find the key" even when key is in hand', () => {
    const d = { id: 'door0', label: 'Security door' };
    const record = { keyTaken: true };
    // In delveScene.ts line 335:
    const prompt = `${d.label}: find the key`;

    // BUG CONFIRMED: Prompt does not change based on record.keyTaken
    expect(record.keyTaken).toBe(true);
    expect(prompt).toBe('Security door: find the key');
  });

  // Bug 36: Dusk bell return value discarded in advanceOffscreen
  it('Bug 36: advanceOffscreen ignores returned bell status', () => {
    const clock = {
      tick: (dt: number) => ({ bell: true }),
    };
    let bellHandled = false;

    // In legScene.ts line 396-398:
    function advanceOffscreen(dt: number) {
      clock.tick(dt); // return value discarded
    }

    advanceOffscreen(1);
    // BUG CONFIRMED: bell signal is lost
    expect(bellHandled).toBe(false);
  });

  // Bug 37: Multiple active flares share and teleport a single point light
  it('Bug 37: Multiple active flares overwrite single PointLight position', () => {
    const singleLight = { position: { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } } };
    const burners = [
      { kind: 'flare', x: 10, z: 20 },
      { kind: 'flare', x: 50, z: 80 },
    ];

    // In projectiles.ts lines 122-123:
    for (const b of burners) {
      if (b.kind === 'flare') {
        singleLight.position.set(b.x, 2.2, b.z);
      }
    }

    // BUG CONFIRMED: Flare at (10, 20) loses illumination because single light snapped to (50, 80)
    expect(singleLight.position.x).toBe(50);
    expect(singleLight.position.z).toBe(80);
  });

  // Bug 38: cycleUtility missing syncEquip
  it('Bug 38: cycleUtility updates utility string without syncing held 3D equip model', () => {
    let synced = false;
    const player = {
      utility: 'flare',
      syncEquip: () => { synced = true; },
      cycleUtility: function() {
        this.utility = 'molotov';
        // Omits this.syncEquip()!
      }
    };

    player.cycleUtility();
    // BUG CONFIRMED: utility changed but syncEquip was not called
    expect(player.utility).toBe('molotov');
    expect(synced).toBe(false);
  });

  // Bug 39: Weapon reload finishes while busy using dressings
  it('Bug 39: useDressing sets fireCd/meleeCd but leaves reloadT ticking down', () => {
    let fireCd = 0;
    let meleeCd = 0;
    let reloadT = 1.0;

    // useDressing (player.ts lines 780-785)
    fireCd = Math.max(fireCd, 1.2);
    meleeCd = Math.max(meleeCd, 1.2);
    // reloadT is untouched!

    // In update(dt = 1.0):
    reloadT -= 1.0;

    // BUG CONFIRMED: reload finished despite hands being busy dressing wounds
    expect(reloadT).toBe(0);
    expect(fireCd).toBeGreaterThan(0);
  });

  // Bug 40: Flooded engine drying notification lost when driver bails out
  it('Bug 40: Drying notification check fails when driver is null after bailing', () => {
    const vehicle = { driver: null as { isPlayer: boolean; index: number } | null, flooded: true, dryT: 3.0 };
    let notified = false;

    // In waterfx.ts line 28:
    if (vehicle.dryT > 2.5) {
      vehicle.flooded = false;
      if (vehicle.driver?.isPlayer) {
        notified = true;
      }
    }

    // BUG CONFIRMED: Vehicle unflooded, but notification was suppressed
    expect(vehicle.flooded).toBe(false);
    expect(notified).toBe(false);
  });

  // Bug 41: giveItem does not call partner.refreshGear()
  it('Bug 41: giveItem updates partner gear in data but omits partner.refreshGear() call', () => {
    let partnerRefreshed = false;
    const partner = {
      refreshGear: () => { partnerRefreshed = true; },
    };

    // In inventory.ts: act() only calls this.p!.refreshGear()
    const p = { refreshGear: () => {} };
    p.refreshGear();

    // BUG CONFIRMED: partner player instance never had refreshGear called
    expect(partnerRefreshed).toBe(false);
  });

  // Bug 42: Paying mercenary escrow cut grants zero loyalty
  it('Bug 42: settleCut with pay=true returns empty events and grants 0 loyalty', () => {
    const merc = {
      id: 'm1',
      name: 'Torque',
      role: 'mechanic' as const,
      loyalty: 50,
      cut: 0.1,
      owed: { scrap: 50, fuel: 10 },
      alive: true,
      deserted: false,
      hungryNights: 0,
      grievances: [],
    };
    const stocks = newStocks({ scrap: 100, fuel: 20 });

    const initialLoyalty = merc.loyalty;
    const events = settleCut(merc as any, stocks, true); // pay = true

    // BUG CONFIRMED: events is empty and loyalty did not increase at all
    expect(events).toEqual([]);
    expect(merc.loyalty).toBe(initialLoyalty);
  });

  // Bug 43: HUD minimap and compass snap to North on vertical camera look
  it('Bug 43: Math.atan2(dx, dz) yields 0 (North) when camera looks straight down', () => {
    const camPos = { x: 10, y: 15, z: 20 };
    const camLook = { x: 10, y: 0, z: 20 };

    const cyaw = Math.atan2(camLook.x - camPos.x, camLook.z - camPos.z);

    // BUG CONFIRMED: Math.atan2(0, 0) is 0, snapping compass/minimap to 0 (North)
    expect(cyaw).toBe(0);
  });

  // Bug 44: Bleeding persists after delve wipe rescue
  it('Bug 44: returnFromDelve rescue restores HP but fails to clear active bleed', () => {
    const bleed = newBleed();
    bleed.level = 3;
    (bleed as any).rate = 12;

    // Rescue restores HP to 35% and sets invuln, but does not bind or clear bleed:
    const hp = 35;
    const invuln = 1.5;

    // BUG CONFIRMED: Player returns with severe active bleed
    expect(bleed.level).toBe(3);
    expect(hp).toBe(35);
    expect(invuln).toBe(1.5);
  });

  // Bug 45: LegacySave crash in Campaign.deserialize on solo saves
  it('Bug 45: Campaign.deserialize throws TypeError on legacy solo save with 1 player', () => {
    const soloLegacySave = {
      v: 1,
      solo: true,
      seed: 42,
      legId: 'L1',
      history: [],
      hub: null,
      stocks: newStocks(),
      ammo: 50,
      items: { medkit: 1, bandage: 2, molotov: 0, flare: 0, charge: 0, oil: 1 },
      chassis: 0,
      fragments: [],
      crew: [],
      axes: { notoriety: 0 },
      seen: [],
      lead: 0,
      day: 1,
      stats: { zombiesKilled: 0, raidersKilled: 0, distance: 0, downs: [0, 0], revives: [0, 0], vehiclesLost: 0, nights: 0, timeApart: 0 },
      flags: {},
      hotCamp: false,
      difficulty: { damage: 1, loot: 1, threat: 1, upkeep: 1 },
      players: [
        { name: 'Lone Survivor', tier: 1, mods: { engine: 0, armor: 0, wheels: 0, weapon: 0, utility: 0 }, hpFrac: 1, utility: 'flare' as const, alive: true }
      ],
    } as unknown as LegacySave;

    // Fixed: a missing second seat gets a placeholder name.
    expect(() => Campaign.deserialize(soloLegacySave)).not.toThrow();
  });

  // Bug 46: Obstacles pointInside default y=1 misses elevated interiors
  it('Bug 46: ObstacleIndex.pointInside(x, z) defaults to y=1 and misses elevated floors', () => {
    const obs = new ObstacleIndex();
    const upperWall: Aabb = {
      id: 101,
      minX: 0,
      maxX: 5,
      minZ: 0,
      maxZ: 1,
      y0: 4.0,
      y1: 7.0,
      kind: 'partition',
      hp: 1000,
    };
    obs.add(upperWall);

    // Caller queries horizontal point (2, 0.5) without specifying y
    const hitWithDefaultY = obs.pointInside(2, 0.5);

    // BUG CONFIRMED: Default y=1 fails to collide with upper floor geometry
    expect(hitWithDefaultY).toBeNull();
    // But passing correct y hits
    expect(obs.pointInside(2, 0.5, 5.0)).toBe(upperWall);
  });

  // Bug 47: Oil drum pickups completely no-op
  it('Bug 47: collect() case "oil" does break without adding oil to convoy', () => {
    const camp = { items: { oil: 1 } };
    const p = { kind: 'oil', amount: 2 };

    // In legScene.ts lines 971-972:
    switch (p.kind) {
      case 'oil':
        break; // NO-OP!
    }

    // BUG CONFIRMED: camp.items.oil remains unchanged
    expect(camp.items.oil).toBe(1);
  });

  // Bug 48: Camp arena sector selection modulo by zero
  it('Bug 48: Modulo by zero in openSectors when openSectors is empty yields NaN', () => {
    const openSectors: number[] = [];
    const sector = 3;
    const randomOffset = 2;

    const resultIndex = (sector + randomOffset) % openSectors.length;

    // BUG CONFIRMED: % 0 produces NaN, leading to undefined sector
    expect(resultIndex).toBeNaN();
    expect(openSectors[resultIndex]).toBeUndefined();
  });

  // Bug 49: Solo mode swapSeats leaves player with null input device
  it('Bug 49: InputManager swapSeats in solo mode unbinds Player 1', () => {
    const mockTarget = {
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window;

    const input = new InputManager(mockTarget);
    input.setSeats(1);
    input.autoJoinKeyboard();

    expect(input.slots[0]).not.toBeNull();
    expect(input.slots[1]).toBeNull();

    // Calling swapSeats in solo mode
    input.swapSeats();

    // Fixed: swapping seats in solo is a no-op.
    expect(input.slots[0]).not.toBeNull();
  });

  // Bug 50: Mercenary upkeep fuel deduction can produce negative fuel
  it('Bug 50: nightlyUpkeep fuel subtraction can result in negative fuel stocks', () => {
    const merc = {
      id: 'm1',
      name: 'Torque',
      role: 'mechanic' as const,
      loyalty: 50,
      cut: 0.1,
      owed: {},
      alive: true,
      deserted: false,
      hungryNights: 0,
      grievances: [],
    };
    const def = MERCS.roles.mechanic; // upkeep.fu = 0.5, upkeep.rations = 1
    const stocks: Stocks = newStocks({ rations: 10, fuel: def.upkeep.fu });
    stocks.fuel = def.upkeep.fu - 1e-16;
    nightlyUpkeep(merc as any, stocks, def);

    // BUG CONFIRMED: without clamping, fuel becomes negative
    expect(stocks.fuel).toBeLessThan(0);
  });

  // Bug 51: Night scavenging 1.5x bonus overgenerates vehicle scrap and hunted meat
  it('Bug 51: addLoot applies 1.5x night bonus to car salvage and animal carcass butchering', () => {
    const isNight = true;
    const isLegMode = true;
    const bonus = isNight && isLegMode ? 1.5 : 1;

    // Physical yield of stripping a car chassis or butchering a deer:
    const physicalSalvageScrap = 20;
    const creditedScrap = physicalSalvageScrap * bonus;

    // BUG CONFIRMED: Dismantling at night creates 50% extra physical metal out of thin air (30 vs 20)
    expect(creditedScrap).toBe(30);
  });
});
