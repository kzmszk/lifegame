CREATE TABLE health_entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL CHECK (kind IN ('weight', 'exercise')),
  occurred_on      TEXT NOT NULL,
  weight_kg        REAL,
  activity         TEXT,
  duration_minutes INTEGER,
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (kind = 'weight' AND weight_kg IS NOT NULL AND weight_kg > 0
      AND activity IS NULL AND duration_minutes IS NULL)
    OR
    (kind = 'exercise' AND weight_kg IS NULL AND activity IS NOT NULL
      AND length(trim(activity)) > 0
      AND (duration_minutes IS NULL
        OR duration_minutes BETWEEN 1 AND 1440))
  )
);

CREATE INDEX idx_health_entries_occurred
  ON health_entries(occurred_on DESC, id DESC);
