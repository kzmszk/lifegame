import type {
  AuthRequest,
  ClientInfo,
} from '@cloudflare/workers-oauth-provider';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CSP_REPORT_PATH,
  defaultHandler,
  grantedScopesForRequest,
  SUPPORTED_SCOPES,
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

const authorizationRequest = (
  overrides: Partial<AuthRequest> = {},
): AuthRequest => ({
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
  ])(
    'rejects unsafe or unsupported authorization requests',
    (overrides, error) => {
      expect(
        validateAuthorizationRequest(authorizationRequest(overrides), client())
          ?.error,
      ).toBe(error);
    },
  );

  it('rejects clients whose registered response or grant types do not match', () => {
    expect(
      validateAuthorizationRequest(
        authorizationRequest(),
        client({ responseTypes: ['token'] }),
      )?.error,
    ).toBe('unauthorized_client');
    expect(
      validateAuthorizationRequest(
        authorizationRequest(),
        client({ grantTypes: ['refresh_token'] }),
      )?.error,
    ).toBe('unauthorized_client');
  });

  it('rejects unknown scopes and defaults omitted scope to every supported scope', () => {
    expect(
      validateAuthorizationRequest(
        authorizationRequest({ scope: ['tasks:admin'] }),
        client(),
      )?.error,
    ).toBe('invalid_scope');
    // Omitting scope stays "everything supported", and the consent page
    // enumerates what that covers, so calendar access is still shown before
    // approval rather than folded in silently.
    expect(grantedScopesForRequest([])).toEqual([
      'tasks:read',
      'tasks:write',
      'calendar:read',
    ]);
    expect(grantedScopesForRequest(['tasks:read'])).toEqual(['tasks:read']);
    // A grant issued before calendar:read existed carries only what it was given.
    expect(grantedScopesForRequest(['tasks:read', 'tasks:write'])).toEqual([
      'tasks:read',
      'tasks:write',
    ]);
  });

  it('does not advertise or accept health scopes', () => {
    expect([...SUPPORTED_SCOPES]).not.toEqual(
      expect.arrayContaining(['health:read', 'health:write']),
    );
    expect(
      validateAuthorizationRequest(
        authorizationRequest({ scope: ['health:read'] }),
        client(),
      )?.error,
    ).toBe('invalid_scope');
    expect(grantedScopesForRequest([])).not.toContain('health:read');
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
    expect(
      validateClientRegistrationMetadata({ client_name: 'x'.repeat(2049) })
        ?.code,
    ).toBe('invalid_client_metadata');
    expect(
      validateClientRegistrationMetadata({
        redirect_uris: Array.from(
          { length: 17 },
          () => 'https://client.example',
        ),
      })?.code,
    ).toBe('invalid_client_metadata');
  });

  it('rejects objects that exceed the key-length limit', () => {
    expect(
      validateClientRegistrationMetadata({ ['k'.repeat(129)]: 'value' }),
    ).toEqual({
      code: 'invalid_client_metadata',
      description: 'metadata has a key that is too long',
    });
  });

  it('rejects many small values that exceed the aggregate byte budget', () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `field_${index}`,
        'x'.repeat(600),
      ]),
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

    expect(validateClientRegistrationMetadata(metadata)?.description).toBe(
      'metadata has more than 512 nodes',
    );
  });

  it('still rejects oversized objects and deeply nested values', () => {
    expect(
      validateClientRegistrationMetadata(
        Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`field_${index}`, 'value']),
        ),
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
  const makeEnv = (completed: { count: number }) =>
    ({
      AUTH_REQUIRED: 'false',
      OAUTH_PROVIDER: {
        lookupClient: async () => client(),
        parseAuthRequest: async () => authorizationRequest(),
        completeAuthorization: async () => {
          completed.count += 1;
          return { redirectTo: 'https://client.example/callback?code=code-1' };
        },
      },
    }) as unknown as Env;

  const fetchAuthorize = (request: Request, env: Env) =>
    defaultHandler.fetch!(
      request as unknown as Parameters<
        NonNullable<typeof defaultHandler.fetch>
      >[0],
      env,
      {} as ExecutionContext,
    );

  it('allows the approved callback origin in form-action so the OAuth redirect is not blocked', async () => {
    const env = makeEnv({ count: 0 });
    const page = await fetchAuthorize(
      new Request('https://lifegame.example/authorize'),
      env,
    );
    const csp = page.headers.get('Content-Security-Policy') ?? '';

    // form-action also applies to the redirect that follows the submission.
    expect(csp).toContain("form-action 'self' https://client.example;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain(
      'form-action &#39;self&#39; https://client.example;',
    );
  });

  const consentHtmlForScope = async (scope: string[]): Promise<string> => {
    const env = makeEnv({ count: 0 });
    (
      env as unknown as {
        OAUTH_PROVIDER: { parseAuthRequest: () => Promise<AuthRequest> };
      }
    ).OAUTH_PROVIDER.parseAuthRequest = async () =>
      authorizationRequest({ scope });
    const page = await fetchAuthorize(
      new Request('https://lifegame.example/authorize'),
      env,
    );
    return page.text();
  };

  it('explains every scope it is about to grant', async () => {
    // Omitted scope grants the full set, so the full set must be explained.
    const html = await consentHtmlForScope([]);

    for (const scope of ['tasks:read', 'tasks:write', 'calendar:read']) {
      expect(html).toContain(`<code>${scope}</code>`);
    }
    expect(html).toContain('Googleカレンダー');
  });

  it('describes only the requested scopes, not the whole catalogue', async () => {
    const html = await consentHtmlForScope(['tasks:read']);

    expect(html).toContain('<code>tasks:read</code>');
    // Listing these would overstate what the client actually asked for.
    expect(html).not.toContain('<code>tasks:write</code>');
    expect(html).not.toContain('<code>calendar:read</code>');
    expect(html).not.toContain('Googleカレンダー');
  });

  it('allows a custom-scheme callback by scheme in form-action', async () => {
    const env = makeEnv({ count: 0 });
    (
      env as unknown as {
        OAUTH_PROVIDER: { parseAuthRequest: () => Promise<AuthRequest> };
      }
    ).OAUTH_PROVIDER.parseAuthRequest = async () =>
      authorizationRequest({ redirectUri: 'myapp://callback' });
    const page = await fetchAuthorize(
      new Request('https://lifegame.example/authorize'),
      env,
    );

    expect(page.headers.get('Content-Security-Policy')).toContain(
      "form-action 'self' myapp:;",
    );
  });

  it('keeps concurrent consent flows valid when both GETs see the same cookie state', async () => {
    const completed = { count: 0 };
    const env = makeEnv(completed);
    const priorCookie =
      '__Host-lifegame-consent-csrf=00000000-0000-4000-8000-000000000000';
    const firstPage = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        headers: { Cookie: priorCookie },
      }),
      env,
    );
    const secondPage = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        headers: { Cookie: priorCookie },
      }),
      env,
    );
    const firstHtml = await firstPage.text();
    const secondHtml = await secondPage.text();
    const firstFlowId = firstHtml.match(/name="flow_id" value="([^"]+)"/)?.[1];
    const secondFlowId = secondHtml.match(
      /name="flow_id" value="([^"]+)"/,
    )?.[1];
    const firstToken = firstHtml.match(
      /name="csrf_token" value="([^"]+)"/,
    )?.[1];
    const secondToken = secondHtml.match(
      /name="csrf_token" value="([^"]+)"/,
    )?.[1];
    const firstCookie = firstPage.headers.get('Set-Cookie');
    const secondCookie = secondPage.headers.get('Set-Cookie');
    expect(firstFlowId).toBeTruthy();
    expect(secondFlowId).toBeTruthy();
    expect(firstFlowId).not.toBe(secondFlowId);
    expect(firstToken).toBeTruthy();
    expect(secondToken).toBeTruthy();
    expect(firstToken).not.toBe(secondToken);
    expect(firstCookie).toContain(
      `__Host-lifegame-consent-${firstFlowId}=${firstToken}`,
    );
    expect(secondCookie).toContain(
      `__Host-lifegame-consent-${secondFlowId}=${secondToken}`,
    );
    expect(firstCookie).toContain('Secure');
    expect(firstCookie).toContain('HttpOnly');
    expect(firstCookie).toContain('SameSite=Lax');
    expect(firstCookie).toContain('Path=/');

    const cookieJar = new Map<string, string>();
    const applySetCookie = (setCookie: string | null) => {
      if (!setCookie) return;
      const pair = setCookie.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator === -1) return;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (setCookie.includes('Max-Age=0')) cookieJar.delete(name);
      else cookieJar.set(name, value);
    };
    const cookieHeader = () =>
      [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
    applySetCookie(`${priorCookie}; Path=/`);
    applySetCookie(firstCookie);
    applySetCookie(secondCookie);

    const firstPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: {
          Cookie: cookieHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `decision=approve&flow_id=${encodeURIComponent(firstFlowId ?? '')}&csrf_token=${encodeURIComponent(firstToken ?? '')}`,
      }),
      env,
    );
    expect(firstPost.status).toBe(302);
    expect(firstPost.headers.get('Set-Cookie')).toContain(
      `__Host-lifegame-consent-${firstFlowId}=;`,
    );
    expect(firstPost.headers.get('Set-Cookie')).not.toContain(
      `__Host-lifegame-consent-${secondFlowId}=;`,
    );
    applySetCookie(firstPost.headers.get('Set-Cookie'));

    const secondPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: {
          Cookie: cookieHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `decision=approve&flow_id=${encodeURIComponent(secondFlowId ?? '')}&csrf_token=${encodeURIComponent(secondToken ?? '')}`,
      }),
      env,
    );
    expect(secondPost.status).toBe(302);
    expect(secondPost.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(completed.count).toBe(2);
  });

  it('supports sequential flows and rejects absent, unknown, mismatched, and malformed submissions', async () => {
    const completed = { count: 0 };
    const env = makeEnv(completed);
    const firstPage = await fetchAuthorize(
      new Request('https://lifegame.example/authorize'),
      env,
    );
    const firstHtml = await firstPage.text();
    const firstFlowId =
      firstHtml.match(/name="flow_id" value="([^"]+)"/)?.[1] ?? '';
    const firstToken =
      firstHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    const firstCookie =
      firstPage.headers.get('Set-Cookie')?.split(';', 1)[0] ?? '';

    const secondPage = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        headers: { Cookie: firstCookie },
      }),
      env,
    );
    const secondHtml = await secondPage.text();
    const secondFlowId =
      secondHtml.match(/name="flow_id" value="([^"]+)"/)?.[1] ?? '';
    const secondToken =
      secondHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    const secondCookie =
      secondPage.headers.get('Set-Cookie')?.split(';', 1)[0] ?? '';
    const bothCookies = `${firstCookie}; ${secondCookie}`;

    const firstPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: {
          Cookie: bothCookies,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `decision=approve&flow_id=${encodeURIComponent(firstFlowId)}&csrf_token=${encodeURIComponent(firstToken)}`,
      }),
      env,
    );
    expect(firstPost.status).toBe(302);
    expect(firstPost.headers.get('Set-Cookie')).toContain(
      `__Host-lifegame-consent-${firstFlowId}=;`,
    );
    expect(firstPost.headers.get('Set-Cookie')).not.toContain(
      `__Host-lifegame-consent-${secondFlowId}=;`,
    );

    const secondPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: {
          Cookie: secondCookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `decision=approve&flow_id=${encodeURIComponent(secondFlowId)}&csrf_token=${encodeURIComponent(secondToken)}`,
      }),
      env,
    );
    expect(secondPost.status).toBe(302);
    expect(completed.count).toBe(2);

    const unknownTokenPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: {
          Cookie: secondCookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `decision=approve&flow_id=${encodeURIComponent(secondFlowId)}&csrf_token=00000000-0000-4000-8000-000000000000`,
      }),
      env,
    );
    expect(unknownTokenPost.status).toBe(400);
    await expect(unknownTokenPost.text()).resolves.toBe('Invalid consent form');

    const mismatchedTokenPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: {
          Cookie: secondCookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `decision=approve&flow_id=${encodeURIComponent(secondFlowId)}&csrf_token=${encodeURIComponent(firstToken)}`,
      }),
      env,
    );
    expect(mismatchedTokenPost.status).toBe(400);
    await expect(mismatchedTokenPost.text()).resolves.toBe(
      'Invalid consent form',
    );

    const absentTokenPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'decision=approve&csrf_token=00000000-0000-4000-8000-000000000000',
      }),
      env,
    );
    expect(absentTokenPost.status).toBe(400);
    await expect(absentTokenPost.text()).resolves.toBe('Invalid consent form');

    const malformedFlowPost = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'decision=approve&flow_id=not-a-valid-flow-id&csrf_token=00000000-0000-4000-8000-000000000000',
      }),
      env,
    );
    expect(malformedFlowPost.status).toBe(400);
    await expect(malformedFlowPost.text()).resolves.toBe(
      'Invalid consent form',
    );
  });
});

