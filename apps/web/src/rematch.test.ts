import { describe, expect, it } from "vitest";
import { rematchMode } from "./App";

describe("solo rematch routing", () => {
  it("recovers solo mode from the synthetic Kiwi opponent after refresh", () => {
    expect(
      rematchMode(
        {
          opponent: {
            id: "11111111-1111-4111-8111-111111111111",
            userId: "22222222-2222-4222-8222-222222222222",
            seat: 2,
            displayName: "Kiwi",
            status: "finished",
          },
        },
        "friend",
      ),
    ).toBe("solo");
  });

  it("keeps normal opponents on the selected friend flow", () => {
    expect(
      rematchMode(
        {
          opponent: {
            id: "11111111-1111-4111-8111-111111111111",
            userId: "22222222-2222-4222-8222-222222222222",
            seat: 2,
            displayName: "Noah",
            status: "finished",
          },
        },
        "friend",
      ),
    ).toBe("friend");
  });
});
