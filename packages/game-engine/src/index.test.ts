import { describe, expect, it } from "vitest";

import {
  DEFAULT_GAME_RULES,
  InvalidStateTransitionError,
  assertGameTransition,
  assertRoundTransition,
  canBuildWordFromRack,
  countPlayableWords,
  enumerateMissedWords,
  generateRack,
  generatePlayableRack,
  generateQualityRack,
  hasPlayableWord,
  inspectSixLetterBaseWord,
  isRoundExpired,
  normalizeWord,
  resolveResult,
  roundExpiresAt,
  scoreWord,
  validateWord,
  type RandomSource,
} from "./index.js";
import { createTestDictionary } from "./test-dictionary.js";

class SequenceRandom implements RandomSource {
  private index = 0;

  public constructor(private readonly values: readonly number[]) {}

  public nextUint32(): number {
    const value = this.values[this.index % this.values.length];
    this.index += 1;
    if (value === undefined)
      throw new Error("SequenceRandom requires at least one value");
    return value;
  }
}

const dictionary = createTestDictionary();

describe("rack generation", () => {
  it("generates the configured rack size with at least one vowel and consonant", () => {
    const rack = generateRack(
      new SequenceRandom([0, 0, 25, 25, 25, 25, 0, 0, 0, 0, 0]),
    );
    expect(rack).toHaveLength(6);
    expect(rack.some((letter) => "aeiou".includes(letter))).toBe(true);
    expect(
      rack.some((letter) => "bcdfghjklmnpqrstvwxyz".includes(letter)),
    ).toBe(true);
  });

  it("supports configured letter pools and deterministic injected randomness", () => {
    const options = { alphabet: "ab", vowels: "a", consonants: "b" };
    expect(
      generateRack(new SequenceRandom([0]), DEFAULT_GAME_RULES, options),
    ).toEqual(["b", "a", "a", "a", "a", "a"]);
  });

  it("rejects malformed pools and RNG output", () => {
    expect(() =>
      generateRack(new SequenceRandom([0]), DEFAULT_GAME_RULES, {
        vowels: "a1",
      }),
    ).toThrow(TypeError);
    expect(() => generateRack(new SequenceRandom([-1]))).toThrow(RangeError);
  });

  it("retries until the rack contains a dictionary-valid playable word", () => {
    const random = new SequenceRandom([
      0, 0, 25, 25, 25, 25, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 4, 0, 0, 0, 0, 0,
    ]);
    const rack = generatePlayableRack(
      random,
      createTestDictionary(["ace"]),
      DEFAULT_GAME_RULES,
      { maximumAttempts: 2 },
    );
    expect(hasPlayableWord(rack, createTestDictionary(["ace"]))).toBe(true);
  });

  it("fails with a bounded error when configured pools cannot make a word", () => {
    expect(() =>
      generatePlayableRack(
        new SequenceRandom([0]),
        createTestDictionary(["cat"]),
        DEFAULT_GAME_RULES,
        {
          alphabet: "z",
          vowels: "a",
          consonants: "b",
          maximumAttempts: 2,
        },
      ),
    ).toThrow("Unable to generate a playable rack after 2 attempts");
  });

  it("generates a shuffled quality rack with playable-word metadata", () => {
    const richDictionary = createTestDictionary([
      "planet",
      "platen",
      "ant",
      "ape",
      "apt",
      "ate",
      "eat",
      "lap",
      "lea",
      "let",
      "nap",
      "net",
      "pal",
      "pan",
      "pat",
      "pea",
      "pen",
      "pet",
      "plan",
      "plane",
      "plate",
      "pleat",
      "tap",
      "tape",
      "tea",
      "ten",
    ]);
    const generated = generateQualityRack(
      new SequenceRandom([0]),
      richDictionary,
      {
        baseWords: ["planet"],
        minimumPlayableWords: 15,
        maximumAttempts: 1,
      },
    );
    expect([...generated.rack].sort()).toEqual(Array.from("planet").sort());
    expect(generated.quality).toMatchObject({
      vowelCount: 2,
      maxDuplicateCount: 1,
      rareLetterCount: 0,
      sixLetterAnagramCount: 2,
    });
    expect(generated.quality.playableWordCount).toBe(
      countPlayableWords("planet", richDictionary),
    );
    expect(generated.quality.playableWordCount).toBeGreaterThanOrEqual(15);
  });

  it("regenerates after a low-yield candidate", () => {
    const fixture = createTestDictionary([
      "future",
      "planet",
      "platen",
      "ant",
      "ape",
      "apt",
      "ate",
      "eat",
      "lap",
      "lea",
      "let",
      "nap",
      "net",
      "pal",
      "pan",
      "pat",
      "pea",
      "pen",
      "pet",
      "plan",
      "plane",
    ]);
    const generated = generateQualityRack(new SequenceRandom([0, 1]), fixture, {
      baseWords: ["future", "planet"],
      minimumPlayableWords: 15,
      maximumAttempts: 2,
    });
    expect([...generated.rack].sort()).toEqual(Array.from("planet").sort());
  });

  it("selects easy, medium, and hard racks from the intended difficulty bands", () => {
    const mixedDictionary = createTestDictionary([
      "planet",
      "ardent",
      "rancor",
    ]);
    const difficultyPools = {
      easy: ["planet"],
      medium: ["ardent"],
      hard: ["rancor"],
    };
    const generateForSlot = (slot: number): string[] =>
      [
        ...generateQualityRack(
          new SequenceRandom([slot, 0]),
          mixedDictionary,
          {
            difficultyPools,
            minimumPlayableWords: 1,
            maximumAttempts: 1,
          },
        ).rack,
      ].sort();

    expect(generateForSlot(0)).toEqual(Array.from("planet").sort());
    expect(generateForSlot(8)).toEqual(Array.from("ardent").sort());
    expect(generateForSlot(15)).toEqual(Array.from("rancor").sort());
  });

  it("rejects awkward patterns and fails after bounded attempts", () => {
    const fixture = createTestDictionary([
      "qaswer",
      "aeiout",
      "teeter",
      "jazzed",
      "future",
    ]);
    expect(inspectSixLetterBaseWord("qaswer", fixture)).toBeNull();
    expect(inspectSixLetterBaseWord("aeiout", fixture)).toBeNull();
    expect(inspectSixLetterBaseWord("teeter", fixture)).toBeNull();
    expect(inspectSixLetterBaseWord("jazzed", fixture)).toBeNull();
    expect(() =>
      generateQualityRack(new SequenceRandom([0]), fixture, {
        baseWords: ["future"],
        minimumPlayableWords: 15,
        maximumAttempts: 2,
      }),
    ).toThrow("Unable to generate a quality rack");
  });
});

