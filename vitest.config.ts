import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Only our own suites: content-sw/ holds a clone of the third-party data repo with its own tests.
export default defineConfig({
  test: { include: ['packages/**/*.test.ts'] },
  resolve: {
    alias: {
      '@holotable/rules': resolve(__dirname, 'packages/rules/src/index.ts'),
      '@holotable/bot': resolve(__dirname, 'packages/bot/src/index.ts'),
    },
  },
});
