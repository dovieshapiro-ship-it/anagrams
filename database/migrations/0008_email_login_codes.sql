CREATE TABLE email_login_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash text NOT NULL,
  code_hash text NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_login_code_challenge_uq ON email_login_codes(challenge_hash);
CREATE INDEX email_login_code_user_created_idx ON email_login_codes(user_id, created_at);
CREATE INDEX email_login_code_expiry_idx ON email_login_codes(expires_at);

ALTER TABLE email_login_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE email_login_codes FROM anon, authenticated;
