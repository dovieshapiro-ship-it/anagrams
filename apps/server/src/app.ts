import { randomBytes, randomInt, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
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
  emailLoginCodes,
  friendGameInvites,
  friendships,
  gamePlayers,
  games,
  invitations,
  magicLinkChallenges,
  passwordResetChallenges,
  passwordCredentials,
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
const reservedUsernames = new Set([
  "admin", "administrator", "kiwi", "kiwigames", "moderator", "support", "system",
]);
const usernameSchema = z
  .string()
  .regex(/^[a-z0-9_]{3,20}$/u)
  .refine((value) => !reservedUsernames.has(value), "This username is reserved");
const usernameBody = z.object({ username: usernameSchema }).strict();
const usernameQuery = z.object({ username: usernameSchema }).strict();
const friendInviteBody = z.object({ friendUserId: uuid }).strict();
const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const magicLinkRequestBody = z
  .object({
    email,
    displayName: z.string().trim().min(1).max(40).optional(),
    username: usernameSchema.optional(),
    continuePath: z.string().max(512).optional(),
  })
  .strict();
const magicLinkConsumeBody = z.object({ token: z.string().min(20).max(256) }).strict();
const password = z.string().min(8).max(128);
const passwordSignupBody = z.object({
  displayName: z.string().trim().min(1).max(40),
  username: usernameSchema,
  email,
  password,
}).strict();
const passwordLoginBody = z.object({ email: z.string().trim().min(3).max(254).transform((value) => value.toLowerCase()), password }).strict();
const forgotPasswordBody = z.object({ email }).strict();
const resetPasswordBody = z.object({ token: z.string().min(20).max(256), password }).strict();
const requestLoginCodeBody = z.object({ email }).strict();
const consumeLoginCodeBody = z.object({ challengeToken: z.string().min(20).max(256), code: z.string().regex(/^\d{6}$/u) }).strict();
const passwordBody = z.object({ password }).strict();

const scrypt = promisify(nodeScrypt);

async function hashPassword(value: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(value, salt, 64) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(value: string, stored: string): Promise<boolean> {
  const [algorithm, saltText, hashText] = stored.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = await scrypt(value, Buffer.from(saltText, "base64url"), expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

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
    methods: ["GET", "POST", "DELETE"],
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
      request.url === "/api/v1/auth/password/signup" ||
      request.url === "/api/v1/auth/password/login" ||
      request.url === "/api/v1/auth/password/forgot" ||
      request.url === "/api/v1/auth/password/reset" ||
      request.url === "/api/v1/auth/code/request" ||
      request.url === "/api/v1/auth/code/consume" ||
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

  async function issuePasswordSession(userId: string, reply: FastifyReply): Promise<void> {
    const sessionToken = opaqueToken();
    const csrfToken = opaqueToken();
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);
    await database.db.insert(authSessions).values({
      userId,
      tokenHash: tokenHash(sessionToken),
      csrfHash: tokenHash(csrfToken),
      expiresAt,
    });
    setSessionCookies(reply, env, sessionToken, csrfToken, expiresAt);
  }

  app.post("/api/v1/auth/password/signup", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (request, reply) => {
    const body = passwordSignupBody.parse(request.body);
    const [existing] = await database.db.select({ id: users.id }).from(users).where(eq(users.username, body.username));
    if (existing) throw new ApiError(409, "USERNAME_UNAVAILABLE", "That username is already taken");
    const [existingEmail] = await database.db.select({ id: userEmails.id }).from(userEmails).where(eq(userEmails.normalizedEmail, body.email));
    if (existingEmail) throw new ApiError(409, "EMAIL_UNAVAILABLE", "An account already uses that email");
    const passwordHash = await hashPassword(body.password);
    const account = await database.db.transaction(async (tx) => {
      const [created] = await tx.insert(users).values({ displayName: body.displayName, username: body.username }).returning();
      if (!created) throw new Error("account creation failed");
      await tx.insert(passwordCredentials).values({ userId: created.id, passwordHash });
      await tx.insert(userEmails).values({ userId: created.id, normalizedEmail: body.email, verifiedAt: new Date() });
      return created;
    });
    await issuePasswordSession(account.id, reply);
    return reply.status(201).send({ user: { id: account.id, displayName: account.displayName, username: account.username } });
  });

  app.post("/api/v1/auth/password/login", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = passwordLoginBody.parse(request.body);
    const base = database.db
      .select({ id: users.id, displayName: users.displayName, username: users.username, passwordHash: passwordCredentials.passwordHash })
      .from(users)
      .innerJoin(passwordCredentials, eq(passwordCredentials.userId, users.id));
    const [account] = body.email.includes("@")
      ? await base.innerJoin(userEmails, eq(userEmails.userId, users.id)).where(eq(userEmails.normalizedEmail, email.parse(body.email)))
      : await base.where(eq(users.username, usernameSchema.parse(body.email)));
    if (!account || !(await verifyPassword(body.password, account.passwordHash)))
      throw new ApiError(401, "UNAUTHENTICATED", "Email or password is incorrect");
    await issuePasswordSession(account.id, reply);
    return { user: { id: account.id, displayName: account.displayName, username: account.username } };
  });

  app.post("/api/v1/auth/password/forgot", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = forgotPasswordBody.parse(request.body);
    const [account] = await database.db
      .select({ userId: userEmails.userId })
      .from(userEmails)
      .innerJoin(passwordCredentials, eq(passwordCredentials.userId, userEmails.userId))
      .where(eq(userEmails.normalizedEmail, body.email));
    if (account && env.RESEND_API_KEY && env.EMAIL_FROM) {
      const token = opaqueToken();
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await database.db.transaction(async (tx) => {
        await tx.update(passwordResetChallenges).set({ consumedAt: new Date() }).where(and(eq(passwordResetChallenges.userId, account.userId), isNull(passwordResetChallenges.consumedAt)));
        await tx.insert(passwordResetChallenges).values({ userId: account.userId, tokenHash: tokenHash(token), expiresAt });
      });
      const resetUrl = `${env.PUBLIC_WEB_URL}/#reset=${encodeURIComponent(token)}`;
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: [body.email],
          subject: "Reset your KiwiGames password",
          text: `Reset your KiwiGames password: ${resetUrl}\n\nThis link expires in 15 minutes and can only be used once.`,
          html: `<p>Reset your KiwiGames password:</p><p><a href="${resetUrl}">Create a new password</a></p><p>This link expires in 15 minutes and can only be used once.</p>`,
        }),
      });
      if (!response.ok) request.log.error({ status: response.status }, "Resend password reset email failed");
    }
    reply.header("Cache-Control", "no-store");
    return reply.status(202).send({ accepted: true });
  });

  app.post("/api/v1/auth/password/reset", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = resetPasswordBody.parse(request.body);
    const passwordHash = await hashPassword(body.password);
    const userId = await database.db.transaction(async (tx) => {
      const [challenge] = await tx.update(passwordResetChallenges).set({ consumedAt: new Date() }).where(and(eq(passwordResetChallenges.tokenHash, tokenHash(body.token)), isNull(passwordResetChallenges.consumedAt), gt(passwordResetChallenges.expiresAt, new Date()))).returning({ userId: passwordResetChallenges.userId });
      if (!challenge) throw new ApiError(401, "RESET_INVALID", "This reset link is invalid or expired");
      await tx.update(passwordCredentials).set({ passwordHash, updatedAt: new Date() }).where(eq(passwordCredentials.userId, challenge.userId));
      await tx.delete(authSessions).where(eq(authSessions.userId, challenge.userId));
      return challenge.userId;
    });
    await issuePasswordSession(userId, reply);
    return { user: { id: userId } };
  });

  app.post("/api/v1/auth/code/request", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = requestLoginCodeBody.parse(request.body);
    const challengeToken = opaqueToken();
    const [account] = await database.db.select({ userId: userEmails.userId }).from(userEmails).where(eq(userEmails.normalizedEmail, body.email));
    if (account && env.RESEND_API_KEY && env.EMAIL_FROM) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      await database.db.transaction(async (tx) => {
        await tx.update(emailLoginCodes).set({ consumedAt: new Date() }).where(and(eq(emailLoginCodes.userId, account.userId), isNull(emailLoginCodes.consumedAt)));
        await tx.insert(emailLoginCodes).values({ userId: account.userId, challengeHash: tokenHash(challengeToken), codeHash: tokenHash(code), expiresAt });
      });
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [body.email], subject: "Your KiwiGames login code", text: `Your KiwiGames code is ${code}. It expires in 10 minutes.`, html: `<p>Your KiwiGames login code is:</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px">${code}</p><p>It expires in 10 minutes.</p>` }),
      });
      if (!response.ok) request.log.error({ status: response.status }, "Resend login code email failed");
    }
    reply.header("Cache-Control", "no-store");
    return reply.status(202).send({ accepted: true, challengeToken });
  });

  app.post("/api/v1/auth/code/consume", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = consumeLoginCodeBody.parse(request.body);
    const result = await database.db.transaction(async (tx) => {
      const [challenge] = await tx.select().from(emailLoginCodes).where(and(eq(emailLoginCodes.challengeHash, tokenHash(body.challengeToken)), isNull(emailLoginCodes.consumedAt), gt(emailLoginCodes.expiresAt, new Date())));
      if (!challenge || challenge.attempts >= 5) return { userId: null, valid: false } as const;
      if (challenge.codeHash !== tokenHash(body.code)) {
        await tx.update(emailLoginCodes).set({ attempts: challenge.attempts + 1 }).where(eq(emailLoginCodes.id, challenge.id));
        return { userId: null, valid: false } as const;
      }
      await tx.update(emailLoginCodes).set({ consumedAt: new Date() }).where(eq(emailLoginCodes.id, challenge.id));
      return { userId: challenge.userId, valid: true } as const;
    });
    if (!result.valid) throw new ApiError(401, "CODE_INVALID", "That code is invalid or expired");
    await issuePasswordSession(result.userId, reply);
    return { user: { id: result.userId } };
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
    {
      config: {
        rateLimit: {
          // Keep production conservative, but do not lock the owner out while
          // repeatedly testing the local/tunnel login flow.
          max: env.NODE_ENV === "production" ? 5 : 100,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const body = magicLinkRequestBody.parse(request.body);
      const continuePath = safeContinuePath(body.continuePath);
      if (body.username) {
        const [taken] = await database.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, body.username));
        if (taken)
          throw new ApiError(409, "USERNAME_UNAVAILABLE", "That username is already taken");
      }
      const rawToken = opaqueToken();
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await database.db.insert(magicLinkChallenges).values({
        tokenHash: tokenHash(rawToken),
        normalizedEmail: body.email,
        requestedDisplayName: body.displayName,
        requestedUsername: body.username,
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
            .values({
              displayName: challenge.requestedDisplayName ?? challenge.normalizedEmail.split("@")[0] ?? "Player",
              username: challenge.requestedUsername,
            })
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
        user: { id: profile.account.id, displayName: profile.account.displayName, username: profile.account.username, email: profile.email },
        continueTo: profile.continueTo,
      };
    },
  );

  app.get("/api/v1/me", async (request) => {
    const userId = requireAuth(request);
    const [profile] = await database.db
      .select({ id: users.id, displayName: users.displayName, username: users.username, email: userEmails.normalizedEmail, hasPassword: sql<boolean>`${passwordCredentials.userId} is not null` })
      .from(users)
      .leftJoin(userEmails, eq(userEmails.userId, users.id))
      .leftJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
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

  app.get("/api/v1/leaderboard", async (request) => {
    const userId = requireAuth(request);
    const topRows = await database.db.execute(sql`
      select u.id as user_id,
             u.display_name,
             u.username,
             max(gp.score)::int as high_score
      from game_players gp
      join games g on g.id = gp.game_id
      join users u on u.id = gp.user_id
      where g.status = 'completed'
        and u.is_synthetic = false
        and u.username is not null
      group by u.id, u.display_name, u.username
      order by high_score desc, u.username asc
      limit 5
    `);
    const ownRows = await database.db.execute(sql`
      select coalesce(max(gp.score), 0)::int as high_score
      from game_players gp
      join games g on g.id = gp.game_id
      where gp.user_id = ${userId}
        and g.status = 'completed'
    `);
    const leaderboardUserIds = topRows.map((row) => String(row.user_id));
    const relationships = leaderboardUserIds.length === 0
      ? []
      : await database.db
          .select()
          .from(friendships)
          .where(
            and(
              inArray(friendships.userAId, [userId, ...leaderboardUserIds]),
              inArray(friendships.userBId, [userId, ...leaderboardUserIds]),
            ),
          );
    const relationshipFor = (otherUserId: string): "self" | "friend" | "incoming" | "outgoing" | "none" => {
      if (otherUserId === userId) return "self";
      const relationship = relationships.find(
        (item) =>
          (item.userAId === userId && item.userBId === otherUserId) ||
          (item.userBId === userId && item.userAId === otherUserId),
      );
      if (relationship?.status === "accepted") return "friend";
      if (relationship?.status === "pending")
        return relationship.requestedByUserId === userId ? "outgoing" : "incoming";
      return "none";
    };
    return {
      highScore: Number(ownRows[0]?.high_score ?? 0),
      leaders: topRows.map((row, index) => ({
        rank: index + 1,
        userId: String(row.user_id),
        displayName: String(row.display_name),
        username: String(row.username),
        highScore: Number(row.high_score),
        relationship: relationshipFor(String(row.user_id)),
      })),
    };
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

  app.post("/api/v1/me/username", async (request) => {
    const userId = requireAuth(request);
    const { username } = usernameBody.parse(request.body);
    try {
      const [updated] = await database.db
        .update(users)
        .set({ username, updatedAt: new Date() })
        .where(and(eq(users.id, userId), eq(users.isSynthetic, false), isNull(users.username)))
        .returning({ id: users.id, displayName: users.displayName, username: users.username });
      if (!updated) throw new ApiError(409, "INVALID_STATE", "Your username has already been set");
      return { user: updated };
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ApiError(409, "USERNAME_UNAVAILABLE", "Username is unavailable");
      throw error;
    }
  });

  app.post("/api/v1/me/password", async (request) => {
    const userId = requireAuth(request);
    const body = passwordBody.parse(request.body);
    const [existing] = await database.db.select({ userId: passwordCredentials.userId }).from(passwordCredentials).where(eq(passwordCredentials.userId, userId));
    if (existing) throw new ApiError(409, "INVALID_STATE", "This account already has a password");
    await database.db.insert(passwordCredentials).values({ userId, passwordHash: await hashPassword(body.password) });
    return { ok: true };
  });

  app.get(
    "/api/v1/friends/search",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const userId = requireAuth(request);
      const { username } = usernameQuery.parse(request.query);
      const [found] = await database.db
        .select({ id: users.id, displayName: users.displayName, username: users.username })
        .from(users)
        .where(and(eq(users.username, username), eq(users.isSynthetic, false)));
      if (!found)
        return { user: null, relationship: "none" as const };
      const publicUser = {
        userId: found.id,
        displayName: found.displayName,
        username: found.username ?? "",
      };
      if (found.id === userId)
        return { user: publicUser, relationship: "self" as const };
      const [low, high] = canonicalPair(userId, found.id);
      const [relationship] = await database.db
        .select()
        .from(friendships)
        .where(and(eq(friendships.userAId, low), eq(friendships.userBId, high)));
      const relationshipState = relationship?.status === "accepted"
        ? "friend"
        : relationship?.status === "pending"
          ? relationship.requestedByUserId === userId
            ? "outgoing"
            : "incoming"
          : "none";
      return { user: publicUser, relationship: relationshipState };
    },
  );

  app.get("/api/v1/friends", async (request) => {
    const userId = requireAuth(request);
    const rows = await database.db.execute(sql`
      select f.id, f.status, f.requested_by_user_id,
             u.id as user_id, u.display_name, u.username
      from friendships f
      join users u on u.id = case when f.user_low_id=${userId} then f.user_high_id else f.user_low_id end
      where (f.user_low_id=${userId} or f.user_high_id=${userId})
      order by u.username nulls last, u.display_name
    `);
    const userSummary = (row: Record<string, unknown>) => ({
      userId: String(row.user_id),
      displayName: String(row.display_name),
      username: typeof row.username === "string" ? row.username : "",
    });
    const requestSummary = (row: Record<string, unknown>) => ({
      id: String(row.id),
      user: userSummary(row),
    });
    return {
      friends: rows.filter((row) => row.status === "accepted").map(userSummary),
      incomingRequests: rows.filter((row) => row.status === "pending" && row.requested_by_user_id !== userId).map(requestSummary),
      outgoingRequests: rows.filter((row) => row.status === "pending" && row.requested_by_user_id === userId).map(requestSummary),
    };
  });

  app.post(
    "/api/v1/friends/requests",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const userId = requireAuth(request);
      const { username } = usernameBody.parse(request.body);
      const [recipient] = await database.db.select({ id: users.id }).from(users).where(and(eq(users.username, username), eq(users.isSynthetic, false)));
      if (!recipient || recipient.id === userId)
        throw new ApiError(404, "NOT_FOUND", "User not found");
      const [low, high] = canonicalPair(userId, recipient.id);
      const relationship = await database.db.transaction(async (tx) => {
        await tx.insert(friendships).values({ userAId: low, userBId: high, requestedByUserId: userId }).onConflictDoNothing();
        const locked = await tx.execute(sql`select * from friendships where user_low_id=${low} and user_high_id=${high} for update`);
        const row = locked[0] as { id: string; status: string; requested_by_user_id: string } | undefined;
        if (!row) throw new Error("friend relationship insert failed");
        if (row.status === "accepted") return { id: row.id, status: "accepted" };
        if (row.status === "pending" && row.requested_by_user_id !== userId) {
          await tx.update(friendships).set({ status: "accepted", resolvedAt: new Date() }).where(eq(friendships.id, row.id));
          return { id: row.id, status: "accepted" };
        }
        if (row.status === "declined")
          await tx.update(friendships).set({ status: "pending", requestedByUserId: userId, resolvedAt: null, createdAt: new Date() }).where(eq(friendships.id, row.id));
        return { id: row.id, status: "pending" };
      });
      return reply.status(relationship.status === "accepted" ? 200 : 201).send({ ok: true });
    },
  );

  app.post("/api/v1/friends/requests/:requestId/accept", async (request) => {
    const userId = requireAuth(request);
    const { requestId } = idBody.parse(request.params);
    await resolveFriendRequest(database.db, requestId, userId, "accepted");
    return { ok: true };
  });

  app.post("/api/v1/friends/requests/:requestId/decline", async (request) => {
    const userId = requireAuth(request);
    const { requestId } = idBody.parse(request.params);
    await resolveFriendRequest(database.db, requestId, userId, "declined");
    return { ok: true };
  });

  app.delete("/api/v1/friends/:friendUserId", async (request) => {
    const userId = requireAuth(request);
    const { friendUserId } = friendInviteBody.parse(request.params);
    const [low, high] = canonicalPair(userId, friendUserId);
    const removed = await database.db.delete(friendships).where(and(eq(friendships.userAId, low), eq(friendships.userBId, high), eq(friendships.status, "accepted"))).returning({ id: friendships.id });
    if (removed.length === 0) throw new ApiError(404, "NOT_FOUND", "Friendship not found");
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
    "/api/v1/games/:gameId/friend-invitations",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const userId = requireAuth(request);
      const { gameId } = gameParam.parse(request.params);
      const { friendUserId } = friendInviteBody.parse(request.body);
      const player = await membership(database.db, gameId, userId);
      if (player.seat !== 1) throw new ApiError(403, "FORBIDDEN", "Only the creator can invite");
      const [game] = await database.db.select().from(games).where(eq(games.id, gameId));
      if (game?.status !== "waiting_for_opponent" || game.mode !== "multiplayer")
        throw new ApiError(409, "INVALID_STATE", "Game is not accepting invitations");
      if (!(await areFriends(database.db, userId, friendUserId)))
        throw new ApiError(403, "FORBIDDEN", "Only friends can receive this invitation");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      const created = await database.db.transaction(async (tx) => {
        const [lowUserId, highUserId] = [userId, friendUserId].sort();
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${lowUserId}), hashtext(${highUserId}))`,
        );
        const now = new Date();
        const superseded = await tx
          .select({ gameId: friendGameInvites.gameId })
          .from(friendGameInvites)
          .where(
            and(
              eq(friendGameInvites.inviterUserId, userId),
              eq(friendGameInvites.recipientUserId, friendUserId),
              eq(friendGameInvites.status, "pending"),
            ),
          );
        await tx
          .update(friendGameInvites)
          .set({ status: "declined", resolvedAt: now })
          .where(
            and(
              eq(friendGameInvites.inviterUserId, userId),
              eq(friendGameInvites.recipientUserId, friendUserId),
              eq(friendGameInvites.status, "pending"),
            ),
          );
        for (const old of superseded) {
          if (old.gameId !== gameId)
            await tx.delete(games).where(eq(games.id, old.gameId));
        }
        const inverseRows = await tx.execute(sql`
          select fgi.* from friend_game_invites fgi
          join games g on g.id=fgi.game_id
          where fgi.inviter_user_id=${friendUserId}
            and fgi.recipient_user_id=${userId}
            and fgi.status='pending'
            and fgi.expires_at > now()
            and g.status='waiting_for_opponent'
          order by fgi.created_at desc
          limit 1
          for update
        `);
        const inverse = inverseRows[0] as
          | { id: string; game_id: string; expires_at: Date }
          | undefined;
        if (inverse) {
          await tx.execute(sql`select id from games where id=${inverse.game_id} for update`);
          const existing = await tx
            .select()
            .from(gamePlayers)
            .where(eq(gamePlayers.gameId, inverse.game_id));
          if (!existing.some((entry) => entry.userId === userId) && existing.length < 2) {
            const [joined] = await tx
              .insert(gamePlayers)
              .values({ gameId: inverse.game_id, userId, seat: 2 })
              .returning();
            if (!joined) throw new Error("crossed invitation join failed");
            await tx.insert(rounds).values({ gameId: inverse.game_id, gamePlayerId: joined.id });
            await tx
              .update(friendGameInvites)
              .set({ status: "accepted", resolvedAt: now })
              .where(eq(friendGameInvites.id, inverse.id));
            await tx
              .update(games)
              .set({ status: "ready_check", version: sql`${games.version}+1`, updatedAt: now })
              .where(eq(games.id, inverse.game_id));
            if (gameId !== inverse.game_id)
              await tx.delete(games).where(eq(games.id, gameId));
            return {
              id: inverse.id,
              gameId: inverse.game_id,
              expiresAt: new Date(inverse.expires_at),
            };
          }
        }
        const [invitation] = await tx
          .insert(friendGameInvites)
          .values({ gameId, inviterUserId: userId, recipientUserId: friendUserId, expiresAt })
          .onConflictDoNothing()
          .returning();
        if (!invitation)
          throw new ApiError(409, "INVALID_STATE", "A pending invitation already exists");
        return invitation;
      });
      return reply.status(201).send({
        invite: {
          id: created.id,
          gameId: created.gameId,
          friendUserId,
          expiresAt: created.expiresAt.toISOString(),
        },
      });
    },
  );

  app.get("/api/v1/games/:gameId/friend-invitation", async (request) => {
    const userId = requireAuth(request);
    const { gameId } = gameParam.parse(request.params);
    const player = await membership(database.db, gameId, userId);
    const [row] = await database.db
      .select({
        userId: users.id,
        displayName: users.displayName,
        username: users.username,
        status: friendGameInvites.status,
      })
      .from(friendGameInvites)
      .innerJoin(
        users,
        eq(
          users.id,
          player.seat === 1
            ? friendGameInvites.recipientUserId
            : friendGameInvites.inviterUserId,
        ),
      )
      .where(
        and(
          eq(friendGameInvites.gameId, gameId),
          player.seat === 1
            ? eq(friendGameInvites.inviterUserId, userId)
            : eq(friendGameInvites.recipientUserId, userId),
        ),
      )
      .orderBy(sql`${friendGameInvites.createdAt} desc`)
      .limit(1);
    return {
      friend: row?.username
        ? { userId: row.userId, displayName: row.displayName, username: row.username }
        : null,
      status: row?.status ?? null,
    };
  });

  app.get("/api/v1/friend-invitations", async (request) => {
    const userId = requireAuth(request);
    const rows = await database.db
      .select({ id: friendGameInvites.id, gameId: friendGameInvites.gameId, expiresAt: friendGameInvites.expiresAt, inviterId: users.id, inviterDisplayName: users.displayName, inviterUsername: users.username })
      .from(friendGameInvites)
      .innerJoin(users, eq(users.id, friendGameInvites.inviterUserId))
      .innerJoin(games, eq(games.id, friendGameInvites.gameId))
      .where(and(eq(friendGameInvites.recipientUserId, userId), eq(friendGameInvites.status, "pending"), gt(friendGameInvites.expiresAt, new Date()), eq(games.status, "waiting_for_opponent")));
    return { invitations: rows.map((row) => ({ id: row.id, gameId: row.gameId, expiresAt: row.expiresAt.toISOString(), inviter: { userId: row.inviterId, displayName: row.inviterDisplayName, username: row.inviterUsername } })) };
  });

  app.post("/api/v1/friend-invitations/:inviteId/accept", async (request) => {
    const userId = requireAuth(request);
    const { inviteId } = z.object({ inviteId: uuid }).strict().parse(request.params);
    const result = await database.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select * from friend_game_invites where id=${inviteId} for update`);
      const invite = locked[0] as { id: string; game_id: string; inviter_user_id: string; recipient_user_id: string; status: string; expires_at: Date } | undefined;
      if (invite?.recipient_user_id !== userId) throw new ApiError(404, "NOT_FOUND", "Invitation not found");
      if (invite.status !== "pending" || new Date(invite.expires_at).getTime() <= Date.now()) throw new ApiError(410, "INVITATION_EXPIRED", "Invitation is no longer available");
      if (!(await areFriends(tx, invite.inviter_user_id, userId)))
        throw new ApiError(403, "FORBIDDEN", "This friendship is no longer active");
      await tx.execute(sql`select id from games where id=${invite.game_id} for update`);
      const existing = await tx.select().from(gamePlayers).where(eq(gamePlayers.gameId, invite.game_id));
      if (existing.some((player) => player.userId === userId)) throw new ApiError(409, "INVALID_STATE", "You already joined this game");
      if (existing.length >= 2) throw new ApiError(409, "GAME_FULL", "The game already has two players");
      const [player] = await tx.insert(gamePlayers).values({ gameId: invite.game_id, userId, seat: 2 }).returning();
      if (!player) throw new Error("friend invite player insert failed");
      await tx.insert(rounds).values({ gameId: invite.game_id, gamePlayerId: player.id });
      const now = new Date();
      await tx.update(friendGameInvites).set({ status: "accepted", resolvedAt: now }).where(eq(friendGameInvites.id, inviteId));
      await tx.update(friendGameInvites).set({ status: "declined", resolvedAt: now }).where(and(eq(friendGameInvites.gameId, invite.game_id), eq(friendGameInvites.status, "pending"), sql`${friendGameInvites.id} <> ${inviteId}`));
      await tx.update(games).set({ status: "ready_check", version: sql`${games.version}+1`, updatedAt: now }).where(eq(games.id, invite.game_id));
      return { gameId: invite.game_id };
    });
    return result;
  });

  app.post("/api/v1/friend-invitations/:inviteId/decline", async (request) => {
    const userId = requireAuth(request);
    const { inviteId } = z.object({ inviteId: uuid }).strict().parse(request.params);
    const [declined] = await database.db.update(friendGameInvites).set({ status: "declined", resolvedAt: new Date() }).where(and(eq(friendGameInvites.id, inviteId), eq(friendGameInvites.recipientUserId, userId), eq(friendGameInvites.status, "pending"))).returning({ id: friendGameInvites.id });
    if (!declined) throw new ApiError(404, "NOT_FOUND", "Invitation not found");
    return { ok: true };
  });

  app.delete("/api/v1/games/:gameId/waiting-room", async (request) => {
    const userId = requireAuth(request);
    const { gameId } = gameParam.parse(request.params);
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from games where id=${gameId} for update`);
      await membership(tx, gameId, userId);
      const [game] = await tx.select().from(games).where(eq(games.id, gameId));
      if (!game)
        throw new ApiError(404, "GAME_NOT_FOUND", "Game not found");
      if (!["waiting_for_opponent", "ready_check"].includes(game.status))
        throw new ApiError(409, "INVALID_STATE", "The game has already started");
      await tx.delete(games).where(eq(games.id, gameId));
    });
    return { ok: true };
  });

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
              intended_user_id: string | null;
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
        if (invitation.intended_user_id && invitation.intended_user_id !== userId)
          throw new ApiError(403, "INVITATION_UNAUTHORIZED", "Invitation is not addressed to this user");
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
      await membership(tx, gameId, userId);
      const members = await tx
        .select()
        .from(gamePlayers)
        .where(eq(gamePlayers.gameId, gameId));
      if (members.length !== 2)
        throw new ApiError(409, "INVALID_STATE", "The opponent has not joined yet");
      const readyAt = new Date();
      const expiresAt = roundExpiresAt(readyAt);
      await tx
        .update(gamePlayers)
        .set({ status: "playing", readyAt })
        .where(eq(gamePlayers.gameId, gameId));
      await tx
        .update(rounds)
        .set({
          status: "active",
          startedAt: readyAt,
          expiresAt,
          version: sql`${rounds.version}+1`,
        })
        .where(
          and(eq(rounds.gameId, gameId), eq(rounds.status, "not_started")),
        );
      await tx
        .update(games)
        .set({
          status: "in_progress",
          version: sql`${games.version}+1`,
          updatedAt: readyAt,
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

function canonicalPair(first: string, second: string): readonly [string, string] {
  return first < second ? [first, second] : [second, first];
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function areFriends(db: Db | Tx, first: string, second: string): Promise<boolean> {
  if (first === second) return false;
  const [low, high] = canonicalPair(first, second);
  const [relationship] = await db
    .select({ id: friendships.id })
    .from(friendships)
    .where(and(eq(friendships.userAId, low), eq(friendships.userBId, high), eq(friendships.status, "accepted")));
  return relationship !== undefined;
}

async function resolveFriendRequest(
  db: Db,
  requestId: string,
  userId: string,
  status: "accepted" | "declined",
): Promise<void> {
  await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select * from friendships where id=${requestId} for update`);
    const relationship = locked[0] as { id: string; user_low_id: string; user_high_id: string; requested_by_user_id: string; status: string } | undefined;
    if (!relationship || ![relationship.user_low_id, relationship.user_high_id].includes(userId))
      throw new ApiError(404, "NOT_FOUND", "Friend request not found");
    if (relationship.requested_by_user_id === userId)
      throw new ApiError(403, "FORBIDDEN", "Only the recipient can resolve this request");
    if (relationship.status !== "pending")
      throw new ApiError(409, "INVALID_STATE", "Friend request is no longer pending");
    await tx.update(friendships).set({ status, resolvedAt: new Date() }).where(eq(friendships.id, requestId));
  });
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
    resultingRematchGameId: acceptedRematch?.resultingGameId ?? undefined,
  };
}
