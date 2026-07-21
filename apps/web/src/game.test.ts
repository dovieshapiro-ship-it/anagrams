import { describe, expect, it } from "vitest";
import { scoreForLength, submitLocalWord, totalScore } from "./game";

describe("local game rules", () => {
  it("uses the approved score curve", () => {
    expect([3, 4, 5, 6].map(scoreForLength)).toEqual([100, 400, 1200, 2000]);
  });

  it("accepts a playable dictionary word case-insensitively", () => {
    expect(submitLocalWord(" PLANET ", [])).toEqual({
      accepted: true,
      entry: { word: "planet", score: 2000 },
    });
  });

  it("rejects impossible, unknown, and duplicate words", () => {
    expect(submitLocalWord("people", [])).toMatchObject({ accepted: false });
    expect(submitLocalWord("tal", [])).toMatchObject({ accepted: false });
    expect(
      submitLocalWord("PLAN", [{ word: "plan", score: 400 }]),
    ).toMatchObject({ accepted: false });
  });

  it("totals authoritative-looking entries without rescoring them", () => {
    expect(
      totalScore([
        { word: "ant", score: 100 },
        { word: "plane", score: 1200 },
      ]),
    ).toBe(1300);
  });
});
