import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { isGrantRevoked, markGrantRevoked } from './revocation';

function kv(stored: Record<string, string> = {}) {
  const put = vi.fn(async (key: string, value: string) => { stored[key] = value; });
  const get = vi.fn(async (key: string) => stored[key] ?? null);
  return { kv: { put, get } as unknown as Env['OAUTH_KV'], put, get };
}

describe('grant revocation markers', () => {
  it('marks a revoked grant so a later refresh can be refused', async () => {
    const store = kv();

    await markGrantRevoked(store.kv, 'me@example.com', 'grant-1');

    expect(await isGrantRevoked(store.kv, 'me@example.com', 'grant-1')).toBe(true);
    // The marker has to outlive any grant that a racing refresh could resurrect.
    expect(store.put).toHaveBeenCalledWith(
      'revoked:me@example.com:grant-1',
      '1',
      { expirationTtl: 30 * 24 * 60 * 60 },
    );
  });

  it('keeps markers separate per user and per grant', async () => {
    const store = kv();
    await markGrantRevoked(store.kv, 'me@example.com', 'grant-1');

    expect(await isGrantRevoked(store.kv, 'me@example.com', 'grant-2')).toBe(false);
    expect(await isGrantRevoked(store.kv, 'someone-else@example.com', 'grant-1')).toBe(false);
  });
});
