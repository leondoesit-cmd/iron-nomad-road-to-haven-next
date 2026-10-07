import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Keep recording masters and credits. Ship smaller Opus derivatives, decoded once by Web Audio.
const root = fileURLToPath(new URL('../public/audio/', import.meta.url));
const out = resolve(root, 'packed');
mkdirSync(out, { recursive: true });
const hash = data => createHash('sha256').update(data).digest('hex');
const inspect = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,duration', '-of', 'json', file], { encoding: 'utf8' })).streams[0];
const previous = (() => { try { return JSON.parse(readFileSync(resolve(out, 'sources.json'), 'utf8')); } catch { return []; } })();
const mapping = {}, entries = [];
let originalBytes = 0, packedBytes = 0;
for (const file of readdirSync(root).filter(f => f.endsWith('.wav')).sort()) {
  const source = resolve(root, file), sourceSha256 = hash(readFileSync(source));
  const name = file.replace(/\.wav$/, '.ogg'), target = resolve(out, name);
  const cached = previous.find(e => e.originalFile === file && e.sourceSha256 === sourceSha256 && e.codec === 'opus' && e.encoding === 'mono64-stereo128-v1');
  if (cached && (() => { try { return hash(readFileSync(target)) === cached.sha256; } catch { return false; } })()) {
    mapping[file] = `packed/${name}`;
    entries.push(cached);
    originalBytes += cached.originalBytes; packedBytes += cached.bytes;
    continue;
  }
  const stream = inspect(source);
  if (!stream || stream.channels > 2) continue;
  const temp = target + '.tmp';
  try {
    const bitrate = stream.channels === 1 ? '64k' : '128k';
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-map', '0:a:0', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', bitrate,
      '-vbr', 'on', '-application', 'audio', '-compression_level', '10', '-f', 'ogg', temp]);
    const encoded = inspect(temp);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', temp, '-map', '0:a:0', '-f', 's16le', '-c:a', 'pcm_s16le', '-'], { maxBuffer: 32 * 1024 * 1024 });
    const duration = pcm.length / (2 * encoded.channels * Number(encoded.sample_rate));
    if (encoded.codec_name !== 'opus' || encoded.channels !== stream.channels || Math.abs(duration - Number(stream.duration)) > 0.001)
      throw new Error(`Channel count or decoded duration changed: ${file}`);
    const bytes = statSync(temp).size, sourceBytes = statSync(source).size;
    if (bytes >= sourceBytes) continue;
    const entry = { file: `packed/${name}`, originalFile: file, sourceSha256, sha256: hash(readFileSync(temp)), codec: 'opus', encoding: 'mono64-stereo128-v1', bitrate,
      sampleRate: Number(encoded.sample_rate), channels: encoded.channels, duration, originalBytes: sourceBytes, bytes };
    renameSync(temp, target);
    mapping[file] = entry.file; entries.push(entry);
    originalBytes += sourceBytes; packedBytes += bytes;
  } finally { rmSync(temp, { force: true }); }
}
writeFileSync(resolve(out, 'sources.json'), JSON.stringify(entries, null, 2) + '\n');
writeFileSync(fileURLToPath(new URL('../src/audio/packedRecordings.json', import.meta.url)), JSON.stringify(mapping, null, 2) + '\n');
console.log(`Verified ${entries.length} Opus recordings: ${(originalBytes / 1e6).toFixed(2)} MB → ${(packedBytes / 1e6).toFixed(2)} MB (${(100 * (1 - packedBytes / originalBytes)).toFixed(1)}% smaller).`);
