import type {
  AuthRequest,
  ClientInfo,
} from '@cloudflare/workers-oauth-provider';
import type { Env } from './env';
import { getAccessUser, isAccessAuthError } from './lib/access';
import { app } from './app';

// calendar:read is separate from tasks:read because Google Calendar is a
// different data source with a different owner. Grants issued before it existed
// carry only the task scopes, so they keep seeing tasks only until reconnected.
export const SUPPORTED_SCOPES = [
  'tasks:read',
  'tasks:write',
  'calendar:read',
] as const;
type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

// Typed as a total record so a new scope cannot reach the consent page without
// a description: approving a permission nobody explained is the failure mode.
const SCOPE_DESCRIPTIONS: Record<SupportedScope, string> = {
  'tasks:read': 'lifegameのタスクを読む',
  'tasks:write': 'lifegameのタスクを追加・変更・削除する',
  'calendar:read': 'Googleカレンダー（private）の予定と祝日を読む',
};

const CONSENT_CSRF_COOKIE_PREFIX = '__Host-lifegame-consent-';
const CONSENT_CSRF_MAX_AGE = 600;
const CONSENT_CSRF_MAX_COOKIE_LENGTH = 512;
const CONSENT_CSRF_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSENT_FLOW_ID_PATTERN = CONSENT_CSRF_TOKEN_PATTERN;

export interface OAuthValidationError {
  error:
    | 'invalid_request'
    | 'invalid_scope'
    | 'unauthorized_client'
    | 'unsupported_response_type';
  description: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  );
}

function authErrorResponse(error: {
  message: string;
  status: number;
}): Response {
  return Response.json({ error: error.message }, { status: error.status });
}

function invalidRequestResponse(
  message = 'Invalid authorization request',
): Response {
  return new Response(message, { status: 400 });
}

function consentCsrfCookieName(flowId: string): string | null {
  return CONSENT_FLOW_ID_PATTERN.test(flowId)
    ? `${CONSENT_CSRF_COOKIE_PREFIX}${flowId}`
    : null;
}

