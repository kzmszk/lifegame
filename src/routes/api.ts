import { Hono } from 'hono';
import type { Context } from 'hono';
import type { GrantSummary } from '@cloudflare/workers-oauth-provider';
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  TaskConflictError,
  updateTask,
  type TaskView,
} from '../db/tasks';
import { parse } from '../lib/parse';
import {
  normalizeRepeatRule,
  RepeatRuleError,
  REPEAT_DUE_DATE_ERROR,
} from '../lib/repeat';
import { getAccessUser, isAccessAuthError } from '../lib/access';
import { tokyoDayBounds, tokyoToday } from '../lib/time';
import {
  fieldsFromBody,
  hasOwn,
  parseId,
  parseStatus,
  validateFields,
  validDate,
  validTime,
} from '../lib/task-validation';
import { markGrantRevoked, revokedGrantIds } from '../lib/revocation';
import {
  createCalendarEvent,
  GoogleCalendarError,
  listCalendarEvents,
} from '../lib/google-calendar';
import type {
  CalendarEventCreateInput,
  CalendarEventResponse,
  CalendarEventsResponse,
  Connection,
  ErrorResponse,
  TaskCreateInput,
  TaskDraft,
} from '../shared/types';
import type { Env } from '../env';

const api = new Hono<{ Bindings: Env }>();
const MAX_CONNECTION_LIST_PAGES = 5;
const CONNECTION_LIST_PAGE_SIZE = 100;
const MAX_GRANT_ID_LENGTH = 256;

