import { loadPhotoTextures } from './photoTex';
import { loadBakedModels } from './bakedModel';
import { ANIMAL_MODEL_NAMES } from './animalModels';
import { CRITTER_MODEL_NAMES } from './lifeRender';

/**
 * Licensed binary assets, fetched and decoded in the background while the title is up: photo-scanned textures
 * (`public/textures`) and rigged, animated models (`public/models`); each folder's `sources.json` and `CREDITS.txt` list
 * where every file came from. Scenes built before they arrive, and tests, use the procedural stand-ins.
 */
let assets: Promise<void> | null = null;
export function loadAssets(): Promise<void> {
  // `?noassets`: everything procedural, for comparing (the benchmark with and without the models and scans).
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('noassets')) return (assets ??= Promise.resolve());
  return (assets ??= Promise.all([
    loadPhotoTextures(),
    loadBakedModels([...ANIMAL_MODEL_NAMES, ...CRITTER_MODEL_NAMES, 'zombie-anims']),
  ]).then(() => undefined, (e) => console.warn('Assets unavailable', e)));
}
