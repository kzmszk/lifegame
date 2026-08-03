import { McpToolError } from './tools';
import type { Env } from '../env';
import { isGrantRevoked } from '../lib/revocation';

export type McpScope = 'tasks:read' | 'tasks:write';
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
// still cannot reach the tasks. Tokens issued before grantId was recorded carry no
// id to check and expire within the hour.
export async function assertGrantActive(
  db: Env['DB'],
  props: McpAuthProps | undefined,
): Promise<void> {
  const grantId = props?.grantId;
  if (typeof grantId !== 'string' || !props?.email) return;
  if (await isGrantRevoked(db, props.email, grantId)) {
    throw new McpToolError('この接続は切断されています。再接続してください');
  }
}
