import { McpToolError } from './tools';
import type { Env } from '../env';
import { isGrantActiveForProps } from '../lib/revocation';

export type McpScope = 'tasks:read' | 'tasks:write' | 'calendar:read';
export type McpAuthProps = { email: string; scopes: string[] } & Record<
  string,
  unknown
>;

export function hasMcpScope(
  props: McpAuthProps | undefined,
  requiredScope: McpScope,
): boolean {
  return Array.isArray(props?.scopes) && props.scopes.includes(requiredScope);
}

export function assertMcpScope(
  props: McpAuthProps | undefined,
  requiredScope: McpScope,
): void {
  if (!hasMcpScope(props, requiredScope)) {
    throw new McpToolError(`この操作には ${requiredScope} スコープが必要です`);
  }
}

// Revocation cannot be serialized with the provider's own token write, so a token
// minted by a refresh that raced a disconnect can outlive the grant. Checking the
// marker here is what makes disconnecting effective: whatever survives that race
// still cannot reach the tasks. The rule itself is shared with POST /sync so the
// two cannot drift; only the way a refusal is reported differs.
export async function assertGrantActive(
  db: Env['DB'],
  props: McpAuthProps | undefined,
): Promise<void> {
  if (!(await isGrantActiveForProps(db, props))) {
    throw new McpToolError('この接続は切断されています。再接続してください');
  }
}
