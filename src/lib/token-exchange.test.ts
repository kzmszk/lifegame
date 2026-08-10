import type { D1Database } from '@cloudflare/workers-types';
import {
  type ClientInfo,
  GrantType,
  type TokenExchangeCallbackOptions,
} from '@cloudflare/workers-oauth-provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTokenExchange, type TokenExchangeEnv } from './token-exchange';

const STORED_CLIENT = { clientId: 'client-123' } as ClientInfo;

// isGrantRevoked asks D1 for a single row; a hit is a revoked grant.
function dbReturning(revoked: boolean): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => (revoked ? { revoked: 1 } : null) }),
    }),
  } as unknown as D1Database;
}

function envWith(revoked: boolean) {
  const updateClient = vi.fn(async () => STORED_CLIENT);
  const env = {
    DB: dbReturning(revoked),
    OAUTH_PROVIDER: { updateClient },
  } as unknown as TokenExchangeEnv;
  return { env, updateClient };
}

function exchange(
  overrides: Partial<TokenExchangeCallbackOptions> = {},
): Pick<
  TokenExchangeCallbackOptions,
  'grantType' | 'clientId' | 'userId' | 'grantId' | 'props' | 'requestedScope'
> {
  return {
    grantType: GrantType.REFRESH_TOKEN,
    clientId: 'client-123',
    userId: 'kazumasa@example.com',
    grantId: 'grant-1',
    props: { email: 'kazumasa@example.com' },
    requestedScope: ['tasks:read'],
    ...overrides,
  };
}

describe('handleTokenExchange', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('extends the client registration when a refresh succeeds', async () => {
    const { env, updateClient } = envWith(false);

    await handleTokenExchange(env, exchange());

    expect(updateClient).toHaveBeenCalledWith('client-123', {});
  });

  it('extends the registration on the authorization code exchange too', async () => {
    const { env, updateClient } = envWith(false);

    await handleTokenExchange(
      env,
      exchange({ grantType: GrantType.AUTHORIZATION_CODE }),
    );

    expect(updateClient).toHaveBeenCalledWith('client-123', {});
  });

  // The order matters on its own: extending first would keep a disconnected
  // connection's registration alive every time it tried to come back.
  it('refuses a revoked grant without extending its registration', async () => {
    const { env, updateClient } = envWith(true);

    await expect(handleTokenExchange(env, exchange())).rejects.toThrow();
    expect(updateClient).not.toHaveBeenCalled();
  });

  it('still issues the token when the registration cannot be extended', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = envWith(false);
    (
      env.OAUTH_PROVIDER.updateClient as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('KV unavailable'));

    const result = await handleTokenExchange(env, exchange());

    expect(result.accessTokenScope).toEqual(['tasks:read']);
  });

  it('carries the granted scopes and grant id into the token props', async () => {
    const { env } = envWith(false);

    const result = await handleTokenExchange(
      env,
      exchange({ requestedScope: ['tasks:read', 'calendar:read'] }),
    );

    expect(result.accessTokenProps).toEqual({
      email: 'kazumasa@example.com',
      scopes: ['tasks:read', 'calendar:read'],
      grantId: 'grant-1',
    });
  });
});