describe("word rules", () => {
  it("normalizes case and surrounding whitespace", () => {
    expect(normalizeWord("  CaT\n")).toBe("cat");
    expect(validateWord({ word: " CaT ", rack: "accent", dictionary })).toEqual(
      {
        accepted: true,
        normalizedWord: "cat",
        score: 100,
      },
    );
  });

  it("handles repeated rack letters by count", () => {
    expect(canBuildWordFromRack("accent", "accent")).toBe(true);
    expect(canBuildWordFromRack("acccent", "accent")).toBe(false);
    expect(canBuildWordFromRack("ante", "accent")).toBe(true);
  });

  it.each([
    { word: "", rack: "accent", code: "EMPTY_WORD" },
    { word: "a-t", rack: "accent", code: "INVALID_CHARACTERS" },
    { word: "at", rack: "accent", code: "WORD_TOO_SHORT" },
    { word: "accented", rack: "accent", code: "WORD_TOO_LONG" },
    { word: "tent", rack: "acenty", code: "WORD_NOT_IN_RACK" },
    { word: "ace", rack: "accent", code: "WORD_NOT_IN_DICTIONARY" },
  ] as const)("rejects $word with $code", ({ word, rack, code }) => {
    expect(validateWord({ word, rack, dictionary })).toMatchObject({
      accepted: false,
      code,
    });
  });

  it("rejects duplicates after normalization", () => {
    expect(
      validateWord({
        word: "CAT",
        rack: "accent",
        dictionary,
        submittedWords: [" cat "],
      }),
    ).toEqual({
      accepted: false,
      normalizedWord: "cat",
      code: "DUPLICATE_WORD",
    });
  });

  it("uses the configured score table", () => {
    expect(
      ["cat", "cane", "enact", "accent"].map((word) => scoreWord(word)),
    ).toEqual([100, 400, 1200, 2000]);
    expect(scoreWord("at")).toBe(0);
  });
});

