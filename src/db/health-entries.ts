import type { D1Database } from '@cloudflare/workers-types';
import { validDate } from '../lib/task-validation';

export const DEFAULT_HEALTH_ENTRY_LIST_LIMIT = 50;
export const MAX_HEALTH_ENTRY_LIST_LIMIT = 100;

export class HealthEntryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealthEntryValidationError';
  }
}

export class HealthEntryConstraintError extends HealthEntryValidationError {
  constructor(message = '健康記録の内容が不正です') {
    super(message);
    this.name = 'HealthEntryConstraintError';
  }
}

export interface WeightMeasurement {
  id: number;
  kind: 'weight';
  occurred_on: string;
  weight_kg: number;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface ExerciseSession {
  id: number;
  kind: 'exercise';
  occurred_on: string;
  activity: string;
  duration_minutes: number | null;
  note: string;
  created_at: string;
  updated_at: string;
}

export type HealthEntry = WeightMeasurement | ExerciseSession;

export interface WeightMeasurementInput {
  kind: 'weight';
  occurred_on: string;
  weight_kg: number;
  note?: string;
}

export interface ExerciseSessionInput {
  kind: 'exercise';
  occurred_on: string;
  activity: string;
  duration_minutes?: number | null;
  note?: string;
}

export type HealthEntryInput = WeightMeasurementInput | ExerciseSessionInput;
export type HealthEntryCreateInput = HealthEntryInput;

export interface WeightMeasurementUpdateInput {
  kind: 'weight';
  occurred_on?: string;
  weight_kg?: number;
  note?: string;
}

export interface ExerciseSessionUpdateInput {
  kind: 'exercise';
  occurred_on?: string;
  activity?: string;
  duration_minutes?: number | null;
  note?: string;
}

export type HealthEntryUpdateInput =
  | WeightMeasurementUpdateInput
  | ExerciseSessionUpdateInput;

export interface HealthEntryListOptions {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface HealthEntryListPage {
  entries: HealthEntry[];
  truncated: boolean;
  next_offset: number | null;
}

interface HealthEntryRow {
  id: number;
  kind: 'weight' | 'exercise';
  occurred_on: string;
  weight_kg: number | null;
  activity: string | null;
  duration_minutes: number | null;
  note: string;
  created_at: string;
  updated_at: string;
}

const HEALTH_ENTRY_COLUMNS = `id, kind, occurred_on, weight_kg, activity,
  duration_minutes, note, created_at, updated_at`;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new HealthEntryValidationError(message);
}

function assertOccurrenceDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !validDate(value))
    invalid('occurred_on は YYYY-MM-DD 形式で指定してください');
}

function assertNote(value: unknown): asserts value is string {
  if (typeof value !== 'string') invalid('note は文字列で指定してください');
}

function assertWeight(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    invalid('weight_kg は 0 より大きい有限数で指定してください');
  }
}

function assertDuration(value: unknown): asserts value is number | null {
  if (value === null) return;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1440
  ) {
    invalid('duration_minutes は 1 以上 1440 以下の整数で指定してください');
  }
}

function assertActivity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '')
    invalid('activity は空にできません');
}

interface NormalizedCreateInput {
  kind: 'weight' | 'exercise';
  occurred_on: string;
  weight_kg: number | null;
  activity: string | null;
  duration_minutes: number | null;
  note: string;
}

function normalizeCreateInput(input: unknown): NormalizedCreateInput {
  if (!isRecord(input))
    invalid('健康記録は JSON オブジェクトで指定してください');
  assertOccurrenceDate(input.occurred_on);
  const note = hasOwn(input, 'note') ? input.note : '';
  assertNote(note);

  if (input.kind === 'weight') {
    if (hasOwn(input, 'activity') || hasOwn(input, 'duration_minutes'))
      invalid('体重測定に運動実績の項目は指定できません');
    assertWeight(input.weight_kg);
    return {
      kind: 'weight',
      occurred_on: input.occurred_on,
      weight_kg: input.weight_kg,
      activity: null,
      duration_minutes: null,
      note,
    };
  }

  if (input.kind === 'exercise') {
    if (hasOwn(input, 'weight_kg'))
      invalid('運動実績に体重測定の項目は指定できません');
    assertActivity(input.activity);
    const duration = hasOwn(input, 'duration_minutes')
      ? input.duration_minutes
      : null;
    assertDuration(duration);
    return {
      kind: 'exercise',
      occurred_on: input.occurred_on,
      weight_kg: null,
      activity: input.activity.trim(),
      duration_minutes: duration,
      note,
    };
  }

  invalid('kind は weight または exercise で指定してください');
}

