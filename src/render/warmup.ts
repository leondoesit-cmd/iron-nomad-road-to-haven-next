import { detailNormalTexture, grungeTexture, leafAtlas, macroTexture, meadowTexture, roadTextures, terrainTextures } from './proctex';
import { impostorTexture } from './trees';

/**
 * Caches the first open-world scene fills on its way up, as separate slices: the procedural textures (made on the CPU,
 * a few hundred milliseconds each) and the tree impostor atlas. The title runs them one per idle moment after it is on
 * screen, so a new run, or the title's own demo, does not pay for them in one long freeze. Each is a cached builder, so
 * running one twice, or before or after a scene made it, costs nothing.
 */
export const WARMUPS: readonly (readonly [string, () => void])[] = [
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
];
