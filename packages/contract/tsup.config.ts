import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Bundles `@nxtgrid/device-messaging-contract` so adopters do not resolve into
 * this repo's `src/`. `zod` stays external (peer). Paths are relative to this
 * file so `pnpm build:contract` (repo root) and `prepack` (package dir) agree.
 */
export default defineConfig({
  entry: [ join(here, 'src/index.ts') ],
  outDir: join(here, 'dist'),
  format: [ 'esm' ],
  platform: 'neutral',
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [ 'zod' ],
});