function clearConsentCsrfCookie(
  response: Response,
  flowId: string | null,
): Response {
  const cookieName = flowId ? consentCsrfCookieName(flowId) : null;
  if (!cookieName) return response;
  const headers = new Headers(response.headers);
  headers.append(
    'Set-Cookie',
    `${cookieName}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseConsentCsrfToken(value: string | null): string | null {
  if (
    !value ||
    value.length > CONSENT_CSRF_MAX_COOKIE_LENGTH ||
    !CONSENT_CSRF_TOKEN_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function serializeConsentCsrfCookie(
  cookieName: string,
  csrfToken: string,
): string {
  return `${cookieName}=${csrfToken}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CONSENT_CSRF_MAX_AGE}`;
}

function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie')?.split(';') ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() === name)
      return cookie.slice(separator + 1).trim();
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
  if (oauthRequest.state)
    redirect.searchParams.set('state', oauthRequest.state);
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
    const rawHostname = new URL(uri).hostname.toLowerCase();
    const hostname =
      rawHostname.startsWith('[') && rawHostname.endsWith(']')
        ? rawHostname.slice(1, -1)
        : rawHostname;
    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

function isSafeRedirectUri(uri: string): boolean {
  const normalized = uri.trim();
  if (
    !normalized ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return (code >= 0 && code <= 31) || (code >= 127 && code <= 159);
    })
  )
    return false;

  const colon = normalized.indexOf(':');
  if (colon === -1) return false;
  try {
    new URL(normalized);
  } catch {
    return false;
  }
  return ![
    'javascript:',
    'data:',
    'vbscript:',
    'file:',
    'mailto:',
    'blob:',
  ].includes(normalized.slice(0, colon + 1).toLowerCase());
}

function isRegisteredRedirectUri(
  redirectUri: string,
  registeredUris: string[],
): boolean {
  if (!isSafeRedirectUri(redirectUri)) return false;
  return registeredUris.some((registeredUri) => {
    if (redirectUri === registeredUri) return true;
    if (!isLoopbackUri(redirectUri) || !isLoopbackUri(registeredUri))
      return false;
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
    return {
      error: 'unsupported_response_type',
      description: 'response_type=code が必要です',
    };
  }
  if (!oauthRequest.codeChallenge?.trim()) {
    return {
      error: 'invalid_request',
      description: 'PKCE code_challenge が必要です',
    };
  }
  if (oauthRequest.codeChallengeMethod !== 'S256') {
    return {
      error: 'invalid_request',
      description: 'PKCE code_challenge_method は S256 が必要です',
    };
  }
  if (!client.responseTypes?.includes('code')) {
    return {
      error: 'unauthorized_client',
      description: 'このクライアントは code response type に対応していません',
    };
  }
  if (!client.grantTypes?.includes('authorization_code')) {
    return {
      error: 'unauthorized_client',
      description:
        'このクライアントは authorization_code grant に対応していません',
    };
  }

  const unknownScopes = oauthRequest.scope.filter(
    (scope) => !SUPPORTED_SCOPES.includes(scope as SupportedScope),
  );
  if (unknownScopes.length > 0) {
    return {
      error: 'invalid_scope',
      description: `未対応のスコープです: ${unknownScopes.join(', ')}`,
    };
  }
  return null;
}

export function grantedScopesForRequest(
  requestedScopes: string[],
): SupportedScope[] {
  // An omitted scope is an explicit request for the full task capability set.
  return requestedScopes.length > 0
    ? (requestedScopes as SupportedScope[])
    : [...SUPPORTED_SCOPES];
}

// form-action also constrains the redirect that follows the submission, so the
// approved client's callback origin must be allowed or the OAuth redirect is
// silently blocked by the browser after the grant has already been stored.
function consentFormActionSource(redirectUri: string): string | null {
  try {
    const url = new URL(redirectUri);
    // Custom-scheme callbacks (myapp://...) have an opaque origin; allow the scheme.
    return url.origin && url.origin !== 'null' ? url.origin : url.protocol;
  } catch {
    return null;
  }
}

// A CSP violation is invisible to both the user and the server unless it is
// reported, which is how the form-action/redirect breakage stayed silent.
export const CSP_REPORT_PATH = '/csp-report';
const CSP_REPORT_ENDPOINT_NAME = 'csp-endpoint';
const MAX_CSP_REPORT_BYTES = 8 * 1024;

function consentCsp(redirectUri: string): string {
  const callbackSource = consentFormActionSource(redirectUri);
  const formAction = callbackSource ? `'self' ${callbackSource}` : "'self'";
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    // report-uri is deprecated but still the only form some browsers honour.
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_ENDPOINT_NAME}`,
  ].join('; ');
}

// Returns null once the byte budget is exceeded. The stream is read in chunks and
// cancelled rather than buffered, so an oversized POST to this unauthenticated
// path cannot make the isolate materialize it first.
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function handleCspReport(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }
  // Browser telemetry from an unauthenticated path: log a bounded amount, store nothing.
  const body = await readBoundedBody(request, MAX_CSP_REPORT_BYTES).catch(
    () => '',
  );
  if (body === null) {
    console.warn(
      `CSP violation report discarded (over ${MAX_CSP_REPORT_BYTES} bytes)`,
    );
  } else if (body) {
    console.warn('CSP violation report:', body);
  }
  return new Response(null, { status: 204 });
}