describe('OAuth redirect validation', () => {
  const fetchParseError = async (
    registeredUri: string,
    requestedUri: string,
  ) => {
    const env = {
      AUTH_REQUIRED: 'false',
      OAUTH_PROVIDER: {
        lookupClient: async () => client({ redirectUris: [registeredUri] }),
        parseAuthRequest: async () => {
          throw new Error('invalid authorization request');
        },
      },
    } as unknown as Env;
    const params = new URLSearchParams({
      client_id: 'client-1',
      redirect_uri: requestedUri,
      response_type: 'code',
      state: 'state-1',
    });
    return defaultHandler.fetch!(
      new Request(
        `https://lifegame.example/authorize?${params}`,
      ) as unknown as Parameters<NonNullable<typeof defaultHandler.fetch>>[0],
      env,
      {} as ExecutionContext,
    );
  };

  it('accepts a different port for bracketed IPv6 loopback callbacks', async () => {
    const response = await fetchParseError(
      'http://[::1]:5678/cb',
      'http://[::1]:1234/cb',
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('http://[::1]:1234/cb');
    expect(response.headers.get('Location')).toContain('error=invalid_request');
  });

  it('requires exact matching for non-loopback callback hosts', async () => {
    const response = await fetchParseError(
      'https://client.example:5678/cb',
      'https://client.example:1234/cb',
    );
    expect(response.status).toBe(400);
  });
});

// A browser only ever sees the emitted header, so this evaluator is deliberately
// independent of the production CSP builder: a wrong policy must not be able to
// validate itself by sharing the code that produced it.
function formActionAllows(
  csp: string,
  pageUrl: string,
  target: string,
): boolean {
  const directive = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === 'form-action' || part.startsWith('form-action '));
  if (!directive) return true;
  const sources = directive.split(/\s+/).slice(1);
  const targetUrl = new URL(target);
  return sources.some((source) => {
    if (source === "'self'")
      return targetUrl.origin === new URL(pageUrl).origin;
    if (source === '*') return true;
    if (/^[a-z][a-z0-9+.-]*:$/i.test(source))
      return targetUrl.protocol === source.toLowerCase();
    try {
      return new URL(source).origin === targetUrl.origin;
    } catch {
      return false;
    }
  });
}

