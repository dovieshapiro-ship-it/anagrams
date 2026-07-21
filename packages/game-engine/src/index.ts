import { DEFAULT_GAME_RULES, type GameRules } from "@anagrams/shared-types";

export { DEFAULT_GAME_RULES } from "@anagrams/shared-types";
export type { GameRules } from "@anagrams/shared-types";

const ASCII_WORD = /^[a-z]+$/;
const UINT32_RANGE = 0x1_0000_0000;
const VOWELS = "aeiou";
const RARE_LETTERS = "jqxz";
const EASY_SIX_LETTER_BASE_WORDS = [
  "planet",
  "listen",
  "retain",
  "garden",
  "stream",
  "orange",
  "reason",
  "senate",
  "course",
  "danger",
  "friend",
  "credit",
  "market",
  "travel",
  "winter",
  "summer",
  "flower",
  "castle",
  "forest",
  "parent",
  "nature",
  "marine",
  "animal",
  "author",
  "camera",
  "detail",
  "editor",
  "ground",
  "health",
  "island",
  "matter",
  "modern",
  "mother",
  "people",
  "person",
  "school",
  "street",
  "theory",
  "thread",
  "wonder",
  "player",
  "please",
  "secure",
  "search",
  "answer",
  "create",
  "active",
  "master",
  "rental",
  "stared",
  "traces",
] as const;
const MEDIUM_SIX_LETTER_BASE_WORDS = [
  "ardent",
  "ascend",
  "canter",
  "cavern",
  "cinder",
  "claret",
  "coarse",
  "craven",
  "dearth",
  "drapes",
  "entail",
  "gaiter",
  "gleans",
  "inmate",
  "mantle",
  "nectar",
  "orient",
  "pliant",
  "reside",
  "saline",
  "satire",
  "tinder",
  "unrest",
] as const;
const HARD_SIX_LETTER_BASE_WORDS = [
  "adroit",
  "airmen",
  "amused",
  "anemic",
  "arisen",
  "astern",
  "binary",
  "bistro",
  "bleary",
  "brazen",
  "cairns",
  "deigns",
  "famine",
  "fiesta",
  "hearth",
  "ironic",
  "lancer",
  "rancor",
  "velour",
  "waning",
] as const;
const DEFAULT_DIFFICULTY_POOLS: SixLetterDifficultyPools = {
  easy: EASY_SIX_LETTER_BASE_WORDS,
  medium: MEDIUM_SIX_LETTER_BASE_WORDS,
  hard: HARD_SIX_LETTER_BASE_WORDS,
};
const qualityCache = new WeakMap<
  WordDictionary,
  Map<string, RackQualityMetadata | null>
>();

export interface RandomSource {
  /** Returns an unsigned integer in the inclusive range 0..2^32-1. */
  nextUint32(): number;
}

export interface RackGenerationOptions {
  readonly alphabet?: string;
  readonly vowels?: string;
  readonly consonants?: string;
}

export interface PlayableRackGenerationOptions extends RackGenerationOptions {
  /** Bounds dictionary scans and RNG use if configured pools cannot produce a word. */
  readonly maximumAttempts?: number;
}

export interface QualityRackGenerationOptions {
  readonly rules?: GameRules;
  /** A flat custom pool bypasses the default mixed-difficulty selection. */
  readonly baseWords?: readonly string[];
  readonly difficultyPools?: SixLetterDifficultyPools;
  readonly minimumPlayableWords?: number;
  readonly maximumAttempts?: number;
}

export interface SixLetterDifficultyPools {
  readonly easy: readonly string[];
  readonly medium: readonly string[];
  readonly hard: readonly string[];
}

export interface RackQualityMetadata {
  readonly playableWordCount: number;
  readonly sixLetterAnagramCount: number;
  readonly vowelCount: number;
  readonly maxDuplicateCount: number;
  readonly rareLetterCount: number;
}

export interface QualityRack {
  readonly rack: readonly string[];
  readonly quality: RackQualityMetadata;
}

export interface WordDictionary {
  has(normalizedWord: string): boolean;
  /** Iterates candidates for missed-word enumeration. Implementations may use a rack index. */
  words(): Iterable<string>;
}

