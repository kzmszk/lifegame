import type { D1Database } from '@cloudflare/workers-types';
import {
  createTask,
  deleteTask,
  listTasks,
  updateTask,
  type TaskView,
} from '../db/tasks';
import { tokyoDayBounds } from '../lib/time';
import { fieldsFromBody, validateFields } from '../lib/task-validation';
import type { Task, TaskCreateInput } from '../shared/types';

export interface DailySummary {
  date: string;
  open_tasks: Task[];
  overdue_tasks: Task[];
  due_today_tasks: Task[];
  inbox_count: number;
  completed_today_tasks: Task[];
}

export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpToolError('JSON オブジェクトを指定してください');
  }
  return value as Record<string, unknown>;
}

function assertValidFields(input: Record<string, unknown>): void {
  const fieldError = validateFields(input);
  if (fieldError) throw new McpToolError(fieldError);
}

function omitUndefined(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function assertValidId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new McpToolError('タスクIDが不正です');
}

export async function getDailySummary(
  db: D1Database,
  now: Date = new Date(),
): Promise<DailySummary> {
  const bounds = tokyoDayBounds(now);
  const [todayTasks, inboxTasks] = await Promise.all([
    listTasks(db, 'today', bounds.today, bounds.startUtc, bounds.nextStartUtc),
    listTasks(db, 'inbox', bounds.today, bounds.startUtc, bounds.nextStartUtc),
  ]);
  const openTasks = todayTasks.filter((task) => task.status === 'open');
  const completedTodayTasks = todayTasks.filter(
    (task) => task.status === 'done',
  );

  return {
    date: bounds.today,
    open_tasks: openTasks,
    overdue_tasks: openTasks.filter(
      (task) => task.due_date !== null && task.due_date < bounds.today,
    ),
    due_today_tasks: openTasks.filter((task) => task.due_date === bounds.today),
    inbox_count: inboxTasks.length,
    completed_today_tasks: completedTodayTasks,
  };
}

export async function listTasksForMcp(
  db: D1Database,
  view: TaskView = 'today',
  now: Date = new Date(),
): Promise<Task[]> {
  if (view !== 'today' && view !== 'inbox' && view !== 'all') {
    throw new McpToolError('view は today, inbox, all のいずれかです');
  }
  const bounds = tokyoDayBounds(now);
  return listTasks(
    db,
    view,
    bounds.today,
    bounds.startUtc,
    bounds.nextStartUtc,
  );
}

export async function createTaskForMcp(
  db: D1Database,
  input: unknown,
): Promise<Task> {
  const body = omitUndefined(record(input));
  assertValidFields(body);
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    throw new McpToolError('title は必須です');
  }

  const createInput: Required<Pick<TaskCreateInput, 'title'>> &
    Omit<TaskCreateInput, 'title'> = {
    title: body.title.trim(),
    note: typeof body.note === 'string' ? body.note : '',
    due_date: typeof body.due_date === 'string' ? body.due_date : null,
    due_time: typeof body.due_time === 'string' ? body.due_time : null,
    priority: typeof body.priority === 'number' ? body.priority : 0,
    tags: typeof body.tags === 'string' ? body.tags : '',
  };
  return createTask(db, createInput);
}

export async function updateTaskForMcp(
  db: D1Database,
  id: number,
  input: unknown,
): Promise<Task> {
  assertValidId(id);
  const body = omitUndefined(record(input));
  assertValidFields(body);
  // A no-op update would return the task, turning tasks:write into a read.
  if (Object.keys(body).length === 0)
    throw new McpToolError('更新する項目を1つ以上指定してください');
  const task = await updateTask(db, id, fieldsFromBody(body));
  if (!task) throw new McpToolError('タスクが見つかりません');
  return task;
}

export async function deleteTaskForMcp(
  db: D1Database,
  id: number,
): Promise<{ deleted: true; id: number }> {
  assertValidId(id);
  const deleted = await deleteTask(db, id);
  if (!deleted) throw new McpToolError('タスクが見つかりません');
  return { deleted: true, id };
}
