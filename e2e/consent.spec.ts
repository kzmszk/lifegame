import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test as base } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import type { ConnectionsResponse } from '../src/shared/types';

// The OAuth state and client names need to stay unique when a local D1/KV run
// survives a failed test or a retry, just like the task titles in tasks.spec.ts.
const RUN_ID = randomUUID().slice(0, 8);

interface CallbackServer {
  url: string;
  origin: string;
  path: string;
  close: () => Promise<void>;
}

interface RegisteredClient {
  clientId: string;
  clientName: string;
}

interface RegistrationResponse {
  client_id?: string;
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startCallbackServer(): Promise<CallbackServer> {
  const path = '/oauth/callback';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>OAuth callback</title>');
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    await closeHttpServer(server);
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeHttpServer(server);
    throw new Error('Callback server did not receive a TCP address');
  }
  const port = (address as AddressInfo).port;
  const url = `http://127.0.0.1:${port}${path}`;
  return {
    url,
    origin: new URL(url).origin,
    path,
    close: () => closeHttpServer(server),
  };
}

type ConsentFixtures = { callback: CallbackServer };
const test = base.extend<ConsentFixtures>({
  // Playwright inspects this parameter's source text and rejects the file unless
  // it is a destructuring pattern, even though this fixture uses none of the
  // others. That is the one case where an empty pattern is not a mistake.
  // oxlint-disable-next-line no-empty-pattern
  callback: async ({}, fixtureUse) => {
    const callback = await startCallbackServer();
    // The callback must stay alive until the browser has finished its real
    // cross-origin navigation; closing it in fixture teardown also covers failures.
    try {
      await fixtureUse(callback);
    } finally {
      await callback.close();
    }
  },
});

function uniqueClientName(label: string): string {
  return `e2e consent ${label} ${RUN_ID}.${test.info().retry}`;
}

function pkcePair(): { codeVerifier: string; codeChallenge: string } {
  // RFC 7636 wants 43-128 unreserved characters. A hyphen-stripped UUID is 32,
  // which the provider happens to accept today; 32 random bytes base64url-encode
  // to 43, so a stricter provider cannot turn this into a mystery e2e failure.
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

async function registerClient(
  request: APIRequestContext,
  callback: CallbackServer,
  label: string,
): Promise<RegisteredClient> {
  const clientName = uniqueClientName(label);
  const response = await request.post('/register', {
    data: {
      client_name: clientName,
      redirect_uris: [callback.url],
      response_types: ['code'],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as RegistrationResponse;
  expect(body.client_id).toBeTruthy();
  return { clientId: body.client_id!, clientName };
}

async function openConsent(
  page: Page,
  client: RegisteredClient,
  callback: CallbackServer,
): Promise<{
  response: NonNullable<Awaited<ReturnType<Page['goto']>>>;
  state: string;
  codeVerifier: string;
}> {
  const state = randomUUID();
  const { codeVerifier, codeChallenge } = pkcePair();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: callback.url,
    scope: 'tasks:read tasks:write',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const response = await page.goto(`/authorize?${params.toString()}`);
  if (!response) throw new Error('Consent page did not return a response');
  expect(response.status()).toBe(200);

  // The form action carries whatever host the worker saw, which is the custom
  // domain from `routes` unless e2e:server passes --host. `form-action 'self'`
  // then blocks the approval, and the only symptom is a waitForURL timeout that
  // says nothing about the cause. Fail here instead, naming it.
  const formAction = await page.locator('form').getAttribute('action');
  expect(
    new URL(formAction ?? '').origin,
    'consent form action must share the page origin: keep --host in e2e:server in step with baseURL, port included',
  ).toBe(new URL(page.url()).origin);

  return { response, state, codeVerifier };
}

async function clickDecision(
  page: Page,
  callback: CallbackServer,
  decision: '許可する' | '拒否する',
): Promise<URL> {
  await Promise.all([
    page.waitForURL(
      (url) => url.origin === callback.origin && url.pathname === callback.path,
    ),
    page.getByRole('button', { name: decision }).click(),
  ]);
  return new URL(page.url());
}

// Approved grants survive the test and are visible through the user's connection
// list, so sweep only this process's marker before the next test starts. A sweep
// that fails quietly is worse than no sweep: the next run gets a fresh RUN_ID and
// will never come back for what this one left behind, so every step is asserted.
test.afterEach(async ({ request }) => {
  const response = await request.get('/api/connections');
  expect(response.ok()).toBe(true);
  const { connections, truncated } =
    (await response.json()) as ConnectionsResponse;
  // A partial list means this sweep cannot see every grant it created.
  expect(truncated).toBe(false);
  for (const connection of connections) {
    if (connection.client_name.includes(RUN_ID)) {
      const deleted = await request.delete(
        `/api/connections/${encodeURIComponent(connection.id)}`,
      );
      expect(deleted.ok()).toBe(true);
    }
  }
});

test('approving consent reaches the callback and exchanges its code for a token', async ({
  page,
  request,
  callback,
}) => {
  const client = await registerClient(request, callback, 'approval');
  const { response, state, codeVerifier } = await openConsent(
    page,
    client,
    callback,
  );

  await expect(
    page.getByText(client.clientName, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('要求された権限: tasks:read, tasks:write', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(callback.url, { exact: true })).toBeVisible();
  expect(response.headers()['content-security-policy']).toContain(
    `form-action 'self' ${callback.origin}`,
  );

  const callbackUrl = await clickDecision(page, callback, '許可する');
  expect(callbackUrl.searchParams.get('code')).toBeTruthy();
  expect(callbackUrl.searchParams.get('state')).toBe(state);

  const tokenResponse = await request.post('/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: client.clientId,
      redirect_uri: callback.url,
      code: callbackUrl.searchParams.get('code')!,
      code_verifier: codeVerifier,
    },
  });
  expect(tokenResponse.status()).toBe(200);
  const tokenBody = (await tokenResponse.json()) as {
    access_token?: unknown;
  };
  expect(typeof tokenBody.access_token).toBe('string');
  expect(tokenBody.access_token).not.toBe('');
});

test('denying consent redirects to the callback with access_denied and state', async ({
  page,
  request,
  callback,
}) => {
  const client = await registerClient(request, callback, 'denial');
  const { state } = await openConsent(page, client, callback);

  const callbackUrl = await clickDecision(page, callback, '拒否する');
  expect(callbackUrl.searchParams.get('error')).toBe('access_denied');
  expect(callbackUrl.searchParams.get('state')).toBe(state);
  expect(callbackUrl.searchParams.get('code')).toBeNull();
});

test('sets consent CSRF cookie attributes in the real browser', async ({
  page,
  request,
  callback,
}) => {
  const client = await registerClient(request, callback, 'cookie');
  await openConsent(page, client, callback);

  const consentCookies = (await page.context().cookies()).filter((cookie) =>
    cookie.name.startsWith('__Host-lifegame-consent-'),
  );
  expect(consentCookies).toHaveLength(1);
  expect(consentCookies[0]).toEqual(
    expect.objectContaining({
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    }),
  );
});

test('sends the callback origin and frame policy in the consent CSP header', async ({
  page,
  request,
  callback,
}) => {
  const client = await registerClient(request, callback, 'csp');
  const { response } = await openConsent(page, client, callback);
  const csp = response.headers()['content-security-policy'];

  expect(csp).toContain(`form-action 'self' ${callback.origin}`);
  expect(csp).toContain("frame-ancestors 'none'");
});