export type WordRejectionCode =
  | "EMPTY_WORD"
  | "INVALID_CHARACTERS"
  | "WORD_TOO_SHORT"
  | "WORD_TOO_LONG"
  | "WORD_NOT_IN_RACK"
  | "WORD_NOT_IN_DICTIONARY"
  | "DUPLICATE_WORD";

export type WordValidationResult =
  | {
      readonly accepted: true;
      readonly normalizedWord: string;
      readonly score: number;
    }
  | {
      readonly accepted: false;
      readonly normalizedWord: string;
      readonly code: WordRejectionCode;
    };

export interface ValidateWordInput {
  readonly word: string;
  readonly rack: string | readonly string[];
  readonly dictionary: WordDictionary;
  readonly submittedWords?: ReadonlySet<string> | readonly string[];
  readonly rules?: GameRules;
}

export type GameState =
  | "waiting_for_opponent"
  | "ready_check"
  | "in_progress"
  | "finalizing"
  | "completed";

export type RoundState = "not_started" | "active" | "finished" | "expired";

export class InvalidStateTransitionError extends Error {
  public constructor(
    public readonly entity: "game" | "round",
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${entity} state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

export interface PlayerResult {
  readonly playerId: string;
  readonly score: number;
  readonly validWordCount: number;
}

export type GameResult =
  | {
      readonly outcome: "win";
      readonly winnerId: string;
      readonly loserId: string;
    }
  | { readonly outcome: "draw" };

const GAME_TRANSITIONS: Readonly<Record<GameState, ReadonlySet<GameState>>> = {
  waiting_for_opponent: new Set(["ready_check"]),
  ready_check: new Set(["in_progress"]),
  in_progress: new Set(["finalizing"]),
  finalizing: new Set(["completed"]),
  completed: new Set(),
};

const ROUND_TRANSITIONS: Readonly<Record<RoundState, ReadonlySet<RoundState>>> =
  {
    not_started: new Set(["active"]),
    active: new Set(["finished", "expired"]),
    finished: new Set(),
    expired: new Set(),
  };

export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

export function isStructurallyValidWord(normalizedWord: string): boolean {
  return ASCII_WORD.test(normalizedWord);
}

export function canBuildWordFromRack(
  word: string,
  rack: string | readonly string[],
): boolean {
  const available = letterCounts(normalizeRack(rack));
  for (const letter of word) {
    const remaining = available.get(letter) ?? 0;
    if (remaining === 0) return false;
    available.set(letter, remaining - 1);
  }
  return true;
}

export function scoreWord(
  word: string,
  rules: GameRules = DEFAULT_GAME_RULES,
): number {
  return rules.scoreByLength[String(normalizeWord(word).length)] ?? 0;
}

export function validateWord(input: ValidateWordInput): WordValidationResult {
  const rules = input.rules ?? DEFAULT_GAME_RULES;
  const normalizedWord = normalizeWord(input.word);
  if (normalizedWord.length === 0)
    return rejected(normalizedWord, "EMPTY_WORD");
  if (!isStructurallyValidWord(normalizedWord))
    return rejected(normalizedWord, "INVALID_CHARACTERS");
  if (normalizedWord.length < rules.minimumWordLength)
    return rejected(normalizedWord, "WORD_TOO_SHORT");
  if (normalizedWord.length > rules.rackSize)
    return rejected(normalizedWord, "WORD_TOO_LONG");
  if (!canBuildWordFromRack(normalizedWord, input.rack))
    return rejected(normalizedWord, "WORD_NOT_IN_RACK");
  if (!input.dictionary.has(normalizedWord))
    return rejected(normalizedWord, "WORD_NOT_IN_DICTIONARY");

  const submitted = input.submittedWords ?? [];
  for (const existing of submitted) {
    if (normalizeWord(existing) === normalizedWord)
      return rejected(normalizedWord, "DUPLICATE_WORD");
  }

  return {
    accepted: true,
    normalizedWord,
    score: scoreWord(normalizedWord, rules),
  };
}

export function generateRack(
  random: RandomSource,
  rules: GameRules = DEFAULT_GAME_RULES,
  options: RackGenerationOptions = {},
): readonly string[] {
  const alphabet = validateLetterPool(
    options.alphabet ?? "abcdefghijklmnopqrstuvwxyz",
    "alphabet",
  );
  const vowels = validateLetterPool(options.vowels ?? "aeiou", "vowels");
  const consonants = validateLetterPool(
    options.consonants ?? "bcdfghjklmnpqrstvwxyz",
    "consonants",
  );
  if (rules.rackSize < 2) throw new RangeError("rackSize must be at least 2");

  const rack = [pick(vowels, random), pick(consonants, random)];
  while (rack.length < rules.rackSize) rack.push(pick(alphabet, random));
  shuffle(rack, random);
  return rack;
}

/**
 * Generates a legal rack that has at least one dictionary-valid playable word.
 * Production game creation should prefer this over `generateRack` so a legal but
 * unusable random rack cannot strand both players.
 */
export function generatePlayableRack(
  random: RandomSource,
  dictionary: WordDictionary,
  rules: GameRules = DEFAULT_GAME_RULES,
  options: PlayableRackGenerationOptions = {},
): readonly string[] {
  const maximumAttempts = options.maximumAttempts ?? 128;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts <= 0) {
    throw new RangeError("maximumAttempts must be a positive safe integer");
  }
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const rack = generateRack(random, rules, options);
    if (hasPlayableWord(rack, dictionary, rules)) return rack;
  }
  throw new Error(
    `Unable to generate a playable rack after ${String(maximumAttempts)} attempts`,
  );
}