type NormalizedUpdateInput =
  | {
      kind: 'weight';
      occurred_on?: string;
      weight_kg?: number;
      note?: string;
    }
  | {
      kind: 'exercise';
      occurred_on?: string;
      activity?: string;
      duration_minutes?: number | null;
      note?: string;
    };

function normalizeUpdateInput(input: unknown): NormalizedUpdateInput {
  if (!isRecord(input))
    invalid('健康記録は JSON オブジェクトで指定してください');
  if (input.kind !== 'weight' && input.kind !== 'exercise')
    invalid('kind は weight または exercise で指定してください');
  let occurredOn: string | undefined;
  if (hasOwn(input, 'occurred_on')) {
    const value = input.occurred_on;
    assertOccurrenceDate(value);
    occurredOn = value;
  }
  let note: string | undefined;
  if (hasOwn(input, 'note')) {
    const value = input.note;
    assertNote(value);
    note = value;
  }

  if (input.kind === 'weight') {
    if (hasOwn(input, 'activity') || hasOwn(input, 'duration_minutes'))
      invalid('体重測定に運動実績の項目は指定できません');
    let weightKg: number | undefined;
    if (hasOwn(input, 'weight_kg')) {
      const value = input.weight_kg;
      assertWeight(value);
      weightKg = value;
    }
    return {
      kind: 'weight',
      ...(occurredOn === undefined ? {} : { occurred_on: occurredOn }),
      ...(weightKg === undefined ? {} : { weight_kg: weightKg }),
      ...(note === undefined ? {} : { note }),
    };
  }

  if (hasOwn(input, 'weight_kg'))
    invalid('運動実績に体重測定の項目は指定できません');
  let activity: string | undefined;
  if (hasOwn(input, 'activity')) {
    const value = input.activity;
    assertActivity(value);
    activity = value.trim();
  }
  let duration: number | null | undefined;
  if (hasOwn(input, 'duration_minutes')) {
    const value = input.duration_minutes;
    assertDuration(value);
    duration = value;
  }
  return {
    kind: 'exercise',
    ...(occurredOn === undefined ? {} : { occurred_on: occurredOn }),
    ...(activity === undefined ? {} : { activity }),
    ...(duration === undefined ? {} : { duration_minutes: duration }),
    ...(note === undefined ? {} : { note }),
  };
}

function isCheckConstraintError(thrown: unknown): boolean {
  return (
    thrown instanceof Error &&
    thrown.message.includes('CHECK constraint failed')
  );
}

function toHealthEntry(row: HealthEntryRow): HealthEntry {
  const common = {
    id: Number(row.id),
    occurred_on: row.occurred_on,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.kind === 'weight' && row.weight_kg !== null) {
    return {
      ...common,
      kind: 'weight',
      weight_kg: Number(row.weight_kg),
    };
  }
  if (row.kind === 'exercise' && row.activity !== null) {
    return {
      ...common,
      kind: 'exercise',
      activity: row.activity,
      duration_minutes:
        row.duration_minutes === null ? null : Number(row.duration_minutes),
    };
  }
  throw new Error('保存された健康記録の内容が不正です');
}

async function getHealthEntry(
  db: D1Database,
  id: number,
): Promise<HealthEntry | null> {
  const row = await db
    .prepare(`SELECT ${HEALTH_ENTRY_COLUMNS} FROM health_entries WHERE id = ?`)
    .bind(id)
    .first<HealthEntryRow>();
  return row ? toHealthEntry(row) : null;
}

