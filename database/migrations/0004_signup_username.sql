ALTER TABLE "magic_link_challenges"
  ADD COLUMN IF NOT EXISTS "requested_username" text;
