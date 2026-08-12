import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerLifegameTools } from './registration';
import type { Env } from '../env';

// The MCP tools only reach for DB here; the calendar half of get_daily_summary
// has no credentials in these fakes and degrades on its own.
function envFor(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

// Revocation is looked up in D1 alongside the task queries, so the fakes below
// answer both. `first()` returning null is what "this grant is still live" looks like.

function liveDb() {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true, meta: { changes: 0 } }),
      }),
    }),
  } as unknown as D1Database;
}

describe('MCP tool registration', () => {
  it('keeps saved links out of the published tools, and health data out of the task ones', () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerLifegameTools(server, envFor(liveDb()), () => ({
      email: 'owner@example.com',
      scopes: ['tasks:read', 'tasks:write'],
    }));

    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            description?: string;
            inputSchema?: z.ZodType;
          }
        >;
      }
    )._registeredTools;

    expect(Object.keys(registeredTools).sort()).toEqual([
      'create_task',
      'delete_task',
      'get_daily_summary',
      'list_health_entries',
      'list_tasks',
      'update_task',
    ]);

    // Saved links have no tool at all, so no description may advertise one.
    // Health entries now have exactly one, which is why the health vocabulary is
    // checked per tool below rather than banned outright: a task tool that grew
    // a weight field would otherwise hide behind list_health_entries' allowance.
    for (const [name, tool] of Object.entries(registeredTools)) {
      expect(tool.description ?? '').not.toMatch(
        /保存リンク|読むリスト|saved[_-]links?/i,
      );
      if (name === 'list_health_entries') continue;
      expect(tool.description ?? '').not.toMatch(
        /健康|体重|運動|weight_kg|occurred_on/i,
      );
    }

    const createInput = registeredTools.create_task.inputSchema!.safeParse({
      title: 'タスク',
      occurred_on: '2026-08-07',
      weight_kg: 68.4,
      url: 'https://example.com',
    });
    expect(createInput.success).toBe(true);
    expect(createInput.data).toEqual({ title: 'タスク' });

    const updateInput = registeredTools.update_task.inputSchema!.safeParse({
      id: 1,
      occurred_on: '2026-08-07',
      activity: '散歩',
      archived: true,
    });
    expect(updateInput.success).toBe(true);
    expect(updateInput.data).toEqual({ id: 1 });
  });

  it('publishes read/write/destructive annotations and returns tool errors for missing scopes', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    const props = { email: 'owner@example.com', scopes: ['tasks:read'] };
    registerLifegameTools(server, envFor(liveDb()), () => props);

    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            annotations?: Record<string, unknown>;
            inputSchema?: z.ZodType;
            handler: (input: unknown) => Promise<unknown>;
          }
        >;
      }
    )._registeredTools;

    expect(registeredTools.get_daily_summary.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(registeredTools.list_tasks.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(registeredTools.create_task.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(registeredTools.update_task.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(registeredTools.delete_task.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(registeredTools.list_health_entries.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(
      (registeredTools.create_task.inputSchema as z.ZodType).safeParse({
        title: '',
      }).success,
    ).toBe(false);

    const result = await registeredTools.create_task.handler({
      title: '書き込み',
    });
    expect(result).toMatchObject({ isError: true });
    expect(
      (result as { content: Array<{ text: string }> }).content[0].text,
    ).toContain('tasks:write');
  });

  // health:read is its own scope precisely so a task grant cannot read the body
  // measurements back out, and so the companion's write grant cannot either.
  it('gates list_health_entries on health:read alone', async () => {
    const storedRow = {
      id: 3,
      kind: 'exercise',
      occurred_on: '2026-08-10',
      weight_kg: null,
      activity: 'ランニング',
      duration_minutes: 12,
      note: '',
      created_at: '2026-08-10 00:00:00',
      updated_at: '2026-08-10 00:00:00',
    };
    const db = {
      prepare: () => ({
        bind: () => ({
          // The revocation lookup shares this fake; null means the grant is live.
          first: async () => null,
          all: async () => ({ results: [storedRow] }),
        }),
      }),
    } as unknown as D1Database;

    const server = new McpServer({ name: 'test', version: '1.0.0' });
    let scopes = ['tasks:read', 'tasks:write', 'health:write'];
    registerLifegameTools(server, envFor(db), () => ({
      email: 'owner@example.com',
      scopes,
    }));
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools.list_health_entries;

    const refused = (await tool.handler({ limit: 50, offset: 0 })) as {
      isError?: true;
      content: Array<{ text: string }>;
    };
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('health:read');

    scopes = ['health:read'];
    const allowed = (await tool.handler({ limit: 50, offset: 0 })) as {
      isError?: true;
      content: Array<{ text: string }>;
    };
    expect(allowed.isError).toBeUndefined();
    expect(JSON.parse(allowed.content[0].text)).toEqual({
      entries: [
        {
          id: 3,
          kind: 'exercise',
          occurred_on: '2026-08-10',
          activity: 'ランニング',
          duration_minutes: 12,
          note: '',
          created_at: '2026-08-10 00:00:00',
          updated_at: '2026-08-10 00:00:00',
        },
      ],
      truncated: false,
      next_offset: null,
    });
  });

  it('reports a bad date range from list_health_entries as a tool error', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerLifegameTools(server, envFor(liveDb()), () => ({
      email: 'owner@example.com',
      scopes: ['health:read'],
    }));
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools.list_health_entries;

    const result = (await tool.handler({
      from: '2026-08-10',
      to: '2026-08-01',
      limit: 50,
      offset: 0,
    })) as { isError?: true; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('from は to 以前');
  });

  it('returns only update metadata without tasks:read and the full task with both scopes', async () => {
    const storedTask = {
      id: 7,
      title: '秘密のタイトル',
      note: '秘密のメモ',
      status: 'open' as const,
      due_date: '2026-08-03',
      due_time: '09:30',
      scheduled_date: null,
      scheduled_time: null,
      priority: 0,
      tags: '秘密',
      repeat_rule: null,
      repeat_child_id: null,
      created_at: '2026-08-01 00:00:00',
      updated_at: '2026-08-01 00:00:00',
      completed_at: null,
    };
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => storedTask,
        }),
      }),
    } as unknown as D1Database;
    let props = { email: 'owner@example.com', scopes: ['tasks:write'] };
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerLifegameTools(server, envFor(db), () => props);
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;

    const writeOnlyResult = await registeredTools.update_task.handler({
      id: 7,
      priority: 0,
    });
    const writeOnlyPayload = JSON.parse(
      (writeOnlyResult as { content: Array<{ text: string }> }).content[0].text,
    ) as Record<string, unknown>;
    expect(writeOnlyPayload).toEqual({
      updated: true,
      id: 7,
      fields: ['priority'],
    });
    expect(JSON.stringify(writeOnlyPayload)).not.toContain('秘密のタイトル');
    expect(JSON.stringify(writeOnlyPayload)).not.toContain('秘密のメモ');
    expect(JSON.stringify(writeOnlyPayload)).not.toContain('秘密');

    props = {
      email: 'owner@example.com',
      scopes: ['tasks:read', 'tasks:write'],
    };
    const fullResult = await registeredTools.update_task.handler({
      id: 7,
      priority: 0,
    });
    const fullPayload = JSON.parse(
      (fullResult as { content: Array<{ text: string }> }).content[0].text,
    ) as {
      task: typeof storedTask;
    };
    expect(fullPayload.task).toEqual(storedTask);
  });

  it('refuses every tool for a token whose grant was revoked', async () => {
    // Stands in for the token a refresh minted while racing a disconnect: the
    // provider still accepts it, so the tools are where it has to be stopped.
    const revokedDb = {
      prepare: (sql: string) => ({
        bind: (userId: string, grantId: string) => ({
          first: async () =>
            sql.includes('revoked_grants') &&
            userId === 'owner@example.com' &&
            grantId === 'grant-1'
              ? { revoked: 1 }
              : null,
          run: async () => ({ success: true, meta: { changes: 1 } }),
        }),
      }),
    } as unknown as D1Database;
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    const props = {
      email: 'owner@example.com',
      scopes: ['tasks:read', 'tasks:write'],
      grantId: 'grant-1',
    };
    registerLifegameTools(server, envFor(revokedDb), () => props);
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;

    for (const [name, input] of [
      ['get_daily_summary', {}],
      ['list_tasks', { view: 'today' }],
      ['create_task', { title: '追加' }],
      ['update_task', { id: 1, priority: 1 }],
      ['delete_task', { id: 1 }],
    ] as const) {
      const result = await registeredTools[name].handler(input);

      expect(result, name).toMatchObject({ isError: true });
      expect(
        (result as { content: Array<{ text: string }> }).content[0].text,
      ).toContain('切断されています');
    }
  });
});
