import type { D1Database } from '@cloudflare/workers-types';
import type {
  Task,
  TaskCreateInput,
  TaskStatus,
  TaskUpdateInput,
} from '../shared/types';

export type TaskView = 'today' | 'inbox' | 'all';

interface TaskRow {
  id: number;
  title: string;
  note: string;
  status: TaskStatus;
  due_date: string | null;
  due_time: string | null;
  priority: number;
  tags: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const TASK_COLUMNS = `id, title, note, status, due_date, due_time, priority, tags,
  created_at, updated_at, completed_at`;

function toTask(row: TaskRow): Task {
  return {
    ...row,
    status: row.status === 'done' ? 'done' : 'open',
    priority: Number(row.priority) || 0,
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
      (title, note, status, due_date, due_time, priority, tags, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END)`,
    )
    .bind(
      input.title,
      input.note ?? '',
      status,
      input.due_date ?? null,
      input.due_time ?? null,
      input.priority ?? 0,
      input.tags ?? '',
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
  if (input.status !== undefined) {
    updates.push('status = ?');
    bindings.push(input.status);
    // Keep status and completed_at coupled in the same UPDATE statement.
    updates.push(
      "completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END",
    );
    bindings.push(input.status);
  }

  if (updates.length === 0) return getTask(db, id);
  updates.push("updated_at = datetime('now')");
  bindings.push(id);

  const result = await db
    .prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...bindings)
    .run();
  if (!result.success || result.meta.changes === 0) return null;
  return getTask(db, id);
}

export async function deleteTask(db: D1Database, id: number): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM tasks WHERE id = ?')
    .bind(id)
    .run();
  return result.success && result.meta.changes > 0;
}
