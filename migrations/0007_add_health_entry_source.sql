-- Health Connect sync will replay the same measurement on every incremental
-- pull, so the table needs a dedupe key before any synced row lands. Health
-- Connect records carry a stable record id, and `occurred_on` alone drops the
-- measurement time. Plain ADD COLUMN keeps the existing rows and the table's
-- CHECK constraints untouched; only a UNIQUE index needs rebuilding-free care.
ALTER TABLE health_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'health_connect'));

-- A synced row is identified by its Health Connect record id. Manual rows have
-- none, and SQLite treats NULLs in a UNIQUE index as distinct, so any number of
-- manual rows still fit under the index below.
ALTER TABLE health_entries ADD COLUMN external_id TEXT
  CHECK (external_id IS NULL OR source <> 'manual');

-- Measurement instant with a tz offset, e.g. '2026-08-10T07:12:00+09:00'.
-- `occurred_on` stays the display and listing key; this is extra detail only.
ALTER TABLE health_entries ADD COLUMN occurred_at TEXT;

CREATE UNIQUE INDEX idx_health_entries_external
  ON health_entries(source, external_id);
