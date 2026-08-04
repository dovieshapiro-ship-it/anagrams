import { z } from "zod";

export const API_V1_PREFIX = "/api/v1" as const;

export const gameRulesSchema = z
  .object({
    rackSize: z.number().int().min(3).max(12),
    roundSeconds: z.number().int().positive(),
    minimumWordLength: z.number().int().positive(),
    scoreByLength: z.record(
      z.string().regex(/^\d+$/),
      z.number().int().nonnegative(),
    ),
  })
  .strict()
  .superRefine((rules, context) => {
    if (rules.minimumWordLength > rules.rackSize) {
      context.addIssue({
        code: "custom",
        message: "minimumWordLength cannot exceed rackSize",
        path: ["minimumWordLength"],
      });
    }
    for (
      let length = rules.minimumWordLength;
      length <= rules.rackSize;
      length += 1
    ) {
      if (rules.scoreByLength[String(length)] === undefined) {
        context.addIssue({
          code: "custom",
          message: `Missing score for word length ${String(length)}`,
          path: ["scoreByLength"],
        });
      }
    }
  });

export type GameRules = z.infer<typeof gameRulesSchema>;

export const DEFAULT_GAME_RULES = gameRulesSchema.parse({
  rackSize: 6,
  roundSeconds: 60,
  minimumWordLength: 3,
  scoreByLength: { 3: 100, 4: 400, 5: 1200, 6: 2000 },
}) satisfies GameRules;

export const idSchema = z.uuid();
export const timestampSchema = z.iso.datetime({ offset: true });
export const displayNameSchema = z.string().trim().min(1).max(80);
export const normalizedWordSchema = z
  .string()
  .regex(/^[a-z]+$/)
  .min(1)
  .max(12);
export const invitationTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .min(32)
  .max(512);
export const expectedVersionSchema = z.number().int().nonnegative();

export const gameStatusSchema = z.enum([
  "waiting_for_opponent",
  "ready_check",
  "in_progress",
  "finalizing",
  "completed",
]);
export type GameStatus = z.infer<typeof gameStatusSchema>;

export const roundStatusSchema = z.enum([
  "not_started",
  "active",
  "finished",
  "expired",
]);
export type RoundStatus = z.infer<typeof roundStatusSchema>;

export const invitationStatusSchema = z.enum([
  "available",
  "expired",
  "used",
  "invalid",
  "unauthorized",
  "game_full",
]);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const rematchStatusSchema = z.enum([
  "none",
  "requested_by_you",
  "requested_by_opponent",
  "accepted",
]);
export type RematchStatus = z.infer<typeof rematchStatusSchema>;

export const errorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "STALE_STATE",
  "INVALID_STATE",
  "INVITATION_INVALID",
  "INVITATION_EXPIRED",
  "INVITATION_USED",
  "INVITATION_UNAUTHORIZED",
  "INVITATION_UNAVAILABLE",
  "GAME_FULL",
  "GAME_NOT_FOUND",
  "ROUND_NOT_FOUND",
  "RESULTS_NOT_READY",
  "ALREADY_JOINED",
  "REMATCH_NOT_FOUND",
  "IDEMPOTENCY_KEY_REUSED",
  "ORIGIN_REJECTED",
  "CSRF_REJECTED",
  "SESSION_FAILED",
  "ROUND_EXPIRED",
  "WORD_TOO_SHORT",
  "WORD_TOO_LONG",
  "WORD_INVALID_CHARACTERS",
  "WORD_NOT_IN_RACK",
  "WORD_NOT_IN_DICTIONARY",
  "DUPLICATE_WORD",
  "RATE_LIMITED",
  "USERNAME_UNAVAILABLE",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1).max(500),
    requestId: z.string().min(1).max(200),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const apiErrorResponseSchema = z
  .object({ error: apiErrorSchema })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export const userSummarySchema = z
  .object({ id: idSchema, displayName: displayNameSchema })
  .strict();
export type UserSummary = z.infer<typeof userSummarySchema>;

export const acceptedWordSchema = z
  .object({
    word: normalizedWordSchema,
    score: z.number().int().nonnegative(),
    submittedAt: timestampSchema,
  })
  .strict();
export type AcceptedWord = z.infer<typeof acceptedWordSchema>;

export const ownRoundSchema = z
  .object({
    status: roundStatusSchema,
    startedAt: timestampSchema.nullable(),
    expiresAt: timestampSchema.nullable(),
    finishedAt: timestampSchema.nullable(),
    acceptedWords: z.array(acceptedWordSchema),
    score: z.number().int().nonnegative(),
  })
  .strict();

