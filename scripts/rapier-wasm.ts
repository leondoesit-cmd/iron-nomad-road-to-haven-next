import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Keep the compat API, but let the browser fetch/compile its identical WASM binary directly. */
export function externalRapierWasm(): Plugin {
  return {
    name: 'external-rapier-wasm',
    apply: 'build',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/@dimforge/rapier3d-compat/dist/rapier.mjs')) return;
      const embedded = /[\w$]+\.toByteArray\("(AGFzbQ[A-Za-z0-9+/=]+)"\)\.buffer/g;
      const matches = [...code.matchAll(embedded)];
      const wasmPath = resolve(dirname(id), 'rapier_wasm3d_bg.wasm');
      if (matches.length !== 1 || !Buffer.from(matches[0][1], 'base64').equals(readFileSync(wasmPath)))
        this.error('Rapier embedded WASM changed: verify its initializer before updating the external-WASM build adapter.');
      this.addWatchFile(wasmPath);
      return {
        code: `import __nomadWasmUrl from ${JSON.stringify(wasmPath + '?url')};\n` + code.replace(embedded, 'fetch(__nomadWasmUrl)'),
        map: null,
      };
    },
  };
}
