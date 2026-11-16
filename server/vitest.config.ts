import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Sandbox tests start real containers, which takes a few seconds each.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The sync and sandbox files both use Docker/Redis; running files one at a
    // time keeps the timing-sensitive sandbox tests stable.
    fileParallelism: false,
  },
});
