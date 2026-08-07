import { env as workerEnv } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../app';
import * as access from '../lib/access';
import {
  REPEAT_DEADLINE_ERROR,
  REPEAT_OPEN_ONLY_ERROR,
  REPEAT_RULE_ERROR,
  REPEAT_SCHEDULED_DATE_ERROR,
} from '../lib/repeat';

function env(overrides: Record<string, unknown> = {}) {
  return {
    ...workerEnv,
    ASSETS: { fetch: vi.fn() },
    AUTH_REQUIRED: 'false',
    ...overrides,
  };
}

interface TaskSeed {
  title?: string;
  note?: string;
  status?: 'open' | 'done';
  due_date?: string | null;
  due_time?: string | null;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  priority?: number;
  tags?: string;
  repeat_rule?: string | null;
}

async function seedTask(overrides: TaskSeed = {}): Promise<number> {
  const task = {
    title: 'ゴミ出し',
    note: '',
    status: 'open' as const,
    due_date: null,
    due_time: null,
    scheduled_date: null,
    scheduled_time: null,
    priority: 0,
    tags: '',
    repeat_rule: null as string | null,
    ...overrides,
  };
  const result = await workerEnv.DB.prepare(
    `INSERT INTO tasks
      (title, note, status, due_date, due_time, scheduled_date, scheduled_time,
       priority, tags, repeat_rule, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END)`,
  )
    .bind(
      task.title,
      task.note,
      task.status,
      task.due_date,
      task.due_time,
      task.scheduled_date,
      task.scheduled_time,
      task.priority,
      task.tags,
      task.repeat_rule,
      task.status,
    )
    .run();
  return Number(result.meta.last_row_id);
}

async function seedRevokedGrant(
  userId: string,
  grantId: string,
): Promise<void> {
  await workerEnv.DB.prepare(
    'INSERT INTO revoked_grants (user_id, grant_id) VALUES (?, ?)',
  )
    .bind(userId, grantId)
    .run();
}

const ACCESS_TEAM_DOMAIN = 'https://team.cloudflareaccess.com';
const ACCESS_AUD = 'access-aud';
let accessKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let accessPublicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  accessKeyPair = await generateKeyPair('RS256');
  accessPublicJwk = await exportJWK(accessKeyPair.publicKey);
  accessPublicJwk.kid = 'test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubAccessJwks(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ keys: [accessPublicJwk] })),
  );
}

function accessEnv(overrides: Record<string, unknown> = {}) {
  return env({
    AUTH_REQUIRED: 'true',
    ALLOWED_EMAIL: 'me@example.com',
    ACCESS_TEAM_DOMAIN,
    ACCESS_AUD,
    ...overrides,
  });
}

async function accessJwt({
  privateKey = accessKeyPair.privateKey,
  email = 'me@example.com',
  issuer = ACCESS_TEAM_DOMAIN,
  audience = ACCESS_AUD,
  expirationTime = '5m',
}: {
  privateKey?: typeof accessKeyPair.privateKey;
  email?: string;
  issuer?: string;
  audience?: string;
  expirationTime?: string | number;
} = {}): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expirationTime)
    .sign(privateKey);
}

async function requestWithAccessJwt(
  token: string | undefined,
  headers: Record<string, string> = {},
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return app.request(
    '/api/tasks',
    {
      headers: {
        ...headers,
        ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}),
      },
    },
    accessEnv(overrides),
  );
}

