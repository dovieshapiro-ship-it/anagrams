# Production dictionary

`words.txt` is a deterministic game dictionary generated from the English Speller Database (ESDB, formerly SCOWLv2).

## Pinned source

- Release: `rel-2026.02.25`
- Commit: `7e99edab8e32f9f9ea2b15f249ca8d4d67237410`
- Archive: `https://github.com/en-wl/wordlist/archive/7e99edab8e32f9f9ea2b15f249ca8d4d67237410.tar.gz`
- Archive SHA-256: `770dd3e42d20b47bb2dd87d150db4ee5472841a7f062876592f67840f5a0b902`
- Generated file SHA-256: `87c2017b519019c1547e8822f42e2bc9861982963dfa4b671999aa4f45ca0559`
- Generated entries: 16,689

The source calls its terms an MIT-like permissive license; it is not labeled SPDX MIT here. The required notice is preserved in `LICENSE.txt`.

## Reproduction

With the pinned archive extracted and its database built using `make`:

```sh
./scowl word-list 60 A 1 --wo-poses=abbr --categories= > en-wl-raw.txt
LC_ALL=C awk '/^[a-z][a-z][a-z]([a-z]([a-z]([a-z])?)?)?$/' en-wl-raw.txt \
  | LC_ALL=C sort -u > words.txt
shasum -a 256 words.txt
```

This selects the vetted size-60 American list with variant level 1, excludes abbreviation parts of speech and special categories, and then retains only entries that were already lowercase ASCII words between three and six letters. Filtering before any lowercasing removes capitalized names and acronyms; ASCII and length filtering removes punctuation, hyphens, apostrophes, spaces, diacritics, and words that cannot be played with the default rack.

No general-purpose dictionary can perfectly distinguish names from ordinary-word homographs or make subjective content decisions. Future removals should use a reviewed denylist with regression tests and must update the generated checksum.
