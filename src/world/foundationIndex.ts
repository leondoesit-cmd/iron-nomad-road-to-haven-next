import type { Foundation } from './terrain';

const CELL = 32;
const PAD = 3.5;
const EMPTY: readonly Foundation[] = [];
const key = (x: number, z: number) => (x + 32768) * 65536 + z + 32768;
const indexes = new WeakMap<Foundation[], { count: number; cells: Map<number, Foundation[]> }>();

/** Foundations are appended while settlements are built. Preserve their order, including overlapping pads. */
export function foundationsAt(foundations: Foundation[], x: number, z: number): readonly Foundation[] {
  if (foundations.length < 16) return foundations;
  let index = indexes.get(foundations);
  if (!index || index.count > foundations.length) {
    index = { count: 0, cells: new Map() };
    indexes.set(foundations, index);
  }
  while (index.count < foundations.length) {
    const f = foundations[index.count++];
    const x0 = Math.floor((f.x0 - PAD) / CELL), x1 = Math.floor((f.x1 + PAD) / CELL);
    const z0 = Math.floor((f.z0 - PAD) / CELL), z1 = Math.floor((f.z1 + PAD) / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const k = key(ix, iz);
      let cell = index.cells.get(k);
      if (!cell) index.cells.set(k, cell = []);
      cell.push(f);
    }
  }
  return index.cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? EMPTY;
}
