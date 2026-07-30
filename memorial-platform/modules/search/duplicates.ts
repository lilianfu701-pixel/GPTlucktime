import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { duplicateCandidates, memorials, searchDocuments } from "@/db/schema";
import { normalizeForSearch } from "./normalize";

/**
 * What a match was based on.
 *
 * Kept as separate numbers rather than folded into one score, so a reviewer can
 * see that two records agree on a common name and nothing else, and decide
 * accordingly. Doc 03 section 7 requires the basis to be recorded, not just the
 * total.
 */
export type ComponentScores = {
  name: number;
  alias: number;
  dates: number;
  place: number;
};

export type DuplicateMatch = {
  candidateMemorialId: string;
  score: number;
  components: ComponentScores;
};

/**
 * Weights. Dates carry the most because two people sharing a name is ordinary,
 * while sharing a name and a date of death is not.
 */
const WEIGHTS: ComponentScores = {
  name: 0.35,
  alias: 0.15,
  dates: 0.35,
  place: 0.15,
};

/** Below this, the pair is not worth putting in front of anyone. */
export const CANDIDATE_THRESHOLD = 0.5;

function nameSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  // Substring containment, which handles a name recorded with and without a
  // middle name, or in one script and its transliteration.
  if (a.includes(b) || b.includes(a)) {
    return 0.8;
  }
  return 0;
}

function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const setB = new Set(b);
  const shared = a.filter((value) => setB.has(value)).length;
  return shared / Math.min(a.length, b.length);
}

function dateAgreement(
  a: { birthYear: number | null; deathYear: number | null },
  b: { birthYear: number | null; deathYear: number | null },
): number {
  // Two unknown years are not agreement. Treating them as a match would make
  // every sparsely filled memorial look like every other one.
  const comparisons: number[] = [];

  if (a.birthYear !== null && b.birthYear !== null) {
    comparisons.push(a.birthYear === b.birthYear ? 1 : 0);
  }
  if (a.deathYear !== null && b.deathYear !== null) {
    comparisons.push(a.deathYear === b.deathYear ? 1 : 0);
  }

  if (comparisons.length === 0) {
    return 0;
  }

  return comparisons.reduce((sum, value) => sum + value, 0) / comparisons.length;
}

/**
 * Finds memorials that may describe the same person.
 *
 * Returns candidates. It does not merge, hide, block creation, or rank one
 * family's page above another's. Doc 03 section 7 keeps merging a human
 * decision, and a family creating a second memorial in grief deserves to be
 * shown the first one, not stopped by a number they cannot see.
 */
export async function findDuplicateCandidates(
  memorialId: string,
): Promise<DuplicateMatch[]> {
  const [subject] = await db()
    .select()
    .from(searchDocuments)
    .where(eq(searchDocuments.memorialId, memorialId));

  if (!subject) {
    return [];
  }

  const subjectName = normalizeForSearch(subject.normalizedText);
  if (subjectName.length === 0) {
    return [];
  }

  // Compared against other memorials that are not deleted. Visibility is not a
  // condition here: a duplicate of a private memorial is still a duplicate, and
  // this result is only ever seen by the family involved or by a reviewer.
  const others = await db()
    .select({
      memorialId: searchDocuments.memorialId,
      normalizedText: searchDocuments.normalizedText,
      aliases: searchDocuments.aliases,
      placeTokens: searchDocuments.placeTokens,
      birthYear: searchDocuments.birthYear,
      deathYear: searchDocuments.deathYear,
    })
    .from(searchDocuments)
    .innerJoin(memorials, eq(memorials.id, searchDocuments.memorialId))
    .where(
      and(
        ne(searchDocuments.memorialId, memorialId),
        sql`${memorials.deletionRequestedAt} is null`,
      ),
    );

  const matches: DuplicateMatch[] = [];

  for (const other of others) {
    const components: ComponentScores = {
      name: nameSimilarity(subjectName, normalizeForSearch(other.normalizedText)),
      alias: overlap(subject.aliases ?? [], other.aliases ?? []),
      dates: dateAgreement(subject, other),
      place: overlap(subject.placeTokens ?? [], other.placeTokens ?? []),
    };

    const score =
      components.name * WEIGHTS.name +
      components.alias * WEIGHTS.alias +
      components.dates * WEIGHTS.dates +
      components.place * WEIGHTS.place;

    if (score >= CANDIDATE_THRESHOLD) {
      matches.push({
        candidateMemorialId: other.memorialId,
        score: Number(score.toFixed(4)),
        components,
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

/**
 * Records candidates for review.
 *
 * Stored with status `open`. Nothing downstream acts on them automatically.
 */
export async function recordDuplicateCandidates(
  memorialId: string,
  matches: readonly DuplicateMatch[],
): Promise<number> {
  if (matches.length === 0) {
    return 0;
  }

  for (const match of matches) {
    await db()
      .insert(duplicateCandidates)
      .values({
        memorialId,
        candidateMemorialId: match.candidateMemorialId,
        score: match.score,
        componentScores: match.components,
        status: "open",
      })
      .onConflictDoUpdate({
        target: [
          duplicateCandidates.memorialId,
          duplicateCandidates.candidateMemorialId,
        ],
        set: { score: match.score, componentScores: match.components },
      });
  }

  return matches.length;
}

/** Open candidates for a memorial. */
export async function openCandidatesFor(
  memorialId: string,
): Promise<{ candidateMemorialId: string; score: number }[]> {
  return db()
    .select({
      candidateMemorialId: duplicateCandidates.candidateMemorialId,
      score: duplicateCandidates.score,
    })
    .from(duplicateCandidates)
    .where(
      and(
        eq(duplicateCandidates.memorialId, memorialId),
        eq(duplicateCandidates.status, "open"),
      ),
    );
}
