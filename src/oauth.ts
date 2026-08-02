import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env';
import { getAccessUser, isAccessAuthError } from './lib/access';
import { app } from './app';

const SUPPORTED_SCOPES = ['tasks:read', 'tasks:write'];

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

function invalidRequestResponse(): Response {
  return new Response('Invalid authorization request', { status: 400 });
}

function oauthErrorRedirect(oauthRequest: AuthRequest, error: string): Response {
  const redirect = new URL(oauthRequest.redirectUri);
  redirect.searchParams.set('error', error);
  redirect.searchParams.set('state', oauthRequest.state);
  return Response.redirect(redirect.toString(), 302);
}

function consentPage(request: Request, oauthRequest: AuthRequest, clientName: string): Response {
  const action = new URL(request.url);
  action.pathname = '/authorize';
  const requestedScopes = oauthRequest.scope.length > 0 ? oauthRequest.scope.join(', ') : 'タスクの読み書き';
  const html = `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>lifegameの接続許可</title>
  <style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#202124}main{border:1px solid #dadce0;border-radius:12px;padding:1.5rem}button{border:0;border-radius:8px;padding:.7rem 1.1rem;font:inherit;cursor:pointer}button[name=decision][value=approve]{background:#1769aa;color:white}button[name=decision][value=deny]{background:#f1f3f4;margin-left:.5rem}</style>
  </head>
  <body><main>
    <h1>lifegameへの接続</h1>
    <p><strong>${escapeHtml(clientName)}</strong> が、あなたのlifegameタスクにアクセスしようとしています。</p>
    <p>要求された権限: ${escapeHtml(requestedScopes)}</p>
    <form method="post" action="${escapeHtml(action.toString())}">
      <button type="submit" name="decision" value="approve">許可する</button>
      <button type="submit" name="decision" value="deny">拒否する</button>
    </form>
  </main></body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
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
  } catch {
    return invalidRequestResponse();
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return new Response('Unknown OAuth client', { status: 400 });
  if (request.method === 'GET') return consentPage(request, oauthRequest, client.clientName || oauthRequest.clientId);

  let decision: string | null = null;
  try {
    decision = String((await request.clone().formData()).get('decision') ?? '');
  } catch {
    return invalidRequestResponse();
  }
  if (decision !== 'approve' && decision !== 'deny') return invalidRequestResponse();
  if (decision === 'deny') return oauthErrorRedirect(oauthRequest, 'access_denied');

  const grantedScopes = oauthRequest.scope.filter((scope) => SUPPORTED_SCOPES.includes(scope));
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: accessUser.email,
    metadata: { clientName: client.clientName || oauthRequest.clientId },
    scope: grantedScopes,
    props: { email: accessUser.email },
  });
  return Response.redirect(redirectTo, 302);
}

export const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    return app.fetch(request, env, ctx);
  },
};
