import { rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const distDirectory = fileURLToPath(new URL('./dist', import.meta.url));
const packageValue = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
await rm(distDirectory, { recursive: true, force: true });
await build({
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/index.js', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  define: {
    'process.env.QUIZTAKER_HELPER_VERSION': JSON.stringify(process.env.RELEASE_VERSION || packageValue.version),
  },
});
