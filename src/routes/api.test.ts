import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../app';

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as D1Database,
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
});
