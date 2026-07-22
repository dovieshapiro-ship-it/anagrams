import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

describe("Anagrams app", () => {
  const profile = {
    user: {
      id: "99999999-9999-4999-8999-999999999999",
      displayName: "Alice",
      username: "alice",
      email: "alice@example.com",
      wins: 7,
    },
  };
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(profile)));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the approved start screen clean and shows permanent wins", async () => {
    render(<App />);
    const profileButton = await screen.findByRole("button", { name: /open player profile/i });
    expect(profileButton).toBeVisible();
    fireEvent.click(profileButton);
    expect(screen.getByRole("dialog", { name: /player profile/i })).toHaveTextContent("@alice");
    expect(screen.getByRole("dialog", { name: /player profile/i })).toHaveTextContent("7 WINS");
    expect(screen.getByRole("heading", { name: "ANAGRAMS" })).toBeVisible();
    expect(
      screen.getByRole("img", { name: /sliced kiwi fruit/i }),
    ).toBeVisible();
    expect(screen.queryByText("FRUIT")).not.toBeInTheDocument();
    expect(screen.getByText(/60 SECONDS.*6 LETTERS/)).toBeVisible();
  });

  it("moves from the title to the approved rules board", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^play$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^solo$/i }));
    expect(screen.getByRole("heading", { name: /how to play/i })).toBeVisible();
    expect(screen.getByText(/6 = 2000/)).toBeVisible();
  });

  it("offers separate login and account creation to signed-out players", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: "r1" } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    render(<App />);
    expect(await screen.findByRole("button", { name: /^log in$/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /create account/i })).toBeVisible();
  });

  it("recovers a stale game URL back to the clean start board", async () => {
    window.history.replaceState(
      {},
      "",
      "/?game=22222222-2222-4222-8222-222222222222",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(
          path.endsWith("/me")
            ? Response.json(profile)
            : new Response(
                JSON.stringify({
                  error: {
                    code: "GAME_NOT_FOUND",
                    message: "Game not found",
                    requestId: "request-1",
                  },
                }),
                {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                },
              ),
        );
      }),
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /no longer available/i,
      ),
    );
    expect(screen.getByRole("button", { name: /^play$/i })).toBeVisible();
    expect(window.location.search).toBe("");
  });

  it("automatically starts the round after the first ready tap completes", async () => {
    const gameId = "11111111-1111-4111-8111-111111111111";
    const meId = "22222222-2222-4222-8222-222222222222";
    const otherId = "33333333-3333-4333-8333-333333333333";
    const now = "2030-01-01T12:00:00.000Z";
    const waitingToStart = {
      serverNow: now,
      game: { id: gameId, status: "in_progress", version: 4, rack: null },
      me: {
        id: meId,
        userId: meId,
        seat: 1,
        status: "ready",
        score: 0,
        validWordCount: 0,
        displayName: "Alice",
        round: {
          status: "not_started",
          startedAt: null,
          expiresAt: null,
          version: 0,
        },
        words: [],
      },
      opponent: {
        id: otherId,
        userId: otherId,
        seat: 2,
        displayName: "Bob",
        status: "ready",
      },
    };
    const active = {
      ...waitingToStart,
      game: { ...waitingToStart.game, version: 5, rack: "letter" },
      me: {
        ...waitingToStart.me,
        status: "playing",
        round: {
          status: "active",
          startedAt: now,
          expiresAt: "2030-01-01T12:01:00.000Z",
          version: 1,
        },
      },
    };
    let started = false;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL): Promise<Response> => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (path.endsWith(`/games/${gameId}/round/start`)) {
          started = true;
          return Promise.resolve(Response.json({ ok: true }));
        }
        if (path.endsWith("/me")) return Promise.resolve(Response.json(profile));
        if (path.endsWith(`/games/${gameId}`))
          return Promise.resolve(Response.json(started ? active : waitingToStart));
        throw new Error(`Unexpected request: ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/?game=${gameId}`);

    render(<App />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/games/${gameId}/round/start`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText(/make as many words as you can/i)).toBeVisible();
  });

  it("clears a consumed invite before starting a solo game after exit", async () => {
    const oldGameId = "11111111-1111-4111-8111-111111111111";
    const newGameId = "22222222-2222-4222-8222-222222222222";
    const meId = "33333333-3333-4333-8333-333333333333";
    const otherId = "44444444-4444-4444-8444-444444444444";
    const now = "2030-01-01T12:00:00.000Z";
    const activeState = {
      serverNow: now,
      game: { id: newGameId, status: "in_progress", version: 2, rack: "letter" },
      me: {
        id: meId,
        userId: meId,
        seat: 1,
        status: "playing",
        score: 0,
        validWordCount: 0,
        displayName: "Alice",
        round: {
          status: "active",
          startedAt: now,
          expiresAt: "2030-01-01T12:01:00.000Z",
          version: 1,
        },
        words: [],
      },
      opponent: {
        id: otherId,
        userId: otherId,
        seat: 2,
        displayName: "Kiwi",
        status: "playing",
      },
    };
    const completedState = {
      ...activeState,
      game: { ...activeState.game, id: oldGameId, status: "completed" },
      results: [
        {
          playerId: meId,
          displayName: "Alice",
          score: 100,
          validWordCount: 1,
          words: ["let"],
          missedWords: [],
        },
        {
          playerId: otherId,
          displayName: "Bob",
          score: 0,
          validWordCount: 0,
          words: [],
          missedWords: [],
        },
      ],
    };
    window.history.replaceState(
      {},
      "",
      `/?game=${oldGameId}&token=already-used-invite-token-1234567890`,
    );
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      let body: unknown;
      if (path.endsWith("/me")) body = profile;
      else if (path.endsWith(`/games/${oldGameId}`)) body = completedState;
      else if (path.endsWith("/games/solo"))
        body = { gameId: newGameId, version: 0 };
      else if (path.endsWith(`/games/${newGameId}`)) body = activeState;
      else throw new Error(`Unexpected request: ${path}`);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: /round results/i });
    fireEvent.click(screen.getByRole("button", { name: /^exit$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^play$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^solo$/i }));
    fireEvent.click(screen.getByRole("button", { name: /start round/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/games/solo",
        expect.any(Object),
      ),
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).endsWith("/invitations/join"),
      ),
    ).toBe(false);
  });
});
