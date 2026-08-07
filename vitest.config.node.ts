import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'node',
    include: ['src/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
    // Database and route tests use the Workers project below. Playwright owns
    // e2e/. Without this, Vitest's default include picks up its *.spec.ts files.
    exclude: [
      ...configDefaults.exclude,
      'src/db/health-entries.test.ts',
      'src/db/saved-links.test.ts',
      'e2e/**',
      'src/db/migration-0004.test.ts',
      'src/db/tasks.test.ts',
      'src/routes/api.test.ts',
    ],
  },
});
