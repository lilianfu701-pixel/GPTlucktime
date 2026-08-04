import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { deceasedPeople, memorialNames, memorials } from "@/db/schema";
import type { Actor } from "@/modules/permissions/types";
import { resolveAccessBySlug } from "./access";
import type { AccessDenial, ViewerRole } from "./access";

export type DatePrecision =
  | "day"
  | "month"
  | "year"
  | "approximate"
  | "unknown";

export type MemorialName = {
  value: string;
  locale: string | null;
  script: string | null;
  type: "primary" | "former" | "native" | "transliteration" | "alias";
};

export type MemorialDetail = {
  memorialId: string;
  slug: string;
  visibility: "public" | "unlisted" | "invite_only";
  /** Reached here only when the viewer may see it; a draft means the family. */
  status: "draft" | "published" | "restricted";
  searchEngineIndexable: boolean;
  primaryName: string;
  /** Other recorded names, minus any the family kept out of search. */
  alternateNames: MemorialName[];
  birthDate: string | null;
  birthDatePrecision: DatePrecision;
  deathDate: string | null;
  deathDatePrecision: DatePrecision;
  publishedAt: Date | null;
  /** Whether the viewer may act on the page rather than only read it. */
  viewerRole: ViewerRole;
};

export type MemorialDetailResult =
  | { ok: true; detail: MemorialDetail }
  /** A merge happened. The caller redirects rather than rendering. */
  | { ok: false; reason: "MERGED"; redirectSlug: string | null }
  | { ok: false; reason: Exclude<AccessDenial, "MERGED">; redirectSlug?: never };

/**
 * Everything the memorial page renders, or the reason it may not.
 *
 * Access is resolved first and the record is only read afterwards. The order
 * matters: a function that loaded the person and then decided whether to show
 * them would put the name in memory — and one `console.log` away from a
 * log line — for a viewer who was never permitted to learn it exists.
 */
export async function loadMemorialDetail(
  slug: string,
  actor: Actor,
): Promise<MemorialDetailResult> {
  const access = await resolveAccessBySlug(slug, actor);

  if (!access.allowed) {
    if (access.reason === "MERGED") {
      return {
        ok: false,
        reason: "MERGED",
        redirectSlug: access.memorialId
          ? await mergeTargetSlug(access.memorialId)
          : null,
      };
    }
    return { ok: false, reason: access.reason };
  }

  const memorialId = access.memorialId;
  if (!memorialId) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const [row] = await db()
    .select({
      slug: memorials.slug,
      visibility: memorials.visibility,
      status: memorials.status,
      searchEngineIndexable: memorials.searchEngineIndexable,
      publishedAt: memorials.publishedAt,
      birthDate: deceasedPeople.birthDate,
      birthDatePrecision: deceasedPeople.birthDatePrecision,
      deathDate: deceasedPeople.deathDate,
      deathDatePrecision: deceasedPeople.deathDatePrecision,
    })
    .from(memorials)
    .innerJoin(
      deceasedPeople,
      eq(deceasedPeople.id, memorials.deceasedPersonId),
    )
    .where(eq(memorials.id, memorialId));

  if (!row) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const names = await db()
    .select({
      value: memorialNames.value,
      locale: memorialNames.locale,
      script: memorialNames.script,
      type: memorialNames.type,
      searchable: memorialNames.searchable,
    })
    .from(memorialNames)
    .where(eq(memorialNames.memorialId, memorialId))
    .orderBy(asc(memorialNames.createdAt));

  /*
   * The row used as the heading, by index rather than by value.
   *
   * Falling back to the first row matters: a memorial with no row typed
   * `primary` — a merge, or an import — would otherwise show its first name as
   * the heading *and* again under "also known as", because a value comparison
   * cannot exclude a row it never identified.
   */
  const primaryIndex = names.findIndex((name) => name.type === "primary");
  const headingIndex = primaryIndex === -1 ? 0 : primaryIndex;

  /*
   * A former name is the case `searchable` guards. Someone who transitioned, or
   * left a marriage, may have a previous name recorded for the family's own
   * records with the flag off. Printing it on a public page would publish
   * precisely what that flag was set to withhold.
   */
  const alternateNames = names
    .filter((name, index) => index !== headingIndex && name.searchable)
    .map(({ searchable: _searchable, ...name }) => name);

  return {
    ok: true,
    detail: {
      memorialId,
      slug: row.slug,
      visibility: row.visibility,
      // `decideAccess` has already refused every status a visitor may not see,
      // so the ones that reach here are the ones worth naming.
      status: row.status as "draft" | "published" | "restricted",
      searchEngineIndexable: row.searchEngineIndexable,
      primaryName: names[headingIndex]?.value ?? "",
      alternateNames,
      birthDate: row.birthDate,
      birthDatePrecision: row.birthDatePrecision,
      deathDate: row.deathDate,
      deathDatePrecision: row.deathDatePrecision,
      publishedAt: row.publishedAt,
      viewerRole: access.role,
    },
  };
}

/**
 * Where a merged memorial now lives.
 *
 * Null when the target is itself gone. A link a family posted in a death
 * notice years ago has to keep working, but not at the cost of following a
 * chain into something that was deleted.
 */
async function mergeTargetSlug(memorialId: string): Promise<string | null> {
  const [source] = await db()
    .select({ mergedInto: memorials.mergedIntoMemorialId })
    .from(memorials)
    .where(eq(memorials.id, memorialId));

  if (!source?.mergedInto) {
    return null;
  }

  const [target] = await db()
    .select({ slug: memorials.slug })
    .from(memorials)
    .where(
      and(
        eq(memorials.id, source.mergedInto),
        eq(memorials.status, "published"),
      ),
    );

  return target?.slug ?? null;
}

/** A year, and whether the family could only estimate it. */
export type LifeYear = { year: string; approximate: boolean };

/**
 * The years shown under a name.
 *
 * Derived here rather than through `Intl.DateTimeFormat`, which has no
 * representation for a partial date at all — a birth known only to the year
 * cannot be expressed as a date, and rendering it as one would invent a day
 * the family never gave us.
 *
 * The `approximate` flag is returned rather than rendered. How an estimate is
 * marked belongs to each language: "c." is Latin, and a Japanese or Arabic
 * page printing it would be showing shorthand nobody reading it uses.
 */
export function lifeSpan(detail: {
  birthDate: string | null;
  birthDatePrecision: DatePrecision;
  deathDate: string | null;
  deathDatePrecision: DatePrecision;
}): { birth: LifeYear | null; death: LifeYear | null } {
  return {
    birth: yearOf(detail.birthDate, detail.birthDatePrecision),
    death: yearOf(detail.deathDate, detail.deathDatePrecision),
  };
}

function yearOf(
  value: string | null,
  precision: DatePrecision,
): LifeYear | null {
  if (!value || precision === "unknown") {
    return null;
  }

  // Presenting a family's best guess as a fact is a small dishonesty that ends
  // up carved into how someone is remembered.
  return { year: value.slice(0, 4), approximate: precision === "approximate" };
}
