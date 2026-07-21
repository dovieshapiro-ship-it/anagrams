import { DEFAULT_GAME_RULES } from "@anagrams/shared-types";

export const ROUND_SECONDS = DEFAULT_GAME_RULES.roundSeconds;
export const DEMO_RACK = ["p", "l", "a", "n", "e", "t"] as const;

const DEMO_WORDS = new Set([
  "ale",
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
  "planet",
  "plate",
  "pleat",
  "tap",
  "tape",
  "tea",
  "ten",
]);

export interface PlayedWord {
  readonly word: string;
  readonly score: number;
}

export type SubmitResult =
  | { readonly accepted: true; readonly entry: PlayedWord }
  | { readonly accepted: false; readonly message: string };

export function scoreForLength(length: number): number {
  return DEFAULT_GAME_RULES.scoreByLength[String(length)] ?? 0;
}

export function submitLocalWord(
  rawWord: string,
  accepted: readonly PlayedWord[],
  rack: readonly string[] = DEMO_RACK,
): SubmitResult {
  const word = rawWord.trim().toLowerCase();
  if (!/^[a-z]+$/.test(word))
    return { accepted: false, message: "Use letters only." };
  if (word.length < DEFAULT_GAME_RULES.minimumWordLength)
    return { accepted: false, message: "Words need at least 3 letters." };
  if (word.length > DEFAULT_GAME_RULES.rackSize)
    return { accepted: false, message: "That word is too long." };
  if (!canMakeFromRack(word, rack))
    return { accepted: false, message: "That word doesn't fit these letters." };
  if (!DEMO_WORDS.has(word))
    return { accepted: false, message: "Not in the club dictionary." };
  if (accepted.some((entry) => entry.word === word))
    return { accepted: false, message: "You already found that one." };
  return {
    accepted: true,
    entry: { word, score: scoreForLength(word.length) },
  };
}

export function totalScore(words: readonly PlayedWord[]): number {
  return words.reduce((total, entry) => total + entry.score, 0);
}

function canMakeFromRack(word: string, rack: readonly string[]): boolean {
  const remaining = new Map<string, number>();
  for (const letter of rack)
    remaining.set(letter, (remaining.get(letter) ?? 0) + 1);
  for (const letter of word) {
    const count = remaining.get(letter) ?? 0;
    if (count === 0) return false;
    remaining.set(letter, count - 1);
  }
  return true;
}
