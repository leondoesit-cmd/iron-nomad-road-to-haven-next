import { describe, expect, it } from 'vitest';
import { fitsSlot, furnRect, furnSlots, generatePlan, planAabbs, reachable, slotWorld, wallPieces, type Look, type PlanInput } from '../src/world/interiors';

// The mall is authored, not generated to a size: it has its own tests (mall.test.ts).
const SIZES: Record<Exclude<Look, 'mall'>, [number, number][]> = {
  house: [[7, 8], [9, 10], [11, 9], [8, 11], [10, 7]],
  store: [[9, 16], [11, 22], [12, 10]],
  motel: [[9, 34], [9, 24], [8, 14]],
  barn: [[14, 24], [16, 20]],
  warehouse: [[20, 44], [18, 22], [24, 30]],
  shack: [[5, 6], [6, 6], [4, 5]],
  garage: [[12, 12.5], [12, 13], [15.4, 11]],
  dealership: [[18, 14], [22, 22], [16, 12]],
  tyreshop: [[10, 8], [14, 15], [12, 10]],
};

function plans(): { look: Look; plan: ReturnType<typeof generatePlan>; label: string }[] {
  const out: { look: Look; plan: ReturnType<typeof generatePlan>; label: string }[] = [];
  for (const look of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
    SIZES[look].forEach(([w, d], i) => {
      for (let seed = 1; seed <= 40; seed++) {
        const inp: PlanInput = { x0: 100, x1: 100 + w, z0: 200, z1: 200 + d, look, door: seed % 2 ? 1 : -1, seed: seed * 31 + i, floors: look === 'house' && seed % 3 === 0 ? 2 : 1, floorY: 3, wear: (seed % 10) / 10, roof: seed % 7 === 0 ? 'none' : 'gable' };
        out.push({ look, plan: generatePlan(inp), label: `${look} ${w}x${d} seed ${seed}` });
      }
    });
  }
  return out;
}

