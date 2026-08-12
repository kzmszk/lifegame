import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_TASK_LIST_LIMIT, MAX_TASK_LIST_LIMIT } from '../shared/types';
import {
  DEFAULT_HEALTH_ENTRY_LIST_LIMIT,
  MAX_HEALTH_ENTRY_LIST_LIMIT,
} from '../db/health-entries';
import type { McpAuthProps, McpScope } from './auth';
import type { Env } from '../env';
import { assertGrantActive, assertMcpScope, hasMcpScope } from './auth';
import {
  createTaskForMcp,
  deleteTaskForMcp,
  getDailySummary,
  listHealthEntriesForMcp,
  listTasksForMcp,
  McpToolError,
  updateTaskForMcp,
} from './tools';

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
  due_date: dateSchema.describe(
    '期限。YYYY-MM-DD。指定しない場合はnullまたは省略',
  ),
  due_time: timeSchema.describe(
    '期限時刻。HH:MM。指定しない場合はnullまたは省略',
  ),
  scheduled_date: dateSchema.describe(
    '実行予定日。YYYY-MM-DD。繰り返しタスクでは必須で、期限とは併用できません',
  ),
  scheduled_time: timeSchema.describe(
    '実行予定時刻。HH:MM。scheduled_date と組み合わせて指定します',
  ),
  priority: prioritySchema.describe('優先度。0は通常、1は高'),
  tags: z.string().optional().describe('カンマ区切りのタグ'),
  note: z.string().optional().describe('補足メモ'),
  repeat_rule: z
    .string()
    .nullable()
    .optional()
    .describe(
      '繰り返し。daily、weekly:曜日、monthly:日、every:日数。nullで解除',
    ),
};

const updateTaskSchema = {
  id: z.number().int().positive().describe('タスクID'),
  title: z.string().min(1).optional().describe('新しいタスク名'),
  due_date: dateSchema.describe('新しい期限。nullで期限なし'),
  due_time: timeSchema.describe('新しい期限時刻。nullで時刻なし'),
  scheduled_date: dateSchema.describe('新しい実行予定日。nullで予定なし'),
  scheduled_time: timeSchema.describe('新しい実行予定時刻。nullで時刻なし'),
  priority: prioritySchema.describe('優先度。0は通常、1は高'),
  tags: z.string().optional().describe('新しいカンマ区切りタグ'),
  note: z.string().optional().describe('新しい補足メモ'),
  status: z
    .enum(['open', 'done'])
    .optional()
    .describe('openまたはdone。completed_atも連動して更新'),
  repeat_rule: z
    .string()
    .nullable()
    .optional()
    .describe(
      '繰り返し。daily、weekly:曜日、monthly:日、every:日数。nullで解除',
    ),
};

