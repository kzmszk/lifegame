import { describe, expect, it } from 'vitest';
import {
  isValidRepeatRule,
  nextRepeatDate,
  RepeatRuleError,
  validateRepeatRule,
} from './repeat';

describe('repeat rules', () => {
  it('accepts the four supported rule forms and rejects malformed values', () => {
    for (const rule of ['daily', 'weekly:1,3,5', 'monthly:15', 'every:3']) {
      expect(isValidRepeatRule(rule)).toBe(true);
      expect(validateRepeatRule(rule)).toBeNull();
    }

    for (const rule of [
      'hourly',
      'weekly:',
      'weekly:1,1',
      'weekly:7',
      'monthly:0',
      'monthly:32',
      'every:0',
      'every:367',
      'every:-1',
    ]) {
      expect(isValidRepeatRule(rule)).toBe(false);
      expect(validateRepeatRule(rule)).not.toBeNull();
    }

    expect(validateRepeatRule(null)).toBeNull();
    expect(validateRepeatRule('')).toBeNull();
    expect(isValidRepeatRule('every:1')).toBe(true);
    expect(isValidRepeatRule('every:366')).toBe(true);
  });

  it('calculates daily, weekly, and every-N-day occurrences', () => {
    expect(nextRepeatDate('daily', '2026-08-03', '2026-08-03')).toBe(
      '2026-08-04',
    );
    expect(nextRepeatDate('weekly:1,3,5', '2026-08-03', '2026-08-10')).toBe(
      '2026-08-12',
    );
    expect(nextRepeatDate('every:3', '2026-08-01', '2026-08-10')).toBe(
      '2026-08-13',
    );
  });

  it('clamps monthly:31 to month end and advances beyond today', () => {
    expect(nextRepeatDate('monthly:31', '2026-01-31', '2026-02-28')).toBe(
      '2026-03-31',
    );
    expect(nextRepeatDate('monthly:31', '2028-01-31', '2028-02-29')).toBe(
      '2028-03-31',
    );
    expect(nextRepeatDate('monthly:31', '2026-01-31', '2026-03-30')).toBe(
      '2026-03-31',
    );
  });

  it('rejects repeat dates that leave the supported year range', () => {
    expect(() => nextRepeatDate('daily', '9999-12-31', '9999-12-31')).toThrow(
      new RepeatRuleError('繰り返しの次回日付が対応範囲(9999年まで)を超えます'),
    );
  });

  it('stops advancing excessively old daily tasks', () => {
    expect(() => nextRepeatDate('daily', '0001-01-01', '2026-08-05')).toThrow(
      new RepeatRuleError(
        '繰り返しの日付計算が上限を超えました。due_dateを新しくしてください',
      ),
    );
  });
});
