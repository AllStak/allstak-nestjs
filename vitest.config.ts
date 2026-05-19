import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // real-nest.test.ts boots a full NestJS app, which can exceed
    // the default 5000ms timeout on slower CI runners (especially
    // Node 18, which loads the @nestjs/core graph more slowly).
    // 30000ms matches the upper bound observed in CI for cold-boot
    // scenarios with no margin for flakes.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
