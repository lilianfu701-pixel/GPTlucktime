import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  deceasedPeople,
  memorialLocations,
  memorialMembers,
  memorialNames,
  memorials,
  outboxEvents,
  relationshipClaims,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import type { Actor, MemorialRole } from "@/modules/permissions/types";
import { buildMemorialSlug } from "./slug";

/** The wording of the responsibility statement the creator accepted. */
export const RELATIONSHIP_STATEMENT_VERSION = "2026-07-29.v1";

export type Relationship = "spouse" | "parent" | "child" | "sibling";

export type DatePrecision = "day" | "month" | "year" | "approximate" | "unknown";

export type PartialDate = {
  /** ISO date. Components finer than the precision are placeholders. */
  value: string | null;
  precision: DatePrecision;
};

export type CreateMemorialInput = {
  relationship: Relationship;
  relationshipStatementAccepted: boolean;
  primaryName: { value: string; locale?: string | undefined; script?: string | undefined };
  aliases?:
    | {
        value: string;
        locale?: string | undefined;
        script?: string | undefined;
        type?: "former" | "native" | "transliteration" | "alias" | undefined;
        searchable?: boolean | undefined;
      }[]
    | undefined;
  birthDate?: PartialDate | undefined;
  deathDate?: PartialDate | undefined;
  locations?:
    | {
        kind: "birth" | "death" | "lived" | "resting_place";
        country?: string | undefined;
        region?: string | undefined;
        city?: string | undefined;
      }[]
    | undefined;
  visibility?: "public" | "unlisted" | "invite_only" | undefined;
  searchEngineIndexable?: boolean | undefined;
};

export type CreateMemorialError =
  | "AUTH_REQUIRED"
  | "RELATIONSHIP_NOT_ELIGIBLE"
  | "STATEMENT_NOT_ACCEPTED"
  | "INVALID_NAME"
  | "INVALID_DATES";

const ELIGIBLE_RELATIONSHIPS: readonly Relationship[] = [
  "spouse",
  "parent",
  "child",
  "sibling",
];

/**
 * Creates a memorial.
 *
 * The deceased record, the memorial, the owner's membership, the relationship
 * claim, the audit entry and the `memorial.created` outbox event are one
 * transaction. A half-created memorial with no owner would be unreachable by
 * the person who made it and unmanageable by anyone else.
 *
 * The caller supplies an idempotency key. A retry after a dropped connection
 * returns the memorial that was already made instead of a second one.
 */
export async function createMemorial(
  actor: Actor,
  input: CreateMemorialInput,
  idempotencyKey: string,
  correlationId: string,
): Promise<
  Result<
    { memorialId: string; slug: string; created: boolean },
    CreateMemorialError
  >
