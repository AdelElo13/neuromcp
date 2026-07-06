import { defineConfig } from 'vitest/config';

// Perf lane: runs only the eval-quality tests with latency assertions armed.
// Kept out of the default `npm test` because wall-clock asserts are
// machine-load-sensitive (see tests/eval/retrieval-quality.test.ts). Run on
// an otherwise idle machine: `npm run test:perf`.
//
// Deliberately NOT built with mergeConfig(vitest.config.ts, …): mergeConfig
// concatenates `include` arrays, so the base `tests/**` glob would drag the
// whole suite back into the perf lane. The few base settings that matter
// here are duplicated instead.
export default defineConfig({
  test: {
    include: ['tests/eval/**/*.test.ts'],
    globals: true,
    testTimeout: 30_000,
    pool: 'forks',
    env: {
      NEUROMCP_PERF_ASSERT: '1',
    },
  },
});
