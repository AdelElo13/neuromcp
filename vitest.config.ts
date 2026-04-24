import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    testTimeout: 30_000,
    pool: 'forks',
    // sprint1: coverage reporting — lcov for Codecov/sonar, text for local eye.
    // Thresholds are a soft floor reflecting today's estate so CI turns red
    // only on a genuine regression, not on day 1. Raise after sprint2.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'eval/**',
        'scripts/**',
      ],
      thresholds: {
        // sprint1 Q5: tightened to track within ~5pp of actual baseline
        // (lines 59% / functions 79% / branches 79%) so a real regression
        // turns CI red instead of slowly drifting under a too-soft floor.
        lines: 55,
        functions: 75,
        statements: 55,
        branches: 70,
      },
    },
  },
});
