import type { Env } from '../env';
import {
  HealthEntryValidationError,
  upsertSyncedHealthEntries,
} from '../db/health-entries';
import { readBoundedBody } from '../lib/bounded-body';
import {
  HealthSyncValidationError,
  MAX_SYNC_BODY_BYTES,
  normalizeSyncPayload,
} from '../lib/health-sync';
import { isGrantRevoked } from '../lib/revocation';

export const HEALTH_SYNC_SCOPE = 'health:write';

export type SyncEnv = Pick<Env, 'DB'>;

// What the OAuth provider decrypts out of the access token and puts on ctx.props.
// Every field is optional here because the token could have been minted before a
// field existed; the checks below decide what a missing one means.
export interface SyncAuthProps {
  email?: unknown;
  scopes?: unknown;
  grantId?: unknown;
}

export interface SyncResponse {
  accepted: number;
}

function errorResponse(
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: message },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } },
  );
}

function hasScope(props: SyncAuthProps | undefined, scope: string): boolean {
  return Array.isArray(props?.scopes) && props.scopes.includes(scope);
}

/**
 * POST /sync — the companion's only write path.
 *
 * The OAuth provider has already rejected a missing or invalid Bearer token by the
 * time this runs, so what is left to check is the scope and whether the grant
 * behind the token was disconnected. The response carries the accepted count and
 * nothing else: the changes token stays on the device, so that what has been
 * synced is recorded in exactly one place.
 */
export async function handleHealthSync(
  request: Request,
  env: SyncEnv,
  props: SyncAuthProps | undefined,
): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse('Method Not Allowed', 405, { Allow: 'POST' });
  }
  if (!hasScope(props, HEALTH_SYNC_SCOPE)) {
    return errorResponse(
      `この操作には ${HEALTH_SYNC_SCOPE} スコープが必要です`,
      403,
      {
        'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${HEALTH_SYNC_SCOPE}"`,
      },
    );
  }
  // Same race as the MCP tools: a token minted by a refresh that overlapped a
  // disconnect can outlive its grant, and the marker is what still stops it.
  if (
    typeof props?.grantId === 'string' &&
    typeof props.email === 'string' &&
    (await isGrantRevoked(env.DB, props.email, props.grantId))
  ) {
    return errorResponse(
      'この接続は切断されています。再接続してください',
      401,
      {
        'WWW-Authenticate': 'Bearer error="invalid_token"',
      },
    );
  }

  const body = await readBoundedBody(request, MAX_SYNC_BODY_BYTES).catch(
    () => null,
  );
  if (body === null) {
    return errorResponse(
      `リクエストが大きすぎます（上限 ${MAX_SYNC_BODY_BYTES} バイト）`,
      413,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return errorResponse('JSON として解釈できませんでした', 400);
  }

  try {
    const records = normalizeSyncPayload(parsed);
    const accepted = await upsertSyncedHealthEntries(env.DB, records);
    return Response.json({ accepted } satisfies SyncResponse, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (thrown) {
    if (
      thrown instanceof HealthSyncValidationError ||
      thrown instanceof HealthEntryValidationError
    ) {
      return errorResponse(thrown.message, 400);
    }
    throw thrown;
  }
}

// The provider calls apiHandlers entries as Workers handlers and passes the token's
// props on ctx.props, which is not in the ExecutionContext type.
export const syncHandler: Required<Pick<ExportedHandler<Env>, 'fetch'>> = {
  fetch(request, env, ctx) {
    return handleHealthSync(
      request,
      env,
      (ctx as ExecutionContext & { props?: SyncAuthProps }).props,
    );
  },
};
