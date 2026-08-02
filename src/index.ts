import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { app } from './app';
import type { Env } from './env';
import { defaultHandler } from './oauth';
import { LifegameMcp } from './mcp/server';

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
});
