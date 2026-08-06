import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { deleteTask, listTasks, TaskConflictError, updateTask } from './tasks';

interface Row {
  id: number;
  title: string;
  note: string;
  status: 'open' | 'done';
  due_date: string | null;
  due_time: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  priority: number;
  tags: string;
  repeat_rule: string | null;
  repeat_child_id: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    title: '定期タスク',
    note: 'メモ',
    status: 'open',
    due_date: null,
    due_time: null,
    scheduled_date: '2099-01-01',
    scheduled_time: '09:30',
    priority: 1,
    tags: '仕事',
    repeat_rule: 'daily',
    repeat_child_id: null,
    created_at: '2098-12-31 00:00:00',
    updated_at: '2098-12-31 00:00:00',
    completed_at: null,
    ...overrides,
  };
}

interface Result {
  success: true;
  results: [];
  meta: { changes: number; last_row_id?: number };
}

class FakeStatement {
  bindings: unknown[] = [];

  constructor(
    readonly database: FakeD1,
    readonly sql: string,
  ) {}

  bind(...bindings: unknown[]): FakeStatement {
    this.bindings = bindings;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const id = this.bindings[0];
    return (
      (this.database.rows.find((candidate) => candidate.id === id) as
        | T
        | undefined) ?? null
    );
  }

  async run(): Promise<Result> {
    if (this.sql.startsWith('DELETE')) {
      const id = Number(this.bindings[0]);
      const index = this.database.rows.findIndex(
        (candidate) => candidate.id === id,
      );
      if (index === -1) return this.database.result(0);
      this.database.rows.splice(index, 1);
      return this.database.result(1);
    }
    if (this.sql.startsWith('UPDATE')) {
      // The id follows the SET bindings.
      const setPart =
        this.sql.match(/UPDATE tasks SET (.+?)\s+WHERE/s)?.[1] ?? '';
      const setBindingCount = (setPart.match(/\?/g) ?? []).length;
      const id = Number(this.bindings[setBindingCount]);
      const target = this.database.rows.find(
        (candidate) => candidate.id === id,
      );
      if (!target) return this.database.result(0);

      this.database.applyUpdate(this, target);
      return this.database.result(1);
    }
    return this.database.result(0);
  }
}

class FakeD1 {
  constructor(
    public readonly rows: Row[],
    private readonly beforeBatch?: () => void,
  ) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<Result[]> {
    this.beforeBatch?.();
    const sourceUpdate = statements[0];
    const setPart =
      sourceUpdate.sql.match(/UPDATE tasks SET (.+?)\s+WHERE/s)?.[1] ?? '';
    const setBindingCount = (setPart.match(/\?/g) ?? []).length;
    const sourceId = Number(sourceUpdate.bindings[setBindingCount]);
    const source = this.rows.find((candidate) => candidate.id === sourceId);
    if (!source || source.status !== 'open') {
      return [this.result(0), this.result(0), this.result(0)];
    }

    let guardIndex = setBindingCount + 1;
    if (
      sourceUpdate.sql.includes('repeat_rule IS ?') &&
      source.repeat_rule !== sourceUpdate.bindings[guardIndex++]
    ) {
      return [this.result(0), this.result(0), this.result(0)];
    }
    if (
      sourceUpdate.sql.includes('scheduled_date IS ?') &&
      source.scheduled_date !== sourceUpdate.bindings[guardIndex]
    ) {
      return [this.result(0), this.result(0), this.result(0)];
    }

    this.applyUpdate(sourceUpdate, source);
    const [nextScheduledDate, nextRule] = statements[1].bindings;
    const childId = Math.max(...this.rows.map((candidate) => candidate.id)) + 1;
    this.rows.push(
      row({
        ...source,
        id: childId,
        status: 'open',
        due_date: null,
        due_time: null,
        scheduled_date: String(nextScheduledDate),
        repeat_rule: String(nextRule),
        repeat_child_id: null,
        completed_at: null,
      }),
    );
    source.repeat_child_id = childId;
    return [this.result(1), this.result(1, childId), this.result(1)];
  }

  applyUpdate(statement: FakeStatement, target: Row): void {
    const updatePart =
      statement.sql.match(/UPDATE tasks SET (.+) WHERE/s)?.[1] ?? '';
    const clauses = updatePart.split(',');
    let bindingIndex = 0;
    for (const clause of clauses) {
      const trimmed = clause.trim();
      if (trimmed.startsWith('updated_at =')) {
        continue;
      }
      if (trimmed.startsWith('repeat_child_id = -1')) {
        target.repeat_child_id = -1;
        continue;
      }
      if (trimmed.startsWith('repeat_rule = NULL')) {
        target.repeat_rule = null;
        continue;
      }
      if (trimmed.startsWith('completed_at = CASE')) {
        target.completed_at =
          statement.bindings[bindingIndex++] === 'done'
            ? '2099-01-01 00:00:00'
            : null;
        continue;
      }
      const field = trimmed.match(/^([a-z_]+) = \?$/)?.[1] as
        | keyof Row
        | undefined;
      if (field) target[field] = statement.bindings[bindingIndex++] as never;
    }
    target.updated_at = '2099-01-01 00:00:00';
  }