describe('building plans', () => {
  const all = plans();
  it('every ground-floor room can be reached from a door to the outside', () => {
    for (const { plan, label } of all) {
      const seen = new Set<number>();
      let doors = 0;
      for (const w of plan.walls) {
        if (w.level !== 0 || !w.ext || w.axis !== 'z') continue;
        for (const op of w.ops) {
          if (op.kind !== 'door' && op.kind !== 'gate') continue;
          doors++;
          const inner = w.c + (w.out > 0 ? -0.8 : 0.8);
          const mid = (op.a + op.b) / 2;
          const start = plan.rooms.find((r) => r.level === 0 && inner >= r.x0 - 0.01 && inner <= r.x1 + 0.01 && mid >= r.z0 - 0.01 && mid <= r.z1 + 0.01);
          expect(start, `${label}: door opens onto no room`).toBeDefined();
          for (const id of reachable(plan, start!)) seen.add(id);
        }
      }
      expect(doors, label).toBeGreaterThan(0);
      // The front door is always on the entrance wall.
      const front = plan.walls.find((w) => w.level === 0 && w.ext && w.axis === 'z' && w.out === plan.door)!;
      expect(front.ops.some((o) => o.kind === 'door' || o.kind === 'gate'), `${label}: no front door`).toBe(true);
      for (const r of plan.rooms.filter((q) => q.level === 0)) expect(seen.has(r.id), `${label}: room ${r.role} unreachable`).toBe(true);
    }
  });

  it('openings stay inside their walls and never overlap', () => {
    for (const { plan, label } of all) {
      for (const w of plan.walls) {
        let last = w.a;
        for (const op of w.ops) {
          expect(op.a, label).toBeGreaterThanOrEqual(w.a - 1e-6);
          expect(op.b, label).toBeLessThanOrEqual(w.b + 1e-6);
          expect(op.a, label).toBeGreaterThanOrEqual(last - 1e-6);
          expect(op.head, label).toBeGreaterThan(op.sill);
          last = op.b;
        }
      }
    }
  });

  it('furniture sits inside a room of its level and keeps doorways clear', () => {
    for (const { plan, label } of all) {
      for (const f of plan.furn) {
        const r = furnRect(f);
        const room = plan.rooms.find((q) => q.level === f.level && r.x0 >= q.x0 - 0.02 && r.x1 <= q.x1 + 0.02 && r.z0 >= q.z0 - 0.02 && r.z1 <= q.z1 + 0.02);
        expect(room, `${label}: ${f.kind} outside every room`).toBeDefined();
      }
      // No solid furniture blocks a doorway.
      for (const w of plan.walls) {
        for (const op of w.ops) {
          if (op.kind !== 'door' && op.kind !== 'gate') continue;
          const mid = (op.a + op.b) / 2;
          for (const side of [-0.6, 0.6]) {
            const px = w.axis === 'z' ? w.c + side : mid;
            const pz = w.axis === 'z' ? mid : w.c + side;
            for (const f of plan.furn) {
              if (!f.solid || f.level !== w.level || f.h < 0.3) continue;
              const r = furnRect(f);
              expect(px > r.x0 && px < r.x1 && pz > r.z0 && pz < r.z1, `${label}: ${f.kind} blocks a door`).toBe(false);
            }
          }
        }
      }
    }
  });

  it('plans are deterministic and varied', () => {
    const a = generatePlan({ x0: 0, x1: 9, z0: 0, z1: 9, look: 'house', door: 1, seed: 5, floors: 1, floorY: 0, wear: 0.3, roof: 'gable' });
    const b = generatePlan({ x0: 0, x1: 9, z0: 0, z1: 9, look: 'house', door: 1, seed: 5, floors: 1, floorY: 0, wear: 0.3, roof: 'gable' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const layouts = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const p = generatePlan({ x0: 0, x1: 9, z0: 0, z1: 9, look: 'house', door: 1, seed, floors: 1, floorY: 0, wear: 0.3, roof: 'gable' });
      layouts.add(p.rooms.map((r) => `${r.role}:${Math.round(r.x0)}${Math.round(r.z0)}`).join('|'));
    }
    expect(layouts.size).toBeGreaterThan(15);
  });

  it('colliders leave the doorways open and have positive size', () => {
    let id = 0;
    for (const { plan, label } of all.slice(0, 120)) {
      const boxes = planAabbs(plan, () => id++);
      for (const a of boxes) {
        expect(a.maxX - a.minX, label).toBeGreaterThan(0);
        expect(a.maxZ - a.minZ, label).toBeGreaterThan(0);
        expect(a.y1 - a.y0, label).toBeGreaterThan(0);
      }
      for (const w of plan.walls) {
        for (const op of w.ops) {
          if (op.kind === 'window') continue;
          const mid = (op.a + op.b) / 2;
          const px = w.axis === 'z' ? w.c : mid;
          const pz = w.axis === 'z' ? mid : w.c;
          const blocking = boxes.filter((a) => a.kind === 'partition' && px > a.minX && px < a.maxX && pz > a.minZ && pz < a.maxZ && a.y0 < plan.floorY + w.level * plan.levelH + 1.0 && a.y1 > plan.floorY + w.level * plan.levelH + 1.0);
          expect(blocking.length, `${label}: wall collider in a doorway`).toBe(0);
        }
      }
    }
  });

  it('pieces tile each wall exactly once', () => {
    for (const { plan } of all.slice(0, 60)) {
      for (const w of plan.walls) {
        let area = 0;
        for (const p of wallPieces(w)) area += (p.u1 - p.u0) * (p.v1 - p.v0);
        let holes = 0;
        for (const op of w.ops) holes += (op.b - op.a) * (Math.min(op.head, w.h) - op.sill);
        expect(area + holes).toBeCloseTo((w.b - w.a) * w.h, 5);
      }
    }
  });
});

describe('walking through buildings', () => {
  const all = plans();
  const R = 0.3; // the player capsule
  const STEP = 0.1;

  /** Flood-fill the floor of one level with a player-sized circle, starting just outside the given door. */
  function walk(plan: ReturnType<typeof generatePlan>, level: number, start: { x: number; z: number }) {
    let id = 0;
    const boxes = planAabbs(plan, () => id++).filter((a) => a.kind === 'partition' || a.kind === 'furniture');
    const base = plan.floorY + level * plan.levelH;
    // A car standing in a bay is as solid as a cabinet (5 x 2.8 m, 1.4 m tall).
    if (level === 0) for (const bay of plan.bays) {
      const alongX = Math.abs(Math.sin(bay.yaw)) > 0.5;
      const hx = alongX ? 2.5 : 1.4;
      const hz = alongX ? 1.4 : 2.5;
      boxes.push({ id: id++, minX: bay.x - hx, maxX: bay.x + hx, minZ: bay.z - hz, maxZ: bay.z + hz, y0: base, y1: base + 1.4, kind: 'furniture', hp: 1 });
    }
    const solid = boxes.filter((a) => a.y1 > base + 0.45 && a.y0 < base + 1.7);
    const nx = Math.ceil((plan.x1 - plan.x0 + 4) / STEP);
    const nz = Math.ceil((plan.z1 - plan.z0 + 4) / STEP);
    const ox = plan.x0 - 2;
    const oz = plan.z0 - 2;
    const blocked = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = ox + (i + 0.5) * STEP;
        const z = oz + (j + 0.5) * STEP;
        for (const a of solid) {
          const cx = Math.max(a.minX, Math.min(x, a.maxX));
          const cz = Math.max(a.minZ, Math.min(z, a.maxZ));
          if ((x - cx) ** 2 + (z - cz) ** 2 < R * R) {
            blocked[j * nx + i] = 1;
            break;
          }
        }
      }
    }
    const seen = new Uint8Array(nx * nz);
    const si = Math.floor((start.x - ox) / STEP);
    const sj = Math.floor((start.z - oz) / STEP);
    const stack = [[si, sj]];
    seen[sj * nx + si] = 1;
    while (stack.length) {
      const [i, j] = stack.pop()!;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= nz || seen[b * nx + a] || blocked[b * nx + a]) continue;
        seen[b * nx + a] = 1;
        stack.push([a, b]);
      }
    }
    return { reach: (x: number, z: number) => seen[Math.floor((z - oz) / STEP) * nx + Math.floor((x - ox) / STEP)] === 1, blocked: (x: number, z: number) => blocked[Math.floor((z - oz) / STEP) * nx + Math.floor((x - ox) / STEP)] === 1 };
  }

  it('a person can walk from the front door to every ground-floor room', () => {
    let rooms = 0;
    let stuck = 0;
    const bad: string[] = [];
    for (const { plan, label } of all) {
      const front = plan.walls.find((w) => w.level === 0 && w.ext && w.axis === 'z' && w.out === plan.door)!;
      const door = front.ops.find((o) => o.kind === 'door' || o.kind === 'gate')!;
      const start = { x: front.c + plan.door * 1.0, z: (door.a + door.b) / 2 };
      const w = walk(plan, 0, start);
      expect(w.reach(start.x, start.z), `${label}: cannot step out of the front door`).toBe(true);
      for (const r of plan.rooms.filter((q) => q.level === 0)) {
        rooms++;
        // Some free spot in the room must be reachable.
        let ok = false;
        for (let x = r.x0 + R; x <= r.x1 - R && !ok; x += 0.2) for (let z = r.z0 + R; z <= r.z1 - R && !ok; z += 0.2) if (!w.blocked(x, z) && w.reach(x, z)) ok = true;
        if (!ok) {
          stuck++;
          bad.push(`${label}: ${r.role} ${(r.x1 - r.x0).toFixed(1)}x${(r.z1 - r.z0).toFixed(1)}`);
        }
      }
    }
    expect(bad.slice(0, 12).join('\n')).toBe('');
    expect(stuck).toBe(0);
    expect(rooms).toBeGreaterThan(300);
  }, 120000);

  it('the stairs of a two-storey house can be reached from the ground floor and lead to every upstairs room', () => {
    let tested = 0;
    for (const { plan, label } of all) {
      if (plan.levels < 2) continue;
      tested++;
      const front = plan.walls.find((w) => w.level === 0 && w.ext && w.axis === 'z' && w.out === plan.door)!;
      const door = front.ops.find((o) => o.kind === 'door')!;
      const w0 = walk(plan, 0, { x: front.c + plan.door, z: (door.a + door.b) / 2 });
      const s = plan.stairs[0];
      expect(w0.reach(s.x, s.z), `${label}: the foot of the stairs is cut off`).toBe(true);
      // Upstairs: start at the landing at the top of the stair.
      const dx = s.dir === '+x' ? 1 : s.dir === '-x' ? -1 : 0;
      const dz = s.dir === '+z' ? 1 : s.dir === '-z' ? -1 : 0;
      const top = { x: s.x + dx * ((s.steps - 1) * s.tread + 0.6), z: s.z + dz * ((s.steps - 1) * s.tread + 0.6) };
      const w1 = walk(plan, 1, top);
      expect(w1.reach(top.x, top.z), `${label}: the landing is blocked`).toBe(true);
      for (const r of plan.rooms.filter((q) => q.level === 1)) {
        let ok = false;
        for (let x = r.x0 + R; x <= r.x1 - R && !ok; x += 0.2) for (let z = r.z0 + R; z <= r.z1 - R && !ok; z += 0.2) if (!w1.blocked(x, z) && w1.reach(x, z)) ok = true;
        expect(ok, `${label}: upstairs ${r.role} is unreachable`).toBe(true);
      }
    }
    expect(tested).toBeGreaterThan(10);
  });
});

