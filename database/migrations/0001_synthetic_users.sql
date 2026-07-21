ALTER TABLE users ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;
