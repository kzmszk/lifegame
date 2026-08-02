import { McpToolError } from './tools';

export type McpScope = 'tasks:read' | 'tasks:write';
export type McpAuthProps = { email: string; scopes: string[] } & Record<string, unknown>;

export function hasMcpScope(props: McpAuthProps | undefined, requiredScope: McpScope): boolean {
  return Array.isArray(props?.scopes) && props.scopes.includes(requiredScope);
}

export function assertMcpScope(props: McpAuthProps | undefined, requiredScope: McpScope): void {
  if (!hasMcpScope(props, requiredScope)) {
    throw new McpToolError(`この操作には ${requiredScope} スコープが必要です`);
  }
}
