import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  familyMatchSuggestions,
  familyPeople,
  memorialNames,
  memorials,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import type { Actor } from "@/modules/permissions/types";
import { maySpeakFor } from "./steward";

export type MatchError =
  | "AUTH_REQUIRED"
  | "SUGGESTION_NOT_FOUND"
  | "ALREADY_DECIDED"
  | "NOT_YOUR_SIDE";

/**
 * What two records agreed on.
 *
 * Kept apart rather than folded into one number, so somebody can see that two
 * records share a common surname and nothing else. Doc 03 section 7 asks for
 * the basis to be recorded, not just the total.
 */
export type MatchSignals = {
  name: boolean;
  birthYear: boolean;
  deathYear: boolean;
};

/** Out of 100. A working note; never shown as a probability about a person. */
export const MATCH_THRESHOLD = 60;

const WEIGHTS = { name: 40, birthYear: 30, deathYear: 30 };

export function scoreOf(signals: MatchSignals): number {
  return (
    (signals.name ? WEIGHTS.name : 0) +
    (signals.birthYear ? WEIGHTS.birthYear : 0) +
    (signals.deathYear ? WEIGHTS.deathYear : 0)
  );
}

/**
 * Whether a pair is worth putting in front of anybody.
 *
 * A shared name alone is never enough, whatever it scores. Half of a large
 * country shares a surname, and a suggestion that two people with the same name
 * might be the same person is not a discovery — it is noise that trains people
 * to accept without looking, which is how a stranger ends up joined to a family
 * they have nothing to do with.
 */
export function isWorthSuggesting(signals: MatchSignals): boolean {
  const corroborated = signals.birthYear || signals.deathYear;
  return signals.name && corroborated && scoreOf(signals) >= MATCH_THRESHOLD;
}

type Candidate = {
  personId: string;
  createdAt: Date;
  name: string;
  birthYear: number | null;
  deathYear: number | null;
};

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function compare(a: Candidate, b: Candidate): MatchSignals {
  return {
    name: normalize(a.name) === normalize(b.name) && a.name.length > 0,
    birthYear:
      a.birthYear !== null && b.birthYear !== null && a.birthYear === b.birthYear,
    deathYear:
      a.deathYear !== null && b.deathYear !== null && a.deathYear === b.deathYear,
  };
}

/**
 * Everything the matcher is allowed to look at.
 *
 * For a node backed by a memorial the name comes from `memorial_names`, and
 * only from rows the family left searchable. A family who recorded a former
 * name but asked for it not to be searched has answered this question already,
 * and the matcher does not get a second opinion.
 */
async function candidates(): Promise<Candidate[]> {
  const living = await db()
    .select({
      personId: familyPeople.id,
      createdAt: familyPeople.createdAt,
      name: familyPeople.displayName,
      birthYear: familyPeople.birthYear,
      deathYear: familyPeople.deathYear,
    })
    .from(familyPeople)
    .where(
      and(
        isNull(familyPeople.deceasedPersonId),
        isNull(familyPeople.mergedIntoPersonId),
      ),
    );

  // Years come from the person's own record, and only where the family said
  // which day it was. A date recorded as "some time in the eighties" must not
  // be compared as though it were a year they gave us.
  const withMemorials = await db()
    .select({
      personId: familyPeople.id,
      createdAt: familyPeople.createdAt,
      name: memorialNames.value,
      birthYear: sql<number | null>`case
        when ${deceasedPeople.birthDatePrecision} in ('day', 'month', 'year')
        then extract(year from ${deceasedPeople.birthDate})::int
      end`,
      deathYear: sql<number | null>`case
        when ${deceasedPeople.deathDatePrecision} in ('day', 'month', 'year')
        then extract(year from ${deceasedPeople.deathDate})::int
      end`,
    })
    .from(familyPeople)
    .innerJoin(
      deceasedPeople,
      eq(deceasedPeople.id, familyPeople.deceasedPersonId),
    )
    .innerJoin(
      memorials,
      eq(memorials.deceasedPersonId, familyPeople.deceasedPersonId),
    )
    // Only names the family left searchable. They have answered this question
    // once already, and the matcher does not get a second opinion.
    .innerJoin(
      memorialNames,
      and(
        eq(memorialNames.memorialId, memorials.id),
        eq(memorialNames.searchable, true),
      ),
    )
    .where(isNull(familyPeople.mergedIntoPersonId));

  const rows: Candidate[] = [];
  for (const row of living) {
    if (!row.name) continue;
    rows.push({
      personId: row.personId,
      createdAt: row.createdAt,
      name: row.name,
      birthYear: row.birthYear,
      deathYear: row.deathYear,
    });
  }
  for (const row of withMemorials) {
    rows.push({
      personId: row.personId,
      createdAt: row.createdAt,
      name: row.name,
      birthYear: row.birthYear,
      deathYear: row.deathYear,
    });
  }
  return rows;
}

export type SuggestionRun = { considered: number; created: number };

/**
 * Looks for nodes that are probably the same person.
 *
 * This is how two family trees find each other: not by guessing at
 * relationships, but by noticing that a grandmother in one tree and a mother in
 * another look like the same woman.
 *
 * Runs as a job. Nothing here notifies anybody directly — a suggestion is a row
 * that its side may look at, not a message pushed at a grieving family.
 */
