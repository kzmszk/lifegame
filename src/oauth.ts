import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env';
import { getAccessUser, isAccessAuthError } from './lib/access';
import { app } from './app';

export const SUPPORTED_SCOPES = ['tasks:read', 'tasks:write'] as const;
type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

const CONSENT_CSRF_COOKIE = '__Host-lifegame-consent-csrf';
const CONSENT_CSRF_MAX_AGE = 600;

export interface OAuthValidationError {
  error: 'invalid_request' | 'invalid_scope' | 'unauthorized_client' | 'unsupported_response_type';
  description: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );
}

function authErrorResponse(error: { message: string; status: number }): Response {
  return Response.json({ error: error.message }, { status: error.status });
}

function invalidRequestResponse(message = 'Invalid authorization request'): Response {
  return new Response(message, { status: 400 });
}

function clearConsentCsrfCookie(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.append(
    'Set-Cookie',
    `${CONSENT_CSRF_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie')?.split(';') ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() === name) return cookie.slice(separator + 1).trim();
  }
  return null;
}

function oauthErrorRedirect(
  oauthRequest: Pick<AuthRequest, 'redirectUri' | 'state'>,
  error: string,
  description?: string,
): Response {
  const redirect = new URL(oauthRequest.redirectUri);
  redirect.searchParams.set('error', error);
  if (description) redirect.searchParams.set('error_description', description);
  if (oauthRequest.state) redirect.searchParams.set('state', oauthRequest.state);
  return Response.redirect(redirect.toString(), 302);
}

function oauthErrorRedirectFromRequest(
  redirectUri: string,
  state: string,
  error: string,
  description?: string,
): Response {
  return oauthErrorRedirect({ redirectUri, state }, error, description);
}

function isLoopbackUri(uri: string): boolean {
  try {
    const hostname = new URL(uri).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  } catch {
    return false;
  }
}

function isSafeRedirectUri(uri: string): boolean {
  const normalized = uri.trim();
  if (!normalized || [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 31) || (code >= 127 && code <= 159);
  })) return false;

  const colon = normalized.indexOf(':');
  if (colon === -1) return false;
  try {
    new URL(normalized);
  } catch {
    return false;
  }
  return !['javascript:', 'data:', 'vbscript:', 'file:', 'mailto:', 'blob:'].includes(
    normalized.slice(0, colon + 1).toLowerCase(),
  );
}

function isRegisteredRedirectUri(redirectUri: string, registeredUris: string[]): boolean {
  if (!isSafeRedirectUri(redirectUri)) return false;
  return registeredUris.some((registeredUri) => {
    if (redirectUri === registeredUri) return true;
    if (!isLoopbackUri(redirectUri) || !isLoopbackUri(registeredUri)) return false;
    try {
      const requested = new URL(redirectUri);
      const registered = new URL(registeredUri);
      return (
        requested.protocol === registered.protocol &&
        requested.hostname === registered.hostname &&
        requested.pathname === registered.pathname &&
        requested.search === registered.search
      );
    } catch {
      return false;
    }
  });
}

export function validateAuthorizationRequest(
  oauthRequest: AuthRequest,
  client: ClientInfo,
): OAuthValidationError | null {
  if (oauthRequest.responseType !== 'code') {
    return { error: 'unsupported_response_type', description: 'response_type=code が必要です' };
  }
  if (!oauthRequest.codeChallenge?.trim()) {
    return { error: 'invalid_request', description: 'PKCE code_challenge が必要です' };
  }
  if (oauthRequest.codeChallengeMethod !== 'S256') {
    return { error: 'invalid_request', description: 'PKCE code_challenge_method は S256 が必要です' };
  }
  if (!client.responseTypes?.includes('code')) {
    return { error: 'unauthorized_client', description: 'このクライアントは code response type に対応していません' };
  }
  if (!client.grantTypes?.includes('authorization_code')) {
    return { error: 'unauthorized_client', description: 'このクライアントは authorization_code grant に対応していません' };
  }

  const unknownScopes = oauthRequest.scope.filter(
    (scope) => !SUPPORTED_SCOPES.includes(scope as SupportedScope),
  );
  if (unknownScopes.length > 0) {
    return { error: 'invalid_scope', description: `未対応のスコープです: ${unknownScopes.join(', ')}` };
  }
  return null;
}

export function grantedScopesForRequest(requestedScopes: string[]): SupportedScope[] {
  // An omitted scope is an explicit request for the full task capability set.
  return requestedScopes.length > 0 ? (requestedScopes as SupportedScope[]) : [...SUPPORTED_SCOPES];
}

function consentPage(request: Request, oauthRequest: AuthRequest, client: ClientInfo): Response {
  const action = new URL(request.url);
  action.pathname = '/authorize';
  const csrfToken = crypto.randomUUID();
  const requestedScopes =
    oauthRequest.scope.length > 0
      ? oauthRequest.scope.join(', ')
      : '省略（tasks:read と tasks:write の両方）';
  const clientName = client.clientName || oauthRequest.clientId;
  const redirectUris = client.redirectUris.map((uri) => `<li>${escapeHtml(uri)}</li>`).join('');
  const html = `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>lifegameの接続許可</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'">
  <style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#202124}main{border:1px solid #dadce0;border-radius:12px;padding:1.5rem}button{border:0;border-radius:8px;padding:.7rem 1.1rem;font:inherit;cursor:pointer}button[name=decision][value=approve]{background:#1769aa;color:white}button[name=decision][value=deny]{background:#f1f3f4;margin-left:.5rem}code{overflow-wrap:anywhere}ul{padding-left:1.3rem}</style>
  </head>
  <body><main>
    <h1>lifegameへの接続</h1>
    <p><strong>${escapeHtml(clientName)}</strong>（client_id: <code>${escapeHtml(client.clientId)}</code>）が、あなたのlifegameタスクにアクセスしようとしています。</p>
    <p>要求された権限: ${escapeHtml(requestedScopes)}</p>
    <p>登録済みのリダイレクトURI:</p><ul>${redirectUris}</ul>
    <form method="post" action="${escapeHtml(action.toString())}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      <button type="submit" name="decision" value="approve">許可する</button>
      <button type="submit" name="decision" value="deny">拒否する</button>
    </form>
  </main></body>
</html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Set-Cookie': `${CONSENT_CSRF_COOKIE}=${csrfToken}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CONSENT_CSRF_MAX_AGE}`,
    },
  });
}

