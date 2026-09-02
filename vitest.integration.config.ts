import { defineConfig } from 'vitest/config';

/** Redis / HTTP smokes. Needs Valkey. Invoked via `pnpm test:integration`. */
export default defineConfig({
  test: {
    include: [ 'test/integration/**/*.spec.ts' ],
    fileParallelism: false,
    passWithNoTests: true,
  },
});
