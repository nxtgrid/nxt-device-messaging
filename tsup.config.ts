import { copyFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * Production build (ADR-004). Lua scripts are copied beside `dist/` when
 * unit 2 lands; `config.default.json` ships with the bundle for ADR-002 fallback.
 */
export default defineConfig({
  entry: [ 'src/main.ts' ],
  format: [ 'esm' ],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  async onSuccess() {
    copyFileSync('config.default.json', 'dist/config.default.json');
  },
});
