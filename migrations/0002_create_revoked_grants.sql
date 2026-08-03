-- Disconnecting a client cannot be serialized with the token write the OAuth
-- provider performs internally, so revocation is recorded here and checked when a
-- token is used. KV was the obvious home for it, but its writes are eventually
-- consistent across locations: a refresh running elsewhere could read no marker
-- for up to a minute after the disconnect returned. D1 has a single primary and
-- no read replication here, so a row written by the disconnect is visible to the
-- next request that looks.
--
-- Rows are kept indefinitely. They are tiny, one per disconnect, and an expiry
-- would have to outlive every token that a raced refresh might still mint.
CREATE TABLE revoked_grants (
  user_id    TEXT NOT NULL,
  grant_id   TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, grant_id)
);
