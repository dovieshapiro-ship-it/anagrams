DO $$ BEGIN
  CREATE TYPE game_mode AS ENUM ('multiplayer', 'solo');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS mode game_mode NOT NULL DEFAULT 'multiplayer';

UPDATE games AS game
SET mode = 'solo'
WHERE EXISTS (
  SELECT 1
  FROM game_players AS player
  JOIN users AS account ON account.id = player.user_id
  WHERE player.game_id = game.id AND account.is_synthetic = true
);

CREATE TABLE IF NOT EXISTS user_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_email text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_email_normalized_uq
  ON user_emails(normalized_email);
CREATE INDEX IF NOT EXISTS user_email_user_idx ON user_emails(user_id);

CREATE TABLE IF NOT EXISTS magic_link_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  normalized_email text NOT NULL,
  requested_display_name text,
  continue_path text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS magic_link_token_hash_uq
  ON magic_link_challenges(token_hash);
CREATE INDEX IF NOT EXISTS magic_link_email_created_idx
  ON magic_link_challenges(normalized_email, created_at);
CREATE INDEX IF NOT EXISTS magic_link_expiry_idx
  ON magic_link_challenges(expires_at);

CREATE INDEX IF NOT EXISTS games_mode_status_winner_idx
  ON games(mode, status, winner_player_id);