describe('API safety boundaries', () => {
  it('rejects impossible calendar dates before persistence', async () => {
    const response = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '予定', due_date: '2026-02-31' }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'due_date は YYYY-MM-DD 形式で指定してください',
    });
  });

  it('rejects a malformed repeat_rule before persistence', async () => {
    const response = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'ゴミ出し',
          due_date: '2026-08-10',
          repeat_rule: 'weekly:9',
        }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: REPEAT_RULE_ERROR });
  });

  // Without a scheduled_date there is no anchor to advance from, so the task would
  // complete once and never come back.
  it('rejects a recurring task that has no scheduled_date', async () => {
    const response = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'ゴミ出し', repeat_rule: 'daily' }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: REPEAT_SCHEDULED_DATE_ERROR,
    });
  });

  it('rejects deadline fields on a recurring task instead of treating them as its start', async () => {
    const response = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'ゴミ出し',
          due_date: '2026-08-10',
          scheduled_date: '2026-08-10',
          repeat_rule: 'daily',
        }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: REPEAT_DEADLINE_ERROR });
  });

  // These are plain bad requests, not races. Letting them fall through to the
  // constraint would answer "conflict" to someone who has nothing to retry.
  it('explains a done recurring task rather than reporting a conflict', async () => {
    const created = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'ゴミ出し',
          scheduled_date: '2026-08-10',
          repeat_rule: 'daily',
          status: 'done',
        }),
      },
      env(),
    );
    expect(created.status).toBe(400);
    expect(await created.json()).toEqual({ error: REPEAT_OPEN_ONLY_ERROR });

    const id = await seedTask({
      status: 'done',
      scheduled_date: '2026-08-10',
    });
    const added = await app.request(
      `/api/tasks/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repeat_rule: 'daily' }),
      },
      env(),
    );
    expect(added.status).toBe(400);
    expect(await added.json()).toEqual({ error: REPEAT_OPEN_ONLY_ERROR });
  });

  // A new row races with nothing, so a constraint failure on insert means our
  // validation and the schema disagree. Answering "conflict" would tell the
  // caller to retry a request that cannot ever succeed.
  it('surfaces a real D1 creation CHECK failure as a server error', async () => {
    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_task_creation
       BEFORE INSERT ON tasks
       BEGIN
         SELECT RAISE(ABORT, 'CHECK constraint failed: tasks');
       END`,
    ).run();
    const response = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'ゴミ出し',
          scheduled_date: '2026-08-10',
          repeat_rule: 'daily',
        }),
      },
      env(),
    );

    expect(response.status).toBe(500);
  });

  it('cancels an active recurrence against real D1', async () => {
    const id = await seedTask({
      scheduled_date: '2026-08-10',
      repeat_rule: 'daily',
    });
    const response = await app.request(
      `/api/tasks/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repeat_rule: null }),
      },
      env(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      task: {
        id,
        repeat_rule: null,
      },
    });
  });

  it('rejects clearing the scheduled_date of an existing recurring task', async () => {
    const id = await seedTask({
      scheduled_date: '2026-08-10',
      repeat_rule: 'daily',
    });
    const response = await app.request(
      `/api/tasks/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_date: null }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: REPEAT_SCHEDULED_DATE_ERROR,
    });
  });

  it('returns 409 when real D1 rejects a recurring completion as a conflict', async () => {
    const id = await seedTask({
      scheduled_date: '2026-08-01',
      repeat_rule: 'daily',
    });
    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_api_completion
       BEFORE UPDATE OF status ON tasks
       WHEN NEW.status = 'done'
       BEGIN
         SELECT RAISE(ABORT, 'CHECK constraint failed: tasks');
       END`,
    ).run();
    const response = await app.request(
      `/api/tasks/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      },
      env(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        'タスクが別の更新と競合しました。最新の内容を確認してからもう一度お試しください',
    });
  });

  // The SPA completes optimistically, so a double-tapped toggle sends the same
  // request twice. The loser must not be told the task vanished.
  it('treats a duplicate completion as idempotent on real D1', async () => {
    const id = await seedTask({
      scheduled_date: '2026-08-01',
      repeat_rule: 'daily',
    });
    const patch = (body: Record<string, unknown>) =>
      app.request(
        `/api/tasks/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env(),
      );

    const first = await patch({ status: 'done' });
    expect(first.status).toBe(200);
    const duplicate = await patch({ status: 'done' });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      task: {
        id,
        status: 'done',
        repeat_rule: null,
        repeat_child_id: id + 1,
      },
    });
  });

  it('requires an allowlisted email when authentication is enabled', async () => {
    const response = await app.request(
      '/api/tasks',
      {},
      env({ AUTH_REQUIRED: 'true' }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'ALLOWED_EMAIL が設定されていません',
    });
  });

  it('rejects a request with no Access JWT', async () => {
    const response = await requestWithAccessJwt(undefined);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Cloudflare Access のユーザー情報がありません',
    });
  });

  it('rejects the legacy email header when no Access JWT is present', async () => {
    const response = await requestWithAccessJwt(undefined, {
      'Cf-Access-Authenticated-User-Email': 'me@example.com',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Cloudflare Access のユーザー情報がありません',
    });
  });

  it('rejects an Access JWT signed by a key outside the JWKS', async () => {
    stubAccessJwks();
    const otherKeyPair = await generateKeyPair('RS256');
    const token = await accessJwt({ privateKey: otherKeyPair.privateKey });
    const response = await requestWithAccessJwt(token);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Cloudflare Access の認証情報を検証できませんでした',
    });
  });

  it('rejects an Access JWT with the wrong audience', async () => {
    stubAccessJwks();
    const token = await accessJwt({ audience: 'another-access-app' });
    const response = await requestWithAccessJwt(token);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Cloudflare Access の認証情報を検証できませんでした',
    });
  });

  it('rejects an Access JWT with the wrong issuer', async () => {
    stubAccessJwks();
    const token = await accessJwt({
      issuer: 'https://other.cloudflareaccess.com',
    });
    const response = await requestWithAccessJwt(token);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Cloudflare Access の認証情報を検証できませんでした',
    });
  });

  it('rejects an expired Access JWT', async () => {
    stubAccessJwks();
    const token = await accessJwt({
      expirationTime: Math.floor(Date.now() / 1000) - 60,
    });
    const response = await requestWithAccessJwt(token);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Cloudflare Access の認証情報を検証できませんでした',
    });
  });

  it('rejects a JWT email that is not allowlisted', async () => {
    stubAccessJwks();
    const token = await accessJwt({ email: 'other@example.com' });
    const response = await requestWithAccessJwt(token);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'このユーザーは利用を許可されていません',
    });
  });

  it('does not fall back to the email header when a valid JWT carries no email', async () => {
    stubAccessJwks();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ACCESS_TEAM_DOMAIN)
      .setAudience(ACCESS_AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(accessKeyPair.privateKey);
    const response = await requestWithAccessJwt(token, {
      'Cf-Access-Authenticated-User-Email': 'me@example.com',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Cloudflare Access のユーザー情報がありません',
    });
  });

  it('rejects a signed JWT that never expires', async () => {
    stubAccessJwks();
    const token = await new SignJWT({ email: 'me@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ACCESS_TEAM_DOMAIN)
      .setAudience(ACCESS_AUD)
      .setIssuedAt()
      .sign(accessKeyPair.privateKey);
    const response = await requestWithAccessJwt(token);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Cloudflare Access の認証情報を検証できませんでした',
    });
  });

  it('returns JSON for unknown API paths and unsupported methods', async () => {
    const unknown = await app.request('/api/does-not-exist', {}, env());
    const unsupported = await app.request(
      '/api/tasks',
      { method: 'PUT' },
      env(),
    );
    const parseUnsupported = await app.request('/api/tasks/parse', {}, env());

    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get('content-type')).toContain(
      'application/json',
    );
    expect(parseUnsupported.status).toBe(405);
  });

  it('returns 405 with Allow: POST for PATCH/DELETE on the parse endpoint', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      const response = await app.request('/api/tasks/parse', { method }, env());

      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
    }
  });

  it("lists the authenticated user's connections with client metadata and newest first", async () => {
    stubAccessJwks();
    const token = await accessJwt();
    const listUserGrants = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            id: 'grant-old',
            clientId: 'client-old',
            userId: 'me@example.com',
            scope: ['tasks:read'],
            metadata: {},
            createdAt: 1785734300,
          },
        ],
        cursor: 'page-2',
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'grant-new',
            clientId: 'client-new',
            userId: 'me@example.com',
            scope: ['tasks:read', 'tasks:write'],
            metadata: { clientName: 'Claude' },
            createdAt: 1785734382,
          },
        ],
      });
    const response = await app.request(
      '/api/connections',
      {
        headers: {
          'Cf-Access-Jwt-Assertion': token,
          'Cf-Access-Authenticated-User-Email': 'attacker@example.com',
        },
      },
      accessEnv({
        OAUTH_PROVIDER: { listUserGrants },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connections: [
        {
          id: 'grant-new',
          client_id: 'client-new',
          client_name: 'Claude',
          scope: ['tasks:read', 'tasks:write'],
          created_at: 1785734382,
        },
        {
          id: 'grant-old',
          client_id: 'client-old',
          client_name: 'client-old',
          scope: ['tasks:read'],
          created_at: 1785734300,
        },
      ],
      truncated: false,
    });
    expect(listUserGrants).toHaveBeenNthCalledWith(1, 'me@example.com', {
      limit: 100,
    });
    expect(listUserGrants).toHaveBeenNthCalledWith(2, 'me@example.com', {
      limit: 100,
      cursor: 'page-2',
    });
  });

  it('verifies Access once while handling a connection request', async () => {
    stubAccessJwks();
    const token = await accessJwt();
    const getAccessUser = vi.spyOn(access, 'getAccessUser');

    const response = await app.request(
      '/api/connections',
      {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      },
      accessEnv({
        OAUTH_PROVIDER: {
          listUserGrants: vi.fn().mockResolvedValue({ items: [] }),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(getAccessUser).toHaveBeenCalledTimes(1);
  });

  it('hides a grant that a raced refresh wrote back after it was revoked', async () => {
    await seedRevokedGrant('local-dev', 'grant-zombie');
    const response = await app.request(
      '/api/connections',
      {},
      env({
        OAUTH_PROVIDER: {
          listUserGrants: vi.fn().mockResolvedValue({
            items: [
              {
                id: 'grant-zombie',
                clientId: 'c1',
                userId: 'local-dev',
                scope: [],
                metadata: {},
                createdAt: 2,
              },
              {
                id: 'grant-live',
                clientId: 'c2',
                userId: 'local-dev',
                scope: [],
                metadata: {},
                createdAt: 1,
              },
            ],
          }),
        },
      }),
    );

    // Listing it would contradict the disconnect the user was already told succeeded.
    expect(await response.json()).toEqual({
      connections: [
        {
          id: 'grant-live',
          client_id: 'c2',
          client_name: 'c2',
          scope: [],
          created_at: 1,
        },
      ],
      truncated: false,
    });
  });

  it('passes the Access email to revokeGrant and ignores a userId query parameter', async () => {
    stubAccessJwks();
    const token = await accessJwt();
    const revokeGrant = vi.fn().mockResolvedValue(undefined);
    const response = await app.request(
      '/api/connections/grant-1?userId=someone-else@example.com',
      {
        method: 'DELETE',
        headers: { 'Cf-Access-Jwt-Assertion': token },
      },
      accessEnv({
        OAUTH_PROVIDER: {
          listUserGrants: vi.fn().mockResolvedValue({
            items: [
              {
                id: 'grant-1',
                clientId: 'client-1',
                userId: 'me@example.com',
                scope: [],
                metadata: {},
                createdAt: 1,
              },
            ],
          }),
          revokeGrant,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(revokeGrant).toHaveBeenCalledWith('grant-1', 'me@example.com');
    // A refresh racing with the first pass re-saves the grant; the second pass sweeps it.
    expect(revokeGrant).toHaveBeenCalledTimes(2);
  });

  it('marks the grant revoked before sweeping it, so an in-flight refresh is refused', async () => {
    stubAccessJwks();
    const token = await accessJwt();
    const markedAtRevoke: boolean[] = [];
    const revokeGrant = vi.fn(async () => {
      const marker = await workerEnv.DB.prepare(
        'SELECT 1 FROM revoked_grants WHERE user_id = ? AND grant_id = ?',
      )
        .bind('me@example.com', 'grant-1')
        .first();
      markedAtRevoke.push(marker !== null);
    });
    const response = await app.request(
      '/api/connections/grant-1',
      {
        method: 'DELETE',
        headers: { 'Cf-Access-Jwt-Assertion': token },
      },
      accessEnv({
        OAUTH_PROVIDER: {
          listUserGrants: vi.fn().mockResolvedValue({
            items: [
              {
                id: 'grant-1',
                clientId: 'client-1',
                userId: 'me@example.com',
                scope: [],
                metadata: {},
                createdAt: 1,
              },
            ],
          }),
          revokeGrant,
        },
      }),
    );

    expect(response.status).toBe(200);
    // Marking after the sweep would leave the race the record exists to close.
    expect(markedAtRevoke).toEqual([true, true]);
  });

  it('stops scanning once the grant being revoked is found', async () => {
    const listUserGrants = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'grant-1',
          clientId: 'client-1',
          userId: 'local-dev',
          scope: [],
          metadata: {},
          createdAt: 1,
        },
      ],
      cursor: 'more-pages',
    });
    const response = await app.request(
      '/api/connections/grant-1',
      { method: 'DELETE' },
      env({
        OAUTH_PROVIDER: {
          listUserGrants,
          revokeGrant: vi.fn().mockResolvedValue(undefined),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(listUserGrants).toHaveBeenCalledTimes(1);
  });

  it('does not claim a grant is missing when the scan was truncated', async () => {
    const revokeGrant = vi.fn();
    const response = await app.request(
      '/api/connections/grant-on-a-later-page',
      { method: 'DELETE' },
      env({
        OAUTH_PROVIDER: {
          listUserGrants: vi
            .fn()
            .mockResolvedValue({ items: [], cursor: 'always-more' }),
          revokeGrant,
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: '接続数が多く、確認しきれませんでした',
    });
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it('returns 404 instead of treating a missing grant as revoked', async () => {
    const revokeGrant = vi.fn();
    const response = await app.request(
      '/api/connections/missing-grant',
      { method: 'DELETE' },
      env({
        OAUTH_PROVIDER: {
          listUserGrants: vi.fn().mockResolvedValue({ items: [] }),
          revokeGrant,
        },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '接続が見つかりません' });
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it('rejects empty, oversized, and control-character grant IDs', async () => {
    for (const path of [
      '/api/connections/',
      `/api/connections/${'x'.repeat(257)}`,
      '/api/connections/bad%0Aid',
    ]) {
      const response = await app.request(path, { method: 'DELETE' }, env());

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: '接続IDが不正です' });
    }
  });

  it('stops following connection cursors at the page limit', async () => {
    const listUserGrants = vi
      .fn()
      .mockResolvedValue({ items: [], cursor: 'always-more' });
    const response = await app.request(
      '/api/connections',
      {},
      env({ OAUTH_PROVIDER: { listUserGrants } }),
    );

    expect(response.status).toBe(200);
    // A partial list must say so; the UI hides connections it cannot show otherwise.
    expect(await response.json()).toEqual({ connections: [], truncated: true });
    // Five pages keeps the worst case (one list plus one get per grant) inside the
    // 1000-operation KV budget, with headroom for a revocation on the same request.
    expect(listUserGrants).toHaveBeenCalledTimes(5);
  });

  it('returns the connection-specific Allow header for unsupported methods', async () => {
    const collection = await app.request(
      '/api/connections',
      { method: 'POST' },
      env(),
    );
    const item = await app.request(
      '/api/connections/grant-1',
      { method: 'GET' },
      env(),
    );

    expect(collection.status).toBe(405);
    expect(collection.headers.get('allow')).toBe('GET');
    expect(item.status).toBe(405);
    expect(item.headers.get('allow')).toBe('DELETE');
  });
});

describe('task list pagination', () => {
  it('bounds all and returns an offset for the next page', async () => {
    await seedTask({ title: 'ページング1' });
    await seedTask({ title: 'ページング2' });
    await seedTask({ title: 'ページング3' });

    const firstResponse = await app.request(
      '/api/tasks?view=all&limit=2&offset=0',
      {},
      env(),
    );
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      tasks: Array<{ id: number }>;
      truncated: boolean;
      next_offset: number | null;
    };
    expect(first.tasks).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(2);

    const secondResponse = await app.request(
      `/api/tasks?view=all&limit=2&offset=${first.next_offset}`,
      {},
      env(),
    );
    const second = (await secondResponse.json()) as typeof first;
    expect(secondResponse.status).toBe(200);
    expect(second.tasks).toHaveLength(1);
    expect(second.truncated).toBe(false);
    expect(second.tasks[0].id).not.toBe(first.tasks[0].id);
  });

  it('bounds inbox and rejects invalid page parameters', async () => {
    await seedTask({ title: 'Inboxページング1' });
    await seedTask({ title: 'Inboxページング2' });
    await seedTask({ title: 'Inboxページング3' });

    const response = await app.request(
      '/api/tasks?view=inbox&limit=2',
      {},
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      truncated: true,
      next_offset: 2,
    });

    const invalid = await app.request('/api/tasks?view=all&limit=0', {}, env());
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: 'limit は 1 以上 100 以下の整数で指定してください',
    });
  });
});

describe('health entry API', () => {
  async function requestHealth(
    path: string,
    init: RequestInit = {},
    requestEnv: Record<string, unknown> = {},
  ): Promise<Response> {
    return app.request(path, init, env(requestEnv));
  }

  async function createHealthEntry(body: Record<string, unknown>) {
    return requestHealth('/api/health-entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('creates both kinds and lists inclusive date filters with pagination', async () => {
    const older = await createHealthEntry({
      kind: 'exercise',
      occurred_on: '2026-08-06',
      activity: '散歩',
    });
    const newer = await createHealthEntry({
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 68.4,
      note: '朝',
    });
    await createHealthEntry({
      kind: 'exercise',
      occurred_on: '2026-08-07',
      activity: '筋トレ',
      duration_minutes: 30,
    });
    expect(older.status).toBe(201);
    expect(newer.status).toBe(201);

    const firstResponse = await requestHealth(
      '/api/health-entries?from=2026-08-06&to=2026-08-07&limit=2&offset=0',
    );
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first).toMatchObject({
      entries: [
        { kind: 'exercise', occurred_on: '2026-08-07', activity: '筋トレ' },
        { kind: 'weight', occurred_on: '2026-08-07', weight_kg: 68.4 },
      ],
      truncated: true,
      next_offset: 2,
    });

    const secondResponse = await requestHealth(
      '/api/health-entries?from=2026-08-06&to=2026-08-07&limit=2&offset=2',
    );
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({
      entries: [
        expect.objectContaining({
          kind: 'exercise',
          occurred_on: '2026-08-06',
          activity: '散歩',
        }),
      ],
      truncated: false,
      next_offset: null,
    });
  });

  it('updates kind-specific fields without changing kind and deletes entries', async () => {
    const created = await createHealthEntry({
      kind: 'weight',
      occurred_on: '2026-08-01',
      weight_kg: 70,
    });
    const { entry } = (await created.json()) as { entry: { id: number } };

    const corrected = await requestHealth(`/api/health-entries/${entry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'weight',
        occurred_on: '2026-08-02',
        weight_kg: 69.5,
        note: '訂正',
      }),
    });
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({
      entry: {
        id: entry.id,
        kind: 'weight',
        occurred_on: '2026-08-02',
        weight_kg: 69.5,
        note: '訂正',
      },
    });

    const changedKind = await requestHealth(`/api/health-entries/${entry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'exercise', activity: '誤入力' }),
    });
    expect(changedKind.status).toBe(400);

    const deleted = await requestHealth(`/api/health-entries/${entry.id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    const deletedAgain = await requestHealth(
      `/api/health-entries/${entry.id}`,
      { method: 'DELETE' },
    );
    expect(deletedAgain.status).toBe(404);
  });

  it('rejects invalid dates, ranges, pagination, numbers, and kind fields', async () => {
    const invalidRequests: Array<Promise<Response>> = [
      requestHealth('/api/health-entries?from=2026-02-30'),
      requestHealth('/api/health-entries?from=2026-08-08&to=2026-08-07'),
      requestHealth('/api/health-entries?limit=0'),
      requestHealth('/api/health-entries?limit=101'),
      requestHealth('/api/health-entries?offset=-1'),
      createHealthEntry({
        kind: 'weight',
        occurred_on: '2026-02-30',
        weight_kg: 68,
      }),
      createHealthEntry({
        kind: 'weight',
        occurred_on: '2026-08-07',
        weight_kg: 0,
      }),
      createHealthEntry({
        kind: 'weight',
        occurred_on: '2026-08-07',
        weight_kg: Number.NaN,
      }),
      createHealthEntry({
        kind: 'exercise',
        occurred_on: '2026-08-07',
        activity: '散歩',
        duration_minutes: 0,
      }),
      createHealthEntry({
        kind: 'exercise',
        occurred_on: '2026-08-07',
        activity: '散歩',
        duration_minutes: 1441,
      }),
      createHealthEntry({
        kind: 'weight',
        occurred_on: '2026-08-07',
        weight_kg: 68,
        activity: '混在',
      }),
      createHealthEntry({
        kind: 'exercise',
        occurred_on: '2026-08-07',
        activity: '散歩',
        weight_kg: 68,
      }),
    ];

    for (const response of await Promise.all(invalidRequests)) {
      expect(response.status).toBe(400);
    }
  });

  it('rejects malformed IDs and reports missing targets', async () => {
    for (const path of [
      '/api/health-entries/',
      '/api/health-entries/not-a-number',
      '/api/health-entries/0',
    ]) {
      const patch = await requestHealth(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'weight', weight_kg: 68 }),
      });
      expect(patch.status).toBe(400);

      const deleted = await requestHealth(path, { method: 'DELETE' });
      expect(deleted.status).toBe(400);
    }

    const missingPatch = await requestHealth('/api/health-entries/999999', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'weight', weight_kg: 68 }),
    });
    expect(missingPatch.status).toBe(404);

    const missingDelete = await requestHealth('/api/health-entries/999999', {
      method: 'DELETE',
    });
    expect(missingDelete.status).toBe(404);
  });

  it('keeps individual reads out of the browser API and requires Access', async () => {
    const unsupported = await requestHealth('/api/health-entries/1');
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get('allow')).toBe('PATCH, DELETE');

    const response = await app.request('/api/health-entries', {}, accessEnv());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Cloudflare Access のユーザー情報がありません',
    });
  });
});

