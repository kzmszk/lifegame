import { Hono } from 'hono';
import type { Context } from 'hono';
import { createTask, deleteTask, getTask, listTasks, updateTask, type TaskView } from '../db/tasks';
import { parse } from '../lib/parse';
import { tokyoDayBounds } from '../lib/time';
import type {
  ErrorResponse,
  TaskCreateInput,
  TaskDraft,
  TaskStatus,
  TaskUpdateInput,
} from '../shared/types';
import type { Env } from '../index';

const api = new Hono<{ Bindings: Env }>();

function error(c: Context<{ Bindings: Env }>, message: string, status: 400 | 401 | 403 | 404 | 405 | 500) {
  return c.json<ErrorResponse>({ error: message }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBody(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function nullableText(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!hasOwn(body, key)) return undefined;
  return body[key] === null || typeof body[key] === 'string' ? (body[key] as string | null) : undefined;
}

function validDate(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return true;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(2000, month - 1, day));
  candidate.setUTCFullYear(year);
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() + 1 === month &&
    candidate.getUTCDate() === day
  );
}

function validTime(value: string | null | undefined): boolean {
  return value === undefined || value === null || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validPriority(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && (value === 0 || value === 1));
}

function parseStatus(value: unknown): TaskStatus | undefined {
  return value === 'open' || value === 'done' ? value : undefined;
}

function parseId(rawId: string): number | null {
  if (!/^\d+$/.test(rawId)) return null;
  const id = Number(rawId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function relativeApiPath(path: string): string {
  return path.startsWith('/api/') ? path.slice('/api'.length) : path;
}

function validateFields(body: Record<string, unknown>): string | null {
  if (hasOwn(body, 'completed_at')) return 'completed_at はクライアントから指定できません';
  if (hasOwn(body, 'due_date') && body.due_date !== null && typeof body.due_date !== 'string') {
    return 'due_date は YYYY-MM-DD 形式で指定してください';
  }
  if (hasOwn(body, 'due_time') && body.due_time !== null && typeof body.due_time !== 'string') {
    return 'due_time は HH:MM 形式で指定してください';
  }
  if (hasOwn(body, 'title') && (typeof body.title !== 'string' || body.title.trim() === '')) {
    return 'title は空にできません';
  }
  if (hasOwn(body, 'note') && typeof body.note !== 'string') return 'note は文字列で指定してください';
  if (hasOwn(body, 'tags') && typeof body.tags !== 'string') return 'tags は文字列で指定してください';
  if (!validDate(nullableText(body, 'due_date'))) return 'due_date は YYYY-MM-DD 形式で指定してください';
  if (!validTime(nullableText(body, 'due_time'))) return 'due_time は HH:MM 形式で指定してください';
  if (!validPriority(body.priority)) return 'priority は 0 または 1 で指定してください';
  if (hasOwn(body, 'status') && !parseStatus(body.status)) return 'status は open または done で指定してください';
  return null;
}

function fieldsFromBody(body: Record<string, unknown>): TaskUpdateInput {
  const fields: TaskUpdateInput = {};
  if (hasOwn(body, 'title')) fields.title = String(body.title).trim();
  if (hasOwn(body, 'note')) fields.note = body.note as string;
  if (hasOwn(body, 'due_date')) fields.due_date = body.due_date as string | null;
  if (hasOwn(body, 'due_time')) fields.due_time = body.due_time as string | null;
  if (hasOwn(body, 'priority')) fields.priority = body.priority as number;
  if (hasOwn(body, 'tags')) fields.tags = body.tags as string;
  if (hasOwn(body, 'status')) fields.status = body.status as TaskStatus;
  return fields;
}

api.use('*', async (c, next) => {
  // Only an explicit local false disables authentication; missing config stays secure.
  if (c.env.AUTH_REQUIRED?.trim().toLowerCase() === 'false') return next();
  const allowedEmail = c.env.ALLOWED_EMAIL?.trim();
  if (!allowedEmail) return error(c, 'ALLOWED_EMAIL が設定されていません', 500);
  const email = c.req.header('Cf-Access-Authenticated-User-Email')?.trim();
  if (!email) return error(c, 'Cloudflare Access のユーザー情報がありません', 401);
  if (email.toLowerCase() !== allowedEmail.toLowerCase()) {
    return error(c, 'このユーザーは利用を許可されていません', 403);
  }
  return next();
});

api.get('/tasks', async (c) => {
  const viewParam = c.req.query('view') ?? 'today';
  if (viewParam !== 'today' && viewParam !== 'inbox' && viewParam !== 'all') {
    return error(c, 'view は today, inbox, all のいずれかです', 400);
  }
  const bounds = tokyoDayBounds();
  const tasks = await listTasks(c.env.DB, viewParam as TaskView, bounds.today, bounds.startUtc, bounds.nextStartUtc);
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
  if (!body || typeof body.text !== 'string' || body.text.trim() === '') return error(c, 'text は必須です', 400);
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
      priority: body.priority === undefined ? draft.priority : (body.priority as number),
      tags: typeof body.tags === 'string' ? body.tags : draft.tags,
      status: parseStatus(body.status),
    };
  } else {
    if (typeof body.title !== 'string' || body.title.trim() === '') return error(c, 'title は必須です', 400);
    input = {
      title: body.title.trim(),
      note: (body.note as string | undefined) ?? '',
      due_date: (body.due_date as string | null | undefined) ?? null,
      due_time: (body.due_time as string | null | undefined) ?? null,
      priority: (body.priority as number | undefined) ?? 0,
      tags: (body.tags as string | undefined) ?? '',
      status: parseStatus(body.status),
    };
  }
  const task = await createTask(c.env.DB, input as Required<Pick<TaskCreateInput, 'title'>> & Omit<TaskCreateInput, 'title'>);
  return c.json({ task }, 201);
});

api.patch('/tasks/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return error(c, 'タスクIDが不正です', 400);
  const body = await readBody(c);
  if (!body) return error(c, 'JSON オブジェクトを指定してください', 400);
  const fieldError = validateFields(body);
  if (fieldError) return error(c, fieldError, 400);
  const task = await updateTask(c.env.DB, id, fieldsFromBody(body));
  return task ? c.json({ task }) : error(c, 'タスクが見つかりません', 404);
});

api.delete('/tasks/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return error(c, 'タスクIDが不正です', 400);
  const deleted = await deleteTask(c.env.DB, id);
  return deleted ? c.json({ ok: true }) : error(c, 'タスクが見つかりません', 404);
});

function knownApiPath(path: string): boolean {
  return path === '/tasks' || path === '/tasks/parse' || /^\/tasks\/[^/]+$/.test(path);
}

// This route is copied to the parent app by app.route(), so unknown /api/* requests
// never fall through to the SPA asset handler.
api.all('*', (c) => {
  const path = relativeApiPath(c.req.path);
  if (knownApiPath(path)) {
    c.header('Allow', path === '/tasks' ? 'GET, POST' : path === '/tasks/parse' ? 'POST' : 'GET, PATCH, DELETE');
    return error(c, 'このAPIメソッドは対応していません', 405);
  }
  return error(c, 'API endpoint が見つかりません', 404);
});

api.notFound((c) => error(c, 'API endpoint が見つかりません', 404));

export default api;
