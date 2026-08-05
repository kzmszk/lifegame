import type { D1Database } from '@cloudflare/workers-types';
import type {
  Task,
  TaskCreateInput,
  TaskStatus,
  TaskUpdateInput,
} from '../shared/types';
import {
  assertRepeatableDueDate,
  nextRepeatDate,
  REPEAT_DONE_ON_UPDATE_ERROR,
  RepeatRuleError,
} from '../lib/repeat';
import { tokyoToday } from '../lib/time';

export type TaskView = 'today' | 'inbox' | 'all';

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
  priority: number;
  tags: string;
  repeat_rule: Task['repeat_rule'];
  repeat_child_id: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const TASK_COLUMNS = `id, title, note, status, due_date, due_time, priority, tags,
  repeat_rule, repeat_child_id, created_at, updated_at, completed_at`;

function toTask(row: TaskRow): Task {
  return {
    ...row,
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
): Promise<Task[]> {
  let sql = `SELECT ${TASK_COLUMNS} FROM tasks`;
  let bindings: Array<string> = [];

  if (view === 'today') {
    sql += ` WHERE (status = 'open' AND due_date IS NOT NULL AND due_date <= ?)
      OR (status = 'done' AND completed_at >= ? AND completed_at < ?)`;
    bindings = [today, dayStartUtc, nextDayStartUtc];
    sql += ` ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END,
      CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC,
      CASE WHEN due_time IS NULL THEN 1 ELSE 0 END, due_time ASC,
      priority DESC, created_at DESC`;
  } else if (view === 'inbox') {
    sql += ` WHERE status = 'open' AND due_date IS NULL ORDER BY priority DESC, created_at DESC`;
  } else {
    sql += ` ORDER BY created_at DESC, id DESC`;
  }

  const result = await db
    .prepare(sql)
    .bind(...bindings)
    .all<TaskRow>();
  return result.results.map(toTask);
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
  const result = await db
    .prepare(
      `INSERT INTO tasks
      (title, note, status, due_date, due_time, priority, tags, repeat_rule, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END)`,
    )
    .bind(
      input.title,
      input.note ?? '',
      status,
      input.due_date ?? null,
      input.due_time ?? null,
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
  assertRepeatableDueDate(finalRule, finalDueDate);

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

  if (updates.length === 0) return current;

  const shouldGenerateChild =
    current.status === 'open' &&
    input.status === 'done' &&
    finalRule !== null &&
    finalRule !== undefined &&
    current.repeat_child_id === null;

  // Adding a rule to a row that ends up done reaches the same dead series the
  // create path already refuses: generation only runs on open→done, so this one
  // would never produce a successor. Keyed on the request introducing the rule,
  // so editing a completed recurring parent's other fields stays allowed.
  const finalStatus = input.status ?? current.status;
  if (
    input.repeat_rule !== undefined &&
    input.repeat_rule !== null &&
    finalStatus === 'done' &&
    !shouldGenerateChild
  ) {
    throw new RepeatRuleError(REPEAT_DONE_ON_UPDATE_ERROR);
  }

  if (shouldGenerateChild) {
    if (finalDueDate === null) throw new RepeatRuleError('due_date が必要です');
    const nextDueDate = nextRepeatDate(finalRule, finalDueDate, tokyoToday());
    const sourceUpdate = `${updates.join(', ')}, repeat_child_id = -1,
      updated_at = datetime('now')`;
    const sourceWhere = [
      'id = ?',
      "status = 'open'",
      'repeat_child_id IS NULL',
      ...(input.repeat_rule === undefined ? ['repeat_rule IS ?'] : []),
      ...(input.due_date === undefined ? ['due_date IS ?'] : []),
    ].join(' AND ');
    const sourceBindings: Array<string | number | null> = [
      ...bindings,
      id,
      ...(input.repeat_rule === undefined ? [current.repeat_rule] : []),
      ...(input.due_date === undefined ? [current.due_date] : []),
    ];
    const statements = [
      db
        .prepare(
          `UPDATE tasks SET ${sourceUpdate}
          WHERE ${sourceWhere}`,
        )
        .bind(...sourceBindings),
      db
        .prepare(
          `INSERT INTO tasks
          (title, note, status, due_date, due_time, priority, tags, repeat_rule, repeat_child_id, completed_at)
          SELECT title, note, 'open', ?, due_time, priority, tags, repeat_rule, NULL, NULL
          FROM tasks
          WHERE id = ? AND status = 'done' AND repeat_child_id = -1
            AND repeat_rule IS NOT NULL AND due_date IS NOT NULL`,
        )
        .bind(nextDueDate, id),
      db
        .prepare(
          `UPDATE tasks SET repeat_child_id = last_insert_rowid(), updated_at = datetime('now')
          WHERE id = ? AND repeat_child_id = -1`,
        )
        .bind(id),
    ];
    const results = await db.batch(statements);
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

  // The rule-needs-a-due-date invariant was checked against the row read above,
  // and only half of it is in this request. A concurrent PATCH supplying the
  // other half passes its own check against the same pre-race row, so without a
  // guard the later write lands a recurring task with no due_date — which then
  // throws on every attempt to complete it. Guard whichever half we inherited.
  // Narrow to the request that introduces the rule: if the task was already
  // recurring, a concurrent PATCH clearing its due_date is rejected outright by
  // assertRepeatableDueDate, so guarding ordinary edits would only manufacture
  // false conflicts on fields that have nothing to do with the invariant.
  const inheritedDueDate =
    input.repeat_rule !== undefined &&
    input.repeat_rule !== null &&
    input.due_date === undefined;
  const inheritedRule =
    input.due_date === null && input.repeat_rule === undefined;
  const where = [
    'id = ?',
    ...(inheritedDueDate ? ['due_date IS ?'] : []),
    ...(inheritedRule ? ['repeat_rule IS ?'] : []),
  ].join(' AND ');
  if (inheritedDueDate) bindings.push(current.due_date);
  if (inheritedRule) bindings.push(current.repeat_rule);

  const result = await db
    .prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE ${where}`)
    .bind(...bindings)
    .run();
  if (!result.success) return null;
  if (result.meta.changes === 0) {
    const latest = await getTask(db, id);
    if (!latest) return null;
    throw new TaskConflictError();
  }
  return getTask(db, id);
}

export async function deleteTask(db: D1Database, id: number): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM tasks WHERE id = ?')
    .bind(id)
    .run();
  return result.success && result.meta.changes > 0;
}
