import { defineConfig } from 'vitest/config';
import { cpSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { externalRapierWasm } from './scripts/rapier-wasm.ts';
const publicDir = resolve('public');
const packed: Record<string, string> = JSON.parse(readFileSync(resolve('src/audio/packedRecordings.json'), 'utf8'));

function musicPaths(dir = resolve('public/music'), prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = prefix + entry.name;
    return entry.isDirectory() ? musicPaths(resolve(dir, entry.name), path + '/')
      : /\.(mp3|wav|ogg|m4a|aac|flac|opus|webm)$/i.test(path) ? [path] : [];
  }).sort();
}

export default defineConfig({
  plugins: [externalRapierWasm(), {
    name: 'packed-audio-assets',
    apply: 'build',
    buildStart() {
      if (!Object.keys(packed).length) return;
      const entries: { file: string; originalFile: string; sourceSha256: string; sha256: string }[] = JSON.parse(readFileSync(resolve(publicDir, 'audio/packed/sources.json'), 'utf8'));
      const hash = (file: string) => createHash('sha256').update(readFileSync(resolve(publicDir, 'audio', file))).digest('hex');
      for (const [original, file] of Object.entries(packed)) {
        const entry = entries.find(e => e.originalFile === original && e.file === file);
        if (!entry || hash(original) !== entry.sourceSha256 || hash(file) !== entry.sha256)
          this.error(`Packed audio is stale or missing for ${original}. Run npm run pack:audio.`);
      }
    },
    writeBundle(options) {
      cpSync(publicDir, resolve(options.dir!), { recursive: true, filter: source => {
        const path = relative(publicDir, source).split('\\').join('/');
        return !(path.startsWith('audio/') && packed[path.slice(6)]);
      } });
    },
  }, {
    name: 'user-music-playlist',
    configureServer(server) {
      server.middlewares.use('/music/playlist.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(musicPaths()));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'music/playlist.json', source: JSON.stringify(musicPaths()) });
    },
  }],
  // PORT is assigned by the preview tooling; fall back to Vite's default otherwise.
  server: { host: '127.0.0.1', port: Number(process.env.PORT) || 5174 },
  build: {
    target: 'es2022', chunkSizeWarningLimit: 1500, copyPublicDir: false,
    rollupOptions: { input: { game: resolve('index.html'), portraits: resolve('portrait.html'), garden: resolve('garden.html') } },
  },
  // The whole-leg generation tests take a few seconds each; a loaded machine pushes them past the 5 s default.
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 20000 },
});
