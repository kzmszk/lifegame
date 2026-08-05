export type RepeatRule =
  | 'daily'
  | `weekly:${string}`
  | `monthly:${number}`
  | `every:${number}`;

export const REPEAT_RULE_ERROR =
  'repeat_rule は daily、weekly:曜日、monthly:日、every:日数(1〜366)の形式で指定してください';
export const REPEAT_SCHEDULED_DATE_ERROR =
  '繰り返しタスクには scheduled_date が必要です';
export const REPEAT_DEADLINE_ERROR =
  '繰り返しタスクに due_date / due_time は指定できません';
export const SCHEDULED_TIME_DATE_ERROR =
  'scheduled_time を指定するには scheduled_date が必要です';
/** A done row keeps no rule: completion hands it to the next occurrence. */
export const REPEAT_OPEN_ONLY_ERROR =
  '繰り返しは未完了のタスクにのみ設定できます';

const MAX_REPEAT_YEAR = 9999;
const MAX_ADVANCE_ITERATIONS = 10_000;

export class RepeatRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepeatRuleError';
  }
}

function parseDate(value: string): [number, number, number] | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  candidate.setUTCFullYear(year);
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() + 1 === month &&
    candidate.getUTCDate() === day
    ? [year, month, day]
    : null;
}

function dateValue(year: number, month: number, day: number): Date {
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCFullYear(year);
  return value;
}

function formatDate(value: Date): string {
  const year = value.getUTCFullYear();
  if (!Number.isFinite(year) || year < 0 || year > MAX_REPEAT_YEAR) {
    throw new RepeatRuleError(
      '繰り返しの次回日付が対応範囲(9999年まで)を超えます',
    );
  }
  return `${value.getUTCFullYear().toString().padStart(4, '0')}-${(value.getUTCMonth() + 1).toString().padStart(2, '0')}-${value
    .getUTCDate()
    .toString()
    .padStart(2, '0')}`;
}

function addDays(value: string, amount: number): string {
  const parts = parseDate(value);
  if (!parts)
    throw new RepeatRuleError(
      'scheduled_date は YYYY-MM-DD 形式で指定してください',
    );
  const date = dateValue(parts[0], parts[1], parts[2]);
  date.setUTCDate(date.getUTCDate() + amount);
  return formatDate(date);
}

function isWeeklyRule(value: string): boolean {
  const match = value.match(/^weekly:([0-6](?:,[0-6])*)$/);
  if (!match) return false;
  const days = match[1].split(',');
  return new Set(days).size === days.length;
}

function isMonthlyRule(value: string): boolean {
  const match = value.match(/^monthly:(\d{1,2})$/);
  if (!match) return false;
  const day = Number(match[1]);
  return day >= 1 && day <= 31;
}

function isEveryRule(value: string): boolean {
  const match = value.match(/^every:(\d+)$/);
  if (!match) return false;
  const days = Number(match[1]);
  return Number.isSafeInteger(days) && days >= 1 && days <= 366;
}

export function isValidRepeatRule(value: unknown): value is RepeatRule {
  return (
    value === 'daily' ||
    (typeof value === 'string' &&
      (isWeeklyRule(value) || isMonthlyRule(value) || isEveryRule(value)))
  );
}

/**
 * Return a stored rule, with null/empty values meaning "not recurring".
 * Throws on a malformed rule rather than returning undefined: callers coalesce
 * the result with `?? null`, so a silent undefined would turn a typo into
 * "not recurring" and drop the repeat the user asked for. Every caller runs
 * `validateRepeatRule` first, so reaching the throw means a validation gap.
 */
export function normalizeRepeatRule(
  value: unknown,
): RepeatRule | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isValidRepeatRule(value)) throw new RepeatRuleError(REPEAT_RULE_ERROR);
  return value;
}

/** Shared validation for HTTP, MCP, and any future input/parser. */
export function validateRepeatRule(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return isValidRepeatRule(value) ? null : REPEAT_RULE_ERROR;
}