// Deliberately excludes submissions, score, and word count. This is the only opponent
// representation permitted in an unfinished public game response.
export const opponentStatusSchema = z
  .object({
    player: userSummarySchema,
    seat: z.literal(1).or(z.literal(2)),
    ready: z.boolean(),
    roundStatus: roundStatusSchema,
  })
  .strict();

export const availableActionSchema = z.enum([
  "create_invitation",
  "mark_ready",
  "start_round",
  "submit_word",
  "finish_round",
  "view_results",
  "request_rematch",
  "accept_rematch",
]);

export const playerGameStateSchema = z
  .object({
    gameId: idSchema,
    status: gameStatusSchema.exclude(["completed"]),
    version: expectedVersionSchema,
    serverTime: timestampSchema,
    rules: gameRulesSchema,
    rack: z
      .array(z.string().regex(/^[a-z]$/))
      .length(DEFAULT_GAME_RULES.rackSize)
      .nullable(),
    you: z
      .object({
        player: userSummarySchema,
        seat: z.literal(1).or(z.literal(2)),
        ready: z.boolean(),
        round: ownRoundSchema,
      })
      .strict(),
    opponent: opponentStatusSchema.nullable(),
    availableActions: z.array(availableActionSchema),
    rematchStatus: rematchStatusSchema,
  })
  .strict();
export type PlayerGameState = z.infer<typeof playerGameStateSchema>;

export const finalPlayerResultSchema = z
  .object({
    player: userSummarySchema,
    seat: z.literal(1).or(z.literal(2)),
    score: z.number().int().nonnegative(),
    validWordCount: z.number().int().nonnegative(),
    acceptedWords: z.array(acceptedWordSchema),
    missedWords: z.array(normalizedWordSchema),
  })
  .strict();

export const finalGameResultSchema = z
  .object({
    gameId: idSchema,
    status: z.literal("completed"),
    version: expectedVersionSchema,
    serverTime: timestampSchema,
    completedAt: timestampSchema,
    rack: z
      .array(z.string().regex(/^[a-z]$/))
      .length(DEFAULT_GAME_RULES.rackSize),
    players: z.tuple([finalPlayerResultSchema, finalPlayerResultSchema]),
    outcome: z.discriminatedUnion("type", [
      z.object({ type: z.literal("win"), winnerPlayerId: idSchema }).strict(),
      z.object({ type: z.literal("draw") }).strict(),
    ]),
    rematchStatus: rematchStatusSchema,
    resultingGameId: idSchema.nullable(),
  })
  .strict();
export type FinalGameResult = z.infer<typeof finalGameResultSchema>;

export const gameStateResponseSchema = z.discriminatedUnion("status", [
  playerGameStateSchema,
  finalGameResultSchema,
]);
export type GameStateResponse = z.infer<typeof gameStateResponseSchema>;

export const emptyRequestSchema = z.object({}).strict();
export const versionedRequestSchema = z
  .object({ expectedVersion: expectedVersionSchema })
  .strict();

export const createDevSessionRequestSchema = z
  .object({ displayName: displayNameSchema })
  .strict();
export const createDevSessionResponseSchema = z
  .object({ user: userSummarySchema, serverTime: timestampSchema })
  .strict();

export const exchangeLaunchTokenRequestSchema = z
  .object({ token: z.string().min(1).max(8_192) })
  .strict();
export const exchangeLaunchTokenResponseSchema = createDevSessionResponseSchema;

export const createGameRequestSchema = emptyRequestSchema;
export const gameCardPayloadSchema = z
  .object({
    title: z.string().min(1).max(120),
    text: z.string().min(1).max(500),
    actionUrl: z.url(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export const invitationSummarySchema = z
  .object({
    invitationUrl: z.url(),
    expiresAt: timestampSchema,
    gameCard: gameCardPayloadSchema,
  })
  .strict();
export const createGameResponseSchema = z
  .object({ game: playerGameStateSchema, invitation: invitationSummarySchema })
  .strict();

export const createInvitationRequestSchema = z
  .object({
    intendedProvider: z.string().trim().min(1).max(80).optional(),
    intendedExternalUserId: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.intendedProvider === undefined) !==
      (value.intendedExternalUserId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "intendedProvider and intendedExternalUserId must be supplied together",
      });
    }
  });
export const createInvitationResponseSchema = invitationSummarySchema;

export const invitationMetadataResponseSchema = z
  .object({
    status: invitationStatusSchema,
    gameId: idSchema.nullable(),
    inviter: userSummarySchema.nullable(),
    expiresAt: timestampSchema.nullable(),
    requiresDevelopmentIdentity: z.boolean(),
  })
  .strict();

export const joinInvitationRequestSchema = emptyRequestSchema;
export const joinInvitationResponseSchema = z
  .object({ game: playerGameStateSchema })
  .strict();
