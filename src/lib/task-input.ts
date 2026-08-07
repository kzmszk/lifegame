import type { RepeatRule } from './repeat';
import { normalizeRepeatRule } from './repeat';
import { parse } from './parse';
import { hasOwn, parseStatus } from './task-validation';
import type { TaskCreateInput, TaskDraft, TaskStatus } from '../shared/types';

export class TaskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskInputError';
  }
}

export interface NormalizedTaskCreateInput {
  title: string;
  note: string;
  due_date: string | null;
  due_time: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  priority: number;
  tags: string;
  repeat_rule: RepeatRule | null;
  status: TaskStatus;
}

function stringOrNull(
  body: Record<string, unknown>,
  key: keyof NormalizedTaskCreateInput,
): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

function withOverrides(
  body: Record<string, unknown>,
  draft: TaskDraft,
): NormalizedTaskCreateInput {
  return {
    ...draft,
    note: typeof body.note === 'string' ? body.note : draft.note,
    priority:
      body.priority === undefined ? draft.priority : (body.priority as number),
    tags: typeof body.tags === 'string' ? body.tags : draft.tags,
    due_date: hasOwn(body, 'due_date')
      ? stringOrNull(body, 'due_date')
      : draft.due_date,
    due_time: hasOwn(body, 'due_time')
      ? stringOrNull(body, 'due_time')
      : draft.due_time,
    scheduled_date: hasOwn(body, 'scheduled_date')
      ? stringOrNull(body, 'scheduled_date')
      : draft.scheduled_date,
    scheduled_time: hasOwn(body, 'scheduled_time')
      ? stringOrNull(body, 'scheduled_time')
      : draft.scheduled_time,
    repeat_rule: hasOwn(body, 'repeat_rule')
      ? (normalizeRepeatRule(body.repeat_rule) ?? null)
      : draft.repeat_rule,
    status: parseStatus(body.status) ?? 'open',
  };
}

function fromStructuredInput(
  body: Record<string, unknown>,
): NormalizedTaskCreateInput {
  if (typeof body.title !== 'string' || body.title.trim() === '')
    throw new TaskInputError('title は必須です');

  return {
    title: body.title.trim(),
    note: typeof body.note === 'string' ? body.note : '',
    due_date: stringOrNull(body, 'due_date'),
    due_time: stringOrNull(body, 'due_time'),
    scheduled_date: stringOrNull(body, 'scheduled_date'),
    scheduled_time: stringOrNull(body, 'scheduled_time'),
    priority: typeof body.priority === 'number' ? body.priority : 0,
    tags: typeof body.tags === 'string' ? body.tags : '',
    repeat_rule: normalizeRepeatRule(body.repeat_rule) ?? null,
    status: parseStatus(body.status) ?? 'open',
  };
}

/**
 * Apply one creation contract to HTTP and MCP writes.
 *
 * Parsed text is the canonical source for fields it supplies; explicit fields
 * still win so the confirmation/edit form can correct a parser result. The
 * structured path uses the same defaults, including an explicit open status,
 * rather than relying on D1's default. Keeping this policy here prevents the
 * Web and MCP adapters from drifting when a new task field is added.
 */
export function normalizeTaskCreateInput(
  body: Record<string, unknown>,
  now?: Date,
): NormalizedTaskCreateInput {
  if (typeof body.text === 'string') {
    if (body.text.trim() === '')
      throw new TaskInputError('text は空にできません');
    return withOverrides(body, parse(body.text, now));
  }
  return fromStructuredInput(body);
}

export type TaskCreateData = Required<Pick<TaskCreateInput, 'title'>> &
  Omit<TaskCreateInput, 'title'>;
