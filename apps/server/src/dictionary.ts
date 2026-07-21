import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { WordDictionary } from "@anagrams/game-engine";

export async function loadDictionary(): Promise<WordDictionary> {
  const path = fileURLToPath(
    new URL(
      "../../../packages/game-engine/dictionary/words.txt",
      import.meta.url,
    ),
  );
  const values = (await readFile(path, "utf8"))
    .split(/\r?\n/u)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => /^[a-z]+$/u.test(word));
  const words = new Set(values);
  return { has: (word) => words.has(word), words: () => words.values() };
}
