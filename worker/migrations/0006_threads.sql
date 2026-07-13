-- Durable conversations: threads + messages, owner-scoped by Access email.
-- Apply: wrangler d1 migrations apply DB [--local]

CREATE TABLE threads (
  id          TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title       TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_threads_owner ON threads(owner_email, updated_at DESC);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  images     TEXT,
  sources    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_thread ON messages(thread_id, seq);
