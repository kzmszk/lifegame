import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach } from 'vitest';

beforeEach(async () => {
  if (!env.TEST_MIGRATIONS)
    throw new Error('TEST_MIGRATIONS binding is not configured');
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(async () => {
  await reset();
});