function error(
  c: Context<{ Bindings: Env }>,
  message: string,
  status: 400 | 401 | 403 | 404 | 405 | 409 | 500 | 502,
) {
  return c.json<ErrorResponse>({ error: message }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBody(
  c: Context<{ Bindings: Env }>,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function relativeApiPath(path: string): string {
  return path.startsWith('/api/') ? path.slice('/api'.length) : path;
}

api.use('*', async (c, next) => {
  const user = await getAccessUser(c.env, c.req.raw);
  if (isAccessAuthError(user)) return error(c, user.message, user.status);
  return next();
});

api.get('/tasks', async (c) => {
  const viewParam = c.req.query('view') ?? 'today';
  if (viewParam !== 'today' && viewParam !== 'inbox' && viewParam !== 'all') {
    return error(c, 'view は today, inbox, all のいずれかです', 400);
  }
  const bounds = tokyoDayBounds();
  const tasks = await listTasks(
    c.env.DB,
    viewParam as TaskView,
    bounds.today,
    bounds.startUtc,
    bounds.nextStartUtc,
  );
  return c.json({ tasks });
});

api.get('/tasks/:id', async (c) => {
  if (relativeApiPath(c.req.path) === '/tasks/parse') {
    c.header('Allow', 'POST');
    return error(c, 'このAPIメソッドは対応していません', 405);
  }
  const id = parseId(c.req.param('id'));
  if (!id) return error(c, 'タスクIDが不正です', 400);
  const task = await getTask(c.env.DB, id);
  return task ? c.json({ task }) : error(c, 'タスクが見つかりません', 404);
});

api.post('/tasks/parse', async (c) => {
  const body = await readBody(c);
  if (!body || typeof body.text !== 'string' || body.text.trim() === '')
    return error(c, 'text は必須です', 400);
  const draft: TaskDraft = parse(body.text);
  return c.json(draft);
});

// Keep the static parse endpoint from being mistaken for the dynamic :id endpoint.
api.get('/tasks/parse', (c) => {
  c.header('Allow', 'POST');
  return error(c, 'このAPIメソッドは対応していません', 405);
});

api.post('/tasks', async (c) => {
  const body = await readBody(c);
  if (!body) return error(c, 'JSON オブジェクトを指定してください', 400);
  const fieldError = validateFields(body);
  if (fieldError) return error(c, fieldError, 400);

  let input: TaskCreateInput;
  if (typeof body.text === 'string') {
    if (body.text.trim() === '') return error(c, 'text は空にできません', 400);
    const draft = parse(body.text);
    input = {
      ...draft,
      note: typeof body.note === 'string' ? body.note : draft.note,
      priority:
        body.priority === undefined
          ? draft.priority
          : (body.priority as number),
      tags: typeof body.tags === 'string' ? body.tags : draft.tags,
      repeat_rule: hasOwn(body, 'repeat_rule')
        ? (normalizeRepeatRule(body.repeat_rule) ?? null)
        : draft.repeat_rule,
      status: parseStatus(body.status),
    };
  } else {
    if (typeof body.title !== 'string' || body.title.trim() === '')
      return error(c, 'title は必須です', 400);
    input = {
      title: body.title.trim(),
      note: (body.note as string | undefined) ?? '',
      due_date: (body.due_date as string | null | undefined) ?? null,
      due_time: (body.due_time as string | null | undefined) ?? null,
      priority: (body.priority as number | undefined) ?? 0,
      tags: (body.tags as string | undefined) ?? '',
      repeat_rule: normalizeRepeatRule(body.repeat_rule) ?? null,
      status: parseStatus(body.status),
    };
  }
  if (input.repeat_rule && input.due_date === null)
    return error(c, REPEAT_DUE_DATE_ERROR, 400);
  const task = await createTask(
    c.env.DB,
    input as Required<Pick<TaskCreateInput, 'title'>> &
      Omit<TaskCreateInput, 'title'>,
  );
  return c.json({ task }, 201);
});

api.patch('/tasks/:id', async (c) => {
  if (relativeApiPath(c.req.path) === '/tasks/parse') {
    c.header('Allow', 'POST');
    return error(c, 'このAPIメソッドは対応していません', 405);
  }
  const id = parseId(c.req.param('id'));
  if (!id) return error(c, 'タスクIDが不正です', 400);
  const body = await readBody(c);
  if (!body) return error(c, 'JSON オブジェクトを指定してください', 400);
  const fieldError = validateFields(body);
  if (fieldError) return error(c, fieldError, 400);
  try {
    const task = await updateTask(c.env.DB, id, fieldsFromBody(body));
    return task ? c.json({ task }) : error(c, 'タスクが見つかりません', 404);
  } catch (thrown) {
    if (thrown instanceof RepeatRuleError) return error(c, thrown.message, 400);
    if (thrown instanceof TaskConflictError)
      return error(c, thrown.message, 409);
    throw thrown;
  }
});

api.delete('/tasks/:id', async (c) => {
  if (relativeApiPath(c.req.path) === '/tasks/parse') {
    c.header('Allow', 'POST');
    return error(c, 'このAPIメソッドは対応していません', 405);
  }
  const id = parseId(c.req.param('id'));
  if (!id) return error(c, 'タスクIDが不正です', 400);
  const deleted = await deleteTask(c.env.DB, id);
  return deleted
    ? c.json({ ok: true })
    : error(c, 'タスクが見つかりません', 404);
});

function calendarError(c: Context<{ Bindings: Env }>, thrown: unknown) {
  if (!(thrown instanceof GoogleCalendarError)) throw thrown;
  console.warn(`Google Calendar 呼び出しに失敗: ${thrown.message}`);
  // Config and credential problems are ours to fix, so they stay 500. An upstream
  // fault is reported as 502 so it reads as "Google is down", not "the app broke".
  return error(c, thrown.message, thrown.kind === 'upstream' ? 502 : 500);
}

api.get('/calendar/events', async (c) => {
  const date = c.req.query('date') ?? tokyoToday();
  if (!validDate(date))
    return error(c, 'date は YYYY-MM-DD 形式で指定してください', 400);
  try {
    const events = await listCalendarEvents(c.env, date);
    return c.json<CalendarEventsResponse>({ date, events });
  } catch (thrown) {
    return calendarError(c, thrown);
  }
});

api.post('/calendar/events', async (c) => {
  const body = await readBody(c);
  if (!body) return error(c, 'JSON オブジェクトを指定してください', 400);
  if (typeof body.title !== 'string' || body.title.trim() === '')
    return error(c, 'title は必須です', 400);
  if (typeof body.date !== 'string' || !validDate(body.date))
    return error(c, 'date は YYYY-MM-DD 形式で指定してください', 400);
  if (typeof body.start_time !== 'string' || !validTime(body.start_time))
    return error(c, 'start_time は HH:MM 形式で指定してください', 400);
  if (hasOwn(body, 'note') && typeof body.note !== 'string')
    return error(c, 'note は文字列で指定してください', 400);

  let endTime: string | undefined;
  if (hasOwn(body, 'end_time') && body.end_time !== null) {
    if (typeof body.end_time !== 'string' || !validTime(body.end_time))
      return error(c, 'end_time は HH:MM 形式で指定してください', 400);
    // An end at or before the start means the event runs past midnight, the same
    // reading the omitted-end_time path already takes when the default hour
    // crosses over. Rejecting it here would make 23:30-00:30 the one overnight
    // duration that cannot be expressed.
    endTime = body.end_time;
  }

  const input: CalendarEventCreateInput = {
    title: body.title.trim(),
    date: body.date,
    start_time: body.start_time,
    ...(endTime ? { end_time: endTime } : {}),
    ...(typeof body.note === 'string' ? { note: body.note } : {}),
  };
  try {
    const event = await createCalendarEvent(c.env, input);
    return c.json<CalendarEventResponse>({ event }, 201);
  } catch (thrown) {
    return calendarError(c, thrown);
  }
});

function clientNameForGrant(grant: GrantSummary): string {
  if (
    typeof grant.metadata === 'object' &&
    grant.metadata !== null &&
    !Array.isArray(grant.metadata)
  ) {
    const clientName = (grant.metadata as Record<string, unknown>).clientName;
    if (typeof clientName === 'string' && clientName.trim() !== '')
      return clientName;
  }
  return grant.clientId;
}

interface GrantScan {
  grants: GrantSummary[];
  /** True when the page budget ran out before the key space was exhausted. */
  truncated: boolean;
}

// Each page costs one KV list plus one get per grant, against a 1000-operation
// budget per invocation. The page cap keeps the worst case well inside it, with
// room left for the revocation that may follow.
async function scanConnectionGrants(
  env: Env,
  userId: string,
  stopWhen?: (grant: GrantSummary) => boolean,
): Promise<GrantScan> {
  const grants: GrantSummary[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_CONNECTION_LIST_PAGES; page += 1) {
    const result = await env.OAUTH_PROVIDER.listUserGrants(userId, {
      limit: CONNECTION_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    grants.push(...result.items);
    if (stopWhen && result.items.some(stopWhen))
      return { grants, truncated: false };
    if (!result.cursor) return { grants, truncated: false };
    cursor = result.cursor;
  }

  // KV keeps returning a cursor after recently deleted keys, so an empty page is
  // not proof that the scan is finished.
  return { grants, truncated: true };
}

function toConnection(grant: GrantSummary): Connection {
  return {
    id: grant.id,
    client_id: grant.clientId,
    client_name: clientNameForGrant(grant),
    scope: grant.scope,
    created_at: grant.createdAt,
  };
}

function isValidGrantId(grantId: string): boolean {
  return (
    grantId.length > 0 &&
    grantId.length <= MAX_GRANT_ID_LENGTH &&
    // Control characters are deliberately rejected at this trust boundary.
    // oxlint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(grantId)
  );
}

api.get('/connections', async (c) => {
  const accessUser = await getAccessUser(c.env, c.req.raw);
  if (isAccessAuthError(accessUser))
    return error(c, accessUser.message, accessUser.status);

  const [scan, revoked] = await Promise.all([
    scanConnectionGrants(c.env, accessUser.email),
    revokedGrantIds(c.env.DB, accessUser.email),
  ]);
  if (scan.truncated)
    console.warn('接続一覧を打ち切りました（ページ上限に到達）');
  // A refresh that wrote back after the sweeps leaves a grant the tools already
  // refuse. Listing it would show a connection the user was told was disconnected.
  const connections = scan.grants
    .filter((grant) => !revoked.has(grant.id))
    .map(toConnection)
    .sort((left, right) => right.created_at - left.created_at);
  // A partial list that looks complete would hide connections the user cannot
  // then reach to disconnect, so the shortfall is reported rather than logged only.
  return c.json({ connections, truncated: scan.truncated });
});

async function revokeConnection(c: Context<{ Bindings: Env }>) {
  const grantId = c.req.param('id') ?? '';
  if (!isValidGrantId(grantId)) return error(c, '接続IDが不正です', 400);

  const accessUser = await getAccessUser(c.env, c.req.raw);
  if (isAccessAuthError(accessUser))
    return error(c, accessUser.message, accessUser.status);

  // revokeGrant() is idempotent, so ownership is confirmed first to tell a missing
  // grant from a revoked one. The scan stops at the match instead of reading every page.
  const scan = await scanConnectionGrants(
    c.env,
    accessUser.email,
    (grant) => grant.id === grantId,
  );
  if (!scan.grants.some((grant) => grant.id === grantId)) {
    // A truncated scan cannot prove absence; saying "not found" here would be a lie.
    return scan.truncated
      ? error(c, '接続数が多く、確認しきれませんでした', 500)
      : error(c, '接続が見つかりません', 404);
  }

  // Written first: a refresh already in flight is refused at issuance time rather
  // than cleaned up afterwards, so it cannot resurrect the grant it just read.
  await markGrantRevoked(c.env.DB, accessUser.email, grantId);

  // The sweep still runs twice. The marker stops future issuance, but a token
  // written between the first pass's enumeration and its deletion of the grant
  // would otherwise stay valid until it expires.
  await c.env.OAUTH_PROVIDER.revokeGrant(grantId, accessUser.email);
  await c.env.OAUTH_PROVIDER.revokeGrant(grantId, accessUser.email);
  return c.json({ ok: true });
}

api.delete('/connections/:id', revokeConnection);
// Keep an empty ID in the connection route so it gets a validation error instead of a generic 404.
api.delete('/connections/', revokeConnection);

function knownApiPath(path: string): boolean {
  return (
    path === '/tasks' ||
    path === '/tasks/parse' ||
    path === '/connections' ||
    path === '/connections/' ||
    path === '/calendar/events' ||
    /^\/(tasks|connections)\/[^/]+$/.test(path)
  );
}

const staticPathMethods: Record<string, string> = {
  '/tasks': 'GET, POST',
  '/tasks/parse': 'POST',
  '/connections': 'GET',
  '/calendar/events': 'GET, POST',
};

// This route is copied to the parent app by app.route(), so unknown /api/* requests
// never fall through to the SPA asset handler.
api.all('*', (c) => {
  const path = relativeApiPath(c.req.path);
  if (knownApiPath(path)) {
    c.header(
      'Allow',
      staticPathMethods[path] ??
        (path.startsWith('/connections/') ? 'DELETE' : 'GET, PATCH, DELETE'),
    );
    return error(c, 'このAPIメソッドは対応していません', 405);
  }
  return error(c, 'API endpoint が見つかりません', 404);
});

api.notFound((c) => error(c, 'API endpoint が見つかりません', 404));

export default api;