async function validatedRedirectContext(
  request: Request,
  env: Env,
): Promise<{ client: ClientInfo; redirectUri: string; state: string } | null> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id') ?? '';
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  if (!clientId || !redirectUri) return null;
  try {
    const client = await env.OAUTH_PROVIDER.lookupClient(clientId);
    if (!client || !isRegisteredRedirectUri(redirectUri, client.redirectUris)) return null;
    return { client, redirectUri, state: url.searchParams.get('state') ?? '' };
  } catch {
    return null;
  }
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const accessUser = getAccessUser(env, request);
  if (isAccessAuthError(accessUser)) return authErrorResponse(accessUser);
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    const validated = await validatedRedirectContext(request, env);
    const rawResponseType = new URL(request.url).searchParams.get('response_type') ?? '';
    const errorCode = rawResponseType === 'code' ? 'invalid_request' : 'unsupported_response_type';
    const response = validated
      ? oauthErrorRedirectFromRequest(
          validated.redirectUri,
          validated.state,
          errorCode,
          error instanceof Error ? error.message : 'Invalid authorization request',
        )
      : invalidRequestResponse();
    return request.method === 'POST' ? clearConsentCsrfCookie(response) : response;
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return new Response('Unknown OAuth client', { status: 400 });
  const validationError = validateAuthorizationRequest(oauthRequest, client);
  if (validationError) {
    const response = oauthErrorRedirect(oauthRequest, validationError.error, validationError.description);
    return request.method === 'POST' ? clearConsentCsrfCookie(response) : response;
  }
  if (request.method === 'GET') return consentPage(request, oauthRequest, client);

  let decision: string | null = null;
  let csrfToken: string | null = null;
  try {
    const form = await request.clone().formData();
    decision = String(form.get('decision') ?? '');
    csrfToken = String(form.get('csrf_token') ?? '');
  } catch {
    return clearConsentCsrfCookie(invalidRequestResponse());
  }
  const cookieToken = getCookie(request, CONSENT_CSRF_COOKIE);
  if (!csrfToken || !cookieToken || csrfToken !== cookieToken) {
    return clearConsentCsrfCookie(new Response('Invalid consent form', { status: 400 }));
  }
  if (decision !== 'approve' && decision !== 'deny') {
    return clearConsentCsrfCookie(invalidRequestResponse());
  }
  if (decision === 'deny') return clearConsentCsrfCookie(oauthErrorRedirect(oauthRequest, 'access_denied'));

  const grantedScopes = grantedScopesForRequest(oauthRequest.scope);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: accessUser.email,
    metadata: { clientName: client.clientName || oauthRequest.clientId, clientId: client.clientId },
    scope: grantedScopes,
    props: { email: accessUser.email, scopes: grantedScopes },
  });
  return clearConsentCsrfCookie(Response.redirect(redirectTo, 302));
}

export const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    return app.fetch(request, env, ctx);
  },
};
