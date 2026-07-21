import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  DEFAULT_GAME_RULES,
  enumerateMissedWords,
  generateQualityRack,
  normalizeWord,
  resolveResult,
  roundExpiresAt,
  validateWord,
  type RandomSource,
  type WordDictionary,
} from "@anagrams/game-engine";
import { z } from "zod";
import type { Env } from "./env.js";
import type { DatabaseHandle } from "./db/client.js";
import {
  authSessions,
  gamePlayers,
  games,
  invitations,
  magicLinkChallenges,
  rematchRequests,
  rounds,
  users,
  userEmails,
  wordSubmissions,
} from "./db/schema.js";
import { ApiError, sendError } from "./errors.js";
import {
  CSRF_COOKIE,
  opaqueToken,
  requestOrigin,
  SESSION_COOKIE,
  tokenHash,
} from "./security.js";

declare module "fastify" {
  interface FastifyRequest {
    authUserId?: string;
    csrfHash?: string;
  }
}

const uuid = z.string().uuid();
const gameParam = z.object({ gameId: uuid }).strict();
const createSessionBody = z
  .object({ displayName: z.string().trim().min(1).max(40) })
  .strict();
const submitBody = z
  .object({ word: z.string().trim().min(1).max(64), idempotencyKey: uuid.optional() })
  .strict();
const joinBody = z.object({ token: z.string().min(20).max(256) }).strict();
const versionBody = z
  .object({ expectedVersion: z.number().int().nonnegative() })
  .strict();
const idBody = z.object({ requestId: uuid }).strict();
const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const magicLinkRequestBody = z
  .object({
    email,
    displayName: z.string().trim().min(1).max(40).optional(),
    continuePath: z.string().max(512).optional(),
  })
  .strict();
const magicLinkConsumeBody = z.object({ token: z.string().min(20).max(256) }).strict();

