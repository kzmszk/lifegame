import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerLifegameTools } from './registration';

describe('MCP tool registration', () => {
  it('publishes read/write/destructive annotations and returns tool errors for missing scopes', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    const props = { email: 'owner@example.com', scopes: ['tasks:read'] };
    registerLifegameTools(server, {} as D1Database, () => props);

    const registeredTools = (server as unknown as {
      _registeredTools: Record<string, {
        annotations?: Record<string, unknown>;
        inputSchema?: z.ZodType;
        handler: (input: unknown) => Promise<unknown>;
      }>;
    })._registeredTools;

    expect(registeredTools.get_daily_summary.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(registeredTools.list_tasks.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(registeredTools.create_task.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(registeredTools.update_task.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(registeredTools.delete_task.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect((registeredTools.create_task.inputSchema as z.ZodType).safeParse({ title: '' }).success).toBe(false);

    const result = await registeredTools.create_task.handler({ title: '書き込み' });
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain('tasks:write');
  });
});