function jsonToolResult(value: unknown): {
  content: [{ type: 'text'; text: string }];
} {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorToolResult(error: unknown): {
  isError: true;
  content: [{ type: 'text'; text: string }];
} {
  const message =
    error instanceof McpToolError || error instanceof Error
      ? error.message
      : 'ツール実行に失敗しました';
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function registerLifegameTools(
  server: McpServer,
  env: Env,
  getProps: () => McpAuthProps | undefined,
): void {
  const db = env.DB;
  // Every tool goes through this: the scope check answers "may this token do it",
  // the revocation check answers "is this connection still supposed to exist".
  async function authorize(
    requiredScope: McpScope,
  ): Promise<McpAuthProps | undefined> {
    const props = getProps();
    assertMcpScope(props, requiredScope);
    await assertGrantActive(db, props);
    return props;
  }

  server.registerTool(
    'get_daily_summary',
    {
      description:
        'JSTの今日について、期限が今日以前または実行予定日が今日以前の未完了タスク、期限と実行予定を分けた期限切れ/今日分、Inbox件数、今日完了したタスクを朝のブリーフィング向けにまとめて返します。calendar:readスコープがある場合はGoogleカレンダーの予定と祝日も含みます。calendar_unavailableがtrueのときは予定を取得できなかったという意味で、予定なしとは異なります。eventsキー自体が無い場合はcalendar:readが許可されていないという意味です。',
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const props = await authorize('tasks:read');
        // Google Calendar is a separate data source, so it needs its own consent.
        // Grants issued before calendar:read existed simply do not carry it.
        return jsonToolResult(
          await getDailySummary(
            env,
            new Date(),
            hasMcpScope(props, 'calendar:read'),
          ),
        );
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    'list_tasks',
    {
      description: `既存のGET /api/tasksと同じ意味で、today・inbox・allのいずれかのタスク一覧を返します。1回の呼び出しは最大${MAX_TASK_LIST_LIMIT}件で、続きがある場合はtruncated=trueとnext_offsetを返します。todayの日付境界はサーバー側のJSTで決まります。`,
      inputSchema: {
        view: z
          .enum(['today', 'inbox', 'all'])
          .default('today')
          .describe('表示。既定値はtoday'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TASK_LIST_LIMIT)
          .default(DEFAULT_TASK_LIST_LIMIT)
          .describe(
            `1回に取得する件数（1〜${MAX_TASK_LIST_LIMIT}。既定値は${DEFAULT_TASK_LIST_LIMIT}）`,
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('取得開始位置。続きはレスポンスのnext_offsetを指定'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ view, limit, offset }) => {
      try {
        await authorize('tasks:read');
        return jsonToolResult(
          await listTasksForMcp(db, view, new Date(), { limit, offset }),
        );
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    'list_health_entries',
    {
      description: `記録済みの体重測定と運動実績を新しい順に返します。fromとtoはoccurred_on（記録が属するローカル日付）に対する境界で、どちらも含みます。1回の呼び出しは最大${MAX_HEALTH_ENTRY_LIST_LIMIT}件で、続きがある場合はtruncated=trueとnext_offsetを返します。返るのは日付単位の粒度で、測定時刻や記録元（手入力か端末からの同期か）は含みません。記録が無い日は行として現れません。運動の記録が無い日は「運動しなかった日」ではなく「記録が残らなかった日」なので、そのつもりで扱ってください。`,
      inputSchema: {
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式で指定してください')
          .optional()
          .describe('この日以降の記録に絞る。YYYY-MM-DD'),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式で指定してください')
          .optional()
          .describe('この日以前の記録に絞る。YYYY-MM-DD'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_HEALTH_ENTRY_LIST_LIMIT)
          .default(DEFAULT_HEALTH_ENTRY_LIST_LIMIT)
          .describe(
            `1回に取得する件数（1〜${MAX_HEALTH_ENTRY_LIST_LIMIT}。既定値は${DEFAULT_HEALTH_ENTRY_LIST_LIMIT}）`,
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('取得開始位置。続きはレスポンスのnext_offsetを指定'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ from, to, limit, offset }) => {
      try {
        await authorize('health:read');
        return jsonToolResult(
          await listHealthEntriesForMcp(db, {
            // Spread rather than pass through: the options type distinguishes an
            // absent bound from an explicit undefined, and only the absent one
            // means "no bound" to the query builder.
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            limit,
            offset,
          }),
        );
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    'create_task',
    {
      description:
        '構造化された入力からタスクを1件作成します。自然言語の解釈や日付の推測はクライアント側で行い、サーバーは入力形式と実在する日付を検証します。',
      inputSchema: createTaskSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        await authorize('tasks:write');
        // The returned task content comes from the caller, unlike update_task's stored row.
        return jsonToolResult({ task: await createTaskForMcp(db, input) });
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    'update_task',
    {
      description:
        'タスクを1件だけ部分更新します。statusをdone/openにするとcompleted_atも同じ更新で設定/クリアされます。',
      inputSchema: updateTaskSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id, ...fields }) => {
      try {
        const props = await authorize('tasks:write');
        const task = await updateTaskForMcp(db, id, fields);
        if (hasMcpScope(props, 'tasks:read')) return jsonToolResult({ task });

        return jsonToolResult({
          updated: true,
          id,
          fields: Object.entries(fields)
            .filter(([, value]) => value !== undefined)
            .map(([field]) => field),
        });
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    'delete_task',
    {
      description:
        '指定したIDのタスクを1件だけ削除します。削除前にクライアント側で確認してください。',
      inputSchema: {
        id: z.number().int().positive().describe('削除するタスクID'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id }) => {
      try {
        await authorize('tasks:write');
        return jsonToolResult(await deleteTaskForMcp(db, id));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );
}
