import type { Env } from '../env';

// Env's own binding type, so this stays compatible with how the Worker is wired.
type OAuthKv = Env['OAUTH_KV'];

// A refresh that has already read a grant re-saves it after revocation deleted it,
// which brings the connection back to life along with its freshly minted token.
// Sweeping after the fact cannot win that race, so issuance itself has to refuse:
// this marker is written before the revocation and checked while the refresh is
// still deciding. It outlives any grant that could be resurrected, since a grant
// cannot survive longer than the 30-day refresh token TTL that keeps renewing it.
const REVOKED_GRANT_TTL_SECONDS = 30 * 24 * 60 * 60;

function revokedGrantKey(userId: string, grantId: string): string {
  return `revoked:${userId}:${grantId}`;
}

export async function markGrantRevoked(kv: OAuthKv, userId: string, grantId: string): Promise<void> {
  await kv.put(revokedGrantKey(userId, grantId), '1', { expirationTtl: REVOKED_GRANT_TTL_SECONDS });
}

export async function isGrantRevoked(kv: OAuthKv, userId: string, grantId: string): Promise<boolean> {
  return (await kv.get(revokedGrantKey(userId, grantId))) !== null;
}
