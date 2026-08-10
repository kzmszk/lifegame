import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { env as workerEnv } from 'cloudflare:workers';
import { app } from './app';
import type { Env } from './env';
import { defaultHandler, SUPPORTED_SCOPES } from './oauth';
import { LifegameMcp } from './mcp/server';
import { validateClientRegistrationMetadata } from './lib/oauth-policy';
import { handleTokenExchange } from './lib/token-exchange';

const CLIENT_REGISTRATION_TTL = 7 * 24 * 60 * 60;

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
  // The callback options carry no env, so the binding comes from the module scope.
  tokenExchangeCallback: (options) =>
    handleTokenExchange(workerEnv as Env, options),
});
