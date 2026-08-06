import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  deleteTask,
  getTask,
  listTasks,
  TaskConflictError,
  updateTask,
} from './tasks';

interface TaskSeed {
  title?: string;
  note?: string;
  status?: 'open' | 'done';
  due_date?: string | null;
  due_time?: string | null;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  priority?: number;
  tags?: string;
  repeat_rule?: string | null;
}

async function seedTask(overrides: TaskSeed = {}): Promise<number> {
  const task = {
    title: '定期タスク',
    note: 'メモ',
    status: 'open' as const,
    due_date: null,
    due_time: null,
    scheduled_date: '2099-01-01',
    scheduled_time: '09:30',
    priority: 1,
    tags: '仕事',
    repeat_rule: 'daily' as string | null,
    ...overrides,
  };
  const result = await env.DB.prepare(
    `INSERT INTO tasks
      (title, note, status, due_date, due_time, scheduled_date, scheduled_time,
       priority, tags, repeat_rule)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      task.title,
      task.note,
      task.status,
      task.due_date,
      task.due_time,
      task.scheduled_date,
      task.scheduled_time,
      task.priority,
      task.tags,
      task.repeat_rule,
    )
    .run();
  return Number(result.meta.last_row_id);
}

async function taskCount(): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM tasks',
  ).first<{
    count: number;
  }>();
  return Number(result?.count ?? 0);
}

describe('recurring task persistence', () => {
  it('spawns exactly one open child when a recurring task is completed', async () => {
    const id = await seedTask();

    const task = await updateTask(env.DB, id, { status: 'done' });
    const child = await getTask(env.DB, id + 1);

    expect(task).toMatchObject({
      id,
      status: 'done',
      repeat_rule: null,
      repeat_child_id: id + 1,
    });
    expect(child).toMatchObject({
      id: id + 1,
      title: '定期タスク',
      note: 'メモ',
      status: 'open',
      due_date: null,
      due_time: null,
      scheduled_date: '2099-01-02',
      scheduled_time: '09:30',
      priority: 1,
      tags: '仕事',
      repeat_rule: 'daily',
      repeat_child_id: null,
      completed_at: null,
    });
    expect(await taskCount()).toBe(2);
  });

  it('does not spawn a second child after reopening and completing the parent', async () => {
    const id = await seedTask();

    await updateTask(env.DB, id, { status: 'done' });
    await updateTask(env.DB, id, { status: 'open' });
    const completedAgain = await updateTask(env.DB, id, { status: 'done' });
    const parent = await getTask(env.DB, id);

    expect(await taskCount()).toBe(2);
    expect(parent?.repeat_rule).toBeNull();
    expect(completedAgain?.repeat_child_id).toBe(id + 1);
  });

  it('treats a duplicate completion as idempotent', async () => {
    const id = await seedTask();

    await updateTask(env.DB, id, { status: 'done' });
    const completedAgain = await updateTask(env.DB, id, { status: 'done' });

    expect(await taskCount()).toBe(2);
    expect(completedAgain).toMatchObject({
      id,
      status: 'done',
      repeat_rule: null,
      repeat_child_id: id + 1,
    });
  });

  it('allows replacing repeat_rule while completing the task', async () => {
    const id = await seedTask();

    const task = await updateTask(env.DB, id, {
      repeat_rule: 'weekly:1',
      status: 'done',
    });
    const child = await getTask(env.DB, id + 1);

    expect(task).toMatchObject({
      status: 'done',
      repeat_rule: null,
      repeat_child_id: id + 1,
    });
    expect(child).toMatchObject({
      repeat_rule: 'weekly:1',
      status: 'open',
    });
  });

  it('returns the winner when two completions race', async () => {
    const id = await seedTask();

    const results = await Promise.allSettled([
      updateTask(env.DB, id, { status: 'done' }),
      updateTask(env.DB, id, { status: 'done' }),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(
      results.map((result) =>
        result.status === 'fulfilled' ? result.value?.status : null,
      ),
    ).toEqual(['done', 'done']);
    expect(await taskCount()).toBe(2);
  });

  it('maps a real D1 CHECK violation during a completion to TaskConflictError', async () => {
    const id = await seedTask();
    await env.DB.prepare(
      `CREATE TRIGGER reject_task_completion
       BEFORE UPDATE OF status ON tasks
       WHEN NEW.status = 'done'
       BEGIN
         SELECT RAISE(ABORT, 'CHECK constraint failed: tasks');
       END`,
    ).run();

    await expect(updateTask(env.DB, id, { status: 'done' })).rejects.toThrow(
      TaskConflictError,
    );
  });

  it('keeps the next recurring task when its completed parent is deleted', async () => {
    const parentId = await seedTask({
      status: 'done',
      repeat_rule: null,
    });
    const childId = await seedTask({
      scheduled_date: '2099-01-02',
      repeat_rule: 'daily',
    });
    await env.DB.prepare('UPDATE tasks SET repeat_child_id = ? WHERE id = ?')
      .bind(childId, parentId)
      .run();

    expect(await deleteTask(env.DB, parentId)).toBe(true);
    expect(await taskCount()).toBe(1);
    expect(await getTask(env.DB, childId)).toMatchObject({
      id: childId,
      status: 'open',
      repeat_rule: 'daily',
      repeat_child_id: null,
      scheduled_date: '2099-01-02',
    });
  });
});

describe('task ordering on real D1', () => {
  it('uses the earliest non-null time when deadline and schedule share a date', async () => {
    await seedTask({
      title: 'deadline later',
      due_date: '2099-01-01',
      due_time: '20:00',
      scheduled_date: '2099-01-01',
      scheduled_time: '09:00',
      repeat_rule: null,
    });
    await seedTask({
      title: 'scheduled without deadline time',
      due_date: '2099-01-01',
      due_time: null,
      scheduled_date: '2099-01-01',
      scheduled_time: '10:00',
      repeat_rule: null,
    });

    const tasks = await listTasks(
      env.DB,
      'today',
      '2099-01-01',
      '2099-01-01 00:00:00',
      '2099-01-02 00:00:00',
    );

    expect(tasks.map((task) => task.title)).toEqual([
      'deadline later',
      'scheduled without deadline time',
    ]);
  });
});
