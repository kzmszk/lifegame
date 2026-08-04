import { OAuthError, OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { env as workerEnv } from 'cloudflare:workers';
import { app } from './app';
import type { Env } from './env';
import { defaultHandler, SUPPORTED_SCOPES } from './oauth';
import { LifegameMcp } from './mcp/server';
import { validateClientRegistrationMetadata } from './lib/oauth-policy';
import { isGrantRevoked } from './lib/revocation';

const CLIENT_REGISTRATION_TTL = 7 * 24 * 60 * 60;

function propsWithScopes(
  props: unknown,
  scopes: string[],
  grantId: string,
): Record<string, unknown> {
  const current =
    typeof props === 'object' && props !== null && !Array.isArray(props)
      ? (props as Record<string, unknown>)
      : {};
  // grantId travels with the token so MCP tool handlers can refuse a token whose
  // grant was revoked, which is the only place a raced refresh can still be caught.
  return { ...current, scopes: [...scopes], grantId };
}

export { app };
export type { Env } from './env';
export { LifegameMcp } from './mcp/server';

// OAuthProvider is the Worker entrypoint. It owns OAuth metadata, DCR, token
// exchange, and the protected MCP route; the existing Hono app remains the
// fallback for the SPA and /api/* routes.
export default new OAuthProvider<Env>({
  apiHandlers: { '/mcp': LifegameMcp.serve('/mcp') },
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  // Shared with the authorize-time validation rather than copied. A client that
  // discovers scopes here and requests exactly them must be able to reach every
  // scope the server honours, or the feature behind a missed one is unreachable.
  scopesSupported: [...SUPPORTED_SCOPES],
  allowPlainPKCE: false,
  clientRegistrationTTL: CLIENT_REGISTRATION_TTL,
  clientRegistrationCallback: ({ clientMetadata }) =>
    validateClientRegistrationMetadata(clientMetadata),
  tokenExchangeCallback: async ({
    grantType,
    userId,
    grantId,
    props,
    requestedScope,
  }) => {
    // This callback runs before a refresh writes the grant back, which is the only
    // point where a disconnect can stop the connection from reviving itself. The
    // callback options carry no env, so the binding comes from the module scope.
    if (
      grantType === 'refresh_token' &&
      (await isGrantRevoked((workerEnv as Env).DB, userId, grantId))
    ) {
      throw new OAuthError('invalid_grant', {
        description: 'この接続は切断されています',
      });
    }
    return {
      // Keep grant props broad for refreshes, while making each access token's
      // effective/downscoped permissions explicit to MCP tool handlers.
      accessTokenProps: propsWithScopes(props, requestedScope, grantId),
      accessTokenScope: requestedScope,
    };
  },
});
