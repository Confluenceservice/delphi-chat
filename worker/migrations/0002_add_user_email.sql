ALTER TABLE memory_facts ADD COLUMN user_email TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_memory_facts_user_email ON memory_facts (user_email);
