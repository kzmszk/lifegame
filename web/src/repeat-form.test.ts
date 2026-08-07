import { describe, expect, it } from 'vitest';
import type { RepeatRule } from '../../src/lib/repeat';
import {
  clampInteger,
  moveDeadlineToSchedule,
  repeatFormValue,
  repeatRuleFor,
} from './repeat-form';

describe('repeat form helpers', () => {
  it('clamps non-integer and non-finite values to an integer range', () => {
    expect(clampInteger(2.9, 1, 3)).toBe(2);
    expect(clampInteger(Number.NaN, 1, 3)).toBe(1);
    expect(clampInteger(Number.POSITIVE_INFINITY, 1, 3)).toBe(1);
    expect(clampInteger(-10, 1, 3)).toBe(1);
    expect(clampInteger(10, 1, 3)).toBe(3);
  });

  it.each<RepeatRule | null>([
    null,
    'daily',
    'weekly:0,2,6',
    'monthly:31',
    'every:366',
  ])('round-trips %s without losing its recurrence rule', (rule) => {
    expect(repeatRuleFor(repeatFormValue(rule))).toBe(rule);
  });

  it('returns null when a weekly form has no valid weekday selected', () => {
    expect(
      repeatRuleFor({
        frequency: 'weekly',
        weeklyDays: [],
        monthlyDay: 1,
        everyDays: 1,
      }),
    ).toBeNull();
    expect(
      repeatRuleFor({
        frequency: 'weekly',
        weeklyDays: [-1, 7, Number.NaN],
        monthlyDay: 1,
        everyDays: 1,
      }),
    ).toBeNull();
  });

  it('clamps every-N-day intervals to their supported lower and upper bounds', () => {
    expect(
      repeatRuleFor({
        frequency: 'every',
        weeklyDays: [1],
        monthlyDay: 1,
        everyDays: 0,
      }),
    ).toBe('every:1');
    expect(
      repeatRuleFor({
        frequency: 'every',
        weeklyDays: [1],
        monthlyDay: 1,
        everyDays: 367,
      }),
    ).toBe('every:366');
    expect(repeatFormValue('every:0').everyDays).toBe(1);
    expect(repeatFormValue('every:999').everyDays).toBe(366);
  });

  it('moves a deadline into the execution schedule when no schedule exists', () => {
    const value = {
      title: 'Prepare report',
      due_date: '2026-08-08',
      due_time: '09:30',
      scheduled_date: null,
      scheduled_time: null,
    };

    expect(moveDeadlineToSchedule(value)).toEqual({
      ...value,
      due_date: null,
      due_time: null,
      scheduled_date: '2026-08-08',
      scheduled_time: '09:30',
    });
  });

  it('does not overwrite an existing execution schedule', () => {
    const value = {
      due_date: '2026-08-08',
      due_time: '09:30',
      scheduled_date: '2026-08-09',
      scheduled_time: '10:00',
    };

    expect(moveDeadlineToSchedule(value)).toEqual({
      ...value,
      due_date: null,
      due_time: null,
    });
  });
});
