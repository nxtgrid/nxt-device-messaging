import { defineConfig } from 'tsup';

/**
 * Production build (ADR-004). Lua scripts are copied beside `dist/` when
 * unit 2 lands; until then the entry is the scaffold composition root.
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
});
