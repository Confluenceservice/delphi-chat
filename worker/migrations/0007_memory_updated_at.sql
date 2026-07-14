-- Memory reconciliation (ADD/UPDATE/DELETE): track when a fact was last
-- rewritten so injection can order by recency of the *edit*, not the insert.
-- Apply directly (this project's d1_migrations table is out of sync with the
-- files, so `migrations apply` would replay 0002-0006):
--   wrangler d1 execute DB --file worker/migrations/0007_memory_updated_at.sql [--local]
--
-- updated_at is nullable for the ALTER (SQLite can't add NOT NULL without a
-- constant default); backfilled here and always written by new code.
ALTER TABLE memory_facts ADD COLUMN updated_at INTEGER;
UPDATE memory_facts SET updated_at = created_at WHERE updated_at IS NULL;
