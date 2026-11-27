import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    // Many test files spawn kicad-cli, a JRE, or a Python engine per test; one
    // worker per core (16 here) floods the machine. Four keeps it responsive.
    maxWorkers: 4,
  },
});