/**
 * The invariant the CHECK constraint enforces, stated once for error messages.
 *
 * The constraint is what makes this true; this is what explains it. Being
 * exhaustive here is a nicety rather than a requirement — a state that slips
 * past is refused by the database and surfaces as a conflict, not as a stored
 * row. Callers pass the state that will actually be written, so a completion
 * that hands its rule to the child passes a null rule.
 */
export function validateRepeatState(
  rule: RepeatRule | null | undefined,
  status: 'open' | 'done',
  scheduledDate: string | null,
  dueDate: string | null,
  dueTime: string | null,
): string | null {
  if (rule === null || rule === undefined) return null;
  if (scheduledDate === null) return REPEAT_SCHEDULED_DATE_ERROR;
  if (dueDate !== null || dueTime !== null) return REPEAT_DEADLINE_ERROR;
  if (status === 'done') return REPEAT_OPEN_ONLY_ERROR;
  return null;
}

export function assertRepeatState(
  rule: RepeatRule | null | undefined,
  status: 'open' | 'done',
  scheduledDate: string | null,
  dueDate: string | null,
  dueTime: string | null,
): void {
  const message = validateRepeatState(
    rule,
    status,
    scheduledDate,
    dueDate,
    dueTime,
  );
  if (message) throw new RepeatRuleError(message);
}

/** A one-off may be scheduled, but a scheduled time always needs its date. */
export function validateScheduleState(
  scheduledDate: string | null,
  scheduledTime: string | null,
): string | null {
  return scheduledTime !== null && scheduledDate === null
    ? SCHEDULED_TIME_DATE_ERROR
    : null;
}

export function assertScheduleState(
  scheduledDate: string | null,
  scheduledTime: string | null,
): void {
  const message = validateScheduleState(scheduledDate, scheduledTime);
  if (message) throw new RepeatRuleError(message);
}

function nextAfter(rule: RepeatRule, fromDate: string): string {
  if (rule === 'daily') return addDays(fromDate, 1);

  if (rule.startsWith('every:')) {
    return addDays(fromDate, Number(rule.slice('every:'.length)));
  }

  if (rule.startsWith('weekly:')) {
    const parts = parseDate(fromDate);
    if (!parts)
      throw new RepeatRuleError(
        'scheduled_date は YYYY-MM-DD 形式で指定してください',
      );
    const weekdays = rule.slice('weekly:'.length).split(',').map(Number);
    const weekday = dateValue(parts[0], parts[1], parts[2]).getUTCDay();
    for (let offset = 1; offset <= 7; offset += 1) {
      if (weekdays.includes((weekday + offset) % 7))
        return addDays(fromDate, offset);
    }
  }

  if (rule.startsWith('monthly:')) {
    const parts = parseDate(fromDate);
    if (!parts)
      throw new RepeatRuleError(
        'scheduled_date は YYYY-MM-DD 形式で指定してください',
      );
    let year = parts[0];
    let month = parts[1] + 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
    const requestedDay = Number(rule.slice('monthly:'.length));
    const lastDay = dateValue(year, month + 1, 0).getUTCDate();
    return formatDate(dateValue(year, month, Math.min(requestedDay, lastDay)));
  }

  throw new RepeatRuleError(REPEAT_RULE_ERROR);
}

/**
 * Calculate the first occurrence strictly after today, advancing over missed
 * occurrences so a long-uncompleted task never creates another past-due copy.
 */
export function nextRepeatDate(
  rule: RepeatRule,
  scheduledDate: string,
  today: string,
): string {
  if (!isValidRepeatRule(rule)) throw new RepeatRuleError(REPEAT_RULE_ERROR);
  if (!parseDate(scheduledDate) || !parseDate(today)) {
    throw new RepeatRuleError('日付は YYYY-MM-DD 形式で指定してください');
  }

  let next = nextAfter(rule, scheduledDate);
  let iterations = 1;
  while (next <= today) {
    if (iterations >= MAX_ADVANCE_ITERATIONS) {
      throw new RepeatRuleError(
        '繰り返しの日付計算が上限を超えました。scheduled_dateを新しくしてください',
      );
    }
    next = nextAfter(rule, next);
    iterations += 1;
  }
  return next;
}
