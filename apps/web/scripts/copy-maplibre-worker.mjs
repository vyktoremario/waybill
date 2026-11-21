// MapLibre 6 runs its tile worker as a separate ES module that bundlers don't emit.
// Copy the worker (and the chunk it imports) into public/ so it is served as a static file.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const dist = join(dirname(require.resolve('maplibre-gl/package.json')), 'dist');
const out = join(import.meta.dirname, '..', 'public', 'maplibre');
mkdirSync(out, { recursive: true });
for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) copyFileSync(join(dist, f), join(out, f));
console.log('[maplibre] worker copied to public/maplibre');
