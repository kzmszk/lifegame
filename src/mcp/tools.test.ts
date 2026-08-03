// These tests cover the pure MCP tool/data boundary. Entrypoint-level OAuth,
// fake KV, and Durable Object flow tests are intentionally deferred because
// the pinned legacy McpAgent runtime requires Cloudflare Durable Object
// primitives that Vitest's Node environment does not provide directly.

import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import {
  createTaskForMcp,
  deleteTaskForMcp,
  getDailySummary,
  listTasksForMcp,
  McpToolError,
  updateTaskForMcp,
} from './tools';
import { assertMcpScope } from './auth';

interface Row {
  id: number;
  title: string;
  note: string;
  status: 'open' | 'done';
  due_date: string | null;
  due_time: string | null;
  priority: number;
  tags: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface FakeResult<T> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id?: number };
}

const row = (overrides: Partial<Row>): Row => ({
  id: 1,
  title: 'タスク',
  note: '',
  status: 'open',
  due_date: null,
  due_time: null,
  priority: 0,
  tags: '',
  created_at: '2026-08-01 00:00:00',
  updated_at: '2026-08-01 00:00:00',
  completed_at: null,
  ...overrides,
});

class FakeStatement {
  private bindings: Array<string | number | null> = [];

  constructor(
    private readonly database: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...bindings: Array<string | number | null>): FakeStatement {
    this.bindings = bindings;
    return this;
  }

  async all<T>(): Promise<FakeResult<T>> {
    let results: Row[];
    if (this.sql.includes("status = 'open' AND due_date IS NULL")) {
      results = this.database.rows.filter(
        (task) => task.status === 'open' && task.due_date === null,
      );
    } else if (
      this.sql.includes(
        "(status = 'open' AND due_date IS NOT NULL AND due_date <= ?)",
      )
    ) {
      const [today, startUtc, nextStartUtc] = this.bindings as [
        string,
        string,
        string,
      ];
      results = this.database.rows.filter(
        (task) =>
          (task.status === 'open' &&
            task.due_date !== null &&
            task.due_date <= today) ||
          (task.status === 'done' &&
            task.completed_at !== null &&
            task.completed_at >= startUtc &&
            task.completed_at < nextStartUtc),
      );
    } else {
      results = [...this.database.rows];
    }
    return { results: results as T[], success: true, meta: { changes: 0 } };
  }

  async first<T>(): Promise<T | null> {
    const id = this.bindings[0];
    const result = this.database.rows.find((task) => task.id === id);
    return (result as T | undefined) ?? null;
  }

  async run(): Promise<FakeResult<unknown>> {
    if (this.sql.startsWith('INSERT')) {
      const [
        title,
        note,
        status,
        dueDate,
        dueTime,
        priority,
        tags,
        completedStatus,
      ] = this.bindings;
      const id = Math.max(0, ...this.database.rows.map((task) => task.id)) + 1;
      this.database.rows.push(
        row({
          id,
          title: String(title),
          note: String(note),
          status: String(status) as Row['status'],
          due_date: dueDate as string | null,
          due_time: dueTime as string | null,
          priority: Number(priority),
          tags: String(tags),
          completed_at:
            completedStatus === 'done' ? '2026-08-03 01:00:00' : null,
        }),
      );
      return this.result({ last_row_id: id, changes: 1 });
    }

    if (this.sql.startsWith('UPDATE')) {
      const updatePart =
        this.sql.match(/UPDATE tasks SET (.+) WHERE id = \?$/)?.[1] ?? '';
      const clauses = updatePart.split(', ');
      const id = this.bindings[this.bindings.length - 1];
      const task = this.database.rows.find((candidate) => candidate.id === id);
      if (!task) return this.result({ changes: 0 });

      let bindingIndex = 0;
      for (const clause of clauses) {
        if (clause.startsWith('updated_at =')) continue;
        if (clause.startsWith('completed_at =')) {
          task.completed_at =
            this.bindings[bindingIndex++] === 'done'
              ? '2026-08-03 01:00:00'
              : null;
          continue;
        }
        const field = clause.match(/^([a-z_]+) = \?$/)?.[1] as
          keyof Row | undefined;
        if (field) task[field] = this.bindings[bindingIndex++] as never;
      }
      task.updated_at = '2026-08-03 01:00:00';
      return this.result({ changes: 1 });
    }

    if (this.sql.startsWith('DELETE')) {
      const id = this.bindings[0];
      const originalLength = this.database.rows.length;
      this.database.rows = this.database.rows.filter((task) => task.id !== id);
      return this.result({
        changes: originalLength - this.database.rows.length,
      });
    }

    return this.result({ changes: 0 });
  }

