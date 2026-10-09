import { defineConfig } from 'tsup';

const external = ['better-sqlite3', 'isolated-vm', 'typescript', 'ws', 'zod', 'commander', '@anthropic-ai/sdk', 'openai', '@google/generative-ai'];

export default defineConfig([
  {
    // Library entry: ESM (dist/index.js) and CJS (dist/index.cjs) with types for both.
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    target: 'node20',
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: true,
    external,
  },
  {
    // CLI module: ESM only, exports main().
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: true,
    clean: false,
    external,
  },
  {
    // The `ouro` executable. Not bundled, so dist/bin.js is byte-stable and can be committed:
    // package managers then link the bin on a fresh clone before the first build.
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    bundle: false,
    sourcemap: false,
    clean: false,
  },
]);