export const getGameResponseSchema = gameStateResponseSchema;
export const markReadyRequestSchema = versionedRequestSchema;
export const markReadyResponseSchema = playerGameStateSchema;
export const startRoundRequestSchema = versionedRequestSchema;
export const startRoundResponseSchema = playerGameStateSchema;
export const submitWordRequestSchema = z
  .object({ word: z.string().trim().min(1).max(64) })
  .strict();
export const submitWordResponseSchema = z
  .object({
    acceptedWord: acceptedWordSchema,
    score: z.number().int().nonnegative(),
    serverTime: timestampSchema,
  })
  .strict();
export const finishRoundRequestSchema = versionedRequestSchema;
export const finishRoundResponseSchema = playerGameStateSchema;
export const getResultsResponseSchema = finalGameResultSchema;

export const requestRematchRequestSchema = versionedRequestSchema;
export const requestRematchResponseSchema = finalGameResultSchema;
export const acceptRematchRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    rematchRequestId: idSchema,
  })
  .strict();
export const acceptRematchResponseSchema = z
  .object({ game: playerGameStateSchema })
  .strict();

export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();
export const readinessResponseSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    checks: z.record(z.string(), z.enum(["up", "down"])),
  })
  .strict();

/**
 * Wire contracts implemented by the initial Fastify service.
 *
 * The richer projection schemas above remain the target domain contracts. These
 * schemas make the currently deployed async HTTP boundary parseable by the web
 * client without duplicating shapes in React code.
 */
export const csrfTokenSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).min(32).max(512);
export const playerStatusSchema = z.enum(["joined", "ready", "playing", "finished"]);

export const wireCreateDevSessionResponseSchema = z
  .object({ user: userSummarySchema, csrfToken: csrfTokenSchema })
  .strict();
export const wireCreateGameResponseSchema = z
  .object({ gameId: idSchema, version: expectedVersionSchema })
  .strict();
// Solo creation uses the same minimal navigation payload as two-player creation.
// Separate aliases make the /games/solo route explicit without creating a second
// wire representation that clients would need to maintain.
export const wireCreateSoloGameRequestSchema = emptyRequestSchema;
export const wireCreateSoloGameResponseSchema = wireCreateGameResponseSchema;
export const wireCreateInvitationResponseSchema = z
  .object({ invitationId: idSchema, invitationUrl: z.url(), expiresAt: timestampSchema })
  .strict();
export const wireJoinInvitationRequestSchema = z.object({ token: invitationTokenSchema }).strict();
export const wireJoinInvitationResponseSchema = z.object({ gameId: idSchema }).strict();
export const commandAcknowledgementSchema = z.object({ ok: z.literal(true) }).strict();

export const wireSubmitWordRequestSchema = z
  .object({ word: z.string().trim().min(1).max(64), idempotencyKey: idSchema })
  .strict();
export const submissionRejectionCodeSchema = z.enum([
  "EMPTY_WORD",
  "INVALID_CHARACTERS",
  "WORD_TOO_SHORT",
  "WORD_TOO_LONG",
  "WORD_NOT_IN_RACK",
  "WORD_NOT_IN_DICTIONARY",
  "DUPLICATE_WORD",
]);
export const wireSubmitWordResponseSchema = z
  .object({
    accepted: z.boolean(),
    normalizedWord: z.string().max(64),
    score: z.number().int().nonnegative(),
    rejectionCode: submissionRejectionCodeSchema.nullable(),
    receivedAt: timestampSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.accepted && result.rejectionCode !== null) {
      context.addIssue({ code: "custom", message: "Accepted submissions cannot have a rejection code", path: ["rejectionCode"] });
    }
    if (!result.accepted && result.rejectionCode === null) {
      context.addIssue({ code: "custom", message: "Rejected submissions require a rejection code", path: ["rejectionCode"] });
    }
  });

const wireRoundSchema = z
  .object({
    status: roundStatusSchema,
    startedAt: timestampSchema.nullable(),
    expiresAt: timestampSchema.nullable(),
    version: expectedVersionSchema,
  })
  .strict();
const wireOwnPlayerSchema = z
  .object({
    id: idSchema,
    userId: idSchema,
    seat: z.literal(1).or(z.literal(2)),
    status: playerStatusSchema,
    score: z.number().int().nonnegative(),
    validWordCount: z.number().int().nonnegative(),
    displayName: displayNameSchema,
    round: wireRoundSchema.nullable(),
    words: z.array(z.object({ word: normalizedWordSchema, score: z.number().int().nonnegative() }).strict()),
  })
  .strict();
const wireOpponentSchema = z
  .object({
    id: idSchema,
    userId: idSchema,
    seat: z.literal(1).or(z.literal(2)),
    displayName: displayNameSchema,
    status: playerStatusSchema,
  })
  .strict();
