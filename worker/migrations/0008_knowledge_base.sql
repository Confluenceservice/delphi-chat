-- Grounded knowledge base + tutor mode: shared corpus of approved docs,
-- admin review queue for cold-starting the corpus from good answers, and
-- per-message stamps recording which mode/grounding produced a reply.
-- Apply directly (this project's d1_migrations table is out of sync with the
-- files, so `wrangler d1 migrations apply` would replay 0002-0006):
--   wrangler d1 execute DB --file worker/migrations/0008_knowledge_base.sql [--local]

CREATE TABLE kb_docs (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  origin     TEXT NOT NULL,            -- 'seed' | 'community'
  created_by TEXT,                     -- suggester email for community docs, NULL for seed
  created_at INTEGER NOT NULL
);

CREATE TABLE kb_chunks (
  id         TEXT PRIMARY KEY,         -- also the Vectorize vector id
  doc_id     TEXT NOT NULL REFERENCES kb_docs(id),
  seq        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_kb_chunks_doc ON kb_chunks(doc_id, seq);

CREATE TABLE kb_queue (
  id           TEXT PRIMARY KEY,
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL,
  mode         TEXT NOT NULL,          -- 'answer' | 'tutor' (mode the answer was generated in)
  suggested_by TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'dismissed'
  created_at   INTEGER NOT NULL,
  reviewed_by  TEXT,
  reviewed_at  INTEGER
);
CREATE INDEX idx_kb_queue_status ON kb_queue(status, created_at DESC);

-- Assistant-message stamps (nullable for the ALTER, same style as 0007).
ALTER TABLE messages ADD COLUMN mode TEXT;             -- 'answer' | 'tutor'
ALTER TABLE messages ADD COLUMN grounded INTEGER;      -- 0/1
ALTER TABLE messages ADD COLUMN corpus_sources TEXT;   -- JSON array
ALTER TABLE messages ADD COLUMN kb_suggested INTEGER;  -- 0/1
