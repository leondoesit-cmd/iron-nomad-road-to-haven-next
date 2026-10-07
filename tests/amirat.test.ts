import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEROES, HERO_IDS, isHero, nextHero } from '../src/data/heroes';
import { HERO_LOOKS, RIG_HEIGHT } from '../src/render/heroLooks';
import { portraitGeometry } from '../src/render/portrait';
import { shortSleeves, lookOf } from '../src/render/outfit';
import { Campaign } from '../src/game/campaign';
import { AmiratGarden, GARDEN_BOUNDS, GARDEN_CHAIR_SEAT, GARDEN_LAYOUT, gardenChair } from '../src/render/amiratGarden';
import { kitMaterial } from '../src/render/materials';
import { COFFEE_TOP, GATE, UDUD_CHAIR } from '../src/world/ududHouse';

describe('Amirat, the grill man', () => {
  it('can be selected in either seat and survives a save with his name and real build', () => {
    expect(isHero('amirat')).toBe(true);
    expect(HEROES.amirat).toMatchObject({ name: 'Amirat', height: 1.75, weight: 77 });
    expect(HERO_LOOKS.amirat.scale * RIG_HEIGHT).toBeCloseTo(1.75, 6);
    expect(HERO_LOOKS.amirat.girth).toBeGreaterThan(HERO_LOOKS.lag.girth);
    for (const seats of [['amirat', 'leo'], ['nar', 'amirat']] as const) {
      const back = Campaign.deserialize(JSON.parse(JSON.stringify(new Campaign(seats).serialize())));
      expect(back.players.map(p => p.hero)).toEqual(seats);
      expect(back.players.find(p => p.hero === 'amirat')?.name).toBe('Amirat');
    }
    const cycle = new Set<string>();
    let selected = 'amirat' as typeof HERO_IDS[number];
    for (let i = 0; i < HERO_IDS.length; i++) {
      cycle.add(selected);
      selected = nextHero(selected);
    }
    expect(cycle.size).toBe(HERO_IDS.length);
    expect(selected).toBe('amirat');
    expect(shortSleeves(lookOf({}).body, HERO_LOOKS.amirat)).toBe(false);
  });

  it('builds the requested garden with exact tree and chair counts and a single-storey house', () => {
    const garden = new AmiratGarden();
    const names: string[] = [];
    garden.root.traverse(o => names.push(o.name));
    expect(names.filter(n => /^orange-tree-\d+$/.test(n))).toHaveLength(3);
    // Four white chairs: Udud's canvas chair (render/partyCast.ts) stands where the right-hand pair was. None at the party table.
    expect(names.filter(n => /^white-leg-wooden-seat-chair-\d+$/.test(n))).toHaveLength(GARDEN_LAYOUT.chairs.length);
    for (const name of ['kids-slide', 'trampoline', 'trampoline-safety-net', 'coffee-table', 'sofa-against-house-wall', 'barbecue-grill', 'tomahawk-steak-1', 'tomahawk-steak-2',
      'coffee-table-takeaway', 'grill-station', 'house-window-glass', 'living-room-glimpse', 'patio-string-lights', 'patio-ceiling-fan-blades', 'flat-roof-fittings',
      'driveway-pavers', 'driveway-kerbs', 'street-lamp', 'gate-mailbox-and-intercom', 'gas-cylinder-cage', 'flower-beds', 'garden-props']) {
      expect(garden.root.getObjectByName(name), name).toBeDefined();
    }
    const home = new THREE.Box3().setFromObject(garden.root.getObjectByName('single-story-family-home')!);
    const sofa = new THREE.Box3().setFromObject(garden.root.getObjectByName('sofa-against-house-wall')!);
    expect(home.max.y).toBeLessThan(3.5);
    // The solar water heater, tank and aerials stand on the flat roof: fittings, not another storey.
    const roof = new THREE.Box3().setFromObject(garden.root.getObjectByName('flat-roof-fittings')!);
    expect(roof.min.y).toBeGreaterThan(3.1);
    expect(roof.max.y).toBeLessThan(5.6);
    expect(roof.min.x).toBeGreaterThan(GARDEN_BOUNDS.house.minX);
    expect(roof.max.z).toBeLessThan(GARDEN_BOUNDS.house.maxZ);
    // The front of the house wall is z = -4.7; steps are farther out and do not define the wall.
    expect(sofa.min.z + 4.7).toBeGreaterThan(0);
    expect(sofa.min.z + 4.7).toBeLessThan(0.2);
    expect(GARDEN_LAYOUT.slide[1]).toBeGreaterThan(GARDEN_BOUNDS.patio.maxZ);
    expect(names.some(n => /flag|bunting/i.test(n))).toBe(false);
    garden.dispose();
  });

  it('has a visibly different sculpt from Leo beneath the hair and clothing', () => {
    const a = portraitGeometry(HERO_LOOKS.amirat.portrait, 'covered').getAttribute('position');
    const l = portraitGeometry(HERO_LOOKS.leo.portrait, 'covered').getAttribute('position');
    expect(a.count).toBe(l.count);
    let distanceSquared = 0;
    for (let i = 0; i < a.count; i++) {
      distanceSquared += (a.getX(i) - l.getX(i)) ** 2 + (a.getY(i) - l.getY(i)) ** 2 + (a.getZ(i) - l.getZ(i)) ** 2;
    }
    // Differences survive a helmet: the anatomy itself changes by several millimetres.
    expect(Math.sqrt(distanceSquared / a.count)).toBeGreaterThan(0.004);
  });

  it('halves the house-to-lawn patio depth while covering every tile and keeping the furniture on it', () => {
    const garden = new AmiratGarden();
    const patio = new THREE.Box3().setFromObject(garden.root.getObjectByName('tiled-patio')!);
    const roof = new THREE.Box3().setFromObject(garden.root.getObjectByName('curved-patio-cover')!);
    expect(patio.min.x).toBeCloseTo(GARDEN_BOUNDS.house.minX, 4);
    expect(patio.max.x).toBeCloseTo(GARDEN_BOUNDS.house.maxX, 4);
    expect(patio.max.z - patio.min.z).toBeCloseTo(6.5 / 2, 4);
    expect(patio.min.z).toBeCloseTo(-4.7, 4);
    expect(roof.min.x).toBeLessThanOrEqual(patio.min.x);
    expect(roof.max.x).toBeGreaterThanOrEqual(patio.max.x);
    expect(roof.min.z).toBeLessThanOrEqual(patio.min.z);
    expect(roof.max.z).toBeGreaterThanOrEqual(patio.max.z);
    expect(roof.max.x - patio.max.x).toBeLessThan(0.15);
    for (const name of ['sofa-against-house-wall', 'coffee-table', ...GARDEN_LAYOUT.chairs.map((_, i) => `white-leg-wooden-seat-chair-${i + 1}`)]) {
      const box = new THREE.Box3().setFromObject(garden.root.getObjectByName(name)!);
      expect(box.min.x, name).toBeGreaterThanOrEqual(patio.min.x);
      expect(box.max.x, name).toBeLessThanOrEqual(patio.max.x);
      expect(box.min.z, name).toBeGreaterThanOrEqual(patio.min.z);
      expect(box.max.z, name).toBeLessThanOrEqual(patio.max.z);
    }
    // The trampoline's nearby tree stays clear of its frame and safety net.
    const tree = new THREE.Vector2(...GARDEN_LAYOUT.trees[0]);
    const trampoline = new THREE.Vector2(...GARDEN_LAYOUT.trampoline);
    expect(tree.distanceTo(trampoline)).toBeGreaterThan(2.2);
    expect(tree.distanceTo(trampoline)).toBeLessThan(3);
    garden.dispose();
  });

  it('keeps the tongs in his hand throughout the cooking cycle, even when the garden is moved and rotated', () => {
    const garden = new AmiratGarden();
    garden.root.position.set(14, 2, -10);
    garden.root.rotation.y = 0.7;
    const hand = new THREE.Vector3();
    const tongs = new THREE.Vector3();
    const poses: number[] = [];
    for (let i = 0; i < 200; i++) {
      garden.update(0.05);
      garden.root.updateMatrixWorld(true);
      garden.amirat!.hand.getWorldPosition(hand);
      garden.tongs!.getWorldPosition(tongs);
      expect(hand.distanceTo(tongs)).toBeLessThan(0.00001);
      expect(tongs.toArray().every(Number.isFinite)).toBe(true);
      poses.push(garden.amirat!.head.rotation.x);
    }
    expect(Math.max(...poses) - Math.min(...poses)).toBeGreaterThan(0.2);
    garden.dispose();
  });

  it('ends the house beside the sofa and leaves a clear connection between the two gardens', () => {
    const garden = new AmiratGarden();
    const home = new THREE.Box3().setFromObject(garden.root.getObjectByName('house-walls-and-roof')!);
    const sofa = new THREE.Box3().setFromObject(garden.root.getObjectByName('sofa-against-house-wall')!);
    const passage = new THREE.Box3().setFromObject(garden.root.getObjectByName('side-passage-to-front-garden')!);
    const patio = new THREE.Box3().setFromObject(garden.root.getObjectByName('tiled-patio')!);
    const front = new THREE.Box3().setFromObject(garden.root.getObjectByName('small-front-garden')!);
    expect(home.max.x - sofa.max.x).toBeGreaterThan(0);
    expect(home.max.x - sofa.max.x).toBeLessThan(0.5);
    expect(passage.max.z).toBeCloseTo(patio.max.z, 4);
    const stairTop = new THREE.Box3().setFromObject(garden.root.getObjectByName('front-gate-upper-step')!);
    expect(passage.min.z).toBeCloseTo(stairTop.max.z, 4);
    expect(front.max.z).toBeLessThan(home.min.z + 0.3);
    expect(front.max.z - front.min.z).toBeLessThan(GARDEN_BOUNDS.lawnEnd - GARDEN_BOUNDS.patio.maxZ);
    // Walk the side route at body height. Neither the house, its fittings, the fence nor a cover support blocks it.
    const ray = new THREE.Raycaster();
    garden.root.updateMatrixWorld(true);
    for (const x of [5.3, 5.9, 6.5]) {
      ray.set(new THREE.Vector3(x, 1, -4.5), new THREE.Vector3(0, 0, -1));
      ray.far = 9.3;
      expect(ray.intersectObjects(garden.root.children, true), `passage at x=${x}`).toHaveLength(0);
    }
    // The sofa and the main garden remain in their existing positions.
    expect(garden.root.getObjectByName('sofa-against-house-wall')!.position.toArray()).toEqual([3.3, 0, -4.14]);
    expect(garden.root.getObjectByName('trampoline')!.position.toArray()).toEqual([4.1, 0, 4.65]);
    garden.dispose();
  });

  it('narrows the front garden to one-third width, swings the screened gate shut and open on its hinge, with exactly two steps', () => {
    const garden = new AmiratGarden();
    const front = new THREE.Box3().setFromObject(garden.root.getObjectByName('small-front-garden')!);
    expect(front.max.x - front.min.x).toBeCloseTo(14 / 3, 4);
    // Leaf and screen hang on the hinge together, the screen on the street side; open, it is swung ~100° into the front garden.
    const leaf = garden.root.getObjectByName('front-gate-leaf') as THREE.Mesh;
    const screen = garden.root.getObjectByName('gate-exterior-blue-privacy-screen') as THREE.Mesh;
    expect(leaf.parent).toBe(garden.gate);
    expect(screen.parent).toBe(garden.gate);
    expect(Math.abs(garden.gate.rotation.y)).toBeGreaterThan(1.5);
    expect(Math.abs(garden.gate.rotation.y)).toBeLessThan(1.95);
    expect(garden.gate.userData.dynamic).toBe(true);
    // Shut, it spans the opening.
    garden.setGate(0);
    garden.root.updateMatrixWorld(true);
    const shut = new THREE.Box3().setFromObject(leaf, true);
    expect(shut.min.x).toBeLessThan(GATE.x - GATE.w / 2 + 0.1);
    expect(shut.max.x).toBeGreaterThan(GATE.x + GATE.w / 2 - 0.12);
    expect(Math.abs((shut.min.z + shut.max.z) / 2 - GATE.z)).toBeLessThan(0.08);
    garden.setGate(1);
    garden.root.updateMatrixWorld(true);
    screen.geometry.computeBoundingBox();
    expect(screen.geometry.boundingBox!.max.z).toBeLessThan(0.001);
    // Only its hinge edge, at the post, reaches into the opening.
    const open = new THREE.Box3().setFromObject(leaf, true);
    expect(open.max.x).toBeLessThan(GATE.x - GATE.w / 2 + 0.1);
    expect(open.min.z).toBeGreaterThan(GATE.z - 0.1);
    expect(open.max.z - open.min.z).toBeGreaterThan(1.0);
    expect(new THREE.Box3().setFromObject(screen).max.y).toBeGreaterThan(1.6);
    // Walk straight through the open gate from the driveway into the passage.
    const ray = new THREE.Raycaster();
    garden.root.updateMatrixWorld(true);
    for (const x of [GATE.x - 0.4, GATE.x, GATE.x + 0.4]) for (const y of [0.3, 1, 1.7]) {
      ray.set(new THREE.Vector3(x, y, GATE.z - 2), new THREE.Vector3(0, 0, 1));
      ray.far = 4;
      expect(ray.intersectObjects(garden.root.children, true), `gate at x=${x} y=${y}`).toHaveLength(0);
    }
    const steps = garden.root.getObjectByName('front-gate-two-steps')!;
    expect(steps.children).toHaveLength(2);
    const upper = new THREE.Box3().setFromObject(steps.children[0]);
    const lower = new THREE.Box3().setFromObject(steps.children[1]);
    expect(lower.min.z).toBeCloseTo(GARDEN_BOUNDS.frontGarden.minZ, 4);
    expect(lower.max.z).toBeCloseTo(upper.min.z, 4);
    expect(upper.max.z).toBeGreaterThan(lower.max.z);
    expect(upper.max.y).toBeLessThan(0);
    expect(upper.max.y - lower.max.y).toBeCloseTo(0.16, 4);
    const railing = new THREE.Box3().setFromObject(garden.root.getObjectByName('metal-fence-section-3')!);
    const outside = new THREE.Box3().setFromObject(garden.root.getObjectByName('exterior-blue-privacy-screen-3')!);
    expect(outside.min.x).toBeGreaterThan(railing.max.x);
    garden.dispose();
  });

  it('lays the driveway flush with the street outside the gate, down to the highway', () => {
    const garden = new AmiratGarden();
    const pavers = new THREE.Box3().setFromObject(garden.root.getObjectByName('driveway-pavers')!);
    expect(pavers.max.y).toBeLessThan(0);
    expect(pavers.min.y).toBeGreaterThan(-0.03);
    expect(pavers.min.z).toBeCloseTo(-26.5, 4);
    expect(pavers.max.z).toBeCloseTo(GATE.z, 4);
    expect(pavers.min.x).toBeGreaterThanOrEqual(0.5 - 1e-6);
    expect(pavers.max.x).toBeLessThanOrEqual(7.5 + 1e-6);
    const threshold = new THREE.Box3().setFromObject(garden.root.getObjectByName('front-gate-threshold')!);
    expect(threshold.max.y).toBeLessThan(0);
    expect(threshold.max.y).toBeGreaterThan(-0.03);
    garden.dispose();
  });

  it("crowds the coffee table with takeaway, inside its top, and leaves Ro's corner for his plate and beer", () => {
    const garden = new AmiratGarden();
    garden.root.updateMatrixWorld(true);
    const [cx, cz] = GARDEN_LAYOUT.coffee;
    const food = garden.root.getObjectByName('coffee-table-takeaway') as THREE.Mesh;
    const p = food.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    let items = 0;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(food.matrixWorld);
      // Everything stands on the oval top (a few millimetres of overhang allowed) and nothing sinks into it.
      expect(((v.x - cx) / 0.8) ** 2 + ((v.z - cz) / 0.45) ** 2, `vertex ${i}`).toBeLessThan(1.05);
      expect(v.y).toBeGreaterThan(COFFEE_TOP - 0.01);
      // Ro's plate (about x 2.82, z -2.67) and beer (x 3.04) on the near-left corner: nothing stands there.
      if (v.x > 2.66 && v.x < 3.1 && v.z > -2.82 && v.z < -2.52) expect(v.y, `corner vertex ${i}`).toBeLessThan(COFFEE_TOP + 0.005);
      if (v.y > COFFEE_TOP + 0.03) items++;
    }
    expect(items).toBeGreaterThan(2000);
    // The long table is gone; the grill stands out on the lawn with Amirat behind it, facing the patio.
    expect(garden.root.getObjectByName('party-table')).toBeUndefined();
    const grill = new THREE.Box3().setFromObject(garden.grill);
    expect(grill.min.z).toBeGreaterThan(GARDEN_BOUNDS.patio.maxZ);
    const face = new THREE.Vector3(0, 0, 1).transformDirection(garden.amirat!.root.matrixWorld);
    expect(face.z).toBeLessThan(-0.99);
    garden.dispose();
  });

  it("leaves Udud's canvas-chair spot by the house door clear", () => {
    const garden = new AmiratGarden();
    garden.root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    for (const z of [UDUD_CHAIR.z - 0.25, UDUD_CHAIR.z, UDUD_CHAIR.z + 0.25]) for (const y of [0.15, 0.5, 1.0, 1.6]) {
      ray.set(new THREE.Vector3(UDUD_CHAIR.x - 0.4, y, z), new THREE.Vector3(1, 0, 0));
      ray.far = 0.8;
      expect(ray.intersectObjects(garden.root.children, true), `spot at z=${z} y=${y}`).toHaveLength(0);
    }
    garden.dispose();
  });

  it('keeps everything static in the shared kit, marks what moves or is see-through, and stays under budget', () => {
    const garden = new AmiratGarden();
    const kit = new Set<THREE.Material>([kitMaterial(), kitMaterial({ detail: false })]);
    let triangles = 0;
    const isDynamic = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.dynamic) return true;
      return false;
    };
    garden.root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.geometry || isDynamic(o)) return;
      expect(m.isMesh, o.name).toBe(true);
      expect(kit.has(m.material as THREE.Material), o.name).toBe(true);
      triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
    });
    expect(triangles).toBeLessThan(300_000);
    for (const name of ['amirat-grill-man', 'amirat-grill-tongs', 'house-window-glass', 'patio-ceiling-fan-blades', 'trampoline-safety-net', 'grill-smoke-0']) {
      expect(isDynamic(garden.root.getObjectByName(name)!), name).toBe(true);
    }
    garden.dispose();
  });

  it('can leave Amirat out when he is on the road, and still smokes the grill', () => {
    const garden = new AmiratGarden({ amirat: false });
    expect(garden.amirat).toBeNull();
    expect(garden.tongs).toBeNull();
    expect(garden.root.getObjectByName('amirat-grill-man')).toBeUndefined();
    expect(garden.root.getObjectByName('amirat-grill-tongs')).toBeUndefined();
    expect(garden.grill.getObjectByName('tomahawk-steak-1')).toBeDefined();
    const smoke = garden.root.getObjectByName('grill-smoke-0')!;
    const before = smoke.position.clone();
    garden.update(0.7);
    expect(smoke.position.distanceTo(before)).toBeGreaterThan(0);
    garden.dispose();
  });

  it('makes the white garden chair at any seat height', () => {
    const ray = new THREE.Raycaster();
    for (const seat of [GARDEN_CHAIR_SEAT, 0.42, 0.55]) {
      const chair = gardenChair(seat);
      chair.updateMatrixWorld(true);
      ray.set(new THREE.Vector3(0, 2, 0.08), new THREE.Vector3(0, -1, 0));
      expect(ray.intersectObject(chair)[0].point.y, `seat ${seat}`).toBeCloseTo(seat, 3);
      const box = new THREE.Box3().setFromObject(chair);
      expect(box.min.y).toBeGreaterThanOrEqual(0);
      expect(box.max.y).toBeGreaterThan(seat + 0.3);
      chair.geometry.dispose();
    }
  });

  it('fits the round light table between the doorway and sofa and puts the cabinet and 70-litre fridge against the left fence', () => {
    const garden = new AmiratGarden();
    const tableObject = garden.root.getObjectByName('barbecue-prep-table') as THREE.Mesh;
    const table = new THREE.Box3().setFromObject(tableObject);
    const sofa = new THREE.Box3().setFromObject(garden.root.getObjectByName('sofa-against-house-wall')!);
    expect(table.min.x).toBeGreaterThan(-0.1); // Right edge of the door's entry steps.
    expect(table.max.x).toBeLessThan(sofa.min.x);
    expect(table.min.z).toBeGreaterThan(GARDEN_BOUNDS.house.maxZ);
    expect(table.max.x - table.min.x).toBeCloseTo(table.max.z - table.min.z, 4);
    const positions = tableObject.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) expect(Math.hypot(positions.getX(i), positions.getZ(i))).toBeLessThan(0.54);
    const storageObject = garden.root.getObjectByName('left-fence-storage-unit')!;
    const fridgeObject = garden.root.getObjectByName('office-refrigerator-70-litre')!;
    const storage = new THREE.Box3().setFromObject(storageObject);
    const fridge = new THREE.Box3().setFromObject(fridgeObject);
    expect(storageObject.rotation.y).toBeCloseTo(Math.PI / 2, 6);
    expect(fridgeObject.rotation.y).toBeCloseTo(Math.PI / 2, 6);
    for (const box of [storage, fridge]) {
      expect(box.min.x).toBeGreaterThan(-7);
      expect(box.min.x).toBeLessThan(-6.8);
      expect(box.min.z).toBeGreaterThan(GARDEN_BOUNDS.patio.minZ);
      expect(box.max.z).toBeLessThan(GARDEN_BOUNDS.patio.maxZ);
    }
    expect(fridge.min.z - storage.max.z).toBeGreaterThan(0.1);
    expect(fridge.max.y).toBeGreaterThan(0.6);
    expect(fridge.max.y).toBeLessThan(0.75);
    expect(fridgeObject.userData.capacityLitres).toBe(70);
    garden.dispose();
  });

  it('produces finite geometry with valid indices for the entire scene', () => {
    const garden = new AmiratGarden();
    garden.root.traverse(o => {
      const geo = (o as THREE.Mesh).geometry;
      if (!geo) return;
      const p = geo.getAttribute('position');
      expect(Array.from(p.array).every(Number.isFinite), o.name).toBe(true);
      if (geo.index) expect(Array.from(geo.index.array).every(i => i < p.count), o.name).toBe(true);
      const normal = geo.getAttribute('normal');
      if (normal) expect(normal.count, o.name).toBe(p.count);
    });
    garden.dispose();
  });
});
