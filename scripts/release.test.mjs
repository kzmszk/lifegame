import assert from 'node:assert/strict';
import test from 'node:test';

import { releasePlan, validateRepository } from './release.mjs';

test('check-only plan never applies a migration or publishes a deployment', () => {
  const plan = releasePlan('check-only');
  const commands = plan.map(({ command, args }) =>
    [command, ...args].join(' '),
  );

  assert.ok(
    commands.includes(
      'npx --no-install wrangler d1 migrations list lifegame --remote',
    ),
  );
  assert.ok(commands.includes('npx --no-install wrangler deploy --dry-run'));
  assert.ok(commands.includes('npm run smoke'));
  assert.equal(
    commands.some((command) => command.includes('migrations apply')),
    false,
  );
  assert.equal(commands.includes('npm run deploy'), false);
});

test('production applies D1 migrations before deploy and smoke', () => {
  const commands = releasePlan('production').map(({ command, args }) =>
    [command, ...args].join(' '),
  );
  const migration = commands.indexOf(
    'npx --no-install wrangler d1 migrations apply lifegame --remote',
  );
  const deploy = commands.indexOf('npm run deploy');

  assert.ok(migration >= 0);
  assert.ok(deploy > migration);
});

test('repository guard accepts only a clean synchronized main', () => {
  const valid = {
    branch: 'main',
    dirty: '',
    head: 'abc123',
    remoteHead: 'abc123',
  };

  assert.doesNotThrow(() => validateRepository(valid));
  assert.throws(
    () => validateRepository({ ...valid, branch: 'feature' }),
    /must run from main/,
  );
  assert.throws(
    () => validateRepository({ ...valid, dirty: ' M README.md' }),
    /clean worktree/,
  );
  assert.throws(
    () => validateRepository({ ...valid, remoteHead: 'def456' }),
    /exactly match origin\/main/,
  );
});
