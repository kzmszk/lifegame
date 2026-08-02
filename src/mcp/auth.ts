import { McpToolError } from './tools';

export type McpScope = 'tasks:read' | 'tasks:write';
export type McpAuthProps = { email: string; scopes: string[] } & Record<string, unknown>;

export function assertMcpScope(props: McpAuthProps | undefined, requiredScope: McpScope): void {
  if (!Array.isArray(props?.scopes) || !props.scopes.includes(requiredScope)) {
    throw new McpToolError(`この操作には ${requiredScope} スコープが必要です`);
  }
}
