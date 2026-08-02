import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider';
import { describe, expect, it } from 'vitest';
import {
  grantedScopesForRequest,
  validateAuthorizationRequest,
} from './oauth';
import { validateClientRegistrationMetadata } from './lib/oauth-policy';

const client = (overrides: Partial<ClientInfo> = {}): ClientInfo => ({
  clientId: 'client-1',
  redirectUris: ['https://client.example/callback'],
  responseTypes: ['code'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenEndpointAuthMethod: 'none',
  ...overrides,
});

const authorizationRequest = (overrides: Partial<AuthRequest> = {}): AuthRequest => ({
  responseType: 'code',
  clientId: 'client-1',
  redirectUri: 'https://client.example/callback',
  scope: ['tasks:read'],
  state: 'state-1',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  ...overrides,
});

describe('OAuth authorization policy', () => {
  it.each([
    [{ codeChallenge: undefined }, 'invalid_request'],
    [{ codeChallenge: '', codeChallengeMethod: 'S256' }, 'invalid_request'],
    [{ codeChallengeMethod: 'plain' }, 'invalid_request'],
    [{ responseType: '' }, 'unsupported_response_type'],
    [{ responseType: 'token' }, 'unsupported_response_type'],
  ])('rejects unsafe or unsupported authorization requests', (overrides, error) => {
    expect(validateAuthorizationRequest(authorizationRequest(overrides), client())?.error).toBe(error);
  });

  it('rejects clients whose registered response or grant types do not match', () => {
    expect(
      validateAuthorizationRequest(authorizationRequest(), client({ responseTypes: ['token'] }))?.error,
    ).toBe('unauthorized_client');
    expect(
      validateAuthorizationRequest(authorizationRequest(), client({ grantTypes: ['refresh_token'] }))?.error,
    ).toBe('unauthorized_client');
  });

  it('rejects unknown scopes and defaults omitted scope to both task scopes', () => {
    expect(
      validateAuthorizationRequest(authorizationRequest({ scope: ['tasks:admin'] }), client())?.error,
    ).toBe('invalid_scope');
    expect(grantedScopesForRequest([])).toEqual(['tasks:read', 'tasks:write']);
    expect(grantedScopesForRequest(['tasks:read'])).toEqual(['tasks:read']);
  });
});

describe('DCR metadata policy', () => {
  it('rejects oversized strings and arrays', () => {
    expect(validateClientRegistrationMetadata({ client_name: 'x'.repeat(2049) })?.code).toBe(
      'invalid_client_metadata',
    );
    expect(validateClientRegistrationMetadata({ redirect_uris: Array.from({ length: 17 }, () => 'https://client.example') })?.code).toBe(
      'invalid_client_metadata',
    );
    expect(validateClientRegistrationMetadata({ client_name: 'Claude', redirect_uris: ['https://client.example'] })).toBeUndefined();
  });
});