/**
 * Selects a common hidden six-letter base word, validates it against the pinned
 * dictionary and quality constraints, then returns only a shuffled rack and
 * non-sensitive quality counts. Quality analysis is cached per dictionary.
 */
export function generateQualityRack(
  random: RandomSource,
  dictionary: WordDictionary,
  options: QualityRackGenerationOptions = {},
): QualityRack {
  const rules = options.rules ?? DEFAULT_GAME_RULES;
  if (rules.rackSize !== 6)
    throw new RangeError("Quality rack generation requires a six-letter rack");
  const minimumPlayableWords = options.minimumPlayableWords ?? 15;
  const maximumAttempts = options.maximumAttempts ?? 64;
  if (
    !Number.isSafeInteger(minimumPlayableWords) ||
    minimumPlayableWords <= 0
  ) {
    throw new RangeError(
      "minimumPlayableWords must be a positive safe integer",
    );
  }
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts <= 0) {
    throw new RangeError("maximumAttempts must be a positive safe integer");
  }
  const baseWords = options.baseWords;
  const difficultyPools = options.difficultyPools ?? DEFAULT_DIFFICULTY_POOLS;
  if (baseWords?.length === 0) throw new RangeError("baseWords cannot be empty");
  if (
    baseWords === undefined &&
    (difficultyPools.easy.length === 0 ||
      difficultyPools.medium.length === 0 ||
      difficultyPools.hard.length === 0)
  )
    throw new RangeError("difficulty pools cannot be empty");

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const selectedPool =
      baseWords ?? selectDifficultyPool(difficultyPools, random);
    const baseWord = selectedPool[uniformIndex(selectedPool.length, random)];
    if (baseWord === undefined)
      throw new Error("Base-word selection invariant failed");
    const quality = inspectSixLetterBaseWord(baseWord, dictionary, rules);
    if (quality === null || quality.playableWordCount < minimumPlayableWords)
      continue;
    const rack = Array.from(normalizeWord(baseWord));
    shuffle(rack, random);
    return { rack, quality };
  }
  throw new Error(
    `Unable to generate a quality rack with at least ${String(minimumPlayableWords)} playable words after ${String(maximumAttempts)} attempts`,
  );
}

function selectDifficultyPool(
  pools: SixLetterDifficultyPools,
  random: RandomSource,
): readonly string[] {
  // Twenty equally likely slots give a 40% easy, 35% medium, 25% hard mix.
  const slot = uniformIndex(20, random);
  if (slot < 8) return pools.easy;
  if (slot < 15) return pools.medium;
  return pools.hard;
}

