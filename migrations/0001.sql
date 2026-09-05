-- Optional HanGPT D1 backing store.
-- Bind a D1 database as DB and apply this migration; HanGPT will mirror structured KV records into D1 while retaining KV compatibility.
CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_kv_updated_at ON app_kv(updated_at);
