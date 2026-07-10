CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_namespace ON memory_facts (namespace);
