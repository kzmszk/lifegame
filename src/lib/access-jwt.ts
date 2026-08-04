import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../env';
import type { AccessAuthError, AccessUser } from './access';

// jose keeps the fetched keys and its own rate limiting inside the set it returns,
// so building one per request would refetch the JWKS on every call. The cache is
// per isolate; a cold isolate simply fetches once.
//
// An unknown kid makes jose refetch, but no more often than its cooldown, so a
// key rotation can be refused for that window. Access publishes the next key
// alongside the current one well before switching to it, so a token signed by a
// kid this cache has never seen is not a case worth widening the window for.
const jwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(issuer: string) {
  let jwks = jwkSets.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwkSets.set(issuer, jwks);
  }
  return jwks;
}

// Access reports the team domain without a scheme in some places and with one in
// others; both name the same issuer, so either spelling is accepted.
function normalizeIssuer(raw: string | undefined): string | null {
  const trimmed = raw?.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    return url.protocol === 'https:' && url.hostname.includes('.')
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export async function verifyAccessJwt(
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD'>,
  request: Request,
): Promise<AccessUser | AccessAuthError> {
  const issuer = normalizeIssuer(env.ACCESS_TEAM_DOMAIN);
  if (!issuer)
    return { message: 'ACCESS_TEAM_DOMAIN が設定されていません', status: 500 };

  const audience = env.ACCESS_AUD?.trim();
  if (!audience)
    return { message: 'ACCESS_AUD が設定されていません', status: 500 };

  const token = request.headers.get('Cf-Access-Jwt-Assertion')?.trim();
  if (!token)
    return {
      message: 'Cloudflare Access のユーザー情報がありません',
      status: 401,
    };

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwksFor(issuer), {
      issuer,
      audience,
      // Access always issues exp, so requiring it costs nothing and keeps a token
      // that somehow lacks one from being valid forever.
      requiredClaims: ['exp'],
    }));
  } catch (cause) {
    // A JWKS that cannot be fetched lands here too. Both cases mean the request is
    // unproven, and treating an unproven request as authenticated is the failure
    // this verification exists to prevent. They need different fixes though, and
    // the client is told the same thing either way, so the reason is logged.
    console.warn('Access JWT の検証に失敗しました', cause);
    return {
      message: 'Cloudflare Access の認証情報を検証できませんでした',
      status: 401,
    };
  }

  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  if (!email)
    return {
      message: 'Cloudflare Access のユーザー情報がありません',
      status: 401,
    };

  return { email };
}
