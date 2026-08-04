import type { Env } from '../env';
import { verifyAccessJwt } from './access-jwt';

export interface AccessUser {
  email: string;
}

export interface AccessAuthError {
  message: string;
  status: 401 | 403 | 500;
}

export async function getAccessUser(
  env: Pick<
    Env,
    'AUTH_REQUIRED' | 'ALLOWED_EMAIL' | 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD'
  >,
  request: Request,
): Promise<AccessUser | AccessAuthError> {
  // Only an explicit local false disables authentication; missing config stays secure.
  if (env.AUTH_REQUIRED?.trim().toLowerCase() === 'false') {
    return {
      email:
        request.headers.get('Cf-Access-Authenticated-User-Email')?.trim() ||
        'local-dev',
    };
  }

  const allowedEmail = env.ALLOWED_EMAIL?.trim();
  if (!allowedEmail)
    return { message: 'ALLOWED_EMAIL が設定されていません', status: 500 };

  const accessUser = await verifyAccessJwt(env, request);
  if (isAccessAuthError(accessUser)) return accessUser;

  if (accessUser.email.toLowerCase() !== allowedEmail.toLowerCase()) {
    return { message: 'このユーザーは利用を許可されていません', status: 403 };
  }

  return accessUser;
}

export function isAccessAuthError(
  value: AccessUser | AccessAuthError,
): value is AccessAuthError {
  return 'status' in value;
}
