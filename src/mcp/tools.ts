import type { D1Database } from '@cloudflare/workers-types';
import {
  createTask,
  deleteTask,
  listTasks,
  TaskConflictError,
  updateTask,
  type TaskView,
} from '../db/tasks';
import { tokyoDayBounds } from '../lib/time';
import { fieldsFromBody, validateFields } from '../lib/task-validation';
import {
  normalizeRepeatRule,
  RepeatRuleError,
  validateScheduleState,
  validateRepeatState,
} from '../lib/repeat';
import { listCalendarEvents, listHolidays } from '../lib/google-calendar';
import type { CalendarEvent, Task, TaskCreateInput } from '../shared/types';
import type { Env } from '../env';

export interface DailySummary {
  date: string;
  open_tasks: Task[];
  overdue_tasks: Task[];
  due_today_tasks: Task[];
  /** Execution schedules are deliberately separate from deadlines. */
  scheduled_overdue_tasks: Task[];
  scheduled_today_tasks: Task[];
  inbox_count: number;
  completed_today_tasks: Task[];
  /**
   * Calendar fields are absent entirely, rather than empty, when the caller has
   * no `calendar:read` grant. An empty array would read as "nothing scheduled",
   * which is the same lie as reporting a free day during an outage.
   */
  events?: CalendarEvent[];
  holidays?: string[];
  /**
   * True when the appointments could not be fetched, so `events` is empty for
   * lack of an answer rather than for lack of entries. Without this the briefing
   * would cheerfully report a free day during an outage. Holidays are fetched
   * separately and are not covered by this flag.
   */
  calendar_unavailable?: boolean;
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
  env: Env,
  now: Date = new Date(),
  // Defaults closed: a caller that has not established a calendar grant gets
  // tasks only, rather than calendar data by omission.
  includeCalendar = false,
): Promise<DailySummary> {
  const db = env.DB;
  const bounds = tokyoDayBounds(now);
  // The calendar is folded in here so a briefing is one tool call, per DESIGN.md
  // section 12. A Google outage must not take the task half of the summary down
  // with it, so the calendar half degrades to empty and says so.
  //
  // The two calendar reads fail independently: holidays are a nicety on a
  // separate subscribed calendar, and losing them must not discard appointments
  // that were fetched successfully.
  const events = !includeCalendar
    ? Promise.resolve(null)
    : listCalendarEvents(env, bounds.today).catch((error: unknown) => {
        console.warn(`ブリーフィングの予定取得に失敗: ${String(error)}`);
        return null;
      });
  const holidays = !includeCalendar
    ? Promise.resolve([])
    : listHolidays(env, bounds.today).catch((error: unknown) => {
        console.warn(`ブリーフィングの祝日取得に失敗: ${String(error)}`);
        return [];
      });

  const [todayTasks, inboxTasks, calendarEvents, holidayNames] =
    await Promise.all([
      listTasks(
        db,
        'today',
        bounds.today,
        bounds.startUtc,
        bounds.nextStartUtc,
      ),
      listTasks(
        db,
        'inbox',
        bounds.today,
        bounds.startUtc,
        bounds.nextStartUtc,
      ),
      events,
      holidays,
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
    scheduled_overdue_tasks: openTasks.filter(
      (task) =>
        task.scheduled_date !== null && task.scheduled_date < bounds.today,
    ),
    scheduled_today_tasks: openTasks.filter(
      (task) => task.scheduled_date === bounds.today,
    ),
    inbox_count: inboxTasks.length,
    completed_today_tasks: completedTodayTasks,
    ...(includeCalendar
      ? {
          events: calendarEvents ?? [],
          holidays: holidayNames,
          calendar_unavailable: calendarEvents === null,
        }
      : {}),
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
    scheduled_date:
      typeof body.scheduled_date === 'string' ? body.scheduled_date : null,
    scheduled_time:
      typeof body.scheduled_time === 'string' ? body.scheduled_time : null,
    priority: typeof body.priority === 'number' ? body.priority : 0,
    tags: typeof body.tags === 'string' ? body.tags : '',
    repeat_rule: normalizeRepeatRule(body.repeat_rule) ?? null,
  };
  const scheduleError = validateScheduleState(
    createInput.scheduled_date ?? null,
    createInput.scheduled_time ?? null,
  );
  if (scheduleError) throw new McpToolError(scheduleError);
  const repeatError = validateRepeatState(
    createInput.repeat_rule ?? null,
    typeof body.status === 'string' && body.status === 'done' ? 'done' : 'open',
    createInput.scheduled_date ?? null,
    createInput.due_date ?? null,
    createInput.due_time ?? null,
  );
  if (repeatError) throw new McpToolError(repeatError);
  try {
    return await createTask(db, createInput);
  } catch (thrown) {
    if (thrown instanceof TaskConflictError)
      throw new McpToolError(thrown.message);
    throw thrown;
  }
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
  let task: Task | null;
  try {
    task = await updateTask(db, id, fieldsFromBody(body));
  } catch (thrown) {
    if (thrown instanceof RepeatRuleError)
      throw new McpToolError(thrown.message);
    if (thrown instanceof TaskConflictError)
      throw new McpToolError(thrown.message);
    throw thrown;
  }
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
