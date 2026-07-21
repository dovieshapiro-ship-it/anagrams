import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const gameStatus = pgEnum("game_status", [
  "waiting_for_opponent",
  "ready_check",
  "in_progress",
  "finalizing",
  "completed",
]);
export const playerStatus = pgEnum("player_status", [
  "joined",
  "ready",
  "playing",
  "finished",
]);
export const roundStatus = pgEnum("round_status", [
  "not_started",
  "active",
  "finished",
  "expired",
]);
export const rematchStatus = pgEnum("rematch_status", [
  "requested",
  "accepted",
  "declined",
]);
export const gameMode = pgEnum("game_mode", ["multiplayer", "solo"]);

const audit = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  isSynthetic: boolean("is_synthetic").notNull().default(false),
  ...audit,
});

export const userEmails = pgTable(
  "user_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    normalizedEmail: text("normalized_email").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    ...audit,
  },
  (t) => [
    uniqueIndex("user_email_normalized_uq").on(t.normalizedEmail),
    index("user_email_user_idx").on(t.userId),
  ],
);

export const magicLinkChallenges = pgTable(
  "magic_link_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    requestedDisplayName: text("requested_display_name"),
    continuePath: text("continue_path"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("magic_link_token_hash_uq").on(t.tokenHash),
    index("magic_link_email_created_idx").on(
      t.normalizedEmail,
      t.createdAt,
    ),
    index("magic_link_expiry_idx").on(t.expiresAt),
  ],
);

export const chatIdentities = pgTable(
  "chat_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("chat_identity_provider_subject_uq").on(
      t.provider,
      t.providerUserId,
    ),
    index("chat_identity_user_idx").on(t.userId),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfHash: text("csrf_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_session_token_hash_uq").on(t.tokenHash),
    index("auth_session_user_idx").on(t.userId),
  ],
);

export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: gameStatus("status").notNull().default("waiting_for_opponent"),
    mode: gameMode("mode").notNull().default("multiplayer"),
    rack: text("rack").notNull(),
    rules: jsonb("rules").notNull(),
    version: integer("version").notNull().default(0),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    parentGameId: uuid("parent_game_id"),
    winnerPlayerId: uuid("winner_player_id"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    ...audit,
  },
  (t) => [
    check("game_rack_six_ascii", sql`${t.rack} ~ '^[a-z]{6}$'`),
    uniqueIndex("game_parent_uq").on(t.parentGameId),
  ],
);

export const gamePlayers = pgTable(
  "game_players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    seat: smallint("seat").notNull(),
    status: playerStatus("status").notNull().default("joined"),
    score: integer("score").notNull().default(0),
    validWordCount: integer("valid_word_count").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (t) => [
    check("game_player_seat_range", sql`${t.seat} between 1 and 2`),
    uniqueIndex("game_player_seat_uq").on(t.gameId, t.seat),
    uniqueIndex("game_player_user_uq").on(t.gameId, t.userId),
    index("game_player_user_idx").on(t.userId),
  ],
);

export const rounds = pgTable(
  "rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    gamePlayerId: uuid("game_player_id")
      .notNull()
      .references(() => gamePlayers.id, { onDelete: "cascade" }),
    status: roundStatus("status").notNull().default("not_started"),
    version: integer("version").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("round_player_uq").on(t.gamePlayerId),
    index("round_due_idx").on(t.status, t.expiresAt),
  ],
);

export const wordSubmissions = pgTable(
  "word_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => rounds.id, { onDelete: "cascade" }),
    normalizedWord: text("normalized_word").notNull(),
    submittedWord: text("submitted_word").notNull(),
    accepted: boolean("accepted").notNull(),
    rejectionCode: text("rejection_code"),
    score: integer("score").notNull().default(0),
    idempotencyKey: uuid("idempotency_key").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("submission_idempotency_uq").on(t.roundId, t.idempotencyKey),
    uniqueIndex("submission_accepted_word_uq")
      .on(t.roundId, t.normalizedWord)
      .where(sql`${t.accepted} = true`),
    index("submission_round_idx").on(t.roundId, t.receivedAt),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    createdByPlayerId: uuid("created_by_player_id")
      .notNull()
      .references(() => gamePlayers.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByUserId: uuid("used_by_user_id").references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("invitation_token_hash_uq").on(t.tokenHash),
    index("invitation_game_idx").on(t.gameId),
  ],
);

export const rematchRequests = pgTable(
  "rematch_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceGameId: uuid("source_game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    requestedByPlayerId: uuid("requested_by_player_id")
      .notNull()
      .references(() => gamePlayers.id),
    status: rematchStatus("status").notNull().default("requested"),
    resultingGameId: uuid("resulting_game_id").references(() => games.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("rematch_requester_uq").on(
      t.sourceGameId,
      t.requestedByPlayerId,
    ),
    uniqueIndex("rematch_result_uq").on(t.resultingGameId),
  ],
);
