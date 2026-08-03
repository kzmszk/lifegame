import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../env';
import type { McpAuthProps } from './auth';
import { registerLifegameTools } from './registration';

// McpAgent の Props 型制約 (Record<string, unknown>) を満たすため交差型にする
export type { McpAuthProps, McpScope } from './auth';
export { registerLifegameTools } from './registration';

export class LifegameMcp extends McpAgent<Env, unknown, McpAuthProps> {
  server = new McpServer({ name: 'lifegame', version: '1.0.0' });

  async init(): Promise<void> {
    registerLifegameTools(this.server, this.env.DB, () => this.props, this.env.OAUTH_KV);
  }
}
