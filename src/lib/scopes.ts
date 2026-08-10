// The scope vocabulary lives here rather than next to either consumer, so the set
// that /authorize advertises and the string /sync enforces cannot drift apart in a
// rename: both sides import the same constant.

// The companion's scope. Nothing else consults it, and there is deliberately no
// scope for reading health entries back out.
export const HEALTH_SYNC_SCOPE = 'health:write';

// calendar:read is separate from tasks:read because Google Calendar is a
// different data source with a different owner. Grants issued before it existed
// carry only the task scopes, so they keep seeing tasks only until reconnected.
export const SUPPORTED_SCOPES = [
  'tasks:read',
  'tasks:write',
  'calendar:read',
  HEALTH_SYNC_SCOPE,
] as const;

export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

// What an omitted `scope` parameter means. This is not the whole supported set:
// the MCP clients that omit scope were written before health:write existed, and
// widening what their next reauthorization silently grants is the wrong default.
// A client that wants to write health records has to name the scope.
export const DEFAULT_SCOPES: readonly SupportedScope[] = [
  'tasks:read',
  'tasks:write',
  'calendar:read',
];
