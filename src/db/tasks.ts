import type { D1Database } from '@cloudflare/workers-types';
import type {
  TaskListPage,
  Task,
  TaskCreateInput,
  TaskStatus,
  TaskUpdateInput,
} from '../shared/types';
import { DEFAULT_TASK_LIST_LIMIT as DEFAULT_LIST_LIMIT } from '../shared/types';
import {
  assertRepeatState,
  assertScheduleState,
  nextRepeatDate,
} from '../lib/repeat';
import { tokyoToday } from '../lib/time';

export type TaskView = 'today' | 'inbox' | 'all';

export interface TaskListOptions {
  /** `null` is reserved for internal aggregate views that need every row. */
  limit?: number | null;
  offset?: number;
}

export class TaskConflictError extends Error {
  constructor(
    message = 'タスクが別の更新と競合しました。最新の内容を確認してからもう一度お試しください',
  ) {
    super(message);
    this.name = 'TaskConflictError';
  }
}

interface TaskRow {
  id: number;
  title: string;
  note: string;
  status: TaskStatus;
  due_date: string | null;
  due_time: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  priority: number;
  tags: string;
  repeat_rule: Task['repeat_rule'];
  repeat_child_id: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const TASK_COLUMNS = `id, title, note, status, due_date, due_time, scheduled_date, scheduled_time, priority, tags,
  repeat_rule, repeat_child_id, created_at, updated_at, completed_at`;

const ACTIONABLE_DATE = `CASE
  WHEN due_date IS NULL THEN scheduled_date
  WHEN scheduled_date IS NULL THEN due_date
  WHEN due_date <= scheduled_date THEN due_date
  ELSE scheduled_date
END`;

const ACTIONABLE_TIME = `CASE
  WHEN due_date IS NULL THEN scheduled_time
  WHEN scheduled_date IS NULL THEN due_time
  WHEN due_date < scheduled_date THEN due_time
  WHEN scheduled_date < due_date THEN scheduled_time
  WHEN due_time IS NULL THEN scheduled_time
  WHEN scheduled_time IS NULL THEN due_time
  WHEN due_time <= scheduled_time THEN due_time
  ELSE scheduled_time
END`;

function isCheckConstraintError(thrown: unknown): boolean {
  // D1 does not expose a structured constraint-error code, so its message is
  // the only signal available for distinguishing this race from other errors.
  return (
    thrown instanceof Error &&
    thrown.message.includes('CHECK constraint failed')
  );
}

function toTask(row: TaskRow): Task {
  return {
    ...row,
    due_date: row.due_date ?? null,
    due_time: row.due_time ?? null,
    scheduled_date: row.scheduled_date ?? null,
    scheduled_time: row.scheduled_time ?? null,
    status: row.status === 'done' ? 'done' : 'open',
    priority: Number(row.priority) || 0,
    repeat_child_id:
      row.repeat_child_id === null ? null : Number(row.repeat_child_id),
  };
}

export async function listTasks(
  db: D1Database,
  view: TaskView,
  today: string,
  dayStartUtc: string,
  nextDayStartUtc: string,
  options: TaskListOptions = {},
): Promise<TaskListPage> {
  let sql = `SELECT ${TASK_COLUMNS} FROM tasks`;
  const limit =
    options.limit === undefined ? DEFAULT_LIST_LIMIT : options.limit;
  const offset = options.offset ?? 0;
  let bindings: Array<string | number> = [];

  if (view === 'today') {
    sql += ` WHERE (status = 'open' AND (
        (due_date IS NOT NULL AND due_date <= ?)
        OR (scheduled_date IS NOT NULL AND scheduled_date <= ?)
      ))
      OR (status = 'done' AND completed_at >= ? AND completed_at < ?)`;
    bindings = [today, today, dayStartUtc, nextDayStartUtc];
    sql += ` ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END,
      CASE WHEN ${ACTIONABLE_DATE} IS NULL THEN 1 ELSE 0 END, ${ACTIONABLE_DATE} ASC,
      CASE WHEN ${ACTIONABLE_TIME} IS NULL THEN 1 ELSE 0 END, ${ACTIONABLE_TIME} ASC,
      priority DESC, created_at DESC, id DESC`;
  } else if (view === 'inbox') {
    sql += ` WHERE status = 'open' AND due_date IS NULL AND scheduled_date IS NULL
      ORDER BY priority DESC, created_at DESC, id DESC`;
  } else {
    sql += ` ORDER BY created_at DESC, id DESC`;
  }

  if (limit !== null) {
    sql += ' LIMIT ? OFFSET ?';
    bindings.push(limit + 1, offset);
  }

  const result = await db
    .prepare(sql)
    .bind(...bindings)
    .all<TaskRow>();
  const truncated = limit !== null && result.results.length > limit;
  const rows =
    limit !== null && result.results.length > limit
      ? result.results.slice(0, limit)
      : result.results;
  return {
    tasks: rows.map(toTask),
    truncated,
    next_offset: truncated ? offset + rows.length : null,
  };
}

export async function getTask(
  db: D1Database,
  id: number,
): Promise<Task | null> {
  const row = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
    .bind(id)
    .first<TaskRow>();
  return row ? toTask(row) : null;
}

export async function createTask(
  db: D1Database,
  input: Required<Pick<TaskCreateInput, 'title'>> &
    Omit<TaskCreateInput, 'title'>,
): Promise<Task> {
  const status = input.status ?? 'open';
  assertScheduleState(
    input.scheduled_date ?? null,
    input.scheduled_time ?? null,
  );
  assertRepeatState(
    input.repeat_rule ?? null,
    status,
    input.scheduled_date ?? null,
    input.due_date ?? null,
    input.due_time ?? null,
  );
  // No conflict mapping here on purpose. A new row races with nothing, so a
  // constraint failure on insert means validation and the schema disagree —
  // a defect to surface, not something the caller can usefully retry.
  const result = await db
    .prepare(
      `INSERT INTO tasks
      (title, note, status, due_date, due_time, scheduled_date, scheduled_time, priority, tags, repeat_rule, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END)`,
    )
    .bind(
      input.title,
      input.note ?? '',
      status,
      input.due_date ?? null,
      input.due_time ?? null,
      input.scheduled_date ?? null,
      input.scheduled_time ?? null,
      input.priority ?? 0,
      input.tags ?? '',
      input.repeat_rule ?? null,
      status,
    )
    .run();

  const task = await getTask(db, Number(result.meta.last_row_id));
  if (!task) throw new Error('作成したタスクを取得できませんでした');
  return task;
}

export async function updateTask(
  db: D1Database,
  id: number,
  input: TaskUpdateInput,
): Promise<Task | null> {
  const current = await getTask(db, id);
  if (!current) return null;

  const finalRule =
    input.repeat_rule !== undefined ? input.repeat_rule : current.repeat_rule;
  const finalDueDate =
    input.due_date !== undefined ? input.due_date : current.due_date;
  const finalDueTime =
    input.due_time !== undefined ? input.due_time : current.due_time;
  const finalScheduledDate =
    input.scheduled_date !== undefined
      ? input.scheduled_date
      : current.scheduled_date;
  const finalScheduledTime =
    input.scheduled_time !== undefined
      ? input.scheduled_time
      : current.scheduled_time;
  const finalStatus = input.status ?? current.status;

  const updates: string[] = [];
  const bindings: Array<string | number | null> = [];

  if (input.title !== undefined) {
    updates.push('title = ?');
    bindings.push(input.title);
  }
  if (input.note !== undefined) {
    updates.push('note = ?');
    bindings.push(input.note);
  }
  if (input.due_date !== undefined) {
    updates.push('due_date = ?');
    bindings.push(input.due_date);
  }
  if (input.due_time !== undefined) {
    updates.push('due_time = ?');
    bindings.push(input.due_time);
  }
  if (input.scheduled_date !== undefined) {
    updates.push('scheduled_date = ?');
    bindings.push(input.scheduled_date);
  }
  if (input.scheduled_time !== undefined) {
    updates.push('scheduled_time = ?');
    bindings.push(input.scheduled_time);
  }
  if (input.priority !== undefined) {
    updates.push('priority = ?');
    bindings.push(input.priority);
  }
  if (input.tags !== undefined) {
    updates.push('tags = ?');
    bindings.push(input.tags);
  }
  if (input.repeat_rule !== undefined) {
    updates.push('repeat_rule = ?');
    bindings.push(input.repeat_rule);
  }
  if (input.status !== undefined) {
    updates.push('status = ?');
    bindings.push(input.status);
    // Keep status and completed_at coupled in the same UPDATE statement.
    updates.push(
      "completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END",
    );
    bindings.push(input.status);
  }

  const shouldGenerateChild =
    current.status === 'open' &&
    input.status === 'done' &&
    finalRule !== null &&
    finalRule !== undefined &&
    finalScheduledDate !== null;

  // Validate the state that will actually be stored. A completion hands its
  // rule to the child, so the row this request writes ends up without one.
  assertScheduleState(finalScheduledDate, finalScheduledTime);
  assertRepeatState(
    shouldGenerateChild ? null : finalRule,
    finalStatus,
    finalScheduledDate,
    finalDueDate,
    finalDueTime,
  );

  if (updates.length === 0) return current;

  if (shouldGenerateChild) {
    const nextScheduledDate = nextRepeatDate(
      finalRule,
      finalScheduledDate,
      tokyoToday(),
    );
    const sourceUpdate = `${updates.join(', ')}, repeat_rule = NULL,
      repeat_child_id = -1, updated_at = datetime('now')`;
    const sourceBindings: Array<string | number | null> = [
      ...bindings,
      id,
      current.repeat_rule,
      current.scheduled_date,
    ];
    const statements = [
      db
        .prepare(
          `UPDATE tasks SET ${sourceUpdate}
          WHERE id = ? AND status = 'open' AND repeat_rule IS ? AND scheduled_date IS ?`,
        )
        .bind(...sourceBindings),
      db
        .prepare(
          `INSERT INTO tasks
          (title, note, status, due_date, due_time, scheduled_date, scheduled_time, priority, tags, repeat_rule, repeat_child_id, completed_at)
          SELECT title, note, 'open', NULL, NULL, ?, scheduled_time, priority, tags, ?, NULL, NULL
          FROM tasks
          WHERE id = ? AND repeat_child_id = -1`,
        )
        .bind(nextScheduledDate, finalRule, id),
      db
        .prepare(
          `UPDATE tasks SET repeat_child_id = last_insert_rowid(), updated_at = datetime('now')
          WHERE id = ? AND repeat_child_id = -1`,
        )
        .bind(id),
    ];
    let results;
    try {
      results = await db.batch(statements);
    } catch (thrown) {
      if (isCheckConstraintError(thrown)) throw new TaskConflictError();
      throw thrown;
    }
    if (!results[0]?.success) return null;
    if (results[0].meta.changes === 0) {
      const latest = await getTask(db, id);
      if (!latest) return latest;
      // A double-tapped complete toggle is the same request twice, so reporting
      // the already-done task is honest. A request that also carried edits is
      // not: those fields were never written, and returning success would drop
      // them silently.
      const completionOnly =
        Object.keys(input).length === 1 && input.status === 'done';
      if (latest.status === 'done' && completionOnly) return latest;
      throw new TaskConflictError();
    }
    if (!results[1]?.success || results[1].meta.changes === 0)
      throw new Error('繰り返しタスクの次回生成に失敗しました');
    if (!results[2]?.success || results[2].meta.changes === 0)
      throw new Error('繰り返しタスクの関連付けに失敗しました');
    return getTask(db, id);
  }

  updates.push("updated_at = datetime('now')");
  bindings.push(id);

  // The rule is the one field that can leave this row: completing the task
  // hands it to the child. So a request that writes repeat_rule — turning the
  // recurrence off, or changing it — has to confirm the rule is still here.
  // Otherwise cancelling a recurrence that a concurrent completion already
  // moved reports success against a parent that no longer owns it, while the
  // child keeps repeating. The constraint cannot catch this: nothing invalid
  // is stored, the write just lands on the wrong row.
  const guardsRule = input.repeat_rule !== undefined;
  const where = guardsRule ? 'id = ? AND repeat_rule IS ?' : 'id = ?';
  if (guardsRule) bindings.push(current.repeat_rule);

  let result;
  try {
    result = await db
      .prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE ${where}`)
      .bind(...bindings)
      .run();
  } catch (thrown) {
    if (isCheckConstraintError(thrown)) throw new TaskConflictError();
    throw thrown;
  }
  if (!result.success) return null;
  if (result.meta.changes === 0) {
    const latest = await getTask(db, id);
    if (!latest) return null;
    throw new TaskConflictError();
  }
  return getTask(db, id);
}

export async function deleteTask(db: D1Database, id: number): Promise<boolean> {
  // repeat_child_id is a one-way history/display link from a completed
  // occurrence to the next open occurrence. Deleting the parent removes the
  // link with it; the child owns its repeat_rule and must remain independent so
  // the series can continue. Deletion is intentionally limited to this row.
  const result = await db
    .prepare('DELETE FROM tasks WHERE id = ?')
    .bind(id)
    .run();
  return result.success && result.meta.changes > 0;
}
