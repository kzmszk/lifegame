import path from 'node:path';
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { configDefaults, defineProject } from 'vitest/config';

export default async function () {
  const migrations = await readD1Migrations(path.resolve('migrations'));

  return defineProject({
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      name: 'workers',
      include: [
        'src/db/migration-0004.test.ts',
        'src/db/tasks.test.ts',
        'src/routes/api.test.ts',
      ],
      exclude: [...configDefaults.exclude, 'e2e/**'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  });
}