function validateListOptions(options: HealthEntryListOptions): {
  from?: string;
  to?: string;
  limit: number;
  offset: number;
} {
  const from = options.from;
  const to = options.to;
  if (from !== undefined) assertOccurrenceDate(from);
  if (to !== undefined) assertOccurrenceDate(to);
  if (from !== undefined && to !== undefined && from > to)
    invalid('from は to 以前の日付で指定してください');

  const limit =
    options.limit === undefined
      ? DEFAULT_HEALTH_ENTRY_LIST_LIMIT
      : options.limit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_HEALTH_ENTRY_LIST_LIMIT
  )
    invalid(
      `limit は 1 以上 ${MAX_HEALTH_ENTRY_LIST_LIMIT} 以下の整数で指定してください`,
    );
  const offset = options.offset === undefined ? 0 : options.offset;
  if (!Number.isSafeInteger(offset) || offset < 0)
    invalid('offset は 0 以上の整数で指定してください');
  return { from, to, limit, offset };
}

export async function listHealthEntries(
  db: D1Database,
  options: HealthEntryListOptions = {},
): Promise<HealthEntryListPage> {
  const { from, to, limit, offset } = validateListOptions(options);
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (from !== undefined) {
    conditions.push('occurred_on >= ?');
    bindings.push(from);
  }
  if (to !== undefined) {
    conditions.push('occurred_on <= ?');
    bindings.push(to);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const result = await db
    .prepare(
      `SELECT ${HEALTH_ENTRY_COLUMNS} FROM health_entries${where}
       ORDER BY occurred_on DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, limit + 1, offset)
    .all<HealthEntryRow>();
  const truncated = result.results.length > limit;
  const rows = truncated ? result.results.slice(0, limit) : result.results;
  return {
    entries: rows.map(toHealthEntry),
    truncated,
    next_offset: truncated ? offset + rows.length : null,
  };
}

export async function createHealthEntry(
  db: D1Database,
  input: HealthEntryInput,
): Promise<HealthEntry> {
  const normalized = normalizeCreateInput(input);
  let result;
  try {
    result = await db
      .prepare(
        `INSERT INTO health_entries
         (kind, occurred_on, weight_kg, activity, duration_minutes, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        normalized.kind,
        normalized.occurred_on,
        normalized.weight_kg,
        normalized.activity,
        normalized.duration_minutes,
        normalized.note,
      )
      .run();
  } catch (thrown) {
    if (isCheckConstraintError(thrown)) throw new HealthEntryConstraintError();
    throw thrown;
  }
  const entry = await getHealthEntry(db, Number(result.meta.last_row_id));
  if (!entry) throw new Error('作成した健康記録を取得できませんでした');
  return entry;
}

export async function updateHealthEntry(
  db: D1Database,
  id: number,
  input: HealthEntryUpdateInput,
): Promise<HealthEntry | null> {
  const normalized = normalizeUpdateInput(input);
  const current = await getHealthEntry(db, id);
  if (!current) return null;
  if (current.kind !== normalized.kind)
    invalid('健康記録の kind は変更できません');

  const updates: string[] = [];
  const bindings: Array<string | number | null> = [];
  if (normalized.occurred_on !== undefined) {
    updates.push('occurred_on = ?');
    bindings.push(normalized.occurred_on);
  }
  if (normalized.note !== undefined) {
    updates.push('note = ?');
    bindings.push(normalized.note);
  }
  if (normalized.kind === 'weight' && normalized.weight_kg !== undefined) {
    updates.push('weight_kg = ?');
    bindings.push(normalized.weight_kg);
  }
  if (normalized.kind === 'exercise') {
    if (normalized.activity !== undefined) {
      updates.push('activity = ?');
      bindings.push(normalized.activity);
    }
    if (normalized.duration_minutes !== undefined) {
      updates.push('duration_minutes = ?');
      bindings.push(normalized.duration_minutes);
    }
  }
  if (updates.length === 0) return current;

  updates.push("updated_at = datetime('now')");
  bindings.push(id);
  let result;
  try {
    result = await db
      .prepare(`UPDATE health_entries SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...bindings)
      .run();
  } catch (thrown) {
    if (isCheckConstraintError(thrown)) throw new HealthEntryConstraintError();
    throw thrown;
  }
  if (!result.success || result.meta.changes === 0) return null;
  return getHealthEntry(db, id);
}

export async function deleteHealthEntry(
  db: D1Database,
  id: number,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM health_entries WHERE id = ?')
    .bind(id)
    .run();
  return result.success && result.meta.changes > 0;
}
