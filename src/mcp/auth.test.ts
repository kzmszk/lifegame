import { describe, expect, it } from 'vitest';
import { assertMcpScope, hasMcpScope, type McpAuthProps } from './auth';
import { McpToolError } from './tools';

const props: McpAuthProps = {
  email: 'owner@example.com',
  scopes: ['tasks:read', 'calendar:read'],
};

describe('hasMcpScope', () => {
  it('matches exact task and calendar scopes independently', () => {
    expect(hasMcpScope(props, 'tasks:read')).toBe(true);
    expect(hasMcpScope(props, 'tasks:write')).toBe(false);
    expect(hasMcpScope(props, 'calendar:read')).toBe(true);
    expect(
      hasMcpScope({ ...props, scopes: ['tasks:write'] }, 'calendar:read'),
    ).toBe(false);
  });

  it('treats missing properties and malformed scopes as unauthorized', () => {
    expect(hasMcpScope(undefined, 'tasks:read')).toBe(false);
    expect(
      hasMcpScope(
        { email: props.email, scopes: 'tasks:read' } as unknown as McpAuthProps,
        'tasks:read',
      ),
    ).toBe(false);
  });
});

describe('assertMcpScope', () => {
  it('allows a granted calendar scope', () => {
    expect(() => assertMcpScope(props, 'calendar:read')).not.toThrow();
  });

  it('throws a tool error that names the missing scope', () => {
    expect(() => assertMcpScope(props, 'tasks:write')).toThrow(
      new McpToolError('この操作には tasks:write スコープが必要です'),
    );
    expect(() => assertMcpScope(undefined, 'calendar:read')).toThrow(
      new McpToolError('この操作には calendar:read スコープが必要です'),
    );
  });
});
