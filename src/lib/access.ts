import type { Env } from '../env';

export interface AccessUser {
  email: string;
}

export interface AccessAuthError {
  message: string;
  status: 401 | 403 | 500;
}

export function getAccessUser(env: Pick<Env, 'AUTH_REQUIRED' | 'ALLOWED_EMAIL'>, request: Request): AccessUser | AccessAuthError {
  // Only an explicit local false disables authentication; missing config stays secure.
  if (env.AUTH_REQUIRED?.trim().toLowerCase() === 'false') {
    return { email: request.headers.get('Cf-Access-Authenticated-User-Email')?.trim() || 'local-dev' };
  }

  const allowedEmail = env.ALLOWED_EMAIL?.trim();
  if (!allowedEmail) return { message: 'ALLOWED_EMAIL が設定されていません', status: 500 };

  const email = request.headers.get('Cf-Access-Authenticated-User-Email')?.trim();
  if (!email) return { message: 'Cloudflare Access のユーザー情報がありません', status: 401 };
  if (email.toLowerCase() !== allowedEmail.toLowerCase()) {
    return { message: 'このユーザーは利用を許可されていません', status: 403 };
  }

  return { email };
}

export function isAccessAuthError(value: AccessUser | AccessAuthError): value is AccessAuthError {
  return 'status' in value;
}