> {
  const userId = actor.userId;
  if (!userId) {
    return err("AUTH_REQUIRED");
  }

  if (!ELIGIBLE_RELATIONSHIPS.includes(input.relationship)) {
    return err("RELATIONSHIP_NOT_ELIGIBLE");
  }

  // Doc 01 section 3.1: the declaration is a step of its own, not a checkbox we
  // can infer from the request having been sent.
  if (!input.relationshipStatementAccepted) {
    return err("STATEMENT_NOT_ACCEPTED");
  }

  const primaryName = input.primaryName.value.trim();
  if (primaryName.length === 0) {
    return err("INVALID_NAME");
  }

  if (!datesAreOrdered(input.birthDate, input.deathDate)) {
    return err("INVALID_DATES");
  }

  const existing = await findByIdempotencyKey(userId, idempotencyKey);
  if (existing) {
    // A replay, not a second bereavement. The caller answers 200 rather than
    // 201 so a client can tell the two apart. See doc 04 section 2.
    return ok({ ...existing, created: false });
  }

  const slug = buildMemorialSlug(primaryName);

  const created = await db()
    .transaction(async (tx) => {
    const [person] = await tx
      .insert(deceasedPeople)
      .values({
        birthDate: input.birthDate?.value ?? null,
        birthDatePrecision: input.birthDate?.precision ?? "unknown",
        deathDate: input.deathDate?.value ?? null,
        deathDatePrecision: input.deathDate?.precision ?? "unknown",
      })
      .returning({ id: deceasedPeople.id });

    if (!person) {
      throw new Error("deceased person insert returned no row");
    }

    const [memorial] = await tx
      .insert(memorials)
      .values({
        deceasedPersonId: person.id,
        slug,
        status: "draft",
        visibility: input.visibility ?? "public",
        searchEngineIndexable: input.searchEngineIndexable ?? true,
        ownerUserId: userId,
        creationIdempotencyKey: idempotencyKey,
      })
      .returning({ id: memorials.id, slug: memorials.slug });

    if (!memorial) {
      throw new Error("memorial insert returned no row");
    }

    await tx.insert(memorialNames).values({
      memorialId: memorial.id,
      value: primaryName,
      locale: input.primaryName.locale ?? null,
      script: input.primaryName.script ?? null,
      type: "primary",
      searchable: true,
    });

    for (const alias of input.aliases ?? []) {
      const value = alias.value.trim();
      if (value.length === 0) continue;
      await tx.insert(memorialNames).values({
        memorialId: memorial.id,
        value,
        locale: alias.locale ?? null,
        script: alias.script ?? null,
        type: alias.type ?? "alias",
        // A family may record a former name without making it findable.
        searchable: alias.searchable ?? true,
      });
    }

    for (const location of input.locations ?? []) {
      await tx.insert(memorialLocations).values({
        memorialId: memorial.id,
        kind: location.kind,
        country: location.country ?? null,
        region: location.region ?? null,
        city: location.city ?? null,
      });
    }

    await tx.insert(memorialMembers).values({
      memorialId: memorial.id,
      userId,
      role: "owner" satisfies MemorialRole,
      acceptedAt: new Date(),
    });

    await tx.insert(relationshipClaims).values({
      memorialId: memorial.id,
      claimantUserId: userId,
      relationship: input.relationship,
      statementVersion: RELATIONSHIP_STATEMENT_VERSION,
      status: "declared",
    });

    await tx.insert(auditLogs).values({
      actorUserId: userId,
      action: "memorial.created",
      resourceType: "memorial",
      resourceId: memorial.id,
      newValue: {
        slug: memorial.slug,
        visibility: input.visibility ?? "public",
        relationship: input.relationship,
      },
      correlationId,
    });

    await tx.insert(outboxEvents).values({
      topic: "memorial.created",
      aggregateId: memorial.id,
      payload: {
        memorialId: memorial.id,
        idempotencyKey,
        ownerUserId: userId,
        correlationId,
      },
    });

      return { memorialId: memorial.id, slug: memorial.slug, created: true };
    })
    .catch(async (error: unknown) => {
      // A retry that arrived while the first request was still committing loses
      // the race on the unique index. That is the mechanism working: return the
      // memorial the winner created rather than reporting a conflict.
      if (isUniqueViolation(error)) {
        const raced = await findByIdempotencyKey(userId, idempotencyKey);
        if (raced) {
          return { ...raced, created: false };
        }
      }
      throw error;
    });

  return ok(created);
}

/**
 * Looks up a previous creation with the same key from the same person.
 *
 * The uniqueness is enforced by an index on (owner, key); this read is the fast
 * path that turns a retry into the original answer instead of a conflict.
 */
async function findByIdempotencyKey(
  userId: string,
  idempotencyKey: string,
): Promise<{ memorialId: string; slug: string } | null> {
  const [row] = await db()
    .select({ memorialId: memorials.id, slug: memorials.slug })
    .from(memorials)
    .where(
      and(
        eq(memorials.ownerUserId, userId),
        eq(memorials.creationIdempotencyKey, idempotencyKey),
      ),
    );

  return row ?? null;
}

/** PostgreSQL reports a violated unique index as SQLSTATE 23505. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

/** Rejects a death recorded before a birth, when both are precise enough to compare. */
function datesAreOrdered(
  birth: PartialDate | undefined,
  death: PartialDate | undefined,
): boolean {
  if (!birth?.value || !death?.value) {
    return true;
  }

  // Approximate or unknown dates carry placeholder components, so comparing
  // them would reject legitimate records.
  if (
    birth.precision === "approximate" ||
    birth.precision === "unknown" ||
    death.precision === "approximate" ||
    death.precision === "unknown"
  ) {
    return true;
  }

  return new Date(birth.value).getTime() <= new Date(death.value).getTime();
}

/** The caller's role on a memorial, or null when they have none. */
export async function memorialRoleFor(
  memorialId: string,
  userId: string | null,
): Promise<MemorialRole | null> {
  if (!userId) {
    return null;
  }

  const [row] = await db()
    .select({ role: memorialMembers.role, revokedAt: memorialMembers.revokedAt })
    .from(memorialMembers)
    .where(
      and(
        eq(memorialMembers.memorialId, memorialId),
        eq(memorialMembers.userId, userId),
      ),
    );

  if (!row || row.revokedAt) {
    return null;
  }

  return row.role;
}
