import { and, arrayContains, desc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { memorialNames, memorials, searchDocuments } from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { MIN_QUERY_LENGTH, isQueryLongEnough, normalizeForSearch } from "./normalize";

export type SearchError = "QUERY_TOO_SHORT" | "NO_CRITERIA";

export type SearchHit = {
  memorialId: string;
  slug: string;
  primaryName: string;
  birthYear: number | null;
  deathYear: number | null;
  countryCodes: string[];
};

export type SearchPage = {
  hits: SearchHit[];
  nextCursor: string | null;
};

/** Bounded so a scraper cannot ask for the platform in one request. */
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 20;

/**
 * How far into the results a caller may page.
 *
 * Deep pagination is how a public search becomes a bulk export. Someone looking
 * for one person finds them in the first pages; someone walking to offset 5000
 * is building a list. Doc 06 section 9 names bulk scraping as a threat.
 */
export const MAX_OFFSET = 200;

export type SearchCriteria = {
  q?: string | undefined;
  birthYear?: number | undefined;
  deathYear?: number | undefined;
  country?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
};

/**
 * Finds public memorials.
 *
 * The privacy conditions live in this SQL statement and are joined against the
 * live `memorials` row, never against anything denormalized into
 * `search_documents`. That is the whole design:
 *
 * A family switching a memorial to invite-only is protected on the next query,
 * even though the index still holds a document for it until a worker catches up.
 * Had the visibility been copied into the document and filtered there, the gap
 * between the privacy change and the reindex would be a window in which the
 * memorial is still findable — precisely what doc 02 section 5 forbids.
 *
 * Applying the filter in application code after the query would be worse again,
 * because the rows would already have left the database.
 */
export async function searchMemorials(
  criteria: SearchCriteria,
): Promise<Result<SearchPage, SearchError>> {
  const query = criteria.q?.trim() ?? "";
  const hasQuery = query.length > 0;

  if (hasQuery && !isQueryLongEnough(query)) {
    return err("QUERY_TOO_SHORT");
  }

  const hasAnyCriteria =
    hasQuery ||
    criteria.birthYear !== undefined ||
    criteria.deathYear !== undefined ||
    Boolean(criteria.country);

  if (!hasAnyCriteria) {
    // An empty search would be a request to list every public memorial.
    return err("NO_CRITERIA");
  }

  const limit = Math.min(
    Math.max(criteria.limit ?? DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const offset = Math.min(parseCursor(criteria.cursor), MAX_OFFSET);

  const conditions: SQL[] = [
    // The privacy contract, in the statement itself.
    eq(memorials.visibility, "public"),
    eq(memorials.status, "published"),
    isNull(memorials.deletionRequestedAt),
  ];

  if (hasQuery) {
    const normalized = normalizeForSearch(query);
    conditions.push(
      sql`${searchDocuments.normalizedText} LIKE ${`%${normalized}%`}`,
    );
  }

  if (criteria.birthYear !== undefined) {
    conditions.push(eq(searchDocuments.birthYear, criteria.birthYear));
  }

  if (criteria.deathYear !== undefined) {
    conditions.push(eq(searchDocuments.deathYear, criteria.deathYear));
  }

  if (criteria.country) {
    conditions.push(
      arrayContains(searchDocuments.countryCodes, [
        criteria.country.toUpperCase(),
      ]),
    );
  }

  const rows = await db()
    .select({
      memorialId: memorials.id,
      slug: memorials.slug,
      birthYear: searchDocuments.birthYear,
      deathYear: searchDocuments.deathYear,
      countryCodes: searchDocuments.countryCodes,
      publishedAt: memorials.publishedAt,
    })
    .from(searchDocuments)
    .innerJoin(memorials, eq(memorials.id, searchDocuments.memorialId))
    .where(and(...conditions))
    // Newest first. Deliberately not by popularity: doc 01 section 4.3 rules out
    // anything that ranks one family's memorial above another's.
    .orderBy(desc(memorials.publishedAt), desc(memorials.id))
    .limit(limit + 1)
    .offset(offset);

  const page = rows.slice(0, limit);
  const hits: SearchHit[] = [];

  for (const row of page) {
    hits.push({
      memorialId: row.memorialId,
      slug: row.slug,
      primaryName: await primaryNameFor(row.memorialId),
      birthYear: row.birthYear,
      deathYear: row.deathYear,
      countryCodes: row.countryCodes ?? [],
    });
  }

  const hasMore = rows.length > limit && offset + limit < MAX_OFFSET;

  return ok({
    hits,
    nextCursor: hasMore ? String(offset + limit) : null,
  });
}

/**
 * The name to show for a result.
 *
 * Read from `memorial_names` rather than from the search document, because the
 * document holds the normalized match key and a person's name should be
 * displayed as their family wrote it.
 */
async function primaryNameFor(memorialId: string): Promise<string> {
  const [row] = await db()
    .select({ value: memorialNames.value })
    .from(memorialNames)
    .where(
      and(
        eq(memorialNames.memorialId, memorialId),
        eq(memorialNames.type, "primary"),
      ),
    );

  return row?.value ?? "";
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export { MIN_QUERY_LENGTH };
