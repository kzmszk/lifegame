import {
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from '@cloudflare/workers-oauth-provider';
import type { Env } from '../env';
import { slideClientRegistration } from './client-registration';
import { isGrantRevoked } from './revocation';

export type TokenExchangeEnv = Pick<Env, 'DB' | 'OAUTH_PROVIDER'>;

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

// Lives outside the provider construction so the order below is reachable from a
// test: a revoked grant must throw before anything extends its client, or a
// disconnected connection keeps its registration alive on the way out.
export async function handleTokenExchange(
  env: TokenExchangeEnv,
  {
    grantType,
    clientId,
    userId,
    grantId,
    props,
    requestedScope,
  }: Pick<
    TokenExchangeCallbackOptions,
    'grantType' | 'clientId' | 'userId' | 'grantId' | 'props' | 'requestedScope'
  >,
): Promise<TokenExchangeCallbackResult> {
  // This callback runs before a refresh writes the grant back, which is the only
  // point where a disconnect can stop the connection from reviving itself.
  if (
    grantType === 'refresh_token' &&
    (await isGrantRevoked(env.DB, userId, grantId))
  ) {
    throw new OAuthError('invalid_grant', {
      description: 'この接続は切断されています',
    });
  }

  await slideClientRegistration(env.OAUTH_PROVIDER, clientId);

  return {
    // Keep grant props broad for refreshes, while making each access token's
    // effective/downscoped permissions explicit to MCP tool handlers.
    accessTokenProps: propsWithScopes(props, requestedScope, grantId),
    accessTokenScope: requestedScope,
  };
}