function consentPage(
  request: Request,
  oauthRequest: AuthRequest,
  client: ClientInfo,
): Response {
  const action = new URL(request.url);
  action.pathname = '/authorize';
  const csp = consentCsp(oauthRequest.redirectUri);
  const flowId = crypto.randomUUID();
  const csrfToken = crypto.randomUUID();
  const requestedScopes =
    oauthRequest.scope.length > 0
      ? oauthRequest.scope.join(', ')
      : `省略（${SUPPORTED_SCOPES.join(' と ')} のすべて）`;
  const scopeDescriptions = SUPPORTED_SCOPES.map(
    (scope) =>
      `<li><code>${escapeHtml(scope)}</code> — ${escapeHtml(SCOPE_DESCRIPTIONS[scope])}</li>`,
  ).join('');
  const clientName = client.clientName || oauthRequest.clientId;
  const redirectUris = client.redirectUris
    .map((uri) => `<li>${escapeHtml(uri)}</li>`)
    .join('');
  const html = `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>lifegameの接続許可</title>
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#202124}main{border:1px solid #dadce0;border-radius:12px;padding:1.5rem}button{border:0;border-radius:8px;padding:.7rem 1.1rem;font:inherit;cursor:pointer}button[name=decision][value=approve]{background:#1769aa;color:white}button[name=decision][value=deny]{background:#f1f3f4;margin-left:.5rem}code{overflow-wrap:anywhere}ul{padding-left:1.3rem}</style>
  </head>
  <body><main>
    <h1>lifegameへの接続</h1>
    <p><strong>${escapeHtml(clientName)}</strong>（client_id: <code>${escapeHtml(client.clientId)}</code>）が、あなたのlifegameのデータにアクセスしようとしています。</p>
    <p>要求された権限: ${escapeHtml(requestedScopes)}</p>
    <ul>${scopeDescriptions}</ul>
    <p>登録済みのリダイレクトURI:</p><ul>${redirectUris}</ul>
    <form method="post" action="${escapeHtml(action.toString())}">
      <input type="hidden" name="flow_id" value="${escapeHtml(flowId)}">
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
      'Content-Security-Policy': csp,
      'Reporting-Endpoints': `${CSP_REPORT_ENDPOINT_NAME}="${new URL(CSP_REPORT_PATH, request.url).toString()}"`,
      'X-Frame-Options': 'DENY',
      'Set-Cookie': serializeConsentCsrfCookie(
        consentCsrfCookieName(flowId)!,
        csrfToken,
      ),
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
    if (!client || !isRegisteredRedirectUri(redirectUri, client.redirectUris))
      return null;
    return { client, redirectUri, state: url.searchParams.get('state') ?? '' };
  } catch {
    return null;
  }
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const accessUser = await getAccessUser(env, request);
  if (isAccessAuthError(accessUser)) return authErrorResponse(accessUser);
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, POST' },
    });
  }

  let decision: string | null = null;
  let flowId: string | null = null;
  let csrfToken: string | null = null;
  if (request.method === 'POST') {
    try {
      const form = await request.clone().formData();
      decision = String(form.get('decision') ?? '');
      flowId = String(form.get('flow_id') ?? '');
      csrfToken = String(form.get('csrf_token') ?? '');
    } catch {
      return invalidRequestResponse();
    }
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    const validated = await validatedRedirectContext(request, env);
    const rawResponseType =
      new URL(request.url).searchParams.get('response_type') ?? '';
    const errorCode =
      rawResponseType === 'code'
        ? 'invalid_request'
        : 'unsupported_response_type';
    const response = validated
      ? oauthErrorRedirectFromRequest(
          validated.redirectUri,
          validated.state,
          errorCode,
          error instanceof Error
            ? error.message
            : 'Invalid authorization request',
        )
      : invalidRequestResponse();
    return request.method === 'POST'
      ? clearConsentCsrfCookie(response, flowId)
      : response;
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client)
    return clearConsentCsrfCookie(
      new Response('Unknown OAuth client', { status: 400 }),
      flowId,
    );
  const validationError = validateAuthorizationRequest(oauthRequest, client);
  if (validationError) {
    const response = oauthErrorRedirect(
      oauthRequest,
      validationError.error,
      validationError.description,
    );
    return request.method === 'POST'
      ? clearConsentCsrfCookie(response, flowId)
      : response;
  }
  if (request.method === 'GET')
    return consentPage(request, oauthRequest, client);

  const cookieName = flowId ? consentCsrfCookieName(flowId) : null;
  const cookieToken = cookieName
    ? parseConsentCsrfToken(getCookie(request, cookieName))
    : null;
  if (!cookieName || !csrfToken || cookieToken !== csrfToken) {
    return clearConsentCsrfCookie(
      new Response('Invalid consent form', { status: 400 }),
      flowId,
    );
  }
  if (decision !== 'approve' && decision !== 'deny') {
    return clearConsentCsrfCookie(invalidRequestResponse(), flowId);
  }
  if (decision === 'deny')
    return clearConsentCsrfCookie(
      oauthErrorRedirect(oauthRequest, 'access_denied'),
      flowId,
    );

  const grantedScopes = grantedScopesForRequest(oauthRequest.scope);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: accessUser.email,
    metadata: {
      clientName: client.clientName || oauthRequest.clientId,
      clientId: client.clientId,
    },
    scope: grantedScopes,
    props: { email: accessUser.email, scopes: grantedScopes },
  });
  return clearConsentCsrfCookie(Response.redirect(redirectTo, 302), flowId);
}

export const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    if (url.pathname === CSP_REPORT_PATH) return handleCspReport(request);
    return app.fetch(request, env, ctx);
  },
};
