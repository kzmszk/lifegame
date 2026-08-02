import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { app } from './app';
import type { Env } from './env';
import { defaultHandler } from './oauth';
import { LifegameMcp } from './mcp/server';
import { validateClientRegistrationMetadata } from './lib/oauth-policy';

const CLIENT_REGISTRATION_TTL = 7 * 24 * 60 * 60;

function propsWithScopes(props: unknown, scopes: string[]): Record<string, unknown> {
  const current = typeof props === 'object' && props !== null && !Array.isArray(props)
    ? (props as Record<string, unknown>)
    : {};
  return { ...current, scopes: [...scopes] };
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
  scopesSupported: ['tasks:read', 'tasks:write'],
  allowPlainPKCE: false,
  clientRegistrationTTL: CLIENT_REGISTRATION_TTL,
  clientRegistrationCallback: ({ clientMetadata }) => validateClientRegistrationMetadata(clientMetadata),
  tokenExchangeCallback: ({ props, requestedScope }) => ({
    // Keep grant props broad for refreshes, while making each access token's
    // effective/downscoped permissions explicit to MCP tool handlers.
    accessTokenProps: propsWithScopes(props, requestedScope),
    accessTokenScope: requestedScope,
  }),
});
