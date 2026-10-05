import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { generatePlan, type Look } from '../src/world/interiors';
import { buildBuildingGeometry } from '../src/render/buildingView';

const SIZES: Record<Look, [number, number][]> = {
  house: [[7, 8], [11, 9]],
  store: [[9, 16], [12, 10]],
  motel: [[9, 34]],
  barn: [[14, 24]],
  warehouse: [[20, 44], [24, 30]],
  shack: [[5, 6], [4, 5]],
};

describe('building corners', () => {
  it('no sight line from outside reaches the corner column of a wall shell', () => {
    const reach = 3;
    const bad: string[] = [];
    for (const look of Object.keys(SIZES) as Look[]) {
      SIZES[look].forEach(([w, d], i) => {
        for (let seed = 1; seed <= 6; seed++) {
          const floors = look === 'house' && seed % 3 === 0 ? 2 : 1;
          const plan = generatePlan({ x0: 100, x1: 100 + w, z0: 200, z1: 200 + d, look, door: seed % 2 ? 1 : -1, seed: seed * 31 + i, floors, floorY: 3, wear: (seed % 10) / 10, roof: 'gable' });
          const geo = buildBuildingGeometry({ plan, extStyle: 14, tint: 0x888888, seed, look, roof: 'gable', ridgeX: true, door: 1, aabb: {} } as never);
          geo.levels.forEach((lv, L) => {
            const meshes = [lv.shell, lv.trim].filter((g): g is THREE.BufferGeometry => !!g).map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.FrontSide })));
            const rc = new THREE.Raycaster();
            const base = plan.floorY + L * plan.levelH;
            for (const [cx, cz, sx, sz] of [[100, 200, 1, 1], [100 + w, 200, -1, 1], [100, 200 + d, 1, -1], [100 + w, 200 + d, -1, -1]]) {
              const tx = cx + (sx * 0.3) / 2;
              const tz = cz + (sz * 0.3) / 2;
              for (const hy of [0.15, 0.6, 1.5, plan.levelH - 0.2]) {
                for (let az = 0; az < 12; az++) {
                  const ang = (az / 12) * (Math.PI / 2) + 0.05;
                  const dir = new THREE.Vector3(sx * Math.cos(ang), 0, sz * Math.sin(ang));
                  const o = new THREE.Vector3(tx - dir.x * reach, base + hy, tz - dir.z * reach);
                  if (o.x >= 100 && o.x <= 100 + w && o.z >= 200 && o.z <= 200 + d) continue;
                  rc.set(o, dir);
                  const hit = rc.intersectObjects(meshes, false)[0];
                  if (!hit || hit.distance > reach - 0.01) bad.push(`${look} ${w}x${d} seed ${seed} level ${L} corner ${cx},${cz} y+${hy}`);
                }
              }
            }
          });
        }
      });
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