  result(changes: number, lastRowId?: number): Result {
    return {
      success: true,
      results: [],
      meta: {
        changes,
        ...(lastRowId === undefined ? {} : { last_row_id: lastRowId }),
      },
    };
  }
}

describe('recurring task persistence', () => {
  it('spawns the next open task when a recurring task is completed', async () => {
    const database = new FakeD1([row()]);
    const task = await updateTask(database as unknown as D1Database, 1, {
      status: 'done',
    });

    expect(task).toMatchObject({
      status: 'done',
      repeat_rule: null,
      repeat_child_id: 2,
    });
    expect(database.rows).toHaveLength(2);
    expect(database.rows[1]).toMatchObject({
      id: 2,
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
  });

  it('does not spawn a second child after reopening and completing the parent', async () => {
    const database = new FakeD1([row()]);
    const db = database as unknown as D1Database;

    await updateTask(db, 1, { status: 'done' });
    await updateTask(db, 1, { status: 'open' });
    const completedAgain = await updateTask(db, 1, { status: 'done' });

    expect(database.rows).toHaveLength(2);
    expect(database.rows[0].repeat_rule).toBeNull();
    expect(completedAgain?.repeat_child_id).toBe(2);
  });

  it('does not spawn a second child when completion is repeated', async () => {
    const database = new FakeD1([row()]);
    const db = database as unknown as D1Database;

    await updateTask(db, 1, { status: 'done' });
    const completedAgain = await updateTask(db, 1, { status: 'done' });

    expect(database.rows).toHaveLength(2);
    expect(database.rows[0].repeat_rule).toBeNull();
    expect(completedAgain?.repeat_child_id).toBe(2);
  });

  it('allows replacing repeat_rule while completing the task', async () => {
    const database = new FakeD1([row()]);

    const task = await updateTask(database as unknown as D1Database, 1, {
      repeat_rule: 'weekly:1',
      status: 'done',
    });

    expect(task).toMatchObject({
      status: 'done',
      repeat_rule: null,
      repeat_child_id: 2,
    });
    expect(database.rows[1]).toMatchObject({
      repeat_rule: 'weekly:1',
      status: 'open',
    });
  });

  it('returns the completed row when a concurrent completion already won', async () => {
    const database = new FakeD1([row()], () => {
      database.rows[0].status = 'done';
      database.rows[0].repeat_rule = null;
      database.rows[0].repeat_child_id = 2;
    });

    const task = await updateTask(database as unknown as D1Database, 1, {
      status: 'done',
    });

    expect(task).toMatchObject({
      id: 1,
      status: 'done',
      repeat_rule: null,
      repeat_child_id: 2,
    });
  });

  it('reports a conflict when the row is still open after the guard fails', async () => {
    const database = new FakeD1([row()], () => {
      database.rows[0].scheduled_date = '2099-01-02';
    });

    await expect(
      updateTask(database as unknown as D1Database, 1, { status: 'done' }),
    ).rejects.toThrow(TaskConflictError);
  });

  it('keeps the next recurring task when its completed parent is deleted', async () => {
    const database = new FakeD1([
      row({
        id: 1,
        status: 'done',
        repeat_rule: null,
        repeat_child_id: 2,
        completed_at: '2099-01-01 10:00:00',
      }),
      row({
        id: 2,
        scheduled_date: '2099-01-02',
        created_at: '2099-01-01 10:00:00',
        updated_at: '2099-01-01 10:00:00',
      }),
    ]);

    const deleted = await deleteTask(database as unknown as D1Database, 1);

    expect(deleted).toBe(true);
    expect(database.rows).toHaveLength(1);
    expect(database.rows[0]).toMatchObject({
      id: 2,
      status: 'open',
      repeat_rule: 'daily',
      repeat_child_id: null,
      scheduled_date: '2099-01-02',
    });
  });
});

describe('today task ordering query', () => {
  it('uses the earliest non-null time when deadline and schedule share a date', async () => {
    let sql = '';
    const database = {
      prepare(statement: string) {
        sql = statement;
        return {
          bind: () => ({ all: async () => ({ results: [] }) }),
        };
      },
    } as unknown as D1Database;

    await listTasks(
      database,
      'today',
      '2026-08-05',
      '2026-08-04 15:00:00',
      '2026-08-05 15:00:00',
    );

    // With matching dates, a deadline at 20:00 and a schedule at 09:00 must
    // order as 09:00; an absent deadline time must likewise not hide 09:00.
    expect(sql).toContain('WHEN due_date < scheduled_date THEN due_time');
    expect(sql).toContain('WHEN scheduled_date < due_date THEN scheduled_time');
    expect(sql).toContain('WHEN due_time IS NULL THEN scheduled_time');
    expect(sql).toContain('WHEN scheduled_time IS NULL THEN due_time');
    expect(sql).toContain('WHEN due_time <= scheduled_time THEN due_time');
    expect(sql).not.toContain('WHEN due_date <= scheduled_date THEN due_time');
  });
});
