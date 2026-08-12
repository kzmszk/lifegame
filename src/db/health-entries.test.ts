import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  createHealthEntry,
  deleteHealthEntry,
  HealthEntryValidationError,
  listHealthEntries,
  updateHealthEntry,
  upsertSyncedHealthEntries,
} from './health-entries';
import type { SyncedHealthRecord } from '../lib/health-sync';

describe('health entries on real D1', () => {
  it('creates and lists a weight measurement', async () => {
    const created = await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 68.4,
      note: '朝',
    });

    expect(created).toMatchObject({
      id: expect.any(Number),
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 68.4,
      note: '朝',
    });

    const page = await listHealthEntries(env.DB, { limit: 50, offset: 0 });
    expect(page).toMatchObject({ truncated: false, next_offset: null });
    expect(page.entries).toEqual([created]);
  });

  it('creates an exercise session with an optional duration', async () => {
    const created = await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-06',
      activity: 'ランニング',
      duration_minutes: 30,
      note: '公園',
    });

    expect(created).toMatchObject({
      kind: 'exercise',
      occurred_on: '2026-08-06',
      activity: 'ランニング',
      duration_minutes: 30,
      note: '公園',
    });
    expect('weight_kg' in created).toBe(false);

    const withoutDuration = await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-06',
      activity: 'ヨガ',
    });
    expect(withoutDuration).toMatchObject({
      kind: 'exercise',
      duration_minutes: null,
    });
  });

  it('orders same-day entries by descending id after occurrence date', async () => {
    const older = await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-07',
      activity: '散歩',
    });
    const newer = await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 68,
    });
    await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-08',
      activity: 'ストレッチ',
    });

    const page = await listHealthEntries(env.DB, { limit: 50 });
    expect(page.entries.map((entry) => entry.id)).toEqual([
      3,
      newer.id,
      older.id,
    ]);
  });

  it('supports inclusive date filters and stable limit-offset pagination', async () => {
    await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-05',
      weight_kg: 65,
    });
    await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-06',
      weight_kg: 66,
    });
    await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 67,
    });

    const first = await listHealthEntries(env.DB, {
      from: '2026-08-05',
      to: '2026-08-07',
      limit: 2,
      offset: 0,
    });
    const second = await listHealthEntries(env.DB, {
      from: '2026-08-05',
      to: '2026-08-07',
      limit: 2,
      offset: first.next_offset ?? 0,
    });

    expect(first.entries.map((entry) => entry.occurred_on)).toEqual([
      '2026-08-07',
      '2026-08-06',
    ]);
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(2);
    expect(second.entries.map((entry) => entry.occurred_on)).toEqual([
      '2026-08-05',
    ]);
    expect(second.truncated).toBe(false);
    expect(second.next_offset).toBeNull();
  });

  it('corrects an entry without changing its kind', async () => {
    const weight = await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-01',
      weight_kg: 70,
    });

    const corrected = await updateHealthEntry(env.DB, weight.id, {
      kind: 'weight',
      occurred_on: '2026-08-02',
      weight_kg: 69.5,
      note: '訂正',
    });

    expect(corrected).toMatchObject({
      id: weight.id,
      kind: 'weight',
      occurred_on: '2026-08-02',
      weight_kg: 69.5,
      note: '訂正',
    });
    await expect(
      updateHealthEntry(env.DB, weight.id, {
        kind: 'exercise',
        activity: '誤入力',
      }),
    ).rejects.toThrow(HealthEntryValidationError);
  });

  it('deletes one entry and reports missing ids', async () => {
    const entry = await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-07',
      activity: '筋トレ',
    });

    expect(await deleteHealthEntry(env.DB, entry.id)).toBe(true);
    expect(await deleteHealthEntry(env.DB, entry.id)).toBe(false);
    expect((await listHealthEntries(env.DB)).entries).toEqual([]);
  });

  it('corrects exercise-specific fields and can clear its duration', async () => {
    const exercise = await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-07',
      activity: 'サイクリング',
      duration_minutes: 45,
    });

    const corrected = await updateHealthEntry(env.DB, exercise.id, {
      kind: 'exercise',
      activity: '水泳',
      duration_minutes: null,
    });

    expect(corrected).toMatchObject({
      kind: 'exercise',
      activity: '水泳',
      duration_minutes: null,
    });
  });

  it('rejects invalid inputs before they reach D1', async () => {
    await expect(
      createHealthEntry(env.DB, {
        kind: 'weight',
        occurred_on: '2026-02-29',
        weight_kg: 68,
      }),
    ).rejects.toThrow(HealthEntryValidationError);
    await expect(
      createHealthEntry(env.DB, {
        kind: 'weight',
        occurred_on: '2026-08-07',
        weight_kg: Number.NaN,
      }),
    ).rejects.toThrow(HealthEntryValidationError);
    await expect(
      createHealthEntry(env.DB, {
        kind: 'exercise',
        occurred_on: '2026-08-07',
        activity: '散歩',
        duration_minutes: 0,
      }),
    ).rejects.toThrow(HealthEntryValidationError);
    await expect(
      createHealthEntry(env.DB, {
        kind: 'weight',
        occurred_on: '2026-08-07',
        weight_kg: 68,
        activity: '混在',
      } as never),
    ).rejects.toThrow(HealthEntryValidationError);
    await expect(
      listHealthEntries(env.DB, {
        from: '2026-08-08',
        to: '2026-08-07',
      }),
    ).rejects.toThrow(HealthEntryValidationError);
  });

  it('enforces the discriminated combinations at the D1 boundary', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO health_entries (kind, occurred_on, weight_kg, activity)
         VALUES ('weight', '2026-08-07', 68, '混在')`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO health_entries (kind, occurred_on, activity, duration_minutes)
         VALUES ('exercise', '2026-08-07', '散歩', 1441)`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO health_entries (kind, occurred_on, activity)
         VALUES ('exercise', '2026-08-07', '   ')`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('records manual entries as their own source', async () => {
    const created = await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 68.4,
    });

    const row = await env.DB.prepare(
      'SELECT source, external_id, occurred_at FROM health_entries WHERE id = ?',
    )
      .bind(created.id)
      .first<{
        source: string;
        external_id: string | null;
        occurred_at: string | null;
      }>();
    expect(row).toEqual({
      source: 'manual',
      external_id: null,
      occurred_at: null,
    });
  });

  it('rejects a second row with the same external id', async () => {
    const insertSynced = (occurredOn: string) =>
      env.DB.prepare(
        `INSERT INTO health_entries
           (kind, occurred_on, weight_kg, source, external_id, occurred_at)
         VALUES ('weight', ?, 68.4, 'health_connect', 'hc-record-1', ?)`,
      )
        .bind(occurredOn, `${occurredOn}T07:12:00+09:00`)
        .run();

    await insertSynced('2026-08-07');
    await expect(insertSynced('2026-08-08')).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('keeps manual entries out of the dedupe key', async () => {
    await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 68.4,
    });
    await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 68.9,
    });

    const page = await listHealthEntries(env.DB);
    expect(page.entries).toHaveLength(2);

    await expect(
      env.DB.prepare(
        `INSERT INTO health_entries (kind, occurred_on, weight_kg, external_id)
         VALUES ('weight', '2026-08-07', 68.4, 'hc-record-1')`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe('filtering the history by kind', () => {
  // The filter has to reach the query rather than the returned page: with a
  // page size of 2 and the matches sitting behind three non-matches, anything
  // filtering after the cut would answer "none" for records that exist.
  async function seed() {
    await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-05',
      weight_kg: 68,
    });
    for (const day of ['2026-08-06', '2026-08-07', '2026-08-08']) {
      await createHealthEntry(env.DB, {
        kind: 'exercise',
        occurred_on: day,
        activity: 'ウォーキング',
      });
    }
  }

  it('returns only the requested kind, across the page boundary', async () => {
    await seed();

    const page = await listHealthEntries(env.DB, {
      kind: 'weight',
      limit: 2,
      offset: 0,
    });

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      kind: 'weight',
      occurred_on: '2026-08-05',
    });
    expect(page.truncated).toBe(false);
  });

  it('paginates within the filtered set, not the whole history', async () => {
    await seed();

    const first = await listHealthEntries(env.DB, {
      kind: 'exercise',
      limit: 2,
      offset: 0,
    });
    const second = await listHealthEntries(env.DB, {
      kind: 'exercise',
      limit: 2,
      offset: first.next_offset ?? 0,
    });

    expect(first.entries.map((entry) => entry.occurred_on)).toEqual([
      '2026-08-08',
      '2026-08-07',
    ]);
    expect(first.truncated).toBe(true);
    expect(second.entries.map((entry) => entry.occurred_on)).toEqual([
      '2026-08-06',
    ]);
    expect(second.truncated).toBe(false);
    expect(
      [...first.entries, ...second.entries].every(
        (entry) => entry.kind === 'exercise',
      ),
    ).toBe(true);
  });

  it('combines the kind filter with the date bounds', async () => {
    await seed();

    const page = await listHealthEntries(env.DB, {
      kind: 'exercise',
      from: '2026-08-07',
      to: '2026-08-08',
    });

    expect(page.entries.map((entry) => entry.occurred_on)).toEqual([
      '2026-08-08',
      '2026-08-07',
    ]);
  });

  it('rejects a kind that is not one of the three', async () => {
    await expect(
      listHealthEntries(env.DB, { kind: 'blood_pressure' as never }),
    ).rejects.toThrow(HealthEntryValidationError);
  });

  it('returns every kind when no filter is given', async () => {
    await seed();

    const page = await listHealthEntries(env.DB, { limit: 50 });

    expect(page.entries).toHaveLength(4);
  });
});

describe('sleep entries', () => {
  const sleep = (overrides: Partial<SyncedHealthRecord> = {}) =>
    ({
      kind: 'sleep',
      external_id: 'hc-sleep-1',
      occurred_on: '2026-08-11',
      occurred_at: '2026-08-11T07:00:00+09:00',
      weight_kg: null,
      activity: null,
      duration_minutes: 445,
      ...overrides,
    }) as SyncedHealthRecord;

  it('stores a synced sleep session and reads it back', async () => {
    expect(await upsertSyncedHealthEntries(env.DB, [sleep()])).toBe(1);

    const page = await listHealthEntries(env.DB, { limit: 50, offset: 0 });
    expect(page.entries).toEqual([
      {
        id: expect.any(Number),
        kind: 'sleep',
        occurred_on: '2026-08-11',
        duration_minutes: 445,
        note: '',
        created_at: expect.any(String),
        updated_at: expect.any(String),
      },
    ]);
  });

  // The table is the last line of defence: the shapes below never get past
  // normalizeSyncPayload, so reaching a CHECK means a validation gap.
  it('refuses a sleep row with no length or with exercise fields', async () => {
    await expect(
      upsertSyncedHealthEntries(env.DB, [sleep({ duration_minutes: null })]),
    ).rejects.toBeInstanceOf(HealthEntryValidationError);
    await expect(
      upsertSyncedHealthEntries(env.DB, [
        sleep({ external_id: 'hc-sleep-2', activity: 'ランニング' }),
      ]),
    ).rejects.toBeInstanceOf(HealthEntryValidationError);
  });

  it('cannot be entered or edited by hand, and says why', async () => {
    await expect(
      createHealthEntry(env.DB, {
        kind: 'sleep',
        occurred_on: '2026-08-11',
        duration_minutes: 445,
      } as never),
    ).rejects.toThrow('同期');

    await upsertSyncedHealthEntries(env.DB, [sleep()]);
    const [stored] = (await listHealthEntries(env.DB, { limit: 1, offset: 0 }))
      .entries;
    await expect(
      updateHealthEntry(env.DB, stored!.id, {
        kind: 'sleep',
        occurred_on: '2026-08-12',
      } as never),
    ).rejects.toThrow('同期');
  });

  // Deleting is allowed even though editing is not: a wrong night should be
  // removable, and the row is the only copy lifegame has.
  it('can be deleted', async () => {
    await upsertSyncedHealthEntries(env.DB, [sleep()]);
    const [stored] = (await listHealthEntries(env.DB, { limit: 1, offset: 0 }))
      .entries;
    expect(await deleteHealthEntry(env.DB, stored!.id)).toBe(true);
    expect(
      (await listHealthEntries(env.DB, { limit: 50, offset: 0 })).entries,
    ).toEqual([]);
  });
});

describe('upsertSyncedHealthEntries', () => {
  const record = (overrides: Partial<SyncedHealthRecord> = {}) =>
    ({
      kind: 'weight',
      external_id: 'hc-record-1',
      occurred_on: '2026-08-10',
      occurred_at: '2026-08-10T07:12:00+09:00',
      weight_kg: 68.4,
      activity: null,
      duration_minutes: null,
      ...overrides,
    }) as SyncedHealthRecord;

  async function storedRow(externalId: string) {
    return env.DB.prepare(
      `SELECT id, kind, occurred_on, occurred_at, weight_kg, note, source
       FROM health_entries WHERE external_id = ?`,
    )
      .bind(externalId)
      .first();
  }

  it('writes a record with its sync source and instant', async () => {
    expect(await upsertSyncedHealthEntries(env.DB, [record()])).toBe(1);

    expect(await storedRow('hc-record-1')).toMatchObject({
      kind: 'weight',
      occurred_on: '2026-08-10',
      occurred_at: '2026-08-10T07:12:00+09:00',
      weight_kg: 68.4,
      source: 'health_connect',
    });
  });

  it('updates in place rather than inserting a second row', async () => {
    await upsertSyncedHealthEntries(env.DB, [record()]);
    const first = await storedRow('hc-record-1');

    await upsertSyncedHealthEntries(env.DB, [
      record({ weight_kg: 67.1, occurred_on: '2026-08-11' }),
    ]);

    const page = await listHealthEntries(env.DB);
    expect(page.entries).toHaveLength(1);
    // The row keeps its id, so anything already pointing at it still resolves.
    expect(await storedRow('hc-record-1')).toMatchObject({
      id: (first as { id: number }).id,
      weight_kg: 67.1,
      occurred_on: '2026-08-11',
    });
  });

  // A note only ever comes from lifegame; a sync carries none, so re-syncing must
  // not blank one out.
  it('preserves a note added in lifegame', async () => {
    await upsertSyncedHealthEntries(env.DB, [record()]);
    const stored = (await storedRow('hc-record-1')) as { id: number };
    await updateHealthEntry(env.DB, stored.id, {
      kind: 'weight',
      note: '朝の測定',
    });

    await upsertSyncedHealthEntries(env.DB, [record({ weight_kg: 67.1 })]);

    expect(await storedRow('hc-record-1')).toMatchObject({
      note: '朝の測定',
      weight_kg: 67.1,
    });
  });

  it('writes nothing when one record in the batch is rejected by the table', async () => {
    await expect(
      upsertSyncedHealthEntries(env.DB, [
        record(),
        record({ external_id: 'hc-record-2', weight_kg: -1 }),
      ]),
    ).rejects.toThrow(HealthEntryValidationError);

    expect((await listHealthEntries(env.DB)).entries).toEqual([]);
  });

  it('does nothing for an empty payload', async () => {
    expect(await upsertSyncedHealthEntries(env.DB, [])).toBe(0);
  });
});
