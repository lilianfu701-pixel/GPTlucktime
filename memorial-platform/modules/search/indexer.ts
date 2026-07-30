import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  deceasedPeople,
  memorialLocations,
  memorialNames,
  memorials,
  searchDocuments,
} from "@/db/schema";
import { normalizeForSearch, placeTokens } from "./normalize";

/**
 * Rebuilds the search document for one memorial.
 *
 * Only names the family left searchable are included. Doc 07 section 4 lets a
 * family record a former name without making it findable, and that choice has to
 * survive every reindex, not just the first one.
 *
 * Aliases and place tokens are folded into `normalizedText` as well as kept in
 * their own columns, so one trigram index serves substring matching across all
 * of them.
 */
export async function indexMemorial(memorialId: string): Promise<boolean> {
  const [memorial] = await db()
    .select({
      id: memorials.id,
      deceasedPersonId: memorials.deceasedPersonId,
      birthDate: deceasedPeople.birthDate,
      deathDate: deceasedPeople.deathDate,
    })
    .from(memorials)
    .innerJoin(
      deceasedPeople,
      eq(deceasedPeople.id, memorials.deceasedPersonId),
    )
    .where(eq(memorials.id, memorialId));

  if (!memorial) {
    return false;
  }

  const names = await db()
    .select({ value: memorialNames.value, type: memorialNames.type })
    .from(memorialNames)
    .where(
      and(
        eq(memorialNames.memorialId, memorialId),
        eq(memorialNames.searchable, true),
      ),
    );

  const locations = await db()
    .select({
      country: memorialLocations.country,
      region: memorialLocations.region,
      city: memorialLocations.city,
    })
    .from(memorialLocations)
    .where(eq(memorialLocations.memorialId, memorialId));

  const aliases = names
    .filter((name) => name.type !== "primary")
    .map((name) => normalizeForSearch(name.value))
    .filter((value) => value.length > 0);

  const tokens = placeTokens(
    locations.flatMap((location) => [location.region, location.city]),
  );

  const countryCodes = [
    ...new Set(
      locations
        .map((location) => location.country?.toUpperCase())
        .filter((code): code is string => Boolean(code)),
    ),
  ];

  const normalizedText = [
    ...names.map((name) => normalizeForSearch(name.value)),
    ...tokens,
  ]
    .filter((value) => value.length > 0)
    .join(" ");

  const birthYear = yearOf(memorial.birthDate);
  const deathYear = yearOf(memorial.deathDate);

  await db()
    .insert(searchDocuments)
    .values({
      memorialId,
      normalizedText,
      aliases,
      countryCodes,
      placeTokens: tokens,
      birthYear,
      deathYear,
      indexedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: searchDocuments.memorialId,
      set: {
        normalizedText,
        aliases,
        countryCodes,
        placeTokens: tokens,
        birthYear,
        deathYear,
        indexedAt: new Date(),
      },
    });

  return true;
}

/**
 * Removes a memorial's search document.
 *
 * Cleanup, not protection. Access is already refused by the time this runs; the
 * query filters on the live memorial row rather than on anything stored here.
 */
export async function removeFromIndex(memorialId: string): Promise<void> {
  await db()
    .delete(searchDocuments)
    .where(eq(searchDocuments.memorialId, memorialId));
}

function yearOf(date: string | null): number | null {
  if (!date) {
    return null;
  }
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}