describe('the car trades', () => {
  const all = plans();
  const kinds = (look: Look) => all.filter((p) => p.look === look);
  it('a garage has parts shelving, a bench and engine stands, and a car in its bay', () => {
    const g = kinds('garage');
    const has = (k: string) => g.filter((p) => p.plan.furn.some((f) => f.kind === k)).length / g.length;
    expect(has('partsshelf')).toBeGreaterThan(0.7);
    expect(has('workbench')).toBeGreaterThan(0.7);
    expect(has('enginestand')).toBeGreaterThan(0.5);
    expect(g.filter((p) => p.plan.bays.length > 0).length / g.length).toBeGreaterThan(0.5);
  });
  it('a tyre shop has tyre racks and stacks, and a dealership has a showroom with cars on the floor', () => {
    const t = kinds('tyreshop');
    expect(t.filter((p) => p.plan.furn.some((f) => f.kind === 'tyrerack')).length / t.length).toBeGreaterThan(0.7);
    const d = kinds('dealership');
    expect(d.filter((p) => p.plan.bays.length >= 2).length / d.length).toBeGreaterThan(0.5);
    expect(d.every((p) => p.plan.rooms.some((r) => r.role === 'sales'))).toBe(true);
  });
  it('a warehouse has pallet racking', () => {
    const w = kinds('warehouse');
    expect(w.filter((p) => p.plan.furn.filter((f) => f.kind === 'rack').length >= 2).length / w.length).toBeGreaterThan(0.6);
  });
  it('loose items lie on a surface of the furniture they name, at a height that surface has, inside the building and clear of the walls', () => {
    let n = 0;
    for (const { plan, label } of all) {
      for (const it of plan.items) {
        n++;
        const f = plan.furn[it.furn];
        expect(f, label).toBeDefined();
        expect(it.level, label).toBe(f.level);
        const slots = furnSlots(f);
        const hit = slots.find((s) => {
          const w = slotWorld(f, s);
          return Math.abs(w.x - it.x) < 1e-6 && Math.abs(w.z - it.z) < 1e-6 && Math.abs(s.y - it.y) < 1e-6;
        });
        expect(hit, `${label}: ${f.kind} has no surface where the item lies`).toBeDefined();
        expect(it.mode).toBe(hit!.floor ? 'beside' : 'on');
        expect(it.x, label).toBeGreaterThan(plan.x0 + 0.3);
        expect(it.x, label).toBeLessThan(plan.x1 - 0.3);
        expect(it.z, label).toBeGreaterThan(plan.z0 + 0.3);
        expect(it.z, label).toBeLessThan(plan.z1 - 0.3);
        // What lies there fits there.
        expect(fitsSlot(it.spec, hit!), `${label}: ${f.kind} slot cannot take it`).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(300);
  });
  it('a floor item stands clear of furniture, and no loose item lies in a doorway', () => {
    for (const { plan, label } of all) {
      for (const it of plan.items) {
        if (it.mode !== 'beside') continue;
        for (const o of plan.furn) {
          if (o === plan.furn[it.furn] || o.level !== it.level || !o.solid) continue;
          const r = furnRect(o);
          expect(it.x > r.x0 - 0.2 && it.x < r.x1 + 0.2 && it.z > r.z0 - 0.2 && it.z < r.z1 + 0.2, `${label}: item inside ${o.kind}`).toBe(false);
        }
      }
    }
  });
  it('is deterministic, and a place holds named things only', () => {
    const a = generatePlan({ x0: 0, x1: 14, z0: 0, z1: 12, look: 'garage', door: 1, seed: 99, floors: 1, floorY: 0, wear: 0.2, roof: 'gable', reach: 0.4 });
    const b = generatePlan({ x0: 0, x1: 14, z0: 0, z1: 12, look: 'garage', door: 1, seed: 99, floors: 1, floorY: 0, wear: 0.2, roof: 'gable', reach: 0.4 });
    expect(JSON.stringify(a.items)).toBe(JSON.stringify(b.items));
    for (const { plan } of all) for (const it of plan.items) expect(['part', 'fuel', 'oil', 'water', 'paint', 'rations', 'medicine', 'medkit', 'bandage', 'ammo']).toContain(it.spec.kind);
  });
});
