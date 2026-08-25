import { defineConfig } from 'tsup';

/**
 * Bundles `@nxt/device-messaging-contract` so adopters do not resolve into
 * this repo's `src/`. `zod` stays external (peer).
 */
export default defineConfig({
  entry: [ 'packages/contract/src/index.ts' ],
  outDir: 'packages/contract/dist',
  format: [ 'esm' ],
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [ 'zod' ],
});
