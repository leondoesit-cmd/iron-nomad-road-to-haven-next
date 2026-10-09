import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

// Photo-scanned surfaces from Poly Haven (CC0). Each set ships an sRGB albedo, an OpenGL normal map and an 8-bit height
// map at 1024 px; the game packs them into its own texture layouts at load (`src/render/photoTex.ts`).
// Run `node scripts/fetch-textures.mjs` to download them again; files already present with the recorded checksum stay.
export const SETS = [
  { key: 'sand', id: 'aerial_beach_01', use: 'Terrain sand: wind ripples' },
  { key: 'earth', id: 'dry_ground_01', use: 'Terrain earth: baked, cracked desert ground' },
  { key: 'rock', id: 'cliff_side', use: 'Terrain rock: layered cliff (triplanar)' },
  { key: 'gravel', id: 'gravel_floor', use: 'Terrain gravel' },
  // Second looks for the four ground materials, mixed in over the land in drifts (`terrainMaterial.ts`), and the living,
  // wooded and wet ground.
  { key: 'sand2', id: 'gravelly_sand', use: 'Terrain sand, second look: coarse, gravelly desert sand' },
  { key: 'earth2', id: 'rocky_trail_02', use: 'Terrain earth, second look: dusty, stony ground' },
  { key: 'rock2', id: 'tiger_rock', use: 'Terrain rock, second look: weathered granular rock face (triplanar)' },
  { key: 'gravel2', id: 'dry_river_pebbles', use: 'Terrain gravel, second look: rounded wadi and river pebbles' },
  { key: 'grass', id: 'leafy_grass', use: 'Living ground: short grass with fallen leaves' },
  { key: 'drygrass', id: 'withered_grass', use: 'Living ground: dry, withered grass at the edge of the green' },
  { key: 'litter', id: 'forest_leaves_03', use: 'Wood floor: leaf litter' },
  { key: 'mud', id: 'brown_mud_02', use: 'Wet ground: mud by the water' },
  { key: 'asphalt', id: 'asphalt_01', use: 'Road surface close-up detail' },
  { key: 'concrete', id: 'concrete_floor_worn_001', use: 'Sidewalk slab close-up detail' },
  // Tree bark is painted in code (`src/render/barkTex.ts`): the scans stretched over trunks looked worse.
  // Wall and floor grain for the facade shader, which keeps its own patterns and takes only the brightness.
  { key: 'wallconcrete', id: 'rough_concrete', use: 'Facades: concrete panels, brick faces, concrete floors', maps: ['albedo'] },
  { key: 'wallplaster', id: 'white_stucco_02', use: 'Facades: stucco and interior plaster', maps: ['albedo'] },
  { key: 'wood', id: 'rough_wood', use: 'Facades: weatherboard and floorboards', maps: ['albedo'] },
  { key: 'metal', id: 'rusty_metal_02', use: 'Facades: corrugated sheet', maps: ['albedo'] },
];

const MAPS = [
  { name: 'albedo', kind: 'Diffuse', ext: 'jpg' },
  { name: 'normal', kind: 'nor_gl', ext: 'jpg' },
  { name: 'height', kind: 'Displacement', ext: 'png' },
];

const root = fileURLToPath(new URL('../public/textures/', import.meta.url));
mkdirSync(root, { recursive: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const UA = { 'User-Agent': 'IronNomad-asset-fetch/1.0' };
const previous = (() => { try { return JSON.parse(readFileSync(resolve(root, 'sources.json'), 'utf8')); } catch { return []; } })();
const catalog = await (await fetch('https://api.polyhaven.com/assets?t=textures', { headers: UA })).json();
const scratch = mkdtempSync(join(tmpdir(), 'ph-'));
const entries = [];
try {
  for (const set of SETS) {
    const info = catalog[set.id];
    if (!info) throw new Error(`Poly Haven has no texture ${set.id}`);
    const files = await (await fetch(`https://api.polyhaven.com/files/${set.id}`, { headers: UA })).json();
    for (const map of MAPS.filter((m) => !set.maps || set.maps.includes(m.name))) {
      const file = `${set.key}-${map.name}.jpg`;
      const target = resolve(root, file);
      const src = files[map.kind]['1k'][map.ext];
      const kept = previous.find((e) => e.file === file && e.original === src.url);
      if (kept && (() => { try { return hash(readFileSync(target)) === kept.sha256; } catch { return false; } })()) {
        entries.push(kept);
        continue;
      }
      const res = await fetch(src.url, { headers: UA });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${src.url}`);
      const raw = Buffer.from(await res.arrayBuffer());
      if (createHash('md5').update(raw).digest('hex') !== src.md5) throw new Error(`Checksum mismatch for ${src.url}`);
      const tmp = join(scratch, `${set.key}-${map.name}.${map.ext}`);
      writeFileSync(tmp, raw);
      // Height maps arrive as 16-bit PNG: one grey channel at 8 bits is plenty for blending and cavities.
      const vf = map.name === 'height' ? ['-vf', 'format=gray16le,format=gray'] : [];
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, ...vf, '-map_metadata', '-1', '-q:v', '3', target]);
      const edit = map.name === 'height' ? '1024 px 16-bit PNG converted to 8-bit greyscale JPEG' : '1024 px JPEG re-encoded without metadata';
      entries.push({
        file, set: set.key, map: map.name, use: set.use, source: `https://polyhaven.com/a/${set.id}`, title: info.name,
        author: Object.keys(info.authors).join(', '), license: 'CC0-1.0', original: src.url, edit, sha256: hash(readFileSync(target)),
      });
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
writeFileSync(resolve(root, 'sources.json'), JSON.stringify(entries, null, 2) + '\n');
const lines = [
  'IRON NOMAD — TEXTURE CREDITS',
  '',
  'Photo-scanned surfaces from Poly Haven (https://polyhaven.com), released under CC0 1.0 Universal',
  '(https://creativecommons.org/publicdomain/zero/1.0/): free for commercial use, no attribution required. Credit is given',
  'here with thanks. The file-by-file source, edits and SHA-256 inventory is in sources.json.',
  '',
];
for (const set of SETS) {
  const e = entries.find((x) => x.set === set.key);
  if (e) lines.push(`${set.key}: "${e.title}" by ${e.author}, ${e.source} (${set.use})`);
}
writeFileSync(resolve(root, 'CREDITS.txt'), lines.join('\n') + '\n');
console.log(`${entries.length} texture maps in public/textures`);
