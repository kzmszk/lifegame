import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../env';
import {
  createTaskForMcp,
  deleteTaskForMcp,
  getDailySummary,
  listTasksForMcp,
  McpToolError,
  updateTaskForMcp,
} from './tools';

// McpAgent の Props 型制約 (Record<string, unknown>) を満たすため交差型にする
export type McpAuthProps = { email: string } & Record<string, unknown>;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式で指定してください')
  .nullable()
  .optional();
const timeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'HH:MM 形式で指定してください')
  .nullable()
  .optional();
const prioritySchema = z.union([z.literal(0), z.literal(1)]).optional();

const createTaskSchema = {
  title: z.string().min(1).describe('タスク名'),
  due_date: dateSchema.describe('期限。YYYY-MM-DD。指定しない場合はnullまたは省略'),
  due_time: timeSchema.describe('期限時刻。HH:MM。指定しない場合はnullまたは省略'),
  priority: prioritySchema.describe('優先度。0は通常、1は高'),
  tags: z.string().optional().describe('カンマ区切りのタグ'),
  note: z.string().optional().describe('補足メモ'),
};

const updateTaskSchema = {
  id: z.number().int().positive().describe('タスクID'),
  title: z.string().min(1).optional().describe('新しいタスク名'),
  due_date: dateSchema.describe('新しい期限。nullで期限なし'),
  due_time: timeSchema.describe('新しい期限時刻。nullで時刻なし'),
  priority: prioritySchema.describe('優先度。0は通常、1は高'),
  tags: z.string().optional().describe('新しいカンマ区切りタグ'),
  note: z.string().optional().describe('新しい補足メモ'),
  status: z.enum(['open', 'done']).optional().describe('openまたはdone。completed_atも連動して更新'),
};

function jsonToolResult(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorToolResult(error: unknown): { isError: true; content: [{ type: 'text'; text: string }] } {
  const message = error instanceof McpToolError || error instanceof Error ? error.message : 'ツール実行に失敗しました';
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export class LifegameMcp extends McpAgent<Env, unknown, McpAuthProps> {
  server = new McpServer({ name: 'lifegame', version: '1.0.0' });

  async init(): Promise<void> {
    this.server.tool(
      'get_daily_summary',
      'JSTの今日について、期限が今日以前の未完了タスク、期限切れ、今日の期限、Inbox件数、今日完了したタスクを朝のブリーフィング向けにまとめて返します。',
      {},
      async () => {
        try {
          return jsonToolResult(await getDailySummary(this.env.DB));
        } catch (error) {
          return errorToolResult(error);
        }
      },
    );

    this.server.tool(
      'list_tasks',
      '既存のGET /api/tasksと同じ意味で、today・inbox・allのいずれかのタスク一覧を返します。todayの日付境界はサーバー側のJSTで決まります。',
      { view: z.enum(['today', 'inbox', 'all']).default('today').describe('表示。既定値はtoday') },
      async ({ view }) => {
        try {
          return jsonToolResult({ tasks: await listTasksForMcp(this.env.DB, view) });
        } catch (error) {
          return errorToolResult(error);
        }
      },
    );

    this.server.tool(
      'create_task',
      '構造化された入力からタスクを1件作成します。自然言語の解釈や日付の推測はクライアント側で行い、サーバーは入力形式と実在する日付を検証します。',
      createTaskSchema,
      async (input) => {
        try {
          return jsonToolResult({ task: await createTaskForMcp(this.env.DB, input) });
        } catch (error) {
          return errorToolResult(error);
        }
      },
    );

    this.server.tool(
      'update_task',
      'タスクを1件だけ部分更新します。statusをdone/openにするとcompleted_atも同じ更新で設定/クリアされます。',
      updateTaskSchema,
      async ({ id, ...fields }) => {
        try {
          return jsonToolResult({ task: await updateTaskForMcp(this.env.DB, id, fields) });
        } catch (error) {
          return errorToolResult(error);
        }
      },
    );

    this.server.tool(
      'delete_task',
      '指定したIDのタスクを1件だけ削除します。削除前にクライアント側で確認してください。',
      { id: z.number().int().positive().describe('削除するタスクID') },
      async ({ id }) => {
        try {
          return jsonToolResult(await deleteTaskForMcp(this.env.DB, id));
        } catch (error) {
          return errorToolResult(error);
        }
      },
    );
  }
}
