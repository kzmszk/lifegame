import { describe, expect, it } from 'vitest';
import {
  HealthSyncValidationError,
  MAX_SYNC_RECORDS,
  normalizeSyncPayload,
} from './health-sync';

const MAX_ACTIVITY_LENGTH = 200;

function weight(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'weight',
    external_id: 'hc-weight-1',
    occurred_at: '2026-08-10T07:12:00+09:00',
    weight_kg: 68.4,
    ...overrides,
  };
}

function exercise(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'exercise',
    external_id: 'hc-exercise-1',
    occurred_at: '2026-08-10T19:00:00+09:00',
    activity: 'ランニング',
    duration_minutes: 32,
    ...overrides,
  };
}

// occurred_at is the wake instant, so occurred_on comes out as the morning the
// night was slept into rather than the evening it started.
function sleep(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'sleep',
    external_id: 'hc-sleep-1',
    occurred_at: '2026-08-11T07:00:00+09:00',
    duration_minutes: 445,
    ...overrides,
  };
}

function rejects(body: unknown): string {
  try {
    normalizeSyncPayload(body);
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(HealthSyncValidationError);
    return (thrown as Error).message;
  }
  throw new Error('payload was accepted');
}

describe('normalizeSyncPayload', () => {
  it('normalizes a weight measurement and derives the local date', () => {
    expect(normalizeSyncPayload([weight()])).toEqual([
      {
        kind: 'weight',
        external_id: 'hc-weight-1',
        occurred_on: '2026-08-10',
        occurred_at: '2026-08-10T07:12:00+09:00',
        weight_kg: 68.4,
        activity: null,
        duration_minutes: null,
      },
    ]);
  });

  it('normalizes an exercise session and trims the activity', () => {
    expect(
      normalizeSyncPayload([exercise({ activity: '  ランニング ' })]),
    ).toEqual([
      {
        kind: 'exercise',
        external_id: 'hc-exercise-1',
        occurred_on: '2026-08-10',
        occurred_at: '2026-08-10T19:00:00+09:00',
        weight_kg: null,
        activity: 'ランニング',
        duration_minutes: 32,
      },
    ]);
  });

  it('treats an omitted duration as none', () => {
    const [record] = normalizeSyncPayload([
      { ...exercise(), duration_minutes: undefined },
    ]);
    expect(record?.duration_minutes).toBeNull();
  });

  it('accepts an empty payload', () => {
    expect(normalizeSyncPayload([])).toEqual([]);
  });

  // The date the entry is listed under is the local one, so the same instant in a
  // different offset belongs to a different day. Deriving it from the offset the
  // device sent is what keeps a 07:12 JST measurement off the previous day.
  it('takes the local date from the offset, not from UTC', () => {
    const [record] = normalizeSyncPayload([
      weight({ occurred_at: '2026-08-10T07:12:00+09:00' }),
    ]);
    expect(record?.occurred_on).toBe('2026-08-10');

    const [utc] = normalizeSyncPayload([
      weight({ occurred_at: '2026-08-09T22:12:00Z' }),
    ]);
    expect(utc?.occurred_on).toBe('2026-08-09');
  });

  it('requires an offset on occurred_at', () => {
    expect(rejects([weight({ occurred_at: '2026-08-10T07:12:00' })])).toContain(
      'オフセット',
    );
  });

  // RFC 3339 4.3: -00:00 means the offset is unknown, so it cannot yield a local
  // date. A stated zero offset can, in either spelling.
  it('rejects the unknown offset but accepts a stated zero offset', () => {
    expect(
      rejects([weight({ occurred_at: '2026-08-10T07:12:00-00:00' })]),
    ).toContain('-00:00');

    for (const zero of ['Z', '+00:00']) {
      const [record] = normalizeSyncPayload([
        weight({ occurred_at: `2026-08-10T07:12:00${zero}` }),
      ]);
      expect(record?.occurred_on).toBe('2026-08-10');
    }
  });

  it('takes the local date from a negative offset too', () => {
    const [record] = normalizeSyncPayload([
      weight({ occurred_at: '2026-08-10T22:12:00-05:00' }),
    ]);
    expect(record?.occurred_on).toBe('2026-08-10');
  });

  it('rejects an occurred_at that is not a real date or time', () => {
    expect(
      rejects([weight({ occurred_at: '2026-02-30T07:12:00+09:00' })]),
    ).toContain('日付');
    expect(
      rejects([weight({ occurred_at: '2026-08-10T25:12:00+09:00' })]),
    ).toContain('時刻');
  });

  it('rejects a record with no external_id', () => {
    expect(rejects([weight({ external_id: '   ' })])).toContain('external_id');
  });

  it('rejects a duplicated external_id in one payload', () => {
    expect(rejects([weight(), weight()])).toContain('重複');
  });

  it('normalizes a sleep session onto the day it ended', () => {
    expect(normalizeSyncPayload([sleep()])).toEqual([
      {
        kind: 'sleep',
        external_id: 'hc-sleep-1',
        occurred_on: '2026-08-11',
        occurred_at: '2026-08-11T07:00:00+09:00',
        weight_kg: null,
        activity: null,
        duration_minutes: 445,
      },
    ]);
  });

  // Unlike an exercise session, which is still worth a row when its length is
  // unusable, a night with no length says nothing.
  it('requires a length on a sleep session', () => {
    expect(rejects([sleep({ duration_minutes: null })])).toContain(
      'duration_minutes',
    );
    expect(rejects([sleep({ duration_minutes: undefined })])).toContain(
      'duration_minutes',
    );
    expect(rejects([sleep({ duration_minutes: 0 })])).toContain(
      'duration_minutes',
    );
    expect(rejects([sleep({ duration_minutes: 1441 })])).toContain(
      'duration_minutes',
    );
  });

  it('rejects a sleep session carrying weight or exercise fields', () => {
    expect(rejects([sleep({ weight_kg: 68 })])).toContain('睡眠実績');
    expect(rejects([sleep({ activity: 'ランニング' })])).toContain('睡眠実績');
  });

  it('rejects an unknown kind by name rather than dropping it', () => {
    expect(rejects([{ ...weight(), kind: 'blood_pressure' }])).toContain(
      'kind',
    );
  });

  it('rejects mixed shapes', () => {
    expect(rejects([weight({ activity: 'ランニング' })])).toContain('運動実績');
    expect(rejects([exercise({ weight_kg: 68 })])).toContain('体重測定');
  });

  // Truncating would answer 200 and let the companion advance its changes token,
  // leaving the shortened name as the only copy.
  it('rejects an over-long activity instead of truncating it', () => {
    const long = 'ラ'.repeat(MAX_ACTIVITY_LENGTH + 1);
    expect(rejects([exercise({ activity: long })])).toContain(
      String(MAX_ACTIVITY_LENGTH),
    );

    const atLimit = 'ラ'.repeat(MAX_ACTIVITY_LENGTH);
    const [record] = normalizeSyncPayload([exercise({ activity: atLimit })]);
    expect(record?.activity).toBe(atLimit);
  });

  // SQLite's length() stops at a NUL, so this would otherwise pass validation and
  // then fail the table's CHECK with a message naming no field.
  it('rejects control characters in an activity', () => {
    expect(rejects([exercise({ activity: '\u0000ランニング' })])).toContain(
      '制御文字',
    );
  });

  it('rejects an out-of-range weight and duration', () => {
    expect(rejects([weight({ weight_kg: 0 })])).toContain('weight_kg');
    expect(rejects([exercise({ duration_minutes: 1441 })])).toContain(
      'duration_minutes',
    );
  });

  it('rejects a body that is not an array', () => {
    expect(rejects({ records: [weight()] })).toContain('配列');
  });

  it('rejects more records than one request may carry', () => {
    const many = Array.from({ length: MAX_SYNC_RECORDS + 1 }, (_, index) =>
      weight({ external_id: `hc-${index}` }),
    );
    expect(rejects(many)).toContain(String(MAX_SYNC_RECORDS));
  });
});