describe("server timing decisions", () => {
  it("calculates the default 60-second deadline", () => {
    expect(
      roundExpiresAt(new Date("2026-01-01T00:00:00.000Z")).toISOString(),
    ).toBe("2026-01-01T00:01:00.000Z");
  });

  it("treats the exact deadline as expired", () => {
    expect(isRoundExpired(59_999, 60_000)).toBe(false);
    expect(isRoundExpired(60_000, 60_000)).toBe(true);
    expect(isRoundExpired(60_001, 60_000)).toBe(true);
  });
});

describe("results", () => {
  const player = (playerId: string, score: number, validWordCount: number) => ({
    playerId,
    score,
    validWordCount,
  });

  it("selects the higher score", () => {
    expect(resolveResult(player("a", 500, 2), player("b", 400, 4))).toEqual({
      outcome: "win",
      winnerId: "a",
      loserId: "b",
    });
  });

  it("breaks an equal score by valid word count", () => {
    expect(resolveResult(player("a", 500, 3), player("b", 500, 2))).toEqual({
      outcome: "win",
      winnerId: "a",
      loserId: "b",
    });
  });

  it("draws when score and count are equal", () => {
    expect(resolveResult(player("a", 500, 2), player("b", 500, 2))).toEqual({
      outcome: "draw",
    });
  });
});

describe("state transitions", () => {
  it("allows only the forward game lifecycle", () => {
    expect(() =>
      assertGameTransition("waiting_for_opponent", "ready_check"),
    ).not.toThrow();
    expect(() =>
      assertGameTransition("ready_check", "in_progress"),
    ).not.toThrow();
    expect(() =>
      assertGameTransition("in_progress", "finalizing"),
    ).not.toThrow();
    expect(() => assertGameTransition("finalizing", "completed")).not.toThrow();
    expect(() => assertGameTransition("completed", "in_progress")).toThrow(
      InvalidStateTransitionError,
    );
    expect(() =>
      assertGameTransition("waiting_for_opponent", "completed"),
    ).toThrow(InvalidStateTransitionError);
  });

  it("allows active rounds to finish or expire but not reopen", () => {
    expect(() => assertRoundTransition("not_started", "active")).not.toThrow();
    expect(() => assertRoundTransition("active", "finished")).not.toThrow();
    expect(() => assertRoundTransition("active", "expired")).not.toThrow();
    expect(() => assertRoundTransition("finished", "active")).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe("missed words", () => {
  it("enumerates playable unique dictionary words not submitted", () => {
    const fixture = createTestDictionary([
      "cat",
      "CAT",
      "act",
      "cane",
      "enact",
      "accent",
      "ante",
      "a-t",
      "at",
      "longword",
    ]);
    expect(
      enumerateMissedWords({
        rack: "accent",
        dictionary: fixture,
        submittedWords: [" CAT ", "cane"],
      }),
    ).toEqual(["act", "ante", "enact", "accent"]);
  });
});
