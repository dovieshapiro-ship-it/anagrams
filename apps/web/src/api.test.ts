import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGame, createIdentity, createSoloGame } from "./api";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const GAME_ID = "22222222-2222-4222-8222-222222222222";
const CSRF = "abcdefghijklmnopqrstuvwxyzABCDEFG_123456";

describe("API client", () => {
  beforeEach(() => {
    document.cookie = `anagrams_csrf=${CSRF}; path=/`;
  });

  it("creates a development identity through the wire schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: USER_ID, displayName: "Alice" },
          csrfToken: CSRF,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(createIdentity("Alice")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/dev/sessions",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("sends the session-bound CSRF token on mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ gameId: GAME_ID, version: 0 }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(createGame()).resolves.toBe(GAME_ID);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("/api/v1/games");
    expect(new Headers(call[1].headers).get("X-CSRF-Token")).toBe(CSRF);
  });

  it("creates a solo game through the dedicated route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ gameId: GAME_ID, version: 0 }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSoloGame()).resolves.toBe(GAME_ID);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/games/solo");
  });
});
