import { describe, expect, it } from "vitest";
import { sixLetterKiwiWords } from "./App";

describe("solo Kiwi results", () => {
  it("shows only authoritative six-letter missed words", () => {
    expect(
      sixLetterKiwiWords({
        missedWords: ["tea", "planet", "plates", "tale", "staple"],
      }),
    ).toEqual(["planet", "plates", "staple"]);
  });

  it("handles a missing Kiwi result without inventing words", () => {
    expect(sixLetterKiwiWords(undefined)).toEqual([]);
  });
});
