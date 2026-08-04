import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright owns e2e/. Without this, vitest's default include picks up the
    // *.spec.ts files there and fails on the Playwright-only imports.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
