-- Sleep was read on the device but never stored: `kind` only admitted 'weight'
-- and 'exercise'. Widening it needs a table rebuild, because SQLite can add a
-- column but cannot alter a CHECK constraint, and both constraints that matter
-- here (the `kind` vocabulary and the per-kind column combination) are CHECKs.
--
-- A sleep row carries its length in `duration_minutes` and nothing else, so the
-- column is required for it — unlike exercise, where a session with no usable
-- length is still worth recording by name. A sleep row with no length would say
-- only "slept at some point", which is not worth a row.
--
-- `occurred_on` for sleep is the local date the session ENDED, decided in the
-- companion by sending the wake instant as `occurred_at`. A night that starts at
-- 23:30 and one that starts at 01:00 then land on the same day, which is what
-- "last night's sleep" means to a reader. Nothing here enforces that; it is
-- recorded so the derivation is not mistaken for the bedtime later.

CREATE TABLE health_entries_rebuilt (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL CHECK (kind IN ('weight', 'exercise', 'sleep')),
  occurred_on      TEXT NOT NULL,
  weight_kg        REAL,
  activity         TEXT,
  duration_minutes INTEGER,
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  source           TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'health_connect')),
  external_id      TEXT CHECK (external_id IS NULL OR source <> 'manual'),
  occurred_at      TEXT,
  CHECK (
    (kind = 'weight' AND weight_kg IS NOT NULL AND weight_kg > 0
      AND activity IS NULL AND duration_minutes IS NULL)
    OR
    (kind = 'exercise' AND weight_kg IS NULL AND activity IS NOT NULL
      AND length(trim(activity)) > 0
      AND (duration_minutes IS NULL
        OR duration_minutes BETWEEN 1 AND 1440))
    OR
    (kind = 'sleep' AND weight_kg IS NULL AND activity IS NULL
      AND duration_minutes IS NOT NULL
      AND duration_minutes BETWEEN 1 AND 1440)
  )
);

INSERT INTO health_entries_rebuilt
  (id, kind, occurred_on, weight_kg, activity, duration_minutes, note,
   created_at, updated_at, source, external_id, occurred_at)
SELECT id, kind, occurred_on, weight_kg, activity, duration_minutes, note,
   created_at, updated_at, source, external_id, occurred_at
FROM health_entries;

DROP TABLE health_entries;

-- Renaming carries the AUTOINCREMENT counter with it: DROP removed the old
-- table's sqlite_sequence row, and the copy above already advanced the new
-- table's. Ids therefore keep climbing rather than restarting inside a range
-- that deleted rows once occupied.
ALTER TABLE health_entries_rebuilt RENAME TO health_entries;

CREATE INDEX idx_health_entries_occurred
  ON health_entries(occurred_on DESC, id DESC);

CREATE UNIQUE INDEX idx_health_entries_external
  ON health_entries(source, external_id);