  private result(meta: {
    changes: number;
    last_row_id?: number;
  }): FakeResult<unknown> {
    return { results: [], success: true, meta };
  }
}

class FakeD1 {
  rows: Row[];

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

describe('MCP tool handlers', () => {
  it('aggregates JST today, overdue, inbox, and completed tasks', async () => {
    const db = new FakeD1([
      row({ id: 1, title: '期限切れ', due_date: '2026-08-02' }),
      row({ id: 2, title: '今日', due_date: '2026-08-03' }),
      row({ id: 3, title: 'Inbox' }),
      row({
        id: 4,
        title: '今日完了',
        status: 'done',
        completed_at: '2026-08-03 01:00:00',
      }),
      row({
        id: 5,
        title: '過去完了',
        status: 'done',
        completed_at: '2026-08-02 14:00:00',
      }),
    ]) as unknown as D1Database;

    const summary = await getDailySummary(
      db,
      new Date('2026-08-03T03:00:00.000Z'),
    );

    expect(summary.date).toBe('2026-08-03');
    expect(summary.open_tasks.map((task) => task.title)).toEqual([
      '期限切れ',
      '今日',
    ]);
    expect(summary.overdue_tasks.map((task) => task.title)).toEqual([
      '期限切れ',
    ]);
    expect(summary.due_today_tasks.map((task) => task.title)).toEqual(['今日']);
    expect(summary.inbox_count).toBe(1);
    expect(summary.completed_today_tasks.map((task) => task.title)).toEqual([
      '今日完了',
    ]);
  });

  it('treats the JST day end as exclusive at 15:00 UTC', async () => {
    const db = new FakeD1([
      row({
        id: 1,
        title: '開始時刻',
        status: 'done',
        completed_at: '2026-08-02 15:00:00',
      }),
      row({
        id: 2,
        title: '開始前',
        status: 'done',
        completed_at: '2026-08-02 14:59:59',
      }),
      row({
        id: 3,
        title: '終了直前',
        status: 'done',
        completed_at: '2026-08-03 14:59:59',
      }),
      row({
        id: 4,
        title: '終了時刻',
        status: 'done',
        completed_at: '2026-08-03 15:00:00',
      }),
    ]) as unknown as D1Database;

    const tasks = await listTasksForMcp(
      db,
      'today',
      new Date('2026-08-03T14:59:59.999Z'),
    );

    expect(tasks.map((task) => task.title)).toEqual(['開始時刻', '終了直前']);
  });

  it('supports every list_tasks view and rejects an invalid view', async () => {
    const db = new FakeD1([
      row({ id: 1, title: '今日', due_date: '2026-08-03' }),
      row({ id: 2, title: 'Inbox' }),
      row({ id: 3, title: 'すべてのみ', due_date: '2026-08-10' }),
    ]) as unknown as D1Database;
    const now = new Date('2026-08-03T03:00:00.000Z');

    expect(
      (await listTasksForMcp(db, 'today', now)).map((task) => task.title),
    ).toEqual(['今日']);
    expect(
      (await listTasksForMcp(db, 'inbox', now)).map((task) => task.title),
    ).toEqual(['Inbox']);
    expect(
      (await listTasksForMcp(db, 'all', now)).map((task) => task.title),
    ).toEqual(['今日', 'Inbox', 'すべてのみ']);
    await expect(listTasksForMcp(db, 'invalid' as never, now)).rejects.toThrow(
      new McpToolError('view は today, inbox, all のいずれかです'),
    );
  });

  it('validates structured creation fields before persistence', async () => {
    const db = new FakeD1([]) as unknown as D1Database;

    await expect(
      createTaskForMcp(db, { title: '不正な日付', due_date: '2026-02-31' }),
    ).rejects.toThrow(
      new McpToolError('due_date は YYYY-MM-DD 形式で指定してください'),
    );
    await expect(
      createTaskForMcp(db, {
        title: '作成',
        due_date: '2026-08-03',
        due_time: '09:30',
        priority: 1,
      }),
    ).resolves.toMatchObject({
      title: '作成',
      due_date: '2026-08-03',
      due_time: '09:30',
      priority: 1,
    });
  });

  it('applies the shared validation contract to every writable field', async () => {
    const db = new FakeD1([]) as unknown as D1Database;
    const invalidCases: Array<[Record<string, unknown>, string]> = [
      [{ title: 'x', due_date: '2026-02-31' }, 'due_date'],
      [{ title: 'x', due_time: '25:00' }, 'due_time'],
      [{ title: ' ' }, 'title'],
      [{ title: 'x', note: 1 }, 'note'],
      [{ title: 'x', tags: 1 }, 'tags'],
      [{ title: 'x', priority: 2 }, 'priority'],
      [{ title: 'x', status: 'paused' }, 'status'],
      [{ title: 'x', completed_at: null }, 'completed_at'],
    ];

    for (const [input, field] of invalidCases) {
      await expect(createTaskForMcp(db, input)).rejects.toThrow(field);
    }
  });

  it('keeps completed_at coupled to status for MCP updates', async () => {
    const database = new FakeD1([row({ id: 1, title: '完了する' })]);
    const db = database as unknown as D1Database;

    const completed = await updateTaskForMcp(db, 1, { status: 'done' });
    expect(completed.status).toBe('done');
    expect(completed.completed_at).not.toBeNull();

    const reopened = await updateTaskForMcp(db, 1, { status: 'open' });
    expect(reopened.status).toBe('open');
    expect(reopened.completed_at).toBeNull();
  });

  it('reports delete and update not-found cases and invalid IDs', async () => {
    const db = new FakeD1([row({ id: 1 })]) as unknown as D1Database;

    await expect(deleteTaskForMcp(db, 1)).resolves.toEqual({
      deleted: true,
      id: 1,
    });
    await expect(deleteTaskForMcp(db, 1)).rejects.toThrow(
      new McpToolError('タスクが見つかりません'),
    );
    await expect(updateTaskForMcp(db, 99, { title: 'なし' })).rejects.toThrow(
      new McpToolError('タスクが見つかりません'),
    );
    await expect(updateTaskForMcp(db, 0, { title: '不正' })).rejects.toThrow(
      new McpToolError('タスクIDが不正です'),
    );
    await expect(
      updateTaskForMcp(db, Number.MAX_SAFE_INTEGER + 1, { title: '不正' }),
    ).rejects.toThrow(new McpToolError('タスクIDが不正です'));
  });

  it('rejects a no-op update so tasks:write cannot be used to read a task', async () => {
    const db = new FakeD1([row({ id: 1 })]) as unknown as D1Database;

    await expect(updateTaskForMcp(db, 1, {})).rejects.toThrow(
      new McpToolError('更新する項目を1つ以上指定してください'),
    );
    await expect(updateTaskForMcp(db, 1, { title: undefined })).rejects.toThrow(
      new McpToolError('更新する項目を1つ以上指定してください'),
    );
  });

  it('rejects completed_at on updates as well as creation', async () => {
    const db = new FakeD1([row({ id: 1 })]) as unknown as D1Database;

    await expect(
      updateTaskForMcp(db, 1, { completed_at: '2026-08-03 00:00:00' }),
    ).rejects.toThrow(
      new McpToolError('completed_at はクライアントから指定できません'),
    );
  });

  it('does not allow a read-scoped token to mutate tasks', () => {
    const readOnlyProps = {
      email: 'owner@example.com',
      scopes: ['tasks:read'],
    };

    expect(() => assertMcpScope(readOnlyProps, 'tasks:read')).not.toThrow();
    expect(() => assertMcpScope(readOnlyProps, 'tasks:write')).toThrow(
      new McpToolError('この操作には tasks:write スコープが必要です'),
    );
    expect(() => assertMcpScope(undefined, 'tasks:read')).toThrow(
      new McpToolError('この操作には tasks:read スコープが必要です'),
    );
  });
});
