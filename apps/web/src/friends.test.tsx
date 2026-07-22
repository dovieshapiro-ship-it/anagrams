import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FriendsScreen } from "./App";
// @ts-expect-error Vite supports the cache-busting query used by App.
import * as versionedApi from "./api.ts?v=password-auth-20";
import type * as ApiTypes from "./api";
import type { FriendsResponse } from "./api";

const api = versionedApi as typeof ApiTypes;

const alice = { userId: "user-alice", username: "alice", displayName: "Alice" };
const bob = { userId: "user-bob", username: "bob", displayName: "Bob" };

function emptyFriends(overrides: Partial<FriendsResponse> = {}): FriendsResponse {
  return { friends: [], incomingRequests: [], outgoingRequests: [], ...overrides };
}

afterEach(() => vi.restoreAllMocks());

describe("friends screen", () => {
  it("shows friends, requests, and persistent game invitations", async () => {
    vi.spyOn(api, "getFriends").mockResolvedValue(
      emptyFriends({
        friends: [alice],
        incomingRequests: [{ id: "request-1", user: bob }],
      }),
    );
    vi.spyOn(api, "getFriendGameInvitations").mockResolvedValue([
      { id: "invite-1", gameId: "game-1", inviter: alice, expiresAt: "2030-01-01T00:00:00Z" },
    ]);

    render(<FriendsScreen onBack={() => undefined} onJoin={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "GAME INVITATIONS" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Find and add people" }));
    expect(screen.getByRole("heading", { name: "FRIEND REQUESTS" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "YOUR FRIENDS" })).toBeVisible();
    expect(screen.getAllByText("Alice")).toHaveLength(2);
  });

  it("performs an exact username search and sends a request", async () => {
    vi.spyOn(api, "getFriends").mockResolvedValue(emptyFriends());
    vi.spyOn(api, "getFriendGameInvitations").mockResolvedValue([]);
    const search = vi.spyOn(api, "searchFriend").mockResolvedValue({
      user: bob,
      relationship: "none",
    });
    const send = vi.spyOn(api, "sendFriendRequest").mockResolvedValue();

    render(<FriendsScreen onBack={() => undefined} onJoin={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Find and add people" }));
    fireEvent.change(screen.getByLabelText("FIND BY USERNAME"), {
      target: { value: "  bob  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "FIND" }));
    expect(await screen.findByText("@bob")).toBeVisible();
    expect(search).toHaveBeenCalledWith("bob");
    fireEvent.click(screen.getByRole("button", { name: "ADD" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("bob"));
  });

  it("accepts a game invitation and hands its game to the app", async () => {
    vi.spyOn(api, "getFriends").mockResolvedValue(emptyFriends());
    vi.spyOn(api, "getFriendGameInvitations").mockResolvedValue([
      { id: "invite-1", gameId: "game-1", inviter: alice, expiresAt: "2030-01-01T00:00:00Z" },
    ]);
    vi.spyOn(api, "acceptFriendGameInvitation").mockResolvedValue("game-1");
    const join = vi.fn();

    render(<FriendsScreen onBack={() => undefined} onJoin={join} />);
    fireEvent.click(await screen.findByRole("button", { name: "JOIN" }));
    await waitFor(() => expect(join).toHaveBeenCalledWith("game-1"));
  });
});
