# `@anagrams/game-engine`

Pure, strict-TypeScript rules for Anagrams. The package performs no network, database, clock, or random I/O. Callers inject current timestamps, an RNG, and a dictionary, which keeps the server authoritative and tests deterministic.

The default rules come from `@anagrams/shared-types`: six letters, 60 seconds, minimum length three, and scores of 100/400/1200/2000 for lengths three through six.

## Dictionary contract

Production code must supply a normalized English dictionary through `WordDictionary`. `has()` determines submission validity. `words()` is required only for missed-word enumeration and may iterate a precomputed rack index in a production implementation; callers should not repeatedly scan a large raw word list.

The pinned production artifact, source metadata, reproducible filtering command, checksum, and license notice live in `dictionary/`. Dictionary entries are lowercase ASCII words from three through six letters. The engine still normalizes and structurally validates entries defensively.

## Randomness contract

`generateRack` requires a `RandomSource`. Production callers must adapt a cryptographically secure source such as Node's `crypto.randomBytes`; `Math.random()` is not suitable. Sampling uses rejection rather than biased modulo reduction. Tests use deterministic sources.

## Main operations

- `generateRack` creates a shuffled rack containing at least one configured vowel and consonant.
- `generatePlayableRack` additionally retries with a bounded attempt count until the dictionary exposes at least one playable word; game creation should prefer it.
- `generateQualityRack` is the production-oriented six-letter generator. It chooses from a hidden curated common-word pool, verifies the base against the supplied dictionary, requires 2–3 vowels, limits duplicates and rare-letter patterns, requires a six-letter anagram, and defaults to at least 15 playable dictionary words. Results include safe quality counts, never the base word. Analysis is cached per dictionary instance.
- `validateWord` normalizes and validates structure, length, rack usage, dictionary membership, and per-round duplicates.
- `scoreWord`, `isRoundExpired`, and `resolveResult` implement scoring and timing rules.
- `assertGameTransition` and `assertRoundTransition` reject illegal state changes.
- `enumerateMissedWords` lists playable dictionary words not submitted by the player.