describe('consent CSP permits the redirect it will issue', () => {
  const PAGE_URL = 'https://lifegame.example/authorize';

  const env = {
    AUTH_REQUIRED: 'false',
    OAUTH_PROVIDER: {
      lookupClient: async () => client(),
      parseAuthRequest: async () => authorizationRequest(),
      completeAuthorization: async () => ({
        redirectTo: 'https://client.example/callback?code=code-1',
      }),
    },
  } as unknown as Env;

  const fetchAuthorize = (request: Request) =>
    defaultHandler.fetch!(
      request as unknown as Parameters<
        NonNullable<typeof defaultHandler.fetch>
      >[0],
      env,
      {} as ExecutionContext,
    );

  it('rejects the pre-fix policy, proving the check has teeth', () => {
    // form-action 'self' alone is what silently blocked the OAuth redirect.
    expect(
      formActionAllows(
        "form-action 'self'",
        PAGE_URL,
        'https://client.example/callback?code=1',
      ),
    ).toBe(false);
    expect(
      formActionAllows(
        "form-action 'self' https://client.example",
        PAGE_URL,
        'https://client.example/cb',
      ),
    ).toBe(true);
    expect(
      formActionAllows(
        "form-action 'self' myapp:",
        PAGE_URL,
        'myapp://cb?code=1',
      ),
    ).toBe(true);
    expect(
      formActionAllows(
        "form-action 'self' https://other.example",
        PAGE_URL,
        'https://client.example/cb',
      ),
    ).toBe(false);
  });

  it('allows a browser to follow the Location returned by an approval', async () => {
    const page = await fetchAuthorize(new Request(PAGE_URL));
    const csp = page.headers.get('Content-Security-Policy') ?? '';
    const html = await page.text();
    const flowId = html.match(/name="flow_id" value="([^"]+)"/)?.[1] ?? '';
    const token = html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    const cookie = page.headers.get('Set-Cookie')?.split(';', 1)[0] ?? '';

    const approval = await fetchAuthorize(
      new Request(PAGE_URL, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `decision=approve&flow_id=${encodeURIComponent(flowId)}&csrf_token=${encodeURIComponent(token)}`,
      }),
    );
    expect(approval.status).toBe(302);

    const location = approval.headers.get('Location') ?? '';
    expect(location).toBeTruthy();
    // The invariant the browser enforces: the policy served with the form must
    // permit the redirect that submitting that form produces.
    expect(formActionAllows(csp, PAGE_URL, location)).toBe(true);
  });

  it('points violation reports at an endpoint the page actually serves', async () => {
    const page = await fetchAuthorize(new Request(PAGE_URL));
    const csp = page.headers.get('Content-Security-Policy') ?? '';

    expect(csp).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(csp).toContain('report-to csp-endpoint');
    expect(page.headers.get('Reporting-Endpoints')).toBe(
      `csp-endpoint="https://lifegame.example${CSP_REPORT_PATH}"`,
    );
  });
});

