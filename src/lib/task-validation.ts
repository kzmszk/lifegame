import type { TaskStatus, TaskUpdateInput } from '../shared/types';

export function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export function nullableText(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!hasOwn(body, key)) return undefined;
  return body[key] === null || typeof body[key] === 'string' ? (body[key] as string | null) : undefined;
}

export function validDate(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return true;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(2000, month - 1, day));
  candidate.setUTCFullYear(year);
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() + 1 === month &&
    candidate.getUTCDate() === day
  );
}

export function validTime(value: string | null | undefined): boolean {
  return value === undefined || value === null || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function validPriority(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && (value === 0 || value === 1));
}

export function parseStatus(value: unknown): TaskStatus | undefined {
  return value === 'open' || value === 'done' ? value : undefined;
}

export function parseId(rawId: string): number | null {
  if (!/^\d+$/.test(rawId)) return null;
  const id = Number(rawId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Keep MCP and HTTP writes on the same validation contract. */
export function validateFields(body: Record<string, unknown>): string | null {
  if (hasOwn(body, 'completed_at')) return 'completed_at はクライアントから指定できません';
  if (hasOwn(body, 'due_date') && body.due_date !== null && typeof body.due_date !== 'string') {
    return 'due_date は YYYY-MM-DD 形式で指定してください';
  }
  if (hasOwn(body, 'due_time') && body.due_time !== null && typeof body.due_time !== 'string') {
    return 'due_time は HH:MM 形式で指定してください';
  }
  if (hasOwn(body, 'title') && (typeof body.title !== 'string' || body.title.trim() === '')) {
    return 'title は空にできません';
  }
  if (hasOwn(body, 'note') && typeof body.note !== 'string') return 'note は文字列で指定してください';
  if (hasOwn(body, 'tags') && typeof body.tags !== 'string') return 'tags は文字列で指定してください';
  if (!validDate(nullableText(body, 'due_date'))) return 'due_date は YYYY-MM-DD 形式で指定してください';
  if (!validTime(nullableText(body, 'due_time'))) return 'due_time は HH:MM 形式で指定してください';
  if (!validPriority(body.priority)) return 'priority は 0 または 1 で指定してください';
  if (hasOwn(body, 'status') && !parseStatus(body.status)) return 'status は open または done で指定してください';
  return null;
}

export function fieldsFromBody(body: Record<string, unknown>): TaskUpdateInput {
  const fields: TaskUpdateInput = {};
  if (hasOwn(body, 'title')) fields.title = String(body.title).trim();
  if (hasOwn(body, 'note')) fields.note = body.note as string;
  if (hasOwn(body, 'due_date')) fields.due_date = body.due_date as string | null;
  if (hasOwn(body, 'due_time')) fields.due_time = body.due_time as string | null;
  if (hasOwn(body, 'priority')) fields.priority = body.priority as number;
  if (hasOwn(body, 'tags')) fields.tags = body.tags as string;
  if (hasOwn(body, 'status')) fields.status = body.status as TaskStatus;
  return fields;
}
