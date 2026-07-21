import type { WordDictionary } from "./index.js";

/** Small deterministic fixture for tests and examples; not a production dictionary. */
export const TEST_DICTIONARY_WORDS = [
  "act",
  "ant",
  "ate",
  "can",
  "cat",
  "eat",
  "net",
  "tan",
  "tea",
  "tent",
  "cane",
  "cant",
  "cent",
  "ante",
  "enact",
  "accent",
] as const;

export function createTestDictionary(
  words: readonly string[] = TEST_DICTIONARY_WORDS,
): WordDictionary {
  const normalized = new Set(words.map((word) => word.trim().toLowerCase()));
  return {
    has: (word) => normalized.has(word),
    words: () => normalized.values(),
  };
}
