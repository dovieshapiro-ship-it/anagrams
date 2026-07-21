import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WireGameStateResponse,
  WireSubmitWordResponse,
} from "@anagrams/shared-types";
import { PlayScreen } from "./App";

const NOW = "2030-01-01T12:00:00.000Z";
const state: WireGameStateResponse = {
  serverNow: NOW,
  game: {
    id: "11111111-1111-4111-8111-111111111111",
    status: "in_progress",
    version: 2,
    rack: "letter",
  },
  me: {
    id: "22222222-2222-4222-8222-222222222222",
    userId: "33333333-3333-4333-8333-333333333333",
    seat: 1,
    status: "playing",
    score: 0,
    validWordCount: 0,
    displayName: "Maya",
    round: {
      status: "active",
      startedAt: NOW,
      expiresAt: "2030-01-01T12:01:00.000Z",
      version: 1,
    },
    words: [],
  },
  opponent: {
    id: "44444444-4444-4444-8444-444444444444",
    userId: "55555555-5555-4555-8555-555555555555",
    seat: 2,
    displayName: "Noah",
    status: "playing",
  },
};

function response(accepted: boolean): WireSubmitWordResponse {
  return {
    accepted,
    normalizedWord: "letter",
    score: accepted ? 2_000 : 0,
    rejectionCode: accepted ? null : "WORD_NOT_IN_DICTIONARY",
    receivedAt: NOW,
  };
}

function setup(onSubmit = vi.fn().mockResolvedValue(response(true))): void {
  render(
    <PlayScreen
      state={state}
      busy={false}
      error=""
      onSubmit={onSubmit}
      onFinish={vi.fn()}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("rack interactions", () => {
  it("uses tap-only entry and suppresses the software keyboard on phones", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    setup();
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: /enter your word/i }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("listitem", { name: /L tile, available/i }));
    expect(screen.getByRole("button", { name: /selected word/i })).toHaveTextContent(
      "l",
    );
  });

  it("tracks duplicate tiles independently and restores the activated used tile", () => {
    setup();
    const es = screen.getAllByRole("listitem", { name: /E tile, available/i });
    const first = es[0];
    const second = es[1];
    if (!first || !second) throw new Error("Expected two E tiles");
    fireEvent.click(first);
    fireEvent.click(second);
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(second).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-pressed", "false");
    expect(second).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores off-rack keys and prevents overusing a duplicated letter", () => {
    setup();
    fireEvent.keyDown(window, { key: "q" });
    fireEvent.keyDown(window, { key: "e" });
    fireEvent.keyDown(window, { key: "e" });
    fireEvent.keyDown(window, { key: "e" });
    expect(screen.getByRole("button", { name: /selected word/i })).toHaveTextContent(
      "ee",
    );
  });

  it("resets every tile after a rejected submission", async () => {
    setup(vi.fn().mockResolvedValue(response(false)));
    const tile = screen.getByRole("listitem", { name: /L tile, available/i });
    fireEvent.click(tile);
    fireEvent.click(screen.getByRole("button", { name: /^enter$/i }));
    await waitFor(() => expect(tile).toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByRole("button", { name: /selected word/i })).toHaveTextContent(
      "",
    );
  });

  it("preserves selected tiles when the transport fails", async () => {
    setup(vi.fn().mockRejectedValue(new Error("Offline")));
    const tile = screen.getByRole("listitem", { name: /L tile, available/i });
    fireEvent.click(tile);
    fireEvent.click(screen.getByRole("button", { name: /^enter$/i }));
    await waitFor(() => expect(screen.getByText("Offline")).toBeVisible());
    expect(tile).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /selected word/i })).toHaveTextContent(
      "l",
    );
  });

  it("shows a one-second six-letter toast and soft slot illumination", async () => {
    vi.useFakeTimers();
    setup();
    for (const tile of screen.getAllByRole("listitem")) fireEvent.click(tile);
    fireEvent.click(screen.getByRole("button", { name: /^enter$/i }));
    await act(async () => Promise.resolve());
    expect(screen.getByRole("status")).toHaveTextContent("Anagram found!");
    expect(
      screen.getByRole("button", { name: /selected word/i }),
    ).toHaveClass("anagram-glow");
    await act(() => vi.advanceTimersByTime(1_001));
    expect(screen.queryByText("Anagram found!")).not.toBeInTheDocument();
  });
});
