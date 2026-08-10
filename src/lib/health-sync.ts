import { validDate } from './task-validation';

// The companion sends whatever an incremental Health Connect pull produced, so a
// payload is bounded here rather than at the database. These two numbers are what
// a single POST may carry; a larger pull is the client's job to split.
export const MAX_SYNC_RECORDS = 500;
export const MAX_SYNC_BODY_BYTES = 512 * 1024;

const MAX_EXTERNAL_ID_LENGTH = 256;
const MAX_ACTIVITY_LENGTH = 200;

// An offset is required, `Z` included. Health Connect leaves zoneOffset nullable
// and the companion resolves it against the device zone before sending, because
// only the device knows which zone the measurement was taken in. Accepting a bare
// local time here would make the server guess that, and the guess would be wrong
// for anyone travelling.
const OCCURRED_AT_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

// RFC 3339 section 4.3 gives `-00:00` the meaning "the offset is unknown", which
// is the one thing this endpoint cannot accept: the local calendar day is derived
// from the offset, and an unknown offset cannot produce one. `Z` and `+00:00` both
// state a known zero offset and stay valid.
const UNKNOWN_OFFSET = '-00:00';

// Same code-point test as isSafeRedirectUri in src/oauth.ts, written as a scan
// rather than a regex because a control-character class is exactly what the
// no-control-regex lint refuses.
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 31) || (code >= 127 && code <= 159);
  });
}

export class HealthSyncValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealthSyncValidationError';
  }
}

export interface SyncedHealthRecord {
  kind: 'weight' | 'exercise';
  external_id: string;
  occurred_on: string;
  occurred_at: string;
  weight_kg: number | null;
  activity: string | null;
  duration_minutes: number | null;
}

function invalid(message: string): never {
  throw new HealthSyncValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function label(index: number): string {
  return `records[${index}]`;
}

function parseExternalId(value: unknown, index: number): string {
  if (typeof value !== 'string' || value.trim() === '')
    invalid(`${label(index)}.external_id は空にできません`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_EXTERNAL_ID_LENGTH)
    invalid(
      `${label(index)}.external_id は ${MAX_EXTERNAL_ID_LENGTH} 文字以内で指定してください`,
    );
  return trimmed;
}

/**
 * Returns the local calendar date the measurement belongs to. The offset in the
 * string is what makes this exact: the date part already is the local date, so no
 * server-side zone enters the answer. `occurred_on` stays the listing key that
 * manual entries also use, which is why it is derived rather than sent.
 */
function parseOccurredAt(
  value: unknown,
  index: number,
): {
  occurred_at: string;
  occurred_on: string;
} {
  if (typeof value !== 'string')
    invalid(
      `${label(index)}.occurred_at は ISO 8601 の日時（オフセット付き）で指定してください`,
    );
  const matched = OCCURRED_AT_PATTERN.exec(value);
  if (!matched)
    invalid(
      `${label(index)}.occurred_at はオフセット付きの ISO 8601 日時で指定してください`,
    );
  const [, date, hour, minute, offset] = matched;
  if (!validDate(date!))
    invalid(`${label(index)}.occurred_at の日付が不正です`);
  if (Number(hour) > 23 || Number(minute) > 59)
    invalid(`${label(index)}.occurred_at の時刻が不正です`);
  if (offset === UNKNOWN_OFFSET)
    invalid(
      `${label(index)}.occurred_at のオフセット -00:00 は「不明」の意味なので受け付けません（UTC なら Z か +00:00）`,
    );
  if (!Number.isFinite(Date.parse(value)))
    invalid(`${label(index)}.occurred_at を日時として解釈できません`);
  return { occurred_at: value, occurred_on: date! };
}

function parseWeight(value: unknown, index: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    invalid(
      `${label(index)}.weight_kg は 0 より大きい有限数で指定してください`,
    );
  return value;
}

function parseActivity(value: unknown, index: number): string {
  if (typeof value !== 'string' || value.trim() === '')
    invalid(`${label(index)}.activity は空にできません`);
  const trimmed = value.trim();
  // Truncating here would answer 200, the companion would advance its changes
  // token, and the shortened name would be the only copy left. Refusing keeps the
  // record on the device where the full value still exists.
  if (trimmed.length > MAX_ACTIVITY_LENGTH)
    invalid(
      `${label(index)}.activity は ${MAX_ACTIVITY_LENGTH} 文字以内で指定してください`,
    );
  // SQLite's length() stops at a NUL, so a control character can turn an activity
  // this layer considers non-empty into one the table's CHECK rejects. Naming it
  // here is what makes the 400 say which field is wrong.
  if (hasControlCharacter(trimmed))
    invalid(`${label(index)}.activity に制御文字は含められません`);
  return trimmed;
}

function parseDuration(value: unknown, index: number): number | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1440
  ) {
    invalid(
      `${label(index)}.duration_minutes は 1 以上 1440 以下の整数で指定してください`,
    );
  }
  return value;
}

function normalizeRecord(input: unknown, index: number): SyncedHealthRecord {
  if (!isRecord(input)) invalid(`${label(index)} は JSON オブジェクトです`);
  const external_id = parseExternalId(input.external_id, index);
  const { occurred_at, occurred_on } = parseOccurredAt(
    input.occurred_at,
    index,
  );

  if (input.kind === 'weight') {
    if (hasOwn(input, 'activity') || hasOwn(input, 'duration_minutes'))
      invalid(`${label(index)} の体重測定に運動実績の項目は指定できません`);
    return {
      kind: 'weight',
      external_id,
      occurred_on,
      occurred_at,
      weight_kg: parseWeight(input.weight_kg, index),
      activity: null,
      duration_minutes: null,
    };
  }

  if (input.kind === 'exercise') {
    if (hasOwn(input, 'weight_kg'))
      invalid(`${label(index)} の運動実績に体重測定の項目は指定できません`);
    return {
      kind: 'exercise',
      external_id,
      occurred_on,
      occurred_at,
      weight_kg: null,
      activity: parseActivity(input.activity, index),
      duration_minutes: parseDuration(input.duration_minutes, index),
    };
  }

  // Sleep is read on the device but health_entries has no shape for it, so it is
  // refused by name instead of being dropped silently: a companion that thinks it
  // synced sleep would keep its changes token and never retry.
  invalid(`${label(index)}.kind は weight または exercise で指定してください`);
}

/**
 * Validates one POST /sync body. The payload is a bare array of records; the
 * result is what the database layer can bind directly.
 */
export function normalizeSyncPayload(body: unknown): SyncedHealthRecord[] {
  if (!Array.isArray(body)) invalid('同期する健康記録の配列を指定してください');
  if (body.length > MAX_SYNC_RECORDS)
    invalid(`一度に同期できる健康記録は ${MAX_SYNC_RECORDS} 件までです`);

  const records = body.map(normalizeRecord);
  // Two records sharing an external_id collapse into one row, so accepting both
  // would report a count the database never stored.
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.external_id))
      invalid(`external_id が重複しています: ${record.external_id}`);
    seen.add(record.external_id);
  }
  return records;
}