describe('CSP violation report endpoint', () => {
  const fetchReport = (request: Request) =>
    defaultHandler.fetch!(
      request as unknown as Parameters<
        NonNullable<typeof defaultHandler.fetch>
      >[0],
      {} as Env,
      {} as ExecutionContext,
    );
  const url = `https://lifegame.example${CSP_REPORT_PATH}`;

  afterEach(() => vi.restoreAllMocks());

  it('logs a report and answers 204', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await fetchReport(
      new Request(url, {
        method: 'POST',
        body: '{"csp-report":{"blocked-uri":"https://client.example/cb"}}',
      }),
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(
      'CSP violation report:',
      expect.stringContaining('blocked-uri'),
    );
  });

  it('rejects an oversized report on its declared length, before touching the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = 'x'.repeat(9 * 1024);
    const request = new Request(url, {
      method: 'POST',
      body,
      headers: { 'content-length': String(body.length) },
    });
    const read = vi.spyOn(request, 'body', 'get');

    const response = await fetchReport(request);

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('discarded'));
    expect(read).not.toHaveBeenCalled();
  });

  it('discards an oversized report that declares no length', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await fetchReport(
      new Request(url, { method: 'POST', body: 'x'.repeat(9 * 1024) }),
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('discarded'));
  });

  it('stops reading a streamed report once it exceeds the budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = new Uint8Array(4 * 1024);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });

    const response = await fetchReport(
      // No content-length: the budget has to be enforced while streaming.
      new Request(url, { method: 'POST', body, duplex: 'half' } as RequestInit),
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('discarded'));
    // Cancelled early rather than draining an endless body.
    expect(pulled).toBeLessThan(5);
  });

  it('rejects methods other than POST', async () => {
    const response = await fetchReport(new Request(url));

    expect(response.status).toBe(405);
  });
});

