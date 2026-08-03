ALTER VIEW friend_requests SET (security_invoker = true);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'chat_identities',
    'auth_sessions',
    'games',
    'game_players',
    'rounds',
    'word_submissions',
    'invitations',
    'rematch_requests',
    'user_emails',
    'magic_link_challenges',
    'friendships',
    'friend_game_invites',
    'password_credentials'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
  END LOOP;
END $$;

REVOKE ALL ON TABLE public.friend_requests FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS friend_game_invite_inviter_idx ON friend_game_invites(inviter_user_id);
CREATE INDEX IF NOT EXISTS friendship_requester_idx ON friendships(requested_by_user_id);
CREATE INDEX IF NOT EXISTS games_winner_player_idx ON games(winner_player_id);
CREATE INDEX IF NOT EXISTS games_created_by_idx ON games(created_by_user_id);
CREATE INDEX IF NOT EXISTS invitation_created_by_player_idx ON invitations(created_by_player_id);
CREATE INDEX IF NOT EXISTS invitation_intended_user_idx ON invitations(intended_user_id);
CREATE INDEX IF NOT EXISTS invitation_used_by_user_idx ON invitations(used_by_user_id);
CREATE INDEX IF NOT EXISTS rematch_requested_by_player_idx ON rematch_requests(requested_by_player_id);
CREATE INDEX IF NOT EXISTS rounds_game_idx ON rounds(game_id);
