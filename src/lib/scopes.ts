// The scope vocabulary lives here rather than next to either consumer, so the set
// that /authorize advertises and the string /sync enforces cannot drift apart in a
// rename: both sides import the same constant.

// The companion's scope. Nothing else consults it.
export const HEALTH_SYNC_SCOPE = 'health:write';

// Reading health entries back out is a separate scope from writing them, because
// the two have opposite blast radii and opposite holders: the companion writes
// and never reads, an MCP client reads and never writes. Granting one must not
// imply the other.
export const HEALTH_READ_SCOPE = 'health:read';

// calendar:read is separate from tasks:read because Google Calendar is a
// different data source with a different owner. Grants issued before it existed
// carry only the task scopes, so they keep seeing tasks only until reconnected.
export const SUPPORTED_SCOPES = [
  'tasks:read',
  'tasks:write',
  'calendar:read',
  HEALTH_SYNC_SCOPE,
  HEALTH_READ_SCOPE,
] as const;

export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

// What an omitted `scope` parameter means. This is not the whole supported set:
// the MCP clients that omit scope were written before the health scopes existed,
// and widening what their next reauthorization silently grants is the wrong
// default. A client that wants to touch health records has to name the scope.
export const DEFAULT_SCOPES: readonly SupportedScope[] = [
  'tasks:read',
  'tasks:write',
  'calendar:read',
];
