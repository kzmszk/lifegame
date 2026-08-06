import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'node',
    include: ['src/**/*.test.ts'],
    // Database and route tests use the Workers project below. Playwright owns
    // e2e/. Without this, Vitest's default include picks up its *.spec.ts files.
    exclude: [
      ...configDefaults.exclude,
      'e2e/**',
      'src/db/tasks.test.ts',
      'src/routes/api.test.ts',
    ],
  },
});
