import type { RepeatRule } from '../../src/lib/repeat';
import type { TaskDraft } from '../../src/shared/types';

export type RepeatFrequency = 'none' | 'daily' | 'weekly' | 'monthly' | 'every';

export interface RepeatFormValue {
  frequency: RepeatFrequency;
  weeklyDays: number[];
  monthlyDay: number;
  everyDays: number;
}

export function clampInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

export function repeatFormValue(rule: RepeatRule | null): RepeatFormValue {
  if (rule === 'daily') {
    return { frequency: 'daily', weeklyDays: [1], monthlyDay: 1, everyDays: 1 };
  }
  if (rule?.startsWith('weekly:')) {
    const weeklyDays = rule
      .slice('weekly:'.length)
      .split(',')
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((left, right) => left - right);
    return {
      frequency: 'weekly',
      weeklyDays: weeklyDays.length > 0 ? weeklyDays : [1],
      monthlyDay: 1,
      everyDays: 1,
    };
  }
  if (rule?.startsWith('monthly:')) {
    return {
      frequency: 'monthly',
      weeklyDays: [1],
      monthlyDay: clampInteger(Number(rule.slice('monthly:'.length)), 1, 31),
      everyDays: 1,
    };
  }
  if (rule?.startsWith('every:')) {
    return {
      frequency: 'every',
      weeklyDays: [1],
      monthlyDay: 1,
      everyDays: clampInteger(Number(rule.slice('every:'.length)), 1, 366),
    };
  }
  return { frequency: 'none', weeklyDays: [1], monthlyDay: 1, everyDays: 1 };
}

export function repeatRuleFor(value: RepeatFormValue): RepeatRule | null {
  if (value.frequency === 'none') return null;
  if (value.frequency === 'daily') return 'daily';
  if (value.frequency === 'weekly') {
    const days = [...new Set(value.weeklyDays)]
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((left, right) => left - right);
    return days.length > 0 ? (`weekly:${days.join(',')}` as RepeatRule) : null;
  }
  if (value.frequency === 'monthly') {
    return `monthly:${clampInteger(value.monthlyDay, 1, 31)}` as RepeatRule;
  }
  return `every:${clampInteger(value.everyDays, 1, 366)}` as RepeatRule;
}

/** Recurrence operates on an execution schedule, never on a deadline. */
export function moveDeadlineToSchedule<
  T extends Pick<
    TaskDraft,
    'due_date' | 'due_time' | 'scheduled_date' | 'scheduled_time'
  >,
>(value: T): T {
  const hasSchedule =
    value.scheduled_date !== null || value.scheduled_time !== null;
  return {
    ...value,
    scheduled_date: hasSchedule ? value.scheduled_date : value.due_date,
    scheduled_time: hasSchedule ? value.scheduled_time : value.due_time,
    due_date: null,
    due_time: null,
  };
}