export function countPlayableWords(
  rack: string | readonly string[],
  dictionary: WordDictionary,
  rules: GameRules = DEFAULT_GAME_RULES,
): number {
  const unique = new Set<string>();
  for (const candidate of dictionary.words()) {
    const normalized = normalizeWord(candidate);
    if (
      isStructurallyValidWord(normalized) &&
      normalized.length >= rules.minimumWordLength &&
      normalized.length <= rules.rackSize &&
      canBuildWordFromRack(normalized, rack)
    )
      unique.add(normalized);
  }
  return unique.size;
}

export function inspectSixLetterBaseWord(
  baseWord: string,
  dictionary: WordDictionary,
  rules: GameRules = DEFAULT_GAME_RULES,
): RackQualityMetadata | null {
  const normalized = normalizeWord(baseWord);
  const cacheKey = `${String(rules.minimumWordLength)}:${String(rules.rackSize)}:${normalized}`;
  let dictionaryCache = qualityCache.get(dictionary);
  if (dictionaryCache?.has(cacheKey) === true)
    return dictionaryCache.get(cacheKey) ?? null;

  let quality: RackQualityMetadata | null = null;
  if (isAcceptableBasePattern(normalized) && dictionary.has(normalized)) {
    const playable = new Set<string>();
    const sixLetterAnagrams = new Set<string>();
    for (const candidate of dictionary.words()) {
      const word = normalizeWord(candidate);
      if (
        !isStructurallyValidWord(word) ||
        word.length < rules.minimumWordLength ||
        word.length > rules.rackSize ||
        !canBuildWordFromRack(word, normalized)
      )
        continue;
      playable.add(word);
      if (word.length === 6) sixLetterAnagrams.add(word);
    }
    if (sixLetterAnagrams.size > 0) {
      const counts = letterCounts(Array.from(normalized));
      quality = {
        playableWordCount: playable.size,
        sixLetterAnagramCount: sixLetterAnagrams.size,
        vowelCount: Array.from(normalized).filter((letter) =>
          VOWELS.includes(letter),
        ).length,
        maxDuplicateCount: Math.max(...counts.values()),
        rareLetterCount: Array.from(normalized).filter((letter) =>
          RARE_LETTERS.includes(letter),
        ).length,
      };
    }
  }
  dictionaryCache ??= new Map();
  dictionaryCache.set(cacheKey, quality);
  qualityCache.set(dictionary, dictionaryCache);
  return quality;
}

export function hasPlayableWord(
  rack: string | readonly string[],
  dictionary: WordDictionary,
  rules: GameRules = DEFAULT_GAME_RULES,
): boolean {
  for (const candidate of dictionary.words()) {
    const normalized = normalizeWord(candidate);
    if (
      isStructurallyValidWord(normalized) &&
      normalized.length >= rules.minimumWordLength &&
      normalized.length <= rules.rackSize &&
      canBuildWordFromRack(normalized, rack)
    ) {
      return true;
    }
  }
  return false;
}

export function isRoundExpired(
  now: Date | number,
  expiresAt: Date | number,
): boolean {
  return toEpoch(now) >= toEpoch(expiresAt);
}

export function roundExpiresAt(
  startedAt: Date | number,
  rules: GameRules = DEFAULT_GAME_RULES,
): Date {
  return new Date(toEpoch(startedAt) + rules.roundSeconds * 1_000);
}

export function assertGameTransition(from: GameState, to: GameState): void {
  if (!GAME_TRANSITIONS[from].has(to))
    throw new InvalidStateTransitionError("game", from, to);
}

export function assertRoundTransition(from: RoundState, to: RoundState): void {
  if (!ROUND_TRANSITIONS[from].has(to))
    throw new InvalidStateTransitionError("round", from, to);
}

export function resolveResult(
  first: PlayerResult,
  second: PlayerResult,
): GameResult {
  const scoreDifference = first.score - second.score;
  if (scoreDifference !== 0)
    return win(
      scoreDifference > 0 ? first : second,
      scoreDifference > 0 ? second : first,
    );

  const countDifference = first.validWordCount - second.validWordCount;
  if (countDifference !== 0)
    return win(
      countDifference > 0 ? first : second,
      countDifference > 0 ? second : first,
    );
  return { outcome: "draw" };
}

