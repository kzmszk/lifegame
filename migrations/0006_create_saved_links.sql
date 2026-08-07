CREATE TABLE saved_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(url) BETWEEN 1 AND 2048),
  CHECK (length(title) <= 300),
  CHECK (length(note) <= 2000)
);

CREATE INDEX idx_saved_links_reading
  ON saved_links(archived_at, created_at DESC, id DESC);
