import { detailNormalTexture, grungeTexture, leafAtlas, macroTexture, meadowTexture, roadTextures, terrainTextures } from './proctex';
import { impostorTexture, treeWarmup } from './trees';
import { scatterWarmup } from './scatter';
import { LANDMARK_KINDS, landmarkProto } from './landmarks';
import { buildLakeWater, buildSwampWater } from './water';
import { buildRiverWater } from './riverWater';
import type { ChunkSource } from '../world/chunkgen';

/**
 * One slice of warm-up work. It fills a cache the first scene would otherwise fill on its way up; a step that returns
 * true has more to do and is called again at the next idle moment.
 */
export type WarmStep = readonly [string, () => boolean | void];

/**
 * Caches the first open-world scene fills on its way up, as separate slices: the procedural textures (made on the CPU,
 * a few hundred milliseconds each) and the tree impostor atlas. The title runs them one per idle moment after it is on
 * screen, so a new run, or the title's own demo, does not pay for them in one long freeze. Each is a cached builder, so
 * running one twice, or before or after a scene made it, costs nothing.
 */
export const WARMUPS: readonly WarmStep[] = [
  ['terrain textures', () => void terrainTextures()],
  ['meadow', () => void meadowTexture()],
  ['ground detail', () => {
    macroTexture();
    grungeTexture();
    detailNormalTexture();
  }],
  ['roads', () => {
    roadTextures('wasteland');
    roadTextures('city');
  }],
  ['leaves', () => void leafAtlas()],
  ['tree impostors', () => void impostorTexture()],
  // Ground cover and tree cards: their textures and materials (the meshes they hand back are only for a scene's first draw).
  ['cards', () => {
    for (const im of [...scatterWarmup(), ...treeWarmup()]) im.dispose();
  }],
];

/** Run `fn` over `items` a few at a time: each call does up to `ms` of work and says whether any is left. */
function sliced<T>(items: T[], fn: (item: T) => void, ms = 24): () => boolean {
  let i = 0;
  return () => {
    const t0 = performance.now();
    while (i < items.length && performance.now() - t0 < ms) fn(items[i++]);
    return i < items.length;
  };
}

/**
 * The caches a leg's own Landscape fills, warmed from its master plan (`world/planCache.ts`: the terrain is shared, so
 * the scene finds them): the depth raster of every lake and swamp, the river ribbons, and the prototype of every kind of
 * landmark that stands on the leg. About a second of the first scene's build, done in idle slices on the title instead.
 */
export function worldWarmups(src: ChunkSource): WarmStep[] {
  const T = src.layout.terrain;
  const steps: WarmStep[] = [];
  steps.push(['lakes', sliced(T.lakes, (l) => buildLakeWater(l).dispose())]);
  const hy = T.hydro;
  if (hy?.ready) {
    for (const sw of hy.swamps) steps.push(['swamp', () => buildSwampWater(T, sw).dispose()]);
    steps.push(['rivers', () => buildRiverWater(T)?.dispose()]);
  }
  type Prop = (typeof src.layout.props)[number];
  const kinds = new Map<string, Prop>();
  for (const p of src.layout.props) {
    if (!LANDMARK_KINDS.has(p.kind)) continue;
    const key = `${p.kind}:${Math.abs(p.seed) % 4}:${p.tag ?? 0}`;
    if (!kinds.has(key)) kinds.set(key, p);
  }
  steps.push(['landmarks', sliced([...kinds.values()], (p) => void landmarkProto(p.kind, p.seed, p.tag ?? 0))]);
  return steps;
}
