#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const databaseName = 'lifegame';

/** @typedef {'check-only' | 'production'} ReleaseMode */

/**
 * Keep the production mutation sequence in one visible, testable plan.
 * @param {ReleaseMode} mode
 */
export function releasePlan(mode) {
  const common = [
    {
      label: 'Run the repository quality gate',
      command: 'npm',
      args: ['run', 'check'],
    },
    {
      label: 'Verify Cloudflare authentication',
      command: 'npx',
      args: ['--no-install', 'wrangler', 'whoami'],
    },
    {
      label: 'List pending production D1 migrations',
      command: 'npx',
      args: [
        '--no-install',
        'wrangler',
        'd1',
        'migrations',
        'list',
        databaseName,
        '--remote',
      ],
    },
  ];

  if (mode === 'check-only') {
    return [
      ...common,
      {
        label: 'Build a deployment without publishing it',
        command: 'npx',
        args: ['--no-install', 'wrangler', 'deploy', '--dry-run'],
      },
      {
        label: 'Smoke-test the currently deployed production service',
        command: 'npm',
        args: ['run', 'smoke'],
      },
    ];
  }

  if (mode === 'production') {
    return [
      ...common,
      {
        label: 'Apply pending production D1 migrations',
        command: 'npx',
        args: [
          '--no-install',
          'wrangler',
          'd1',
          'migrations',
          'apply',
          databaseName,
          '--remote',
        ],
      },
      {
        label: 'Deploy and smoke-test production',
        command: 'npm',
        args: ['run', 'deploy'],
      },
    ];
  }

  throw new Error(`Unknown release mode: ${mode}`);
}

/**
 * @param {{ branch: string, dirty: string, head: string, remoteHead: string }} state
 */
export function validateRepository(state) {
  if (state.branch !== 'main') {
    throw new Error(`Release must run from main, not ${state.branch}`);
  }
  if (state.dirty !== '') {
    throw new Error(
      'Release requires a clean worktree, including untracked files',
    );
  }
  if (state.head !== state.remoteHead) {
    throw new Error('Local main must exactly match origin/main before release');
  }
}

function completed(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.status ?? 'unknown'}`,
    );
  }
  return result;
}

function run(command, args, label) {
  console.log(`\n==> ${label}`);
  return completed(
    spawnSync(command, args, { stdio: 'inherit', shell: false }),
    label,
  );
}

function capture(command, args, label) {
  const result = completed(
    spawnSync(command, args, { encoding: 'utf8', shell: false }),
    label,
  );
  return result.stdout.trim();
}

function repositoryState() {
  run('git', ['fetch', 'origin', 'main'], 'Fetch origin/main');
  return {
    branch: capture('git', ['branch', '--show-current'], 'Read current branch'),
    dirty: capture(
      'git',
      ['status', '--porcelain', '--untracked-files=normal'],
      'Read worktree status',
    ),
    head: capture('git', ['rev-parse', 'HEAD'], 'Read local main'),
    remoteHead: capture(
      'git',
      ['rev-parse', 'origin/main'],
      'Read origin/main',
    ),
  };
}

function usage() {
  console.error(
    'Usage: node scripts/release.mjs (--check-only | --production) [--print-plan]',
  );
}

function main() {
  const mode = process.argv.includes('--check-only')
    ? 'check-only'
    : process.argv.includes('--production')
      ? 'production'
      : null;
  if (
    !mode ||
    process.argv.includes('--check-only') ===
      process.argv.includes('--production')
  ) {
    usage();
    process.exitCode = 2;
    return;
  }

  const plan = releasePlan(mode);
  if (process.argv.includes('--print-plan')) {
    console.log(JSON.stringify(plan));
    return;
  }

  const state = repositoryState();
  validateRepository(state);
  console.log(`Releasing ${state.head} from a clean, synchronized main.`);
  for (const step of plan) run(step.command, step.args, step.label);
  console.log(
    mode === 'production'
      ? '\nProduction migration, deployment, and smoke checks completed.'
      : '\nRelease preflight completed without changing production.',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `\nRelease stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
