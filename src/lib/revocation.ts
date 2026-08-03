import type { D1Database } from '@cloudflare/workers-types';

// A refresh that has already read a grant re-saves it after revocation deleted it,
// which brings the connection back to life along with its freshly minted token.
// That write happens inside the OAuth provider and cannot be serialized from here,
// so revocation is recorded instead and checked wherever a token gets used.
//
// This lives in D1 rather than KV on purpose. KV writes are eventually consistent
// across locations, so a refresh or tool call running elsewhere could read no
// marker for up to a minute after the disconnect already answered ok. D1 has a
// single primary and no read replication here, so the record is visible at once.
export async function markGrantRevoked(db: D1Database, userId: string, grantId: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO revoked_grants (user_id, grant_id) VALUES (?, ?)')
    .bind(userId, grantId)
    .run();
}

export async function isGrantRevoked(db: D1Database, userId: string, grantId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS revoked FROM revoked_grants WHERE user_id = ? AND grant_id = ?')
    .bind(userId, grantId)
    .first<{ revoked: number }>();
  return row !== null;
}
