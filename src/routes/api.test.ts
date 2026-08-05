import type { D1Database } from '@cloudflare/workers-types';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../app';
import {
  REPEAT_DONE_ON_CREATE_ERROR,
  REPEAT_DUE_DATE_ERROR,
  REPEAT_RULE_ERROR,
} from '../lib/repeat';

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database,
    ASSETS: { fetch: vi.fn() },
    AUTH_REQUIRED: 'false',
    ...overrides,
  };
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

  // Without a due_date there is no anchor to advance from, so the task would
  // complete once and never come back.
  it('rejects a recurring task that has no due_date', async () => {
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
    expect(await response.json()).toEqual({ error: REPEAT_DUE_DATE_ERROR });
  });

  // The child is spawned by the open→done transition, which a task created
  // already done never makes — the series would be born with no successor.
  it('rejects creating a recurring task that is already done', async () => {
    const response = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'ゴミ出し',
          due_date: '2026-08-10',
          repeat_rule: 'daily',
          status: 'done',
        }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: REPEAT_DONE_ON_CREATE_ERROR,
    });
  });

  it('rejects clearing the due_date of an existing recurring task', async () => {
    const stored = {
      id: 1,
      title: 'ゴミ出し',
      note: '',
      status: 'open' as const,
      due_date: '2026-08-10',
      due_time: null,
      priority: 0,
      tags: '',
      repeat_rule: 'daily',
      repeat_child_id: null,
      created_at: '2026-08-01 00:00:00',
      updated_at: '2026-08-01 00:00:00',
      completed_at: null,
    };
    const response = await app.request(
      '/api/tasks/1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due_date: null }),
      },
      env({
        DB: {
          prepare: () => ({
            bind: () => ({
              run: async () => ({ success: true, meta: { changes: 1 } }),
              first: async () => stored,
              all: async () => ({ results: [] }),
            }),
          }),
        } as unknown as D1Database,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: REPEAT_DUE_DATE_ERROR });
  });

  it('returns 409 when a recurring completion loses to a concurrent edit', async () => {
    const stored = {
      id: 1,
      title: 'ゴミ出し',
      note: '',
      status: 'open' as const,
      due_date: '2026-08-01',
      due_time: null,
      priority: 0,
      tags: '',
      repeat_rule: 'daily',
      repeat_child_id: null,
      created_at: '2026-08-01 00:00:00',
      updated_at: '2026-08-01 00:00:00',
      completed_at: null,
    };
    const response = await app.request(
      '/api/tasks/1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      },
      env({
        DB: {
          prepare: () => ({
            bind: () => ({
              first: async () => stored,
              run: async () => ({ success: true, meta: { changes: 1 } }),
            }),
          }),
          batch: async () =>
            [0, 0, 0].map(() => ({
              success: true,
              results: [],
              meta: { changes: 0 },
            })),
        } as unknown as D1Database,
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        'タスクが別の更新と競合しました。最新の内容を確認してからもう一度お試しください',
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

  it('hides a grant that a raced refresh wrote back after it was revoked', async () => {
    const DB = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [{ grant_id: 'grant-zombie' }] }),
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => null,
        }),
      }),
    } as unknown as D1Database;
    const response = await app.request(
      '/api/connections',
      {},
      env({
        DB,
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
    const order: string[] = [];
    const marked: Array<[string, string]> = [];
    const revokeGrant = vi.fn(async () => {
      order.push('revoke');
    });
    const DB = {
      prepare: (sql: string) => ({
        bind: (userId: string, grantId: string) => ({
          run: async () => {
            order.push('mark');
            marked.push([
              sql.includes('revoked_grants') ? 'revoked_grants' : sql,
              `${userId}:${grantId}`,
            ]);
            return { success: true, meta: { changes: 1 } };
          },
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      }),
    };
    const response = await app.request(
      '/api/connections/grant-1',
      {
        method: 'DELETE',
        headers: { 'Cf-Access-Jwt-Assertion': token },
      },
      accessEnv({
        DB,
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
    expect(marked).toEqual([['revoked_grants', 'me@example.com:grant-1']]);
    // Marking after the sweep would leave the race the record exists to close.
    expect(order).toEqual(['mark', 'revoke', 'revoke']);
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
