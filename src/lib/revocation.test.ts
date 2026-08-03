import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { isGrantRevoked, markGrantRevoked } from './revocation';

// Enough of D1 to record what was written and answer the lookup from it.
function fakeDb() {
  const rows = new Set<string>();
  const run = vi.fn();
  const db = {
    prepare: (sql: string) => ({
      bind: (userId: string, grantId: string) => ({
        run: async () => {
          run(sql, userId, grantId);
          rows.add(`${userId}\u0000${grantId}`);
          return { success: true, meta: { changes: 1 } };
        },
        first: async () =>
          rows.has(`${userId}\u0000${grantId}`) ? { revoked: 1 } : null,
      }),
    }),
  } as unknown as D1Database;
  return { db, run };
}

describe('grant revocation records', () => {
  it('records a revoked grant so a later refresh or tool call can be refused', async () => {
    const { db, run } = fakeDb();

    await markGrantRevoked(db, 'me@example.com', 'grant-1');

    expect(await isGrantRevoked(db, 'me@example.com', 'grant-1')).toBe(true);
    // D1 rather than KV: KV writes are eventually consistent across locations, so a
    // refresh running elsewhere could miss a marker written moments earlier.
    expect(run.mock.calls[0][0]).toContain('revoked_grants');
  });

  it('keeps records separate per user and per grant', async () => {
    const { db } = fakeDb();
    await markGrantRevoked(db, 'me@example.com', 'grant-1');

    expect(await isGrantRevoked(db, 'me@example.com', 'grant-2')).toBe(false);
    expect(
      await isGrantRevoked(db, 'someone-else@example.com', 'grant-1'),
    ).toBe(false);
  });

  it('stays revoked when the same grant is revoked twice', async () => {
    const { db } = fakeDb();

    await markGrantRevoked(db, 'me@example.com', 'grant-1');
    await markGrantRevoked(db, 'me@example.com', 'grant-1');

    expect(await isGrantRevoked(db, 'me@example.com', 'grant-1')).toBe(true);
  });
});
