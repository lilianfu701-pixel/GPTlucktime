/**
 * Text preparation shared by the indexer and the query.
 *
 * Both sides must normalize identically. If they diverge, a memorial becomes
 * findable by a spelling nobody would type, or unfindable by the one they would.
 */

/**
 * Lowercases, strips combining marks and collapses whitespace.
 *
 * Combining marks are removed so that a name typed without accents still finds
 * the person: someone searching for a grandparent from a phone keyboard that
 * cannot produce "ó" should not be turned away. The original spelling is kept
 * on `memorial_names` and is what gets displayed; this is only the match key.
 *
 * Unicode is normalized to NFC first, so text that arrives decomposed compares
 * the same as text that arrives composed. Doc 07 section 4 requires that
 * normalization not lose the original input, which it does not: this produces a
 * separate value.
 */
export function normalizeForSearch(input: string): string {
  return input
    .normalize("NFC")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits a place name into the tokens a search might use. */
export function placeTokens(
  parts: readonly (string | null | undefined)[],
): string[] {
  const tokens = new Set<string>();

  for (const part of parts) {
    if (!part) continue;
    const normalized = normalizeForSearch(part);
    if (normalized.length === 0) continue;
    tokens.add(normalized);
    for (const word of normalized.split(" ")) {
      if (word.length > 1) {
        tokens.add(word);
      }
    }
  }

  return [...tokens];
}

/**
 * The shortest query worth running.
 *
 * One character matches almost everything and would return an arbitrary slice of
 * the platform. Two is enough for a Chinese, Japanese or Korean name, which is
 * why the floor is not three.
 */
export const MIN_QUERY_LENGTH = 2;

export function isQueryLongEnough(query: string): boolean {
  return normalizeForSearch(query).length >= MIN_QUERY_LENGTH;
}
