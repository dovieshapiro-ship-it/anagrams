import { describe, expect, it } from "vitest";

import {
  DEFAULT_GAME_RULES,
  acceptRematchRequestSchema,
  apiErrorResponseSchema,
  createDevSessionRequestSchema,
  createGameRequestSchema,
  createInvitationRequestSchema,
  finalGameResultSchema,
  gameRulesSchema,
  playerGameStateSchema,
  submitWordRequestSchema,
  versionedRequestSchema,
  wireGameStateResponseSchema,
  wireCreateSoloGameRequestSchema,
  wireCreateSoloGameResponseSchema,
  wireSubmitWordRequestSchema,
  wireSubmitWordResponseSchema,
} from "./index.js";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-07-21T12:00:00.000Z";

const activeState = {
  gameId: firstId,
  status: "in_progress",
  version: 4,
  serverTime: timestamp,
  rules: DEFAULT_GAME_RULES,
  rack: ["a", "c", "c", "e", "n", "t"],
  you: {
    player: { id: firstId, displayName: "Ada" },
    seat: 1,
    ready: true,
    round: {
      status: "active",
      startedAt: timestamp,
      expiresAt: "2026-07-21T12:01:00.000Z",
      finishedAt: null,
      acceptedWords: [{ word: "cat", score: 100, submittedAt: timestamp }],
      score: 100,
    },
  },
  opponent: {
    player: { id: secondId, displayName: "Grace" },
    seat: 2,
    ready: true,
    roundStatus: "active",
  },
  availableActions: ["submit_word", "finish_round"],
  rematchStatus: "none",
} as const;

describe("approved rules", () => {
  it("preserves the six-letter scoring contract", () => {
    expect(DEFAULT_GAME_RULES).toEqual({
      rackSize: 6,
      roundSeconds: 60,
      minimumWordLength: 3,
      scoreByLength: { 3: 100, 4: 400, 5: 1200, 6: 2000 },
    });
  });

  it("rejects incomplete score tables and impossible minimum lengths", () => {
    expect(() =>
      gameRulesSchema.parse({
        ...DEFAULT_GAME_RULES,
        scoreByLength: { 3: 100 },
      }),
    ).toThrow();
    expect(() =>
      gameRulesSchema.parse({ ...DEFAULT_GAME_RULES, minimumWordLength: 7 }),
    ).toThrow();
  });
});

describe("strict request contracts", () => {
  it("rejects unknown fields instead of silently stripping them", () => {
    expect(() =>
      createDevSessionRequestSchema.parse({
        displayName: "Ada",
        userId: secondId,
      }),
    ).toThrow();
    expect(() => createGameRequestSchema.parse({ rack: "accent" })).toThrow();
    expect(() =>
      versionedRequestSchema.parse({ expectedVersion: 1, playerId: secondId }),
    ).toThrow();
    expect(() =>
      submitWordRequestSchema.parse({
        word: "cat",
        score: 999,
        submittedAt: timestamp,
      }),
    ).toThrow();
    expect(() =>
      acceptRematchRequestSchema.parse({
        expectedVersion: 1,
        rematchRequestId: firstId,
        resultingGameId: secondId,
      }),
    ).toThrow();
  });

  it("requires recipient binding fields as a pair", () => {
    expect(
      createInvitationRequestSchema.safeParse({ intendedProvider: "example" })
        .success,
    ).toBe(false);
    expect(
      createInvitationRequestSchema.safeParse({
        intendedExternalUserId: "user-2",
      }).success,
    ).toBe(false);
    expect(
      createInvitationRequestSchema.safeParse({
        intendedProvider: "example",
        intendedExternalUserId: "user-2",
      }).success,
    ).toBe(true);
  });

  it("bounds and trims externally supplied strings", () => {
    expect(
      createDevSessionRequestSchema.parse({ displayName: "  Ada  " }),
    ).toEqual({ displayName: "Ada" });
    expect(submitWordRequestSchema.safeParse({ word: "" }).success).toBe(false);
    expect(
      submitWordRequestSchema.safeParse({ word: "x".repeat(65) }).success,
    ).toBe(false);
  });
});

describe("privacy projections", () => {
  it("accepts an active state containing own words", () => {
    expect(
      playerGameStateSchema.parse(activeState).you.round.acceptedWords,
    ).toHaveLength(1);
  });

  it.each([
    ["acceptedWords", [{ word: "ant", score: 100, submittedAt: timestamp }]],
    ["score", 100],
    ["validWordCount", 1],
  ])("rejects opponent %s in unfinished state", (key, value) => {
    const leaked = {
      ...activeState,
      opponent: { ...activeState.opponent, [key]: value },
    };
    expect(playerGameStateSchema.safeParse(leaked).success).toBe(false);
  });

  it("rejects completed status from the unfinished projection", () => {
    expect(
      playerGameStateSchema.safeParse({ ...activeState, status: "completed" })
        .success,
    ).toBe(false);
  });

  it("allows both players' words only in a completed result", () => {
    const playerResult = (id: string, displayName: string, seat: 1 | 2) => ({
      player: { id, displayName },
      seat,
      score: 100,
      validWordCount: 1,
      acceptedWords: [{ word: "cat", score: 100, submittedAt: timestamp }],
      missedWords: ["act", "cane"],
    });
    const parsed = finalGameResultSchema.parse({
      gameId: firstId,
      status: "completed",
      version: 8,
      serverTime: timestamp,
      completedAt: timestamp,
      rack: ["a", "c", "c", "e", "n", "t"],
      players: [
        playerResult(firstId, "Ada", 1),
        playerResult(secondId, "Grace", 2),
      ],
      outcome: { type: "win", winnerPlayerId: firstId },
      rematchStatus: "none",
      resultingGameId: null,
    });
    expect(parsed.players[1].acceptedWords[0]?.word).toBe("cat");
  });
});

