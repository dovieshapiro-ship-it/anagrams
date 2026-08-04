CREATE TABLE password_reset_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX password_reset_token_hash_uq ON password_reset_challenges(token_hash);
CREATE INDEX password_reset_user_created_idx ON password_reset_challenges(user_id, created_at);
CREATE INDEX password_reset_expiry_idx ON password_reset_challenges(expires_at);

ALTER TABLE password_reset_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE password_reset_challenges FROM anon, authenticated;
