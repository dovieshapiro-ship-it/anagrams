import { randomUUID } from "node:crypto";

import { canBuildWordFromRack, countPlayableWords } from "@anagrams/game-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createDatabase, type DatabaseHandle } from "./db/client.js";
import { loadDictionary } from "./dictionary.js";
import { loadEnv } from "./env.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://dovieshapiro@127.0.0.1:5432/anagrams_integration";
const origin = "http://localhost:3000";

interface Session {
  readonly cookie: string;
  readonly csrf: string;
  readonly userId: string;
}

describe("two-player API integration", () => {
  let database: DatabaseHandle | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let dictionary: Awaited<ReturnType<typeof loadDictionary>>;

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    dictionary = await loadDictionary();
    app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl,
        WEB_ORIGINS: origin,
        PUBLIC_WEB_URL: origin,
        COOKIE_SECURE: "false",
      }),
      database,
      dictionary,
    });
  });

  beforeEach(async () => {
    if (database === undefined)
      throw new Error("Database setup did not complete");
    await database.sqlClient`truncate table magic_link_challenges, rematch_requests, invitations, word_submissions, rounds, game_players, games, auth_sessions, chat_identities, users restart identity cascade`;
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (database !== undefined) await database.close();
  });

  it("completes a private game and reveals results only after both players finish", async () => {
    if (app === undefined || database === undefined)
      throw new Error("Application setup did not complete");
    const alice = await createSession("Alice");
    const bob = await createSession("Bob");

    const created = await post("/api/v1/games", alice, {});
    expect(created.statusCode).toBe(201);
    const gameId = created.json<{ gameId: string }>().gameId;

    const invited = await post(
      `/api/v1/games/${gameId}/invitations`,
      alice,
      {},
    );
    expect(invited.statusCode).toBe(201);
    const invitationUrl = new URL(
      invited.json<{ invitationUrl: string }>().invitationUrl,
    );
    const token = invitationUrl.searchParams.get("token");
    expect(token).toBeTruthy();
    if (token === null)
      throw new Error("Invitation URL did not contain a token");

    const joined = await post("/api/v1/invitations/join", bob, { token });
    expect(joined.statusCode).toBe(200);

    const aliceInitial = await getState(gameId, alice);
    expect(aliceInitial.game.rack).toBeNull();
    await post(`/api/v1/games/${gameId}/ready`, alice, {
      expectedVersion: aliceInitial.game.version,
    });

    const active = await getState(gameId, alice);
    const bobActive = await getState(gameId, bob);
    expect(active.me.round?.status).toBe("active");
    expect(bobActive.me.round?.status).toBe("active");
    expect(active.me.round?.startedAt).toBe(bobActive.me.round?.startedAt);
    expect(active.game.rack).toMatch(/^[a-z]{6}$/u);
    assertQualityRack(active.game.rack);
    const word = Array.from(dictionary.words()).find(
      (candidate) =>
        candidate.length >= 3 &&
        candidate.length <= 6 &&
        active.game.rack !== null && canBuildWordFromRack(candidate, active.game.rack),
    );
    expect(word).toBeTruthy();
    if (word === undefined)
      throw new Error("Generated rack has no playable dictionary word");

    const submission = await post(
      `/api/v1/games/${gameId}/round/submit`,
      alice,
      {
        word,
        idempotencyKey: randomUUID(),
      },
    );
    expect(submission.statusCode).toBe(200);
    const expectedScore = { 3: 100, 4: 400, 5: 1200, 6: 2000 }[word.length];
    expect(submission.json<{ score: number }>().score).toBe(expectedScore);

    const duplicate = await post(
      `/api/v1/games/${gameId}/round/submit`,
      alice,
      { word: word.toUpperCase(), idempotencyKey: randomUUID() },
    );
    expect(duplicate.statusCode).toBe(200);
    expect(
      duplicate.json<{ accepted: boolean; rejectionCode: string }>(),
    ).toMatchObject({
      accepted: false,
      rejectionCode: "DUPLICATE_WORD",
    });

    const bobPrivate = await getState(gameId, bob);
    const serializedPrivateState = JSON.stringify(bobPrivate);
    expect(serializedPrivateState).not.toContain(`"${word}"`);
    expect(bobPrivate.opponent).not.toHaveProperty("score");
    expect(bobPrivate.opponent).not.toHaveProperty("validWordCount");

    expect(
      (await post(`/api/v1/games/${gameId}/round/finish`, alice, { expectedVersion: (await getState(gameId, alice)).game.version }))
        .statusCode,
    ).toBe(200);
    expect(
      (await post(`/api/v1/games/${gameId}/round/finish`, bob, { expectedVersion: (await getState(gameId, bob)).game.version })).statusCode,
    ).toBe(200);

    const results = await app.inject({
      method: "GET",
      url: `/api/v1/games/${gameId}/results`,
      headers: { cookie: alice.cookie },
    });
    expect(results.statusCode).toBe(200);
    const body = results.json<{
      game: { status: string };
      results: { words: string[]; missedWords: string[] }[];
    }>();
    expect(body.game.status).toBe("completed");
    expect(body.results.some((player) => player.words.includes(word))).toBe(
      true,
    );
    expect(body.results.every((player) => Array.isArray(player.missedWords))).toBe(true);
    const aliceProfile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: alice.cookie },
    });
    expect(aliceProfile.json<{ user: { wins: number } }>().user.wins).toBe(1);

    const rematch = await post(`/api/v1/games/${gameId}/rematch`, alice, {});
    expect(rematch.statusCode).toBe(201);
    const bobWithRequest = await getState(gameId, bob);
    expect(bobWithRequest.pendingRematch).toMatchObject({ canAccept: true });
    const requestId = rematch.json<{ requestId: string }>().requestId;
    const acceptedRematch = await post(
      `/api/v1/games/${gameId}/rematch/accept`,
      bob,
      { requestId },
    );
    expect(acceptedRematch.statusCode).toBe(200);
    const rematchGameId = acceptedRematch.json<{ gameId: string }>().gameId;
    const [rematchRow] = await database.sqlClient<{ rack: string }[]>`
      select rack from games where id = ${rematchGameId}
    `;
    expect(rematchRow).toBeDefined();
    if (rematchRow) assertQualityRack(rematchRow.rack);
  });

  it("completes a solo game against a non-authenticatable Kiwi opponent", async () => {
    if (app === undefined || database === undefined)
      throw new Error("Test setup did not complete");
    const alice = await createSession("Alice");
    const created = await post("/api/v1/games/solo", alice, {});
    expect(created.statusCode).toBe(201);
    const gameId = created.json<{ gameId: string }>().gameId;

    const initial = await getState(gameId, alice);
    expect(initial.game.status).toBe("in_progress");
    expect(initial.game.rack).toBeNull();
    expect(initial.opponent).toMatchObject({
      displayName: "Kiwi",
      status: "finished",
      seat: 2,
    });
    expect(initial.pendingRematch).toBeUndefined();

    const started = await post(`/api/v1/games/${gameId}/round/start`, alice, {
      expectedVersion: initial.game.version,
    });
    expect(started.statusCode).toBe(200);
    const active = await getState(gameId, alice);
    expect(active.game.rack).toMatch(/^[a-z]{6}$/u);
    assertQualityRack(active.game.rack);
    const word = Array.from(dictionary.words()).find(
      (candidate) =>
        candidate.length >= 3 &&
        candidate.length <= 6 &&
        active.game.rack !== null &&
        canBuildWordFromRack(candidate, active.game.rack),
    );
    if (word === undefined) throw new Error("Solo rack has no playable word");
    const submitted = await post(
      `/api/v1/games/${gameId}/round/submit`,
      alice,
      { word, idempotencyKey: randomUUID() },
    );
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json<{ accepted: boolean }>().accepted).toBe(true);

    const finished = await post(`/api/v1/games/${gameId}/round/finish`, alice, {
      expectedVersion: active.game.version,
    });
    expect(finished.statusCode).toBe(200);
    const result = await getState(gameId, alice);
    expect(result.game.status).toBe("completed");
    expect(result.results).toHaveLength(2);
    expect(result.results?.find((player) => player.displayName === "Kiwi")).toMatchObject({
      score: 0,
      validWordCount: 0,
      words: [],
    });
    expect(
      result.results
        ?.find((player) => player.displayName === "Kiwi")
        ?.missedWords.some((possible) => possible.length === 6),
    ).toBe(true);
    expect(
      (await post(`/api/v1/games/${gameId}/rematch`, alice, {})).statusCode,
    ).toBe(409);
    const soloProfile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: alice.cookie },
    });
    expect(soloProfile.json<{ user: { wins: number } }>().user.wins).toBe(0);

    const syntheticSessions = await database.sqlClient<{ count: number }[]>`
      select count(*)::int as count
      from auth_sessions s
      join users u on u.id = s.user_id
      where u.is_synthetic = true
    `;
    expect(syntheticSessions[0]?.count).toBe(0);
  });

  it("creates a mutual friendship and accepts a persistent friend game invite", async () => {
    if (app === undefined || database === undefined) throw new Error("Test setup did not complete");
    const alice = await createSession("Alice");
    const bob = await createSession("Bob");
    expect((await post("/api/v1/me/username", alice, { username: "alice_1" })).statusCode).toBe(200);
    expect((await post("/api/v1/me/username", bob, { username: "bob_2" })).statusCode).toBe(200);
    const requested = await post("/api/v1/friends/requests", alice, { username: "bob_2" });
    expect(requested.statusCode).toBe(201);
    const bobFriends = await app.inject({ method: "GET", url: "/api/v1/friends", headers: { cookie: bob.cookie } });
    const requestId = bobFriends.json<{ incomingRequests: { id: string }[] }>().incomingRequests[0]?.id;
    if (!requestId) throw new Error("Expected an incoming friend request");
    expect((await post(`/api/v1/friends/requests/${requestId}/accept`, bob, {})).statusCode).toBe(200);
    const created = await post("/api/v1/games", alice, {});
    const gameId = created.json<{ gameId: string }>().gameId;
    const invited = await post(`/api/v1/games/${gameId}/friend-invitations`, alice, { friendUserId: bob.userId });
    expect(invited.statusCode).toBe(201);
    const outgoing = await app.inject({
      method: "GET",
      url: `/api/v1/games/${gameId}/friend-invitation`,
      headers: { cookie: alice.cookie },
    });
    expect(outgoing.statusCode).toBe(200);
    expect(outgoing.json<{ friend: { userId: string; username: string } }>().friend).toMatchObject({
      userId: bob.userId,
      username: "bob_2",
    });
    const inviteId = invited.json<{ invite: { id: string } }>().invite.id;
    const listed = await app.inject({ method: "GET", url: "/api/v1/friend-invitations", headers: { cookie: bob.cookie } });
    expect(listed.json<{ invitations: unknown[] }>().invitations).toHaveLength(1);
    const accepted = await post(`/api/v1/friend-invitations/${inviteId}/accept`, bob, {});
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ gameId });
    const count = await database.sqlClient<{ count: number }[]>`select count(*)::int as count from game_players where game_id=${gameId}`;
    expect(count[0]?.count).toBe(2);
  });

  it("merges crossed friend invitations into one shared waiting room", async () => {
    if (app === undefined || database === undefined)
      throw new Error("Test setup did not complete");
    const alice = await createSession("Alice");
    const bob = await createSession("Bob");
    await post("/api/v1/me/username", alice, { username: "alice_cross" });
    await post("/api/v1/me/username", bob, { username: "bob_cross" });
    await post("/api/v1/friends/requests", alice, { username: "bob_cross" });
    const bobFriends = await app.inject({
      method: "GET",
      url: "/api/v1/friends",
      headers: { cookie: bob.cookie },
    });
    const requestId = bobFriends.json<{ incomingRequests: { id: string }[] }>()
      .incomingRequests[0]?.id;
    if (!requestId) throw new Error("Expected a friend request");
    await post(`/api/v1/friends/requests/${requestId}/accept`, bob, {});

    const aliceGame = (await post("/api/v1/games", alice, {})).json<{ gameId: string }>().gameId;
    await post(`/api/v1/games/${aliceGame}/friend-invitations`, alice, {
      friendUserId: bob.userId,
    });
    const bobGame = (await post("/api/v1/games", bob, {})).json<{ gameId: string }>().gameId;
    const crossed = await post(`/api/v1/games/${bobGame}/friend-invitations`, bob, {
      friendUserId: alice.userId,
    });
    expect(crossed.statusCode).toBe(201);
    expect(crossed.json<{ invite: { gameId: string } }>().invite.gameId).toBe(aliceGame);
    const sharedPlayers = await database.sqlClient<{ count: number }[]>`
      select count(*)::int as count from game_players where game_id=${aliceGame}
    `;
    expect(sharedPlayers[0]?.count).toBe(2);
    const discardedGames = await database.sqlClient<{ count: number }[]>`
      select count(*)::int as count from games where id=${bobGame}
    `;
    expect(discardedGames[0]?.count).toBe(0);
  });

  it("allows exactly one concurrent invitation redemption and hides the game from the loser", async () => {
    if (app === undefined || database === undefined)
      throw new Error("Test setup did not complete");
    const alice = await createSession("Alice");
    const bob = await createSession("Bob");
    const carol = await createSession("Carol");
    const created = await post("/api/v1/games", alice, {});
    const gameId = created.json<{ gameId: string }>().gameId;
    const invited = await post(
      `/api/v1/games/${gameId}/invitations`,
      alice,
      {},
    );
    const token = new URL(
      invited.json<{ invitationUrl: string }>().invitationUrl,
    ).searchParams.get("token");
    if (token === null)
      throw new Error("Invitation URL did not contain a token");

    const [bobJoin, carolJoin] = await Promise.all([
      post("/api/v1/invitations/join", bob, { token }),
      post("/api/v1/invitations/join", carol, { token }),
    ]);
    expect([bobJoin.statusCode, carolJoin.statusCode].sort()).toEqual([
      200, 410,
    ]);

    const rows = await database.sqlClient<{ count: number }[]>`
      select count(*)::int as count from game_players where game_id = ${gameId}
    `;
    expect(rows[0]?.count).toBe(2);

    const losingSession = bobJoin.statusCode === 200 ? carol : bob;
    const unauthorized = await app.inject({
      method: "GET",
      url: `/api/v1/games/${gameId}`,
      headers: { cookie: losingSession.cookie },
    });
    expect(unauthorized.statusCode).toBe(404);

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/games",
      headers: { cookie: alice.cookie, origin },
      payload: {},
    });
    expect(missingCsrf.statusCode).toBe(403);
  });

  it("creates a permanent account from a one-time magic link", async () => {
    if (app === undefined)
      throw new Error("Application setup did not complete");
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/auth/magic-links",
      headers: { origin },
      payload: { email: "Alice@Example.com", displayName: "Alice", username: "alice_words" },
    });
    expect(requested.statusCode).toBe(202);
    const link = requested.json<{ developmentMagicLink: string }>().developmentMagicLink;
    const token = new URL(link).hash.replace(/^#magic=/u, "");
    expect(token.length).toBeGreaterThan(20);

    const consumed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/magic-links/consume",
      headers: { origin },
      payload: { token },
    });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json<{ user: { displayName: string; email: string; username: string } }>().user).toMatchObject({
      displayName: "Alice",
      email: "alice@example.com",
      username: "alice_words",
    });
    const cookie = String(consumed.headers["set-cookie"]).split(";", 1)[0];
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { displayName: string; username: string; wins: number } }>().user).toMatchObject({ displayName: "Alice", username: "alice_words", wins: 0 });

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/magic-links/consume",
      headers: { origin },
      payload: { token },
    });
    expect(replay.statusCode).toBe(401);
  });

  async function createSession(displayName: string): Promise<Session> {
    if (app === undefined)
      throw new Error("Application setup did not complete");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/sessions",
      payload: { displayName },
    });
    expect(response.statusCode).toBe(201);
    const setCookie = response.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const cookie = String(setCookie).split(";", 1)[0];
    if (cookie === undefined)
      throw new Error("Session response did not set a cookie");
    return {
      cookie,
      csrf: String(response.headers["x-csrf-token"]),
      userId: response.json<{ user: { id: string } }>().user.id,
    };
  }

  async function post(
    url: string,
    session: Session,
    payload: Record<string, unknown>,
  ) {
    if (app === undefined)
      throw new Error("Application setup did not complete");
    return await app.inject({
      method: "POST",
      url,
      headers: {
        cookie: session.cookie,
        origin,
        "x-csrf-token": session.csrf,
      },
      payload,
    });
  }

  async function getState(gameId: string, session: Session) {
    if (app === undefined)
      throw new Error("Application setup did not complete");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/games/${gameId}`,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{
      game: { id: string; status: string; version: number; rack: string | null };
      me: {
        round: {
          status: string;
          startedAt: string | null;
        } | null;
      };
      opponent?: Record<string, unknown>;
      pendingRematch?: { id: string; requestedByPlayerId: string; canAccept: boolean };
      results?: { displayName: string; score: number; validWordCount: number; words: string[]; missedWords: string[] }[];
    }>();
  }

  function assertQualityRack(rack: string | null): void {
    expect(rack).toMatch(/^[a-z]{6}$/u);
    if (rack === null) throw new Error("Quality rack was hidden unexpectedly");
    expect(countPlayableWords(rack, dictionary)).toBeGreaterThanOrEqual(15);
    const letters = Array.from(rack);
    const vowelCount = letters.filter((letter) => "aeiou".includes(letter)).length;
    expect(vowelCount).toBeGreaterThanOrEqual(2);
    expect(vowelCount).toBeLessThanOrEqual(3);
    const counts = new Map<string, number>();
    for (const letter of letters) counts.set(letter, (counts.get(letter) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(
      Array.from(dictionary.words()).some(
        (word) => word.length === 6 && canBuildWordFromRack(word, rack),
      ),
    ).toBe(true);
  }
});
