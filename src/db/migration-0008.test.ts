import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const migrationTable = 'migration_0008_test';

function migration(name: string) {
  const result = env.TEST_MIGRATIONS?.find(
    (candidate) => candidate.name === name,
  );
  if (!result) throw new Error(`Migration is not configured: ${name}`);
  return result;
}

// The setup file applies the whole schema before each test, so the pre-0008
// state has to be rebuilt in the same database. 0008 copies every row into a new
// table and drops the old one, which is the shape of migration that loses data
// quietly: a column missed in either list of the INSERT ... SELECT reads as a
// successful migration and an emptied column.
async function applySchemaThrough0007() {
  await env.DB.batch([
    env.DB.prepare('DROP TABLE IF EXISTS health_entries'),
    env.DB.prepare(`DROP TABLE IF EXISTS ${migrationTable}`),
  ]);
  await applyD1Migrations(
    env.DB,
    [
      migration('0005_create_health_entries.sql'),
      migration('0007_add_health_entry_source.sql'),
    ],
    migrationTable,
  );
}

async function apply0008() {
  await applyD1Migrations(
    env.DB,
    [migration('0008_allow_sleep_health_entries.sql')],
    migrationTable,
  );
}

describe('migration 0008', () => {
  it('carries every column of every existing row across the rebuild', async () => {
    await applySchemaThrough0007();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO health_entries
           (id, kind, occurred_on, weight_kg, activity, duration_minutes, note,
            created_at, updated_at, source, external_id, occurred_at)
         VALUES (?, 'weight', '2026-08-10', 68.4, NULL, NULL, '朝',
            '2026-08-10 00:00:00', '2026-08-10 00:00:00', 'manual', NULL, NULL)`,
      ).bind(1),
      env.DB.prepare(
        `INSERT INTO health_entries
           (id, kind, occurred_on, weight_kg, activity, duration_minutes, note,
            created_at, updated_at, source, external_id, occurred_at)
         VALUES (?, 'exercise', '2026-08-10', NULL, 'ランニング', 12, '',
            '2026-08-10 01:00:00', '2026-08-10 01:00:00', 'health_connect',
            'hc-exercise-1', '2026-08-10T19:00:00+09:00')`,
      ).bind(2),
    ]);

    await apply0008();

    const { results } = await env.DB.prepare(
      `SELECT id, kind, occurred_on, weight_kg, activity, duration_minutes, note,
              created_at, updated_at, source, external_id, occurred_at
       FROM health_entries ORDER BY id`,
    ).all();
    expect(results).toEqual([
      {
        id: 1,
        kind: 'weight',
        occurred_on: '2026-08-10',
        weight_kg: 68.4,
        activity: null,
        duration_minutes: null,
        note: '朝',
        created_at: '2026-08-10 00:00:00',
        updated_at: '2026-08-10 00:00:00',
        source: 'manual',
        external_id: null,
        occurred_at: null,
      },
      {
        id: 2,
        kind: 'exercise',
        occurred_on: '2026-08-10',
        weight_kg: null,
        activity: 'ランニング',
        duration_minutes: 12,
        note: '',
        created_at: '2026-08-10 01:00:00',
        updated_at: '2026-08-10 01:00:00',
        source: 'health_connect',
        external_id: 'hc-exercise-1',
        occurred_at: '2026-08-10T19:00:00+09:00',
      },
    ]);
  });

  // DROP removes the old table's sqlite_sequence row and RENAME carries the new
  // table's over, so ids keep climbing. Restarting them would let a new row take
  // an id that something else still refers to.
  it('keeps the autoincrement counter past the highest existing id', async () => {
    await applySchemaThrough0007();
    await env.DB.prepare(
      `INSERT INTO health_entries (id, kind, occurred_on, weight_kg)
       VALUES (?, 'weight', '2026-08-10', 68.4)`,
    )
      .bind(42)
      .run();

    await apply0008();

    await env.DB.prepare(
      `INSERT INTO health_entries (kind, occurred_on, weight_kg)
       VALUES ('weight', '2026-08-11', 68.0)`,
    ).run();
    const row = await env.DB.prepare(
      'SELECT MAX(id) AS highest FROM health_entries',
    ).first<{ highest: number }>();
    expect(row?.highest).toBe(43);
  });

  it('rebuilds both indexes, so the sync dedupe key still holds', async () => {
    await applySchemaThrough0007();
    await apply0008();

    const insertSynced = (externalId: string) =>
      env.DB.prepare(
        `INSERT INTO health_entries
           (kind, occurred_on, weight_kg, source, external_id)
         VALUES ('weight', '2026-08-10', 68.4, 'health_connect', ?)`,
      )
        .bind(externalId)
        .run();

    await insertSynced('hc-weight-1');
    await expect(insertSynced('hc-weight-1')).rejects.toThrow();

    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'health_entries' ORDER BY name`,
    ).all<{ name: string }>();
    expect(results.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'idx_health_entries_external',
        'idx_health_entries_occurred',
      ]),
    );
  });

  it('admits sleep only in the shape the sync sends', async () => {
    await applySchemaThrough0007();
    // The shape upsertSyncedHealthEntries produces, with one column swappable.
    const insertSynced = (overrides: Record<string, unknown> = {}) => {
      const row = {
        duration_minutes: 445,
        source: 'health_connect',
        external_id: 'hc-sleep-1',
        occurred_at: '2026-08-11T07:00:00+09:00',
        weight_kg: null,
        activity: null,
        ...overrides,
      };
      return env.DB.prepare(
        `INSERT INTO health_entries
           (kind, occurred_on, duration_minutes, source, external_id,
            occurred_at, weight_kg, activity)
         VALUES ('sleep', '2026-08-11', ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          row.duration_minutes,
          row.source,
          row.external_id,
          row.occurred_at,
          row.weight_kg,
          row.activity,
        )
        .run();
    };

    await expect(insertSynced()).rejects.toThrow();

    await apply0008();

    await insertSynced();

    // A night with no length says only "slept", and one carrying another kind's
    // columns is not a night at all.
    await expect(
      insertSynced({ external_id: 'hc-sleep-2', duration_minutes: null }),
    ).rejects.toThrow();
    await expect(
      insertSynced({ external_id: 'hc-sleep-3', duration_minutes: 1441 }),
    ).rejects.toThrow();
    await expect(
      insertSynced({ external_id: 'hc-sleep-4', activity: 'ランニング' }),
    ).rejects.toThrow();
    await expect(
      insertSynced({ external_id: 'hc-sleep-5', weight_kg: 68.4 }),
    ).rejects.toThrow();
  });

  // Sleep has no manual entry path, so a manual-shaped sleep row is a row
  // nothing in lifegame can have produced. Leaving it to the application layer
  // would mean the column defaults alone are enough to create one.
  it('refuses a sleep row that did not come from the sync', async () => {
    await applySchemaThrough0007();
    await apply0008();

    // Column defaults: source 'manual', external_id and occurred_at NULL.
    await expect(
      env.DB.prepare(
        `INSERT INTO health_entries (kind, occurred_on, duration_minutes)
         VALUES ('sleep', '2026-08-11', 445)`,
      ).run(),
    ).rejects.toThrow();

    const missing = (column: string, value: unknown) =>
      env.DB.prepare(
        `INSERT INTO health_entries
           (kind, occurred_on, duration_minutes, source, external_id, occurred_at)
         VALUES ('sleep', '2026-08-11', 445,
           ${column === 'source' ? '?' : "'health_connect'"},
           ${column === 'external_id' ? '?' : "'hc-sleep-1'"},
           ${column === 'occurred_at' ? '?' : "'2026-08-11T07:00:00+09:00'"})`,
      )
        .bind(value)
        .run();

    await expect(missing('source', 'manual')).rejects.toThrow();
    await expect(missing('external_id', null)).rejects.toThrow();
    await expect(missing('occurred_at', null)).rejects.toThrow();
  });
});