export function enumerateMissedWords(input: {
  readonly rack: string | readonly string[];
  readonly dictionary: WordDictionary;
  readonly submittedWords: ReadonlySet<string> | readonly string[];
  readonly rules?: GameRules;
}): readonly string[] {
  const rules = input.rules ?? DEFAULT_GAME_RULES;
  const submitted = new Set(Array.from(input.submittedWords, normalizeWord));
  const missed = new Set<string>();

  for (const candidate of input.dictionary.words()) {
    const normalized = normalizeWord(candidate);
    if (submitted.has(normalized) || missed.has(normalized)) continue;
    if (!isStructurallyValidWord(normalized)) continue;
    if (
      normalized.length < rules.minimumWordLength ||
      normalized.length > rules.rackSize
    )
      continue;
    if (canBuildWordFromRack(normalized, input.rack)) missed.add(normalized);
  }

  return [...missed].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
}

function rejected(
  normalizedWord: string,
  code: WordRejectionCode,
): WordValidationResult {
  return { accepted: false, normalizedWord, code };
}

function normalizeRack(rack: string | readonly string[]): readonly string[] {
  const letters = typeof rack === "string" ? Array.from(rack) : [...rack];
  return letters.map((letter) => normalizeWord(letter));
}

function letterCounts(letters: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const letter of letters)
    counts.set(letter, (counts.get(letter) ?? 0) + 1);
  return counts;
}

function isAcceptableBasePattern(word: string): boolean {
  if (!/^[a-z]{6}$/.test(word)) return false;
  const letters = Array.from(word);
  const vowelCount = letters.filter((letter) => VOWELS.includes(letter)).length;
  if (vowelCount !== 2 && vowelCount !== 3) return false;
  const counts = letterCounts(letters);
  if (Math.max(...counts.values()) > 2) return false;
  if (word.includes("q") && !word.includes("u")) return false;
  if (letters.filter((letter) => RARE_LETTERS.includes(letter)).length > 1)
    return false;
  return longestClassRun(word, true) <= 2 && longestClassRun(word, false) <= 3;
}

function longestClassRun(word: string, vowels: boolean): number {
  let longest = 0;
  let current = 0;
  for (const letter of word) {
    if (VOWELS.includes(letter) === vowels) {
      current += 1;
      longest = Math.max(longest, current);
    } else current = 0;
  }
  return longest;
}

function validateLetterPool(pool: string, name: string): string {
  const normalized = normalizeWord(pool);
  if (!ASCII_WORD.test(normalized))
    throw new TypeError(`${name} must contain only ASCII letters`);
  return normalized;
}

function pick(pool: string, random: RandomSource): string {
  const value = pool[uniformIndex(pool.length, random)];
  if (value === undefined)
    throw new RangeError("Cannot pick from an empty letter pool");
  return value;
}

function uniformIndex(length: number, random: RandomSource): number {
  if (!Number.isSafeInteger(length) || length <= 0 || length > UINT32_RANGE) {
    throw new RangeError("Random selection length must be between 1 and 2^32");
  }
  const acceptanceLimit = UINT32_RANGE - (UINT32_RANGE % length);
  for (;;) {
    const value = random.nextUint32();
    if (!Number.isInteger(value) || value < 0 || value >= UINT32_RANGE) {
      throw new RangeError(
        "RandomSource.nextUint32() returned an invalid value",
      );
    }
    if (value < acceptanceLimit) return value % length;
  }
}

function shuffle(values: string[], random: RandomSource): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = uniformIndex(index + 1, random);
    const currentValue = values[index];
    const otherValue = values[other];
    if (currentValue === undefined || otherValue === undefined)
      throw new Error("Shuffle index invariant failed");
    values[index] = otherValue;
    values[other] = currentValue;
  }
}

function toEpoch(value: Date | number): number {
  const epoch = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(epoch)) throw new RangeError("Timestamp must be finite");
  return epoch;
}

function win(winner: PlayerResult, loser: PlayerResult): GameResult {
  return { outcome: "win", winnerId: winner.playerId, loserId: loser.playerId };
}