type Db = DatabaseHandle["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function safeContinuePath(value: string | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

function setSessionCookies(
  reply: FastifyReply,
  env: Env,
  sessionToken: string,
  csrfToken: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: env.cookieSecure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  reply.header("x-csrf-token", csrfToken);
}

export interface BuildAppOptions {
  readonly env: Env;
  readonly database: DatabaseHandle;
  readonly dictionary: WordDictionary;
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const { env, database, dictionary } = options;
  const app = Fastify({
    trustProxy: env.trustProxy,
    logger: {
      level: env.NODE_ENV === "test" ? "silent" : "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "req.body.token",
        "req.query.token",
      ],
    },
    bodyLimit: 16 * 1024,
  });
  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, callback) =>
      callback(null, origin === undefined || env.origins.includes(origin)),
    credentials: true,
    methods: ["GET", "POST"],
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'self'", ...env.origins],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.authUserId ?? request.ip,
  });
  await app.register(swagger, {
    openapi: { info: { title: "Anagrams API", version: "1.0.0" } },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  const expiryTimer = setInterval(() => {
    void sweepExpiredGames(database.db, dictionary).catch((error: unknown) =>
      app.log.error({ err: error }, "round expiry sweep failed"),
    );
  }, 5_000);
  expiryTimer.unref();
  app.addHook("onClose", () => clearInterval(expiryTimer));

  app.setErrorHandler((error, _request, reply) => sendError(reply, error));
  app.addHook("onRequest", async (request) =>
    authenticate(request, database.db),
  );
  // Fastify hooks must either return a promise or invoke a callback. Keeping this
  // async prevents the request lifecycle from waiting for a missing callback.
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook("preHandler", async (request) => {
    if (
      !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
      request.url === "/api/v1/dev/sessions" ||
      request.url === "/api/v1/auth/magic-links" ||
      request.url === "/api/v1/auth/magic-links/consume"
    )
      return;
    const origin = requestOrigin(request);
    if (origin === undefined || !env.origins.includes(origin))
      throw new ApiError(
        403,
        "ORIGIN_REJECTED",
        "Request origin is not allowed",
      );
    if (!request.authUserId) return;
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || tokenHash(csrf) !== request.csrfHash)
      throw new ApiError(403, "CSRF_REJECTED", "CSRF validation failed");
  });

  app.get("/health", () => ({ status: "ok", service: "anagrams-server", version: "0.1.0" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await database.db.execute(sql`select 1`);
      return { status: "ready", checks: { database: "up" } };
    } catch {
      return reply.status(503).send({ status: "not_ready", checks: { database: "down" } });
    }
  });

  app.post(
    "/api/v1/dev/sessions",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      if (env.NODE_ENV === "production")
        throw new ApiError(404, "NOT_FOUND", "Route not found");
      const body = createSessionBody.parse(request.body);
      const sessionToken = opaqueToken();
      const csrfToken = opaqueToken();
      const expiresAt = new Date(
        Date.now() + env.SESSION_TTL_HOURS * 3_600_000,
      );
      const [user] = await database.db
        .insert(users)
        .values({ displayName: body.displayName })
        .returning();
      if (!user)
        throw new ApiError(500, "SESSION_FAILED", "Could not create session");
      await database.db
        .insert(authSessions)
        .values({
          userId: user.id,
          tokenHash: tokenHash(sessionToken),
          csrfHash: tokenHash(csrfToken),
          expiresAt,
        });
      reply.setCookie(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        secure: env.cookieSecure,
        sameSite: "lax",
        path: "/",
        expires: expiresAt,
      });
      reply.setCookie(CSRF_COOKIE, csrfToken, {
        httpOnly: false,
        secure: env.cookieSecure,
        sameSite: "lax",
        path: "/",
        expires: expiresAt,
      });
      reply.header("x-csrf-token", csrfToken);
      return reply
        .status(201)
        .send({
          user: { id: user.id, displayName: user.displayName },
          csrfToken,
        });
    },
  );

  app.post(
    "/api/v1/auth/magic-links",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const body = magicLinkRequestBody.parse(request.body);
      const continuePath = safeContinuePath(body.continuePath);
      const rawToken = opaqueToken();
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await database.db.insert(magicLinkChallenges).values({
        tokenHash: tokenHash(rawToken),
        normalizedEmail: body.email,
        requestedDisplayName: body.displayName,
        continuePath,
        expiresAt,
      });
      const developmentMagicLink = `${env.PUBLIC_WEB_URL}/#magic=${encodeURIComponent(rawToken)}`;
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({
        accepted: true,
        ...(env.NODE_ENV !== "production" ? { developmentMagicLink } : {}),
      });
    },
  );

  app.post(
    "/api/v1/auth/magic-links/consume",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const body = magicLinkConsumeBody.parse(request.body);
      const sessionToken = opaqueToken();
      const csrfToken = opaqueToken();
      const sessionExpiresAt = new Date(
        Date.now() + env.SESSION_TTL_HOURS * 3_600_000,
      );
      const profile = await database.db.transaction(async (tx) => {
        const [challenge] = await tx
          .update(magicLinkChallenges)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(magicLinkChallenges.tokenHash, tokenHash(body.token)),
              isNull(magicLinkChallenges.consumedAt),
              gt(magicLinkChallenges.expiresAt, new Date()),
            ),
          )
          .returning();
        if (!challenge)
          throw new ApiError(401, "UNAUTHENTICATED", "This sign-in link is invalid or expired");
        const [existingEmail] = await tx
          .select()
          .from(userEmails)
          .where(eq(userEmails.normalizedEmail, challenge.normalizedEmail));
        let userId = existingEmail?.userId;
        if (!userId) {
          const [createdUser] = await tx
            .insert(users)
            .values({ displayName: challenge.requestedDisplayName ?? challenge.normalizedEmail.split("@")[0] ?? "Player" })
            .returning();
          if (!createdUser) throw new Error("account creation failed");
          userId = createdUser.id;
          await tx.insert(userEmails).values({
            userId,
            normalizedEmail: challenge.normalizedEmail,
            verifiedAt: new Date(),
          });
        }
        const [account] = await tx.select().from(users).where(eq(users.id, userId));
        if (!account || account.isSynthetic)
          throw new ApiError(401, "UNAUTHENTICATED", "This sign-in link is invalid or expired");
        await tx.insert(authSessions).values({
          userId,
          tokenHash: tokenHash(sessionToken),
          csrfHash: tokenHash(csrfToken),
          expiresAt: sessionExpiresAt,
        });
        return { account, email: challenge.normalizedEmail, continueTo: challenge.continuePath };
      });
      setSessionCookies(reply, env, sessionToken, csrfToken, sessionExpiresAt);
      reply.header("Cache-Control", "no-store");
      return {
        user: { id: profile.account.id, displayName: profile.account.displayName, email: profile.email },
        continueTo: profile.continueTo,
      };
    },
  );

  app.get("/api/v1/me", async (request) => {
    const userId = requireAuth(request);
    const [profile] = await database.db
      .select({ id: users.id, displayName: users.displayName, email: userEmails.normalizedEmail })
      .from(users)
      .leftJoin(userEmails, eq(userEmails.userId, users.id))
      .where(eq(users.id, userId));
    if (!profile) throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
    const result = await database.db.execute(sql`
      select count(*)::int as wins
      from games g
      join game_players winner on winner.id = g.winner_player_id
      where winner.user_id = ${userId}
        and g.status = 'completed'
        and g.mode = 'multiplayer'
    `);
    const wins = (result[0] as { wins?: number } | undefined)?.wins ?? 0;
    return { user: { ...profile, wins } };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    requireAuth(request);
    const raw = request.cookies[SESSION_COOKIE];
    if (raw)
      await database.db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(eq(authSessions.tokenHash, tokenHash(raw)));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/v1/games", async (request, reply) => {
    const userId = requireAuth(request);
    const random: RandomSource = {
      nextUint32: () => randomBytes(4).readUInt32BE(),
    };
    const rack = generateQualityRack(random, dictionary).rack.join("");
    const created = await database.db.transaction(async (tx) => {
      const [game] = await tx
        .insert(games)
        .values({ rack, rules: DEFAULT_GAME_RULES, createdByUserId: userId })
        .returning();
      if (!game) throw new Error("game insert failed");
      const [player] = await tx
        .insert(gamePlayers)
        .values({ gameId: game.id, userId, seat: 1 })
        .returning();
      if (!player) throw new Error("player insert failed");
      await tx
        .insert(rounds)
        .values({ gameId: game.id, gamePlayerId: player.id });
      return game;
    });
    return reply.status(201).send({ gameId: created.id, version: created.version });
  });

  app.post("/api/v1/games/solo", async (request, reply) => {
    const userId = requireAuth(request);
    z.object({}).strict().parse(request.body ?? {});
    const random: RandomSource = {
      nextUint32: () => randomBytes(4).readUInt32BE(),
    };
    const rack = generateQualityRack(random, dictionary).rack.join("");
    const created = await database.db.transaction(async (tx) => {
      const [kiwi] = await tx
        .insert(users)
        .values({ displayName: "Kiwi", isSynthetic: true })
        .returning();
      if (!kiwi) throw new Error("synthetic opponent insert failed");
      const [game] = await tx
        .insert(games)
        .values({ rack, rules: DEFAULT_GAME_RULES, createdByUserId: userId, status: "in_progress", mode: "solo" })
        .returning();
      if (!game) throw new Error("solo game insert failed");
      const now = new Date();
      const [creator] = await tx
        .insert(gamePlayers)
        .values({ gameId: game.id, userId, seat: 1, status: "ready", readyAt: now })
        .returning();
      const [opponent] = await tx
        .insert(gamePlayers)
        .values({ gameId: game.id, userId: kiwi.id, seat: 2, status: "finished" })
        .returning();
      if (!creator || !opponent) throw new Error("solo players insert failed");
      await tx.insert(rounds).values([
        { gameId: game.id, gamePlayerId: creator.id },
        { gameId: game.id, gamePlayerId: opponent.id, status: "finished", startedAt: now, expiresAt: now, finishedAt: now },
      ]);
      return game;
    });
    return reply.status(201).send({ gameId: created.id, version: created.version });
  });

  app.post(
    "/api/v1/games/:gameId/invitations",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const userId = requireAuth(request);
      const { gameId } = gameParam.parse(request.params);
      const secret = opaqueToken();
      const hash = tokenHash(secret);
      const expiresAt = new Date(
        Date.now() + env.INVITATION_TTL_MINUTES * 60_000,
      );
      const player = await membership(database.db, gameId, userId);
      if (player.seat !== 1)
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Only the game creator can invite",
        );
      const [invitation] = await database.db
        .insert(invitations)
        .values({
          gameId,
          createdByPlayerId: player.id,
          tokenHash: hash,
          expiresAt,
        })
        .returning();
      if (!invitation) throw new Error("invitation insert failed");
      const invitationUrl = new URL("/join", env.PUBLIC_WEB_URL);
      invitationUrl.searchParams.set("token", secret);
      return reply.status(201).send({
        invitationId: invitation.id,
        invitationUrl: invitationUrl.toString(),
        expiresAt,
      });
    },
  );

  app.post(
    "/api/v1/invitations/join",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const userId = requireAuth(request);
      const body = joinBody.parse(request.body);
      const hash = tokenHash(body.token);
      const result = await database.db.transaction(async (tx) => {
        const locked = await tx.execute(
          sql`select * from invitations where token_hash = ${hash} for update`,
        );
        const invitation = locked[0] as
          | {
              id: string;
              game_id: string;
              expires_at: Date;
              used_at: Date | null;
              revoked_at: Date | null;
            }
          | undefined;
        if (
          !invitation ||
          invitation.used_at ||
          invitation.revoked_at ||
          new Date(invitation.expires_at).getTime() <= Date.now()
        )
          throw new ApiError(
            410,
            "INVITATION_UNAVAILABLE",
            "Invitation is invalid, expired, or already used",
          );
        await tx.execute(
          sql`select id from games where id=${invitation.game_id} for update`,
        );
        const existing = await tx
          .select()
          .from(gamePlayers)
          .where(eq(gamePlayers.gameId, invitation.game_id));
        if (existing.some((p) => p.userId === userId))
          throw new ApiError(
            409,
            "ALREADY_JOINED",
            "You already joined this game",
          );
        if (existing.length >= 2)
          throw new ApiError(
            409,
            "GAME_FULL",
            "The game already has two players",
          );
        const [player] = await tx
          .insert(gamePlayers)
          .values({ gameId: invitation.game_id, userId, seat: 2 })
          .returning();
        if (!player) throw new Error("player insert failed");
        await tx
          .insert(rounds)
          .values({ gameId: invitation.game_id, gamePlayerId: player.id });
        await tx
          .update(invitations)
          .set({ usedAt: new Date(), usedByUserId: userId })
          .where(eq(invitations.id, invitation.id));
        await tx
          .update(games)
          .set({
            status: "ready_check",
            version: sql`${games.version}+1`,
            updatedAt: new Date(),
          })
          .where(eq(games.id, invitation.game_id));
        return { gameId: invitation.game_id };
      });
      return reply.status(200).send(result);
    },
  );

  app.get("/api/v1/games/:gameId", async (request) => {
    const userId = requireAuth(request);
    const { gameId } = gameParam.parse(request.params);
    await reconcileGame(database.db, gameId, dictionary);
    return gameState(database.db, gameId, userId, dictionary);
  });

  app.post("/api/v1/games/:gameId/ready", async (request) => {
    const userId = requireAuth(request);
    const { gameId } = gameParam.parse(request.params);
    const body = versionBody.parse(request.body);
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from games where id=${gameId} for update`);
      const [game] = await tx.select().from(games).where(eq(games.id, gameId));
      if (game?.version !== body.expectedVersion)
        throw new ApiError(
          409,
          "STALE_STATE",
          "Game state changed; reload and retry",
        );
      const player = await membership(tx, gameId, userId);
      await tx
        .update(gamePlayers)
        .set({ status: "ready", readyAt: new Date() })
        .where(eq(gamePlayers.id, player.id));
      const members = await tx
        .select()
        .from(gamePlayers)
        .where(eq(gamePlayers.gameId, gameId));
      const allReady =
        members.length === 2 &&
        members.every((p) => p.id === player.id || p.status === "ready");
      await tx
        .update(games)
        .set({
          status: allReady ? "in_progress" : "ready_check",
          version: sql`${games.version}+1`,
          updatedAt: new Date(),
        })
        .where(eq(games.id, gameId));
    });
    return { ok: true };
  });

  app.post("/api/v1/games/:gameId/round/start", async (request) => {
    const userId = requireAuth(request);
    const { gameId } = gameParam.parse(request.params);
    const body = versionBody.parse(request.body);
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from games where id=${gameId} for update`);
      const player = await membership(tx, gameId, userId);
      const locked = await tx.execute(
        sql`select * from rounds where game_player_id=${player.id} for update`,
      );
      const round = locked[0] as { id: string; status: string } | undefined;
      const [game] = await tx.select().from(games).where(eq(games.id, gameId));
      if (game?.version !== body.expectedVersion)
        throw new ApiError(409, "STALE_STATE", "Game state changed; reload and retry");
      if (game.status !== "in_progress" || round?.status !== "not_started")
        throw new ApiError(409, "INVALID_STATE", "Round cannot be started");
      const startedAt = new Date();
      await tx
        .update(rounds)
        .set({
          status: "active",
          startedAt,
          expiresAt: roundExpiresAt(startedAt),
          version: sql`${rounds.version}+1`,
        })
        .where(eq(rounds.id, round.id));
      await tx
        .update(gamePlayers)
        .set({ status: "playing" })
        .where(eq(gamePlayers.id, player.id));
    });
    return { ok: true };
  });

  app.post(
    "/api/v1/games/:gameId/round/submit",
    { config: { rateLimit: { max: 30, timeWindow: "10 seconds" } } },
    async (request) => {
      const userId = requireAuth(request);
      const { gameId } = gameParam.parse(request.params);
      const body = submitBody.parse(request.body);
      const idempotencyKey = uuid.parse(
        body.idempotencyKey ?? request.headers["idempotency-key"],
      );
      return database.db.transaction(async (tx) => {
        const player = await membership(tx, gameId, userId);
        const locked = await tx.execute(
          sql`select *, clock_timestamp() as received_at from rounds where game_player_id=${player.id} for update`,
        );
        const round = locked[0] as
          | {
              id: string;
              status: string;
              expires_at: Date | null;
              received_at: Date;
            }
          | undefined;
        if (!round)
          throw new ApiError(404, "ROUND_NOT_FOUND", "Round not found");
        const [prior] = await tx
          .select()
          .from(wordSubmissions)
          .where(
            and(
              eq(wordSubmissions.roundId, round.id),
              eq(wordSubmissions.idempotencyKey, idempotencyKey),
            ),
          );
        if (prior) {
          if (prior.normalizedWord !== normalizeWord(body.word))
            throw new ApiError(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "Idempotency key was used for another command",
            );
          return submissionDto(prior);
        }
        if (
          round.status !== "active" ||
          !round.expires_at ||
          new Date(round.received_at).getTime() >=
            new Date(round.expires_at).getTime()
        ) {
          if (round.status === "active")
            await tx
              .update(rounds)
              .set({
                status: "expired",
                finishedAt: new Date(round.received_at),
                version: sql`${rounds.version}+1`,
              })
              .where(eq(rounds.id, round.id));
          throw new ApiError(409, "ROUND_EXPIRED", "The round has ended");
        }
        const [game] = await tx
          .select()
          .from(games)
          .where(eq(games.id, gameId));
        if (!game) throw new ApiError(404, "GAME_NOT_FOUND", "Game not found");
        const acceptedRows = await tx
          .select({ word: wordSubmissions.normalizedWord })
          .from(wordSubmissions)
          .where(
            and(
              eq(wordSubmissions.roundId, round.id),
              eq(wordSubmissions.accepted, true),
            ),
          );
        const validation = validateWord({
          word: body.word,
          rack: game.rack,
          dictionary,
          submittedWords: acceptedRows.map((row) => row.word),
        });
        const [saved] = await tx
          .insert(wordSubmissions)
          .values({
            roundId: round.id,
            submittedWord: body.word,
            normalizedWord: validation.normalizedWord,
            accepted: validation.accepted,
            rejectionCode: validation.accepted ? null : validation.code,
            score: validation.accepted ? validation.score : 0,
            idempotencyKey,
            receivedAt: new Date(round.received_at),
          })
          .returning();
        if (!saved) throw new Error("submission insert failed");
        if (validation.accepted)
          await tx
            .update(gamePlayers)
            .set({
              score: sql`${gamePlayers.score}+${validation.score}`,
              validWordCount: sql`${gamePlayers.validWordCount}+1`,
            })
            .where(eq(gamePlayers.id, player.id));
        return submissionDto(saved);
      });
    },
  );

  app.post("/api/v1/games/:gameId/round/finish", async (request) => {
    const userId = requireAuth(request);
    const { gameId } = gameParam.parse(request.params);
    const body = versionBody.parse(request.body);
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from games where id=${gameId} for update`);
      const [game] = await tx.select().from(games).where(eq(games.id, gameId));
      if (game?.version !== body.expectedVersion)
        throw new ApiError(409, "STALE_STATE", "Game state changed; reload and retry");
      const player = await membership(tx, gameId, userId);
      await tx.execute(
        sql`select id from rounds where game_player_id=${player.id} for update`,
      );
      await tx
        .update(rounds)
        .set({
          status: "finished",
          finishedAt: new Date(),
          version: sql`${rounds.version}+1`,
        })
        .where(
          and(eq(rounds.gamePlayerId, player.id), eq(rounds.status, "active")),
        );
      await tx
        .update(gamePlayers)
        .set({ status: "finished" })
        .where(eq(gamePlayers.id, player.id));
    });
    await reconcileGame(database.db, gameId, dictionary);
    return { ok: true };
  });

  app.get("/api/v1/games/:gameId/results", async (request) => {
    const userId = requireAuth(request);
    const { gameId } = gameParam.parse(request.params);
    await reconcileGame(database.db, gameId, dictionary);
    const state = await gameState(database.db, gameId, userId, dictionary);
    if (state.game.status !== "completed")
      throw new ApiError(409, "RESULTS_NOT_READY", "Results are not ready");
    return state;
  });

  app.post("/api/v1/games/:gameId/rematch", async (request, reply) => {
    const userId = requireAuth(request);
    const { gameId } = gameParam.parse(request.params);
    const player = await membership(database.db, gameId, userId);
    const [game] = await database.db
      .select()
      .from(games)
      .where(eq(games.id, gameId));
    if (game?.status !== "completed")
      throw new ApiError(409, "INVALID_STATE", "Game is not complete");
    const [syntheticOpponent] = await database.db
      .select({ id: users.id })
      .from(gamePlayers)
      .innerJoin(users, eq(users.id, gamePlayers.userId))
      .where(
        and(
          eq(gamePlayers.gameId, gameId),
          eq(users.isSynthetic, true),
        ),
      );
    if (syntheticOpponent)
      throw new ApiError(
        409,
        "INVALID_STATE",
        "Start a new solo game instead of requesting a rematch",
      );
    const [requestRow] = await database.db
      .insert(rematchRequests)
      .values({ sourceGameId: gameId, requestedByPlayerId: player.id })
      .onConflictDoNothing()
      .returning();
    return reply
      .status(requestRow ? 201 : 200)
      .send({ requestId: requestRow?.id ?? null });
  });

  app.post("/api/v1/games/:gameId/rematch/accept", async (request) => {
    const userId = requireAuth(request);
    const { gameId } = gameParam.parse(request.params);
    const { requestId } = idBody.parse(request.body);
    return database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from games where id=${gameId} for update`);
      const player = await membership(tx, gameId, userId);
      const locked = await tx.execute(
        sql`select * from rematch_requests where id=${requestId} and source_game_id=${gameId} for update`,
      );
      const requestRow = locked[0] as
        | {
            id: string;
            requested_by_player_id: string;
            status: string;
            resulting_game_id: string | null;
          }
        | undefined;
      if (!requestRow)
        throw new ApiError(
          404,
          "REMATCH_NOT_FOUND",
          "Rematch request not found",
        );
      if (requestRow.requested_by_player_id === player.id)
        throw new ApiError(
          403,
          "FORBIDDEN",
          "The other player must accept the rematch",
        );
      if (requestRow.resulting_game_id)
        return { gameId: requestRow.resulting_game_id };
      const oldPlayers = await tx
        .select()
        .from(gamePlayers)
        .where(eq(gamePlayers.gameId, gameId))
        .orderBy(asc(gamePlayers.seat));
      if (oldPlayers.length !== 2)
        throw new ApiError(409, "INVALID_STATE", "Game players are incomplete");
      const random: RandomSource = {
        nextUint32: () => randomBytes(4).readUInt32BE(),
      };
      const [newGame] = await tx
        .insert(games)
        .values({
          rack: generateQualityRack(random, dictionary).rack.join(""),
          rules: DEFAULT_GAME_RULES,
          createdByUserId: userId,
          parentGameId: gameId,
          status: "ready_check",
        })
        .returning();
      if (!newGame) throw new Error("rematch game insert failed");
      for (const old of oldPlayers) {
        const [createdPlayer] = await tx
          .insert(gamePlayers)
          .values({ gameId: newGame.id, userId: old.userId, seat: old.seat })
          .returning();
        if (createdPlayer)
          await tx
            .insert(rounds)
            .values({ gameId: newGame.id, gamePlayerId: createdPlayer.id });
      }
      await tx
        .update(rematchRequests)
        .set({
          status: "accepted",
          resultingGameId: newGame.id,
          resolvedAt: new Date(),
        })
        .where(eq(rematchRequests.id, requestId));
      return { gameId: newGame.id };
    });
  });

  return app;
}

