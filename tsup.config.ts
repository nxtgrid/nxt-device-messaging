import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

const LUA_SRC_DIR = 'src/lib/redis-repository/lua';
/** Beside `dist/main.js` — `client.ts` loads `./lua` from `import.meta.url`. */
const LUA_DIST_DIR = 'dist/lua';

/**
 * Production build (ADR-004). Lua scripts are copied beside the bundle;
 * `config.default.json` ships with the bundle for ADR-002 fallback.
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
    // Lua scripts are loaded at runtime by the Redis repository (ADR-004).
    mkdirSync(LUA_DIST_DIR, { recursive: true });
    for (const name of readdirSync(LUA_SRC_DIR)) {
      if (!name.endsWith('.lua')) continue;
      copyFileSync(join(LUA_SRC_DIR, name), join(LUA_DIST_DIR, name));
    }
  },
});
