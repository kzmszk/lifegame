import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createHealthEntry, listHealthEntries } from '../db/health-entries';
import { markGrantRevoked } from '../lib/revocation';
import { handleHealthSync, type SyncAuthProps } from './sync';

const SYNCED_PROPS: SyncAuthProps = {
  email: 'owner@example.com',
  scopes: ['health:write'],
  grantId: 'grant-1',
};

function weight(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'weight',
    external_id: 'hc-weight-1',
    occurred_at: '2026-08-10T07:12:00+09:00',
    weight_kg: 68.4,
    ...overrides,
  };
}

function post(body: unknown, method = 'POST'): Request {
  return new Request('https://lifegame.example.com/sync', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

async function sync(
  body: unknown,
  props: SyncAuthProps | undefined = SYNCED_PROPS,
): Promise<Response> {
  return handleHealthSync(post(body), env, props);
}

async function entries() {
  const page = await listHealthEntries(env.DB, { limit: 100, offset: 0 });
  return page.entries;
}

describe('POST /sync', () => {
  it('accepts a payload and stores it as a health entry', async () => {
    const response = await sync([weight()]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(await entries()).toMatchObject([
      { kind: 'weight', occurred_on: '2026-08-10', weight_kg: 68.4, note: '' },
    ]);
  });

  // The whole point of sending the wake instant: this session started on 08-10
  // at 23:30 JST and still lands on 08-11, the morning it was slept into.
  it('stores a sleep session under the day it ended', async () => {
    const response = await sync([
      {
        kind: 'sleep',
        external_id: 'hc-sleep-1',
        occurred_at: '2026-08-11T07:00:00+09:00',
        duration_minutes: 450,
      },
    ]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(await entries()).toMatchObject([
      { kind: 'sleep', occurred_on: '2026-08-11', duration_minutes: 450 },
    ]);
  });

  it('refuses a sleep session with no length', async () => {
    const response = await sync([
      {
        kind: 'sleep',
        external_id: 'hc-sleep-1',
        occurred_at: '2026-08-11T07:00:00+09:00',
      },
    ]);

    expect(response.status).toBe(400);
    expect(await entries()).toEqual([]);
  });

  // Acceptance criterion 1: the companion replays the same records on every
  // incremental pull, so a repeat must not add rows.
  it('is idempotent across identical payloads', async () => {
    await sync([weight()]);
    const second = await sync([weight()]);

    expect(await second.json()).toEqual({ accepted: 1 });
    expect(await entries()).toHaveLength(1);
  });

  it('updates the existing row when a record changes', async () => {
    await sync([weight()]);
    await sync([weight({ weight_kg: 67.1 })]);

    const stored = await entries();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'weight', weight_kg: 67.1 });
  });

  // Acceptance criterion 3: manual rows carry no external_id, so nothing the
  // companion sends can collide with one.
  it('leaves manually entered records alone', async () => {
    const manual = await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-10',
      weight_kg: 70,
      note: '手入力',
    });

    await sync([weight()]);

    const stored = await entries();
    expect(stored).toHaveLength(2);
    expect(stored).toContainEqual(manual);
  });

  // Acceptance criterion 2.
  it('refuses a token without the health:write scope', async () => {
    const response = await sync([weight()], {
      ...SYNCED_PROPS,
      scopes: ['tasks:read'],
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'insufficient_scope',
    );
    expect(await entries()).toEqual([]);
  });

  it('refuses a request whose props carry no scopes at all', async () => {
    // Not via sync(): passing undefined would fall back to its default props.
    const missing = await handleHealthSync(post([weight()]), env, undefined);

    expect(missing.status).toBe(403);
    expect((await sync([weight()], {})).status).toBe(403);
    expect(await entries()).toEqual([]);
  });

  it('refuses a token whose grant was disconnected', async () => {
    await markGrantRevoked(env.DB, 'owner@example.com', 'grant-1');

    const response = await sync([weight()]);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('invalid_token');
    expect(await entries()).toEqual([]);
  });

  it('lets a token through when a different grant was disconnected', async () => {
    await markGrantRevoked(env.DB, 'owner@example.com', 'grant-other');

    expect((await sync([weight()])).status).toBe(200);
  });

  // The provider matches api handlers by prefix, so a valid token would otherwise
  // reach this handler at any path starting with /sync and write through it.
  it('refuses a path that only starts with /sync', async () => {
    const response = await handleHealthSync(
      new Request('https://lifegame.example.com/sync-anything', {
        method: 'POST',
        body: JSON.stringify([weight()]),
      }),
      env,
      SYNCED_PROPS,
    );

    expect(response.status).toBe(404);
    expect(await entries()).toEqual([]);
  });

  it('accepts the path with a trailing slash', async () => {
    const response = await handleHealthSync(
      new Request('https://lifegame.example.com/sync/', {
        method: 'POST',
        body: JSON.stringify([weight()]),
      }),
      env,
      SYNCED_PROPS,
    );

    expect(await response.json()).toEqual({ accepted: 1 });
  });

  it('rejects anything but POST', async () => {
    const response = await handleHealthSync(
      post(null, 'GET'),
      env,
      SYNCED_PROPS,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('rejects a body that is not JSON', async () => {
    const response = await handleHealthSync(
      new Request('https://lifegame.example.com/sync', {
        method: 'POST',
        body: 'not json',
      }),
      env,
      SYNCED_PROPS,
    );

    expect(response.status).toBe(400);
  });

  it('rejects an invalid record without storing any of the payload', async () => {
    const response = await sync([
      weight(),
      weight({ external_id: 'hc-weight-2', weight_kg: -1 }),
    ]);

    expect(response.status).toBe(400);
    expect(await entries()).toEqual([]);
  });

  it('accepts an empty payload', async () => {
    const response = await sync([]);

    expect(await response.json()).toEqual({ accepted: 0 });
  });
});