describe('/authorize Access JWT verification', () => {
  const TEAM_DOMAIN = 'https://team.cloudflareaccess.com';
  const AUD = 'access-aud';
  let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
  let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

  beforeAll(async () => {
    keyPair = await generateKeyPair('RS256');
    publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeEnv = (completeAuthorization: unknown) =>
    ({
      AUTH_REQUIRED: 'true',
      ALLOWED_EMAIL: 'me@example.com',
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD: AUD,
      OAUTH_PROVIDER: {
        lookupClient: async () => client(),
        parseAuthRequest: async () => authorizationRequest(),
        completeAuthorization,
      },
    }) as unknown as Env;

  const fetchAuthorize = (request: Request, env: Env) =>
    defaultHandler.fetch!(
      request as unknown as Parameters<
        NonNullable<typeof defaultHandler.fetch>
      >[0],
      env,
      {} as ExecutionContext,
    );

  const jwt = (email = 'me@example.com') =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keyPair.privateKey);

  const stubJwks = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ keys: [publicJwk] })),
    );

  it('refuses to render the consent page without a verified JWT', async () => {
    const response = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        // The header alone must not stand in for the assertion.
        headers: { 'Cf-Access-Authenticated-User-Email': 'me@example.com' },
      }),
      makeEnv(async () => ({ redirectTo: 'https://client.example/callback' })),
    );

    expect(response.status).toBe(401);
  });

  it('grants the identity from the JWT, not from the email header', async () => {
    stubJwks();
    const completeAuthorization = vi.fn(async () => ({
      redirectTo: 'https://client.example/callback?code=code-1',
    }));
    const env = makeEnv(completeAuthorization);
    const token = await jwt();

    const page = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      env,
    );
    const html = await page.text();
    const flowId = html.match(/name="flow_id" value="([^"]+)"/)?.[1] ?? '';
    const csrfToken =
      html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    expect(flowId).toBeTruthy();

    const approved = await fetchAuthorize(
      new Request('https://lifegame.example/authorize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cf-Access-Jwt-Assertion': token,
          // A header naming someone else must not reach completeAuthorization.
          'Cf-Access-Authenticated-User-Email': 'someone-else@example.com',
          Cookie: `__Host-lifegame-consent-${flowId}=${csrfToken}`,
        },
        body: `decision=approve&flow_id=${encodeURIComponent(flowId)}&csrf_token=${encodeURIComponent(csrfToken)}`,
      }),
      env,
    );

    expect(approved.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'me@example.com',
        props: expect.objectContaining({ email: 'me@example.com' }),
      }),
    );
  });
});