async function authenticate(request: FastifyRequest, db: Db): Promise<void> {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return;
  const [session] = await db
    .select({
      userId: authSessions.userId,
      csrfHash: authSessions.csrfHash,
      expiresAt: authSessions.expiresAt,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, tokenHash(raw)),
        isNull(authSessions.revokedAt),
        eq(users.isSynthetic, false),
      ),
    );
  if (!session || session.expiresAt.getTime() <= Date.now()) return;
  request.authUserId = session.userId;
  request.csrfHash = session.csrfHash;
}
function requireAuth(request: FastifyRequest): string {
  if (!request.authUserId)
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  return request.authUserId;
}
async function membership(db: Db | Tx, gameId: string, userId: string) {
  const [player] = await db
    .select()
    .from(gamePlayers)
    .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, userId)));
  if (!player) throw new ApiError(404, "GAME_NOT_FOUND", "Game not found");
  return player;
}
function submissionDto(row: typeof wordSubmissions.$inferSelect) {
  return {
    accepted: row.accepted,
    normalizedWord: row.normalizedWord,
    score: row.score,
    rejectionCode: row.rejectionCode,
    receivedAt: row.receivedAt,
  };
}

async function reconcileGame(
  db: Db,
  gameId: string,
  dictionary: WordDictionary,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from games where id=${gameId} for update`);
    const now = new Date();
    await tx
      .update(rounds)
      .set({
        status: "expired",
        finishedAt: now,
        version: sql`${rounds.version}+1`,
      })
      .where(
        and(
          eq(rounds.gameId, gameId),
          eq(rounds.status, "active"),
          sql`${rounds.expiresAt} <= clock_timestamp()`,
        ),
      );
    const gameRounds = await tx
      .select()
      .from(rounds)
      .where(eq(rounds.gameId, gameId));
    if (
      gameRounds.length !== 2 ||
      !gameRounds.every(
        (round) => round.status === "finished" || round.status === "expired",
      )
    )
      return;
    const [game] = await tx.select().from(games).where(eq(games.id, gameId));
    if (!game || game.status === "completed") return;
    const players = await tx
      .select()
      .from(gamePlayers)
      .where(eq(gamePlayers.gameId, gameId))
      .orderBy(asc(gamePlayers.seat));
    if (players.length !== 2) return;
    const all = await tx
      .select()
      .from(wordSubmissions)
      .where(
        and(
          inArray(
            wordSubmissions.roundId,
            gameRounds.map((round) => round.id),
          ),
          eq(wordSubmissions.accepted, true),
        ),
      );
    for (const player of players) {
      const round = gameRounds.find((item) => item.gamePlayerId === player.id);
      const own = all.filter((item) => item.roundId === round?.id);
      await tx
        .update(gamePlayers)
        .set({
          status: "finished",
          score: own.reduce((sum, item) => sum + item.score, 0),
          validWordCount: own.length,
        })
        .where(eq(gamePlayers.id, player.id));
    }
    const refreshed = await tx
      .select()
      .from(gamePlayers)
      .where(eq(gamePlayers.gameId, gameId))
      .orderBy(asc(gamePlayers.seat));
    const first = refreshed[0];
    const second = refreshed[1];
    if (!first || !second) return;
    const result = resolveResult(
      {
        playerId: first.id,
        score: first.score,
        validWordCount: first.validWordCount,
      },
      {
        playerId: second.id,
        score: second.score,
        validWordCount: second.validWordCount,
      },
    );
    await tx
      .update(games)
      .set({
        status: "completed",
        winnerPlayerId: result.outcome === "win" ? result.winnerId : null,
        finalizedAt: now,
        version: sql`${games.version}+1`,
        updatedAt: now,
      })
      .where(eq(games.id, gameId));
    void dictionary;
  });
}

export async function sweepExpiredGames(
  db: Db,
  dictionary: WordDictionary,
): Promise<number> {
  const due = await db.execute(sql`
    select distinct game_id
    from rounds
    where status = 'active' and expires_at <= clock_timestamp()
    order by game_id
    limit 100
  `);
  for (const row of due) {
    const gameId = (row as { game_id: string }).game_id;
    await reconcileGame(db, gameId, dictionary);
  }
  return due.length;
}

async function gameState(
  db: Db,
  gameId: string,
  userId: string,
  dictionary: WordDictionary,
) {
  const me = await membership(db, gameId, userId);
  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  if (!game) throw new ApiError(404, "GAME_NOT_FOUND", "Game not found");
  const players = await db
    .select({
      id: gamePlayers.id,
      userId: gamePlayers.userId,
      seat: gamePlayers.seat,
      status: gamePlayers.status,
      score: gamePlayers.score,
      validWordCount: gamePlayers.validWordCount,
      displayName: users.displayName,
    })
    .from(gamePlayers)
    .innerJoin(users, eq(users.id, gamePlayers.userId))
    .where(eq(gamePlayers.gameId, gameId))
    .orderBy(asc(gamePlayers.seat));
  const gameRounds = await db
    .select()
    .from(rounds)
    .where(eq(rounds.gameId, gameId));
  const myRound = gameRounds.find((round) => round.gamePlayerId === me.id);
  const ownWords = myRound
    ? await db
        .select()
        .from(wordSubmissions)
        .where(
          and(
            eq(wordSubmissions.roundId, myRound.id),
            eq(wordSubmissions.accepted, true),
          ),
        )
        .orderBy(asc(wordSubmissions.receivedAt))
    : [];
  const completed = game.status === "completed";
  const resultWords = completed
    ? await db
        .select()
        .from(wordSubmissions)
        .where(
          and(
            inArray(
              wordSubmissions.roundId,
              gameRounds.map((r) => r.id),
            ),
            eq(wordSubmissions.accepted, true),
          ),
        )
    : [];
  const currentPlayer = players.find((player) => player.id === me.id);
  if (!currentPlayer || !myRound)
    throw new ApiError(500, "INTERNAL_ERROR", "Game membership is incomplete");
  const opponent = players.find((player) => player.id !== me.id);
  const opponentRound = opponent
    ? gameRounds.find((round) => round.gamePlayerId === opponent.id)
    : undefined;
  const rematches = await db
    .select()
    .from(rematchRequests)
    .where(eq(rematchRequests.sourceGameId, gameId));
  const pendingRematch = rematches.find((row) => row.status === "requested");
  const acceptedRematch = rematches.find((row) => row.status === "accepted");
  const rematchStatus = acceptedRematch
    ? "accepted"
    : pendingRematch?.requestedByPlayerId === me.id
      ? "requested_by_you"
      : pendingRematch
        ? "requested_by_opponent"
        : "none";
  const serverTime = new Date().toISOString();
  void opponentRound;
  void rematchStatus;
  void acceptedRematch;
  const results = completed
    ? players.map((player) => {
        const round = gameRounds.find((item) => item.gamePlayerId === player.id);
        const words = resultWords
          .filter((word) => word.roundId === round?.id)
          .map((word) => word.normalizedWord);
        return {
          playerId: player.id,
          displayName: player.displayName,
          score: player.score,
          validWordCount: player.validWordCount,
          words,
          missedWords: enumerateMissedWords({ rack: game.rack, dictionary, submittedWords: words }),
        };
      })
    : undefined;
  return {
    serverNow: serverTime,
    game: {
      id: game.id,
      status: game.status,
      version: game.version,
      rack: myRound.status === "not_started" ? null : game.rack,
      winnerPlayerId: completed ? game.winnerPlayerId : undefined,
    },
    me: {
      id: currentPlayer.id,
      userId: currentPlayer.userId,
      seat: currentPlayer.seat,
      status: currentPlayer.status,
      score: currentPlayer.score,
      validWordCount: currentPlayer.validWordCount,
      displayName: currentPlayer.displayName,
      round: {
        status: myRound.status,
        startedAt: myRound.startedAt?.toISOString() ?? null,
        expiresAt: myRound.expiresAt?.toISOString() ?? null,
        version: myRound.version,
      },
      words: ownWords.map((word) => ({ word: word.normalizedWord, score: word.score })),
    },
    opponent: opponent
      ? {
          id: opponent.id,
          userId: opponent.userId,
          seat: opponent.seat,
          displayName: opponent.displayName,
          status: opponent.status,
        }
      : undefined,
    results,
    pendingRematch: pendingRematch
      ? {
          id: pendingRematch.id,
          requestedByPlayerId: pendingRematch.requestedByPlayerId,
          canAccept: pendingRematch.requestedByPlayerId !== me.id,
        }
      : undefined,
  };
}