describe('calendar endpoints', () => {
  function calendarEnv(overrides: Record<string, unknown> = {}) {
    const store = new Map<string, string>();
    return env({
      OAUTH_KV: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => void store.set(key, value),
        delete: async (key: string) => void store.delete(key),
      },
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      GOOGLE_REFRESH_TOKEN: 'refresh-token',
      ...overrides,
    });
  }

  function stubGoogle(handler: (url: string, init?: RequestInit) => Response) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://oauth2.googleapis.com/token'))
          return Response.json({ access_token: 'token', expires_in: 3599 });
        calls.push({ url, init });
        return handler(url, init);
      }),
    );
    return calls;
  }

  it('rejects a malformed date before calling Google', async () => {
    const calls = stubGoogle(() => Response.json({ items: [] }));
    const response = await app.request(
      '/api/calendar/events?date=2026-13-01',
      {},
      calendarEnv(),
    );

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('returns the requested day of events', async () => {
    stubGoogle(() =>
      Response.json({
        items: [
          {
            id: 'event-1',
            summary: 'ランチ会',
            start: { dateTime: '2026-08-07T12:30:00+09:00' },
            end: { dateTime: '2026-08-07T13:00:00+09:00' },
          },
        ],
      }),
    );

    const response = await app.request(
      '/api/calendar/events?date=2026-08-07',
      {},
      calendarEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      date: '2026-08-07',
      events: [{ id: 'event-1', title: 'ランチ会', start_time: '12:30' }],
    });
  });

  it('reports an upstream Google failure as 502, not as an app error', async () => {
    stubGoogle(() => new Response('', { status: 503 }));
    const response = await app.request(
      '/api/calendar/events?date=2026-08-07',
      {},
      calendarEnv(),
    );

    expect(response.status).toBe(502);
  });

  it('reports unconfigured credentials as 500', async () => {
    stubGoogle(() => Response.json({ items: [] }));
    const response = await app.request(
      '/api/calendar/events?date=2026-08-07',
      {},
      calendarEnv({ GOOGLE_REFRESH_TOKEN: undefined }),
    );

    expect(response.status).toBe(500);
  });

  it('carries an explicit end time past midnight into the next day', async () => {
    const calls = stubGoogle(() =>
      Response.json({
        id: 'created',
        summary: '夜更かし',
        start: { dateTime: '2026-08-05T23:30:00+09:00' },
        end: { dateTime: '2026-08-06T02:00:00+09:00' },
      }),
    );

    const response = await app.request(
      '/api/calendar/events',
      {
        method: 'POST',
        body: JSON.stringify({
          title: '夜更かし',
          date: '2026-08-05',
          start_time: '23:30',
          end_time: '02:00',
        }),
      },
      calendarEnv(),
    );

    expect(response.status).toBe(201);
    // 23:30-02:00 is an ordinary evening, not an invalid interval.
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.end.dateTime).toBe('2026-08-06T02:00:00');
  });

  it('still rejects a malformed end time', async () => {
    const calls = stubGoogle(() => Response.json({ id: 'x' }));
    const response = await app.request(
      '/api/calendar/events',
      {
        method: 'POST',
        body: JSON.stringify({
          title: '会議',
          date: '2026-08-05',
          start_time: '15:00',
          end_time: '25:00',
        }),
      },
      calendarEnv(),
    );

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('creates an event and returns it', async () => {
    stubGoogle(() =>
      Response.json({
        id: 'created',
        summary: '歯医者',
        start: { dateTime: '2026-08-05T15:00:00+09:00' },
        end: { dateTime: '2026-08-05T16:00:00+09:00' },
      }),
    );

    const response = await app.request(
      '/api/calendar/events',
      {
        method: 'POST',
        body: JSON.stringify({
          title: '歯医者',
          date: '2026-08-05',
          start_time: '15:00',
        }),
      },
      calendarEnv(),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      event: { id: 'created', title: '歯医者', start_time: '15:00' },
    });
  });

  it('advertises both methods on the calendar collection', async () => {
    const response = await app.request(
      '/api/calendar/events',
      { method: 'DELETE' },
      calendarEnv(),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST');
  });
});
