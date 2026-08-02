import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider';
import { describe, expect, it } from 'vitest';
import {
  defaultHandler,
  grantedScopesForRequest,
  validateAuthorizationRequest,
} from './oauth';
import { validateClientRegistrationMetadata } from './lib/oauth-policy';
import type { Env } from './env';

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
  it('accepts realistic client metadata', () => {
    expect(
      validateClientRegistrationMetadata({
        client_name: 'LifeGame',
        redirect_uris: ['https://client.example/oauth/callback'],
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
        scope: 'tasks:read tasks:write',
        logo_uri: 'https://client.example/logo.png',
        contacts: ['security@client.example'],
      }),
    ).toBeUndefined();
  });

  it('rejects oversized strings and arrays', () => {
    expect(validateClientRegistrationMetadata({ client_name: 'x'.repeat(2049) })?.code).toBe(
      'invalid_client_metadata',
    );
    expect(validateClientRegistrationMetadata({ redirect_uris: Array.from({ length: 17 }, () => 'https://client.example') })?.code).toBe(
      'invalid_client_metadata',
    );
  });

  it('rejects objects that exceed the key-length limit', () => {
    expect(validateClientRegistrationMetadata({ ['k'.repeat(129)]: 'value' })).toEqual({
      code: 'invalid_client_metadata',
      description: 'metadata has a key that is too long',
    });
  });

  it('rejects many small values that exceed the aggregate byte budget', () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`field_${index}`, 'x'.repeat(600)]),
    );

    expect(validateClientRegistrationMetadata(metadata)?.description).toContain(
      'total size limit',
    );
  });

  it('rejects a node-count blowup even when each node is small', () => {
    const metadata = {
      branches: Array.from({ length: 2 }, () =>
        Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => 'x')),
      ),
    };

    expect(validateClientRegistrationMetadata(metadata)?.description).toBe('metadata has more than 512 nodes');
  });

  it('still rejects oversized objects and deeply nested values', () => {
    expect(
      validateClientRegistrationMetadata(
        Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field_${index}`, 'value'])),
      )?.code,
    ).toBe('invalid_client_metadata');
    expect(
      validateClientRegistrationMetadata({
        nested: { a: { b: { c: { d: { e: 'value' } } } } },
      })?.code,
    ).toBe('invalid_client_metadata');
  });
});

describe('OAuth consent CSRF protection', () => {
  it('keeps two consent tokens valid independently and rejects unknown or absent tokens', async () => {
    let completedAuthorizations = 0;
    const env = {
      AUTH_REQUIRED: 'false',
      OAUTH_PROVIDER: {
        lookupClient: async () => client(),
        parseAuthRequest: async () => authorizationRequest(),
        completeAuthorization: async () => {
          completedAuthorizations += 1;
          return { redirectTo: 'https://client.example/callback?code=code-1' };
        },
      },
    } as unknown as Env;
    const request = new Request('https://lifegame.example/authorize');
    const fetchAuthorize = (authorizationRequest: Request) =>
      defaultHandler.fetch!(
        authorizationRequest as unknown as Parameters<NonNullable<typeof defaultHandler.fetch>>[0],
        env,
        {} as ExecutionContext,
      );

    const firstPage = await fetchAuthorize(request);
    const firstToken = (await firstPage.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
    const firstCookie = firstPage.headers.get('Set-Cookie');
    expect(firstToken).toBeTruthy();
    expect(firstCookie).toContain('__Host-lifegame-consent-csrf=');
    expect(firstCookie).toContain('Secure');
    expect(firstCookie).toContain('HttpOnly');
    expect(firstCookie).toContain('SameSite=Lax');
    expect(firstCookie).toContain('Path=/');

    const secondPage = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        headers: { Cookie: firstCookie?.split(';')[0] ?? '' },
      }),
    );
    const secondToken = (await secondPage.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
    const secondCookie = secondPage.headers.get('Set-Cookie')?.split(';')[0];
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);
    expect(secondCookie).toContain(firstToken);
    expect(secondCookie).toContain(secondToken);

    const firstPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: {
          Cookie: secondCookie ?? '',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `decision=approve&csrf_token=${encodeURIComponent(firstToken ?? '')}`,
      }),
    );
    expect(firstPost.status).toBe(302);
    const remainingCookie = firstPost.headers.get('Set-Cookie')?.split(';')[0];
    expect(remainingCookie).toContain(secondToken);
    expect(remainingCookie).not.toContain(firstToken);

    const secondPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: {
          Cookie: remainingCookie ?? '',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `decision=approve&csrf_token=${encodeURIComponent(secondToken ?? '')}`,
      }),
    );
    expect(secondPost.status).toBe(302);
    expect(secondPost.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(completedAuthorizations).toBe(2);

    const unknownTokenPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: {
          Cookie: secondCookie ?? '',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'decision=approve&csrf_token=00000000-0000-4000-8000-000000000000',
      }),
    );
    expect(unknownTokenPost.status).toBe(400);
    await expect(unknownTokenPost.text()).resolves.toBe('Invalid consent form');

    const absentTokenPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'decision=approve',
      }),
    );
    expect(absentTokenPost.status).toBe(400);
    await expect(absentTokenPost.text()).resolves.toBe('Invalid consent form');
  });
});