describe("uniform errors", () => {
  it("accepts typed safe API errors and rejects arbitrary top-level data", () => {
    expect(
      apiErrorResponseSchema.parse({
        error: {
          code: "ROUND_EXPIRED",
          message: "The round has ended.",
          requestId: "req-1",
        },
      }),
    ).toBeTruthy();
    expect(
      apiErrorResponseSchema.safeParse({
        error: { code: "ROUND_EXPIRED", message: "ended", requestId: "req-1" },
        stack: "secret",
      }).success,
    ).toBe(false);
  });
});

describe("implemented async wire contracts", () => {
  const wireState = {
    serverNow: timestamp,
    game: { id: firstId, status: "in_progress", version: 4, rack: "accent" },
    me: {
      id: firstId,
      userId: firstId,
      seat: 1,
      status: "playing",
      score: 100,
      validWordCount: 1,
      displayName: "Ada",
      round: { status: "active", startedAt: timestamp, expiresAt: "2026-07-21T12:01:00.000Z", version: 1 },
      words: [{ word: "cat", score: 100 }],
    },
    opponent: { id: secondId, userId: secondId, seat: 2, displayName: "Grace", status: "playing" },
  } as const;

  it("parses polling state and rejects opponent disclosure", () => {
    expect(wireGameStateResponseSchema.parse(wireState).game.rack).toBe("accent");
    expect(wireGameStateResponseSchema.safeParse({ ...wireState, opponent: { ...wireState.opponent, score: 0 } }).success).toBe(false);
  });

  it("redacts the rack until the caller's own round starts", () => {
    const beforeStart = {
      ...wireState,
      game: { ...wireState.game, status: "ready_check", rack: null },
      me: {
        ...wireState.me,
        status: "ready",
        round: { status: "not_started", startedAt: null, expiresAt: null, version: 0 },
      },
    } as const;
    expect(wireGameStateResponseSchema.safeParse(beforeStart).success).toBe(true);
    expect(
      wireGameStateResponseSchema.safeParse({
        ...beforeStart,
        game: { ...beforeStart.game, rack: "accent" },
      }).success,
    ).toBe(false);
    expect(
      wireGameStateResponseSchema.safeParse({
        ...wireState,
        game: { ...wireState.game, rack: null },
      }).success,
    ).toBe(false);
  });

  it("rejects results before the completed state and requires them after completion", () => {
    const emptyResults = [
      { playerId: firstId, displayName: "Ada", score: 0, validWordCount: 0, words: [], missedWords: [] },
      { playerId: secondId, displayName: "Grace", score: 0, validWordCount: 0, words: [], missedWords: [] },
    ];
    expect(wireGameStateResponseSchema.safeParse({ ...wireState, results: emptyResults }).success).toBe(false);
    expect(wireGameStateResponseSchema.safeParse({ ...wireState, game: { ...wireState.game, status: "completed" } }).success).toBe(false);
    expect(wireGameStateResponseSchema.safeParse({ ...wireState, game: { ...wireState.game, status: "completed" }, results: emptyResults }).success).toBe(true);
  });

  it("supports polling the actionable rematch identifier", () => {
    const complete = {
      ...wireState,
      game: { ...wireState.game, status: "completed" },
      results: [
        { playerId: firstId, displayName: "Ada", score: 0, validWordCount: 0, words: [], missedWords: [] },
        { playerId: secondId, displayName: "Grace", score: 0, validWordCount: 0, words: [], missedWords: [] },
      ],
      pendingRematch: { id: secondId, requestedByPlayerId: firstId, canAccept: true },
    } as const;
    expect(wireGameStateResponseSchema.parse(complete).pendingRematch?.id).toBe(secondId);
  });

  it("makes word retries explicit and validates accepted/rejected outcomes", () => {
    expect(wireSubmitWordRequestSchema.safeParse({ word: "cat", idempotencyKey: firstId }).success).toBe(true);
    expect(wireSubmitWordRequestSchema.safeParse({ word: "cat" }).success).toBe(false);
    expect(
      wireSubmitWordResponseSchema.safeParse({ accepted: true, normalizedWord: "cat", score: 100, rejectionCode: null, receivedAt: timestamp }).success,
    ).toBe(true);
    expect(
      wireSubmitWordResponseSchema.safeParse({ accepted: false, normalizedWord: "cat", score: 0, rejectionCode: null, receivedAt: timestamp }).success,
    ).toBe(false);
  });

  it("uses the normal creation response for the solo route", () => {
    expect(wireCreateSoloGameRequestSchema.parse({})).toEqual({});
    expect(wireCreateSoloGameRequestSchema.safeParse({ difficulty: "easy" }).success).toBe(false);
    expect(wireCreateSoloGameResponseSchema.parse({ gameId: firstId, version: 0 })).toEqual({
      gameId: firstId,
      version: 0,
    });
  });

  it("accepts a synthetic opponent through the ordinary completed results projection", () => {
    const completed = {
      ...wireState,
      game: { ...wireState.game, status: "completed", winnerPlayerId: firstId },
      me: { ...wireState.me, status: "finished", round: { ...wireState.me.round, status: "finished" } },
      opponent: { ...wireState.opponent, displayName: "KiwiBot", status: "finished" },
      results: [
        { playerId: firstId, displayName: "Ada", score: 400, validWordCount: 1, words: ["cane"], missedWords: [] },
        { playerId: secondId, displayName: "KiwiBot", score: 100, validWordCount: 1, words: ["cat"], missedWords: ["act"] },
      ],
    } as const;
    const parsed = wireGameStateResponseSchema.parse(completed);
    expect(parsed.results?.[1]?.displayName).toBe("KiwiBot");
  });
});
