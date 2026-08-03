import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../app';

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
    expect(await response.json()).toEqual({ error: 'due_date は YYYY-MM-DD 形式で指定してください' });
  });

  it('requires an allowlisted email when authentication is enabled', async () => {
    const response = await app.request('/api/tasks', {}, env({ AUTH_REQUIRED: 'true' }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'ALLOWED_EMAIL が設定されていません' });
  });

  it('returns JSON for unknown API paths and unsupported methods', async () => {
    const unknown = await app.request('/api/does-not-exist', {}, env());
    const unsupported = await app.request('/api/tasks', { method: 'PUT' }, env());
    const parseUnsupported = await app.request('/api/tasks/parse', {}, env());

    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get('content-type')).toContain('application/json');
    expect(parseUnsupported.status).toBe(405);
  });

  it('returns 405 with Allow: POST for PATCH/DELETE on the parse endpoint', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      const response = await app.request('/api/tasks/parse', { method }, env());

      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(response.headers.get('content-type')).toContain('application/json');
    }
  });

  it('lists the authenticated user\'s connections with client metadata and newest first', async () => {
    const listUserGrants = vi.fn()
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
      { headers: { 'Cf-Access-Authenticated-User-Email': 'me@example.com' } },
      env({
        AUTH_REQUIRED: 'true',
        ALLOWED_EMAIL: 'me@example.com',
        OAUTH_PROVIDER: { listUserGrants },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connections: [
        { id: 'grant-new', client_id: 'client-new', client_name: 'Claude', scope: ['tasks:read', 'tasks:write'], created_at: 1785734382 },
        { id: 'grant-old', client_id: 'client-old', client_name: 'client-old', scope: ['tasks:read'], created_at: 1785734300 },
      ],
      truncated: false,
    });
    expect(listUserGrants).toHaveBeenNthCalledWith(1, 'me@example.com', { limit: 100 });
    expect(listUserGrants).toHaveBeenNthCalledWith(2, 'me@example.com', { limit: 100, cursor: 'page-2' });
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
              { id: 'grant-zombie', clientId: 'c1', userId: 'local-dev', scope: [], metadata: {}, createdAt: 2 },
              { id: 'grant-live', clientId: 'c2', userId: 'local-dev', scope: [], metadata: {}, createdAt: 1 },
            ],
          }),
        },
      }),
    );

    // Listing it would contradict the disconnect the user was already told succeeded.
    expect(await response.json()).toEqual({
      connections: [{ id: 'grant-live', client_id: 'c2', client_name: 'c2', scope: [], created_at: 1 }],
      truncated: false,
    });
  });

  it('passes the Access email to revokeGrant and ignores a userId query parameter', async () => {
    const revokeGrant = vi.fn().mockResolvedValue(undefined);
    const response = await app.request(
      '/api/connections/grant-1?userId=someone-else@example.com',
      { method: 'DELETE', headers: { 'Cf-Access-Authenticated-User-Email': 'me@example.com' } },
      env({
        AUTH_REQUIRED: 'true',
        ALLOWED_EMAIL: 'me@example.com',
        OAUTH_PROVIDER: {
          listUserGrants: vi.fn().mockResolvedValue({
            items: [{ id: 'grant-1', clientId: 'client-1', userId: 'me@example.com', scope: [], metadata: {}, createdAt: 1 }],
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
    const order: string[] = [];
    const marked: Array<[string, string]> = [];
    const revokeGrant = vi.fn(async () => { order.push('revoke'); });
    const DB = {
      prepare: (sql: string) => ({
        bind: (userId: string, grantId: string) => ({
          run: async () => {
            order.push('mark');
            marked.push([sql.includes('revoked_grants') ? 'revoked_grants' : sql, `${userId}:${grantId}`]);
            return { success: true, meta: { changes: 1 } };
          },
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      }),
    };
    const response = await app.request(
      '/api/connections/grant-1',
      { method: 'DELETE', headers: { 'Cf-Access-Authenticated-User-Email': 'me@example.com' } },
      env({
        AUTH_REQUIRED: 'true',
        ALLOWED_EMAIL: 'me@example.com',
        DB,
        OAUTH_PROVIDER: {
          listUserGrants: vi.fn().mockResolvedValue({
            items: [{ id: 'grant-1', clientId: 'client-1', userId: 'me@example.com', scope: [], metadata: {}, createdAt: 1 }],
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
      items: [{ id: 'grant-1', clientId: 'client-1', userId: 'local-dev', scope: [], metadata: {}, createdAt: 1 }],
      cursor: 'more-pages',
    });
    const response = await app.request(
      '/api/connections/grant-1',
      { method: 'DELETE' },
      env({ OAUTH_PROVIDER: { listUserGrants, revokeGrant: vi.fn().mockResolvedValue(undefined) } }),
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
          listUserGrants: vi.fn().mockResolvedValue({ items: [], cursor: 'always-more' }),
          revokeGrant,
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '接続数が多く、確認しきれませんでした' });
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
    for (const path of ['/api/connections/', `/api/connections/${'x'.repeat(257)}`, '/api/connections/bad%0Aid']) {
      const response = await app.request(path, { method: 'DELETE' }, env());

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: '接続IDが不正です' });
    }
  });

  it('stops following connection cursors at the page limit', async () => {
    const listUserGrants = vi.fn().mockResolvedValue({ items: [], cursor: 'always-more' });
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
    const collection = await app.request('/api/connections', { method: 'POST' }, env());
    const item = await app.request('/api/connections/grant-1', { method: 'GET' }, env());

    expect(collection.status).toBe(405);
    expect(collection.headers.get('allow')).toBe('GET');
    expect(item.status).toBe(405);
    expect(item.headers.get('allow')).toBe('DELETE');
  });
});
