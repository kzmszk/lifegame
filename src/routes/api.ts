import { Hono } from 'hono';
import type { Context } from 'hono';
import { createTask, deleteTask, getTask, listTasks, updateTask, type TaskView } from '../db/tasks';
import { parse } from '../lib/parse';
import { getAccessUser, isAccessAuthError } from '../lib/access';
import { tokyoDayBounds } from '../lib/time';
import { fieldsFromBody, parseId, parseStatus, validateFields } from '../lib/task-validation';
import type {
  ErrorResponse,
  TaskCreateInput,
  TaskDraft,
} from '../shared/types';
import type { Env } from '../env';

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

function relativeApiPath(path: string): string {
  return path.startsWith('/api/') ? path.slice('/api'.length) : path;
}

api.use('*', async (c, next) => {
  const user = getAccessUser(c.env, c.req.raw);
  if (isAccessAuthError(user)) return error(c, user.message, user.status);
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
  const task = await updateTask(c.env.DB, id, fieldsFromBody(body));
  return task ? c.json({ task }) : error(c, 'タスクが見つかりません', 404);
});

api.delete('/tasks/:id', async (c) => {
  if (relativeApiPath(c.req.path) === '/tasks/parse') {
    c.header('Allow', 'POST');
    return error(c, 'このAPIメソッドは対応していません', 405);
  }
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