const wireCompletedPlayerSchema = z
  .object({
    playerId: idSchema,
    displayName: displayNameSchema,
    score: z.number().int().nonnegative(),
    validWordCount: z.number().int().nonnegative(),
    words: z.array(normalizedWordSchema),
    missedWords: z.array(normalizedWordSchema),
  })
  .strict();
export const wireGameStateResponseSchema = z
  .object({
    serverNow: timestampSchema,
    game: z
      .object({
        id: idSchema,
        status: gameStatusSchema,
        version: expectedVersionSchema,
        rack: z.string().regex(/^[a-z]{6}$/).nullable(),
        winnerPlayerId: idSchema.nullable().optional(),
      })
      .strict(),
    me: wireOwnPlayerSchema,
    opponent: wireOpponentSchema.optional(),
    results: z.array(wireCompletedPlayerSchema).length(2).optional(),
    pendingRematch: z
      .object({ id: idSchema, requestedByPlayerId: idSchema, canAccept: z.boolean() })
      .strict()
      .optional(),
    resultingRematchGameId: idSchema.nullable().optional(),
  })
  .strict()
  .superRefine((state, context) => {
    const ownRoundHasStarted =
      state.me.round !== null && state.me.round.status !== "not_started";
    if (!ownRoundHasStarted && state.game.rack !== null) {
      context.addIssue({
        code: "custom",
        message: "The rack must be redacted until the player's own round starts",
        path: ["game", "rack"],
      });
    }
    if (ownRoundHasStarted && state.game.rack === null) {
      context.addIssue({
        code: "custom",
        message: "A started round requires the rack",
        path: ["game", "rack"],
      });
    }
    if (state.game.status !== "completed" && state.results !== undefined) {
      context.addIssue({ code: "custom", message: "Results cannot be exposed before completion", path: ["results"] });
    }
    if (state.game.status === "completed" && state.results === undefined) {
      context.addIssue({ code: "custom", message: "Completed games require results", path: ["results"] });
    }
  });

export const wireRequestRematchResponseSchema = z.object({ requestId: idSchema.nullable() }).strict();
export const wireAcceptRematchRequestSchema = z.object({ requestId: idSchema }).strict();
export const wireAcceptRematchResponseSchema = z.object({ gameId: idSchema }).strict();
export const wireHealthResponseSchema = z.object({ status: z.literal("ok") }).strict();
export const wireReadinessResponseSchema = z.object({ status: z.enum(["ready", "not_ready"]) }).strict();

export type WireCreateDevSessionResponse = z.infer<typeof wireCreateDevSessionResponseSchema>;
export type WireCreateGameResponse = z.infer<typeof wireCreateGameResponseSchema>;
export type WireCreateSoloGameRequest = z.infer<typeof wireCreateSoloGameRequestSchema>;
export type WireCreateSoloGameResponse = z.infer<typeof wireCreateSoloGameResponseSchema>;
export type WireCreateInvitationResponse = z.infer<typeof wireCreateInvitationResponseSchema>;
export type WireGameStateResponse = z.infer<typeof wireGameStateResponseSchema>;
export type WireSubmitWordRequest = z.infer<typeof wireSubmitWordRequestSchema>;
export type WireSubmitWordResponse = z.infer<typeof wireSubmitWordResponseSchema>;

export type CreateDevSessionRequest = z.infer<
  typeof createDevSessionRequestSchema
>;
export type CreateDevSessionResponse = z.infer<
  typeof createDevSessionResponseSchema
>;
export type ExchangeLaunchTokenRequest = z.infer<
  typeof exchangeLaunchTokenRequestSchema
>;
export type CreateGameRequest = z.infer<typeof createGameRequestSchema>;
export type CreateGameResponse = z.infer<typeof createGameResponseSchema>;
export type CreateInvitationRequest = z.infer<
  typeof createInvitationRequestSchema
>;
export type CreateInvitationResponse = z.infer<
  typeof createInvitationResponseSchema
>;
export type InvitationMetadataResponse = z.infer<
  typeof invitationMetadataResponseSchema
>;
export type JoinInvitationResponse = z.infer<
  typeof joinInvitationResponseSchema
>;
export type MarkReadyRequest = z.infer<typeof markReadyRequestSchema>;
export type StartRoundRequest = z.infer<typeof startRoundRequestSchema>;
export type SubmitWordRequest = z.infer<typeof submitWordRequestSchema>;
export type SubmitWordResponse = z.infer<typeof submitWordResponseSchema>;
export type FinishRoundRequest = z.infer<typeof finishRoundRequestSchema>;
export type RequestRematchRequest = z.infer<typeof requestRematchRequestSchema>;
export type AcceptRematchRequest = z.infer<typeof acceptRematchRequestSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
