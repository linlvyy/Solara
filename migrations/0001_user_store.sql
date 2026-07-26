CREATE TABLE IF NOT EXISTS user_store (
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner, key)
);

CREATE INDEX IF NOT EXISTS user_store_updated_idx
  ON user_store (owner, updated_at DESC);

