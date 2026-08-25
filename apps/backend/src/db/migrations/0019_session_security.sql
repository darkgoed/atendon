ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 1;

UPDATE users SET session_version=1 WHERE session_version IS NULL;