export async function findMatches(): Promise<SuggestionRun> {
  const rows = await candidates();
  let created = 0;

  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.personId === b.personId) continue;

      const signals = compare(a, b);
      if (!isWorthSuggesting(signals)) continue;

      // Ordering by age is what closes the probing hole; see the schema.
      const [older, newer] =
        a.createdAt.getTime() <= b.createdAt.getTime() ? [a, b] : [b, a];

      const inserted = await db()
        .insert(familyMatchSuggestions)
        .values({
          olderPersonId: older.personId,
          newerPersonId: newer.personId,
          score: scoreOf(signals),
          signals: JSON.stringify(signals),
        })
        .onConflictDoNothing()
        .returning({ id: familyMatchSuggestions.id });

      created += inserted.length;
    }
  }

  return { considered: rows.length, created };
}

export type VisibleSuggestion = {
  suggestionId: string;
  /** The node of theirs this is about. Never the other side's. */
  yourPersonId: string;
  score: number;
  signals: MatchSignals;
  /** True once both sides have agreed and the other side may be named. */
  matched: boolean;
};

/**
 * The suggestions a person may see.
 *
 * The older side sees theirs as soon as it exists. The newer side sees nothing
 * until the older side has accepted — otherwise creating a node and watching
 * for a suggestion would be a way to test whether a person appears in somebody
 * else's private tree, which is exactly what the platform refuses to confirm
 * anywhere else.
 *
 * Either way the payload names only the reader's own node.
 */
export async function suggestionsFor(
  actor: Actor,
): Promise<VisibleSuggestion[]> {
  if (!actor.userId) return [];

  const rows = await db()
    .select()
    .from(familyMatchSuggestions)
    .where(ne(familyMatchSuggestions.status, "dismissed"));

  const visible: VisibleSuggestion[] = [];

  for (const row of rows) {
    const matched = row.status === "matched";

    if (await maySpeakFor(actor, row.olderPersonId)) {
      visible.push({
        suggestionId: row.id,
        yourPersonId: row.olderPersonId,
        score: row.score,
        signals: JSON.parse(row.signals) as MatchSignals,
        matched,
      });
      continue;
    }

    // The newer side is told nothing until the older side has said yes.
    if (
      row.olderDecision === "accepted" &&
      (await maySpeakFor(actor, row.newerPersonId))
    ) {
      visible.push({
        suggestionId: row.id,
        yourPersonId: row.newerPersonId,
        score: row.score,
        signals: JSON.parse(row.signals) as MatchSignals,
        matched,
      });
    }
  }

  return visible;
}

/**
 * Accepts a suggestion on one side.
 *
 * Two yeses are needed and they come from different families. The second one
 * turns the suggestion into a match; until then nothing about the other side is
 * disclosed, and the first family cannot tell whether anyone is even reading.
 */
export async function acceptSuggestion(
  actor: Actor,
  suggestionId: string,
  correlationId: string,
): Promise<Result<{ matched: boolean }, MatchError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [row] = await db()
    .select()
    .from(familyMatchSuggestions)
    .where(eq(familyMatchSuggestions.id, suggestionId));

  if (!row || row.status === "dismissed") {
    return err("SUGGESTION_NOT_FOUND");
  }

  const isOlder = await maySpeakFor(actor, row.olderPersonId);
  const isNewer = !isOlder && (await maySpeakFor(actor, row.newerPersonId));

  if (!isOlder && !isNewer) {
    // A stranger must not learn that a suggestion exists.
    return err("SUGGESTION_NOT_FOUND");
  }

  // The newer side cannot act on something it is not supposed to know about.
  if (isNewer && row.olderDecision !== "accepted") {
    return err("SUGGESTION_NOT_FOUND");
  }

  const already = isOlder ? row.olderDecision : row.newerDecision;
  if (already !== "pending") {
    return err("ALREADY_DECIDED");
  }

  const bothAccepted = isNewer || row.newerDecision === "accepted";

  await db()
    .update(familyMatchSuggestions)
    .set({
      ...(isOlder ? { olderDecision: "accepted" as const } : {}),
      ...(isNewer ? { newerDecision: "accepted" as const } : {}),
      ...(bothAccepted
        ? { status: "matched" as const, resolvedAt: new Date() }
        : {}),
    })
    .where(eq(familyMatchSuggestions.id, suggestionId));

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: bothAccepted ? "family.match_confirmed" : "family.match_accepted",
    resourceType: "family_match",
    resourceId: suggestionId,
    correlationId,
  });

  return ok({ matched: bothAccepted });
}

/**
 * Declines a suggestion.
 *
 * The other side is never told which record was refused, or by whom. They are
 * not told anything at all: a decline simply means no match was confirmed, and
 * turning that into a notification would hand out the fact that somebody
 * matching their relative exists and wants nothing to do with them.
 */
export async function declineSuggestion(
  actor: Actor,
  suggestionId: string,
  correlationId: string,
): Promise<Result<{ dismissed: true }, MatchError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [row] = await db()
    .select()
    .from(familyMatchSuggestions)
    .where(eq(familyMatchSuggestions.id, suggestionId));

  if (!row || row.status === "dismissed") {
    return err("SUGGESTION_NOT_FOUND");
  }

  const isOlder = await maySpeakFor(actor, row.olderPersonId);
  const isNewer = !isOlder && (await maySpeakFor(actor, row.newerPersonId));

  if (!isOlder && !isNewer) {
    return err("SUGGESTION_NOT_FOUND");
  }

  if (isNewer && row.olderDecision !== "accepted") {
    return err("SUGGESTION_NOT_FOUND");
  }

  await db()
    .update(familyMatchSuggestions)
    .set({
      ...(isOlder ? { olderDecision: "declined" as const } : {}),
      ...(isNewer ? { newerDecision: "declined" as const } : {}),
      status: "dismissed",
      resolvedAt: new Date(),
    })
    .where(eq(familyMatchSuggestions.id, suggestionId));

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "family.match_declined",
    resourceType: "family_match",
    resourceId: suggestionId,
    correlationId,
  });

  return ok({ dismissed: true });
}
