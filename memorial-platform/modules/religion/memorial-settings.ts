import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLogs,
  memorialRitualSettings,
  ritualVersions,
} from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { memorialRoleFor } from "@/modules/memorials/membership";
import { canOnMemorial } from "@/modules/permissions/policy";
import type { Actor } from "@/modules/permissions/types";
import { publishedTranslation } from "./catalog";

export type RitualSettingError =
  | "AUTH_REQUIRED"
  | "MEMORIAL_NOT_FOUND"
  | "MEMORIAL_FORBIDDEN"
  | "RITUAL_VERSION_NOT_FOUND"
  | "RITUAL_VERSION_NOT_PUBLISHED"
  | "FAMILY_CONFIRMATION_REQUIRED";

export type RitualSettingInput = {
  enabled: boolean;
  displayNameOverride?: string | null | undefined;
  allowAnonymous?: boolean | undefined;
  allowMessage?: boolean | undefined;
  moderationMode?: "pre_review" | "post_review" | undefined;
  /** Must be true to switch a ritual on. Never inferred from the request. */
  familyConfirmed?: boolean | undefined;
};

/**
 * Records what a family has decided to offer.
 *
 * Owner only. Doc 06 section 3 keeps this away from administrators and editors:
 * deciding how visitors may mourn is not the same as helping write a biography.
 *
 * Enabling requires an explicit confirmation. There is no path by which
 * selecting a religion, or saving any other setting, turns a ritual on.
 */
export async function setRitualSetting(
  actor: Actor,
  memorialId: string,
  ritualVersionId: string,
  input: RitualSettingInput,
  correlationId: string,
): Promise<Result<{ enabled: boolean; ritualVersionId: string }, RitualSettingError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const role = await memorialRoleFor(memorialId, actor.userId);
  // Someone with no role must not learn the memorial exists.
  if (!role) {
    return err("MEMORIAL_NOT_FOUND");
  }

  if (!canOnMemorial({ actor, role, action: "configure_rituals" })) {
    return err("MEMORIAL_FORBIDDEN");
  }

  const [version] = await db()
    .select({
      id: ritualVersions.id,
      definitionId: ritualVersions.definitionId,
      status: ritualVersions.status,
      allowAnonymous: ritualVersions.allowAnonymous,
      allowMessage: ritualVersions.allowMessage,
      suggestPreReview: ritualVersions.suggestPreReview,
    })
    .from(ritualVersions)
    .where(eq(ritualVersions.id, ritualVersionId));

  if (!version) {
    return err("RITUAL_VERSION_NOT_FOUND");
  }

  // A draft was never reviewed; a retired one was withdrawn for a reason. A
  // family may keep an already-adopted revision, but cannot newly adopt either.
  if (version.status !== "published") {
    const [existing] = await db()
      .select({ id: memorialRitualSettings.id })
      .from(memorialRitualSettings)
      .where(
        and(
          eq(memorialRitualSettings.memorialId, memorialId),
          eq(memorialRitualSettings.ritualVersionId, ritualVersionId),
        ),
      );

    if (!existing) {
      return err("RITUAL_VERSION_NOT_PUBLISHED");
    }
  }

  if (input.enabled && input.familyConfirmed !== true) {
    return err("FAMILY_CONFIRMATION_REQUIRED");
  }

  const now = new Date();

  // The reviewed revision sets the ceiling. A family may be more restrictive
  // than the revision allows, never more permissive: if the reviewed guidance
  // says a practice should not be anonymous, a checkbox does not overrule it.
  const allowAnonymous =
    (input.allowAnonymous ?? false) && version.allowAnonymous;
  const allowMessage = (input.allowMessage ?? version.allowMessage) && version.allowMessage;
  const moderationMode =
    input.moderationMode ?? (version.suggestPreReview ? "pre_review" : "post_review");

  await db()
    .insert(memorialRitualSettings)
    .values({
      memorialId,
      ritualDefinitionId: version.definitionId,
      ritualVersionId,
      enabled: input.enabled,
      displayNameOverride: input.displayNameOverride ?? null,
      allowAnonymous,
      allowMessage,
      moderationMode,
      familyConfirmedAt: input.enabled ? now : null,
      confirmedByUserId: input.enabled ? actor.userId : null,
    })
    .onConflictDoUpdate({
      target: [
        memorialRitualSettings.memorialId,
        memorialRitualSettings.ritualDefinitionId,
      ],
      set: {
        // Switching to another revision of the same action is a deliberate
        // choice by the family, so the pinned version moves with it.
        ritualVersionId,
        enabled: input.enabled,
        displayNameOverride: input.displayNameOverride ?? null,
        allowAnonymous,
        allowMessage,
        moderationMode,
        familyConfirmedAt: input.enabled ? now : null,
        confirmedByUserId: input.enabled ? actor.userId : null,
        updatedAt: now,
      },
    });

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: input.enabled ? "ritual_setting.enabled" : "ritual_setting.disabled",
    resourceType: "memorial",
    resourceId: memorialId,
    newValue: {
      ritualVersionId,
      enabled: input.enabled,
      allowAnonymous,
      allowMessage,
      moderationMode,
    },
    correlationId,
  });

  return ok({ enabled: input.enabled, ritualVersionId });
}

export type EnabledRitual = {
  ritualVersionId: string;
  ritualDefinitionId: string;
  displayNameOverride: string | null;
  allowAnonymous: boolean;
  allowMessage: boolean;
  moderationMode: "pre_review" | "post_review";
};

/**
 * What a visitor may actually do on this memorial.
 *
 * The `enabled` condition is in the query, not applied afterwards, so a later
 * caller cannot omit it and offer a family something they never turned on.
 */
export async function enabledRituals(
  memorialId: string,
): Promise<EnabledRitual[]> {
  return db()
    .select({
      ritualVersionId: memorialRitualSettings.ritualVersionId,
      ritualDefinitionId: memorialRitualSettings.ritualDefinitionId,
      displayNameOverride: memorialRitualSettings.displayNameOverride,
      allowAnonymous: memorialRitualSettings.allowAnonymous,
      allowMessage: memorialRitualSettings.allowMessage,
      moderationMode: memorialRitualSettings.moderationMode,
    })
    .from(memorialRitualSettings)
    .where(
      and(
        eq(memorialRitualSettings.memorialId, memorialId),
        eq(memorialRitualSettings.enabled, true),
      ),
    );
}

export type OfferableRitual = EnabledRitual & {
  /** The family's wording, else the reviewed catalog name, else null. */
  name: string | null;
  description: string | null;
  method: string | null;
  /** False when this language has no reviewed rendering for the ritual. */
  translated: boolean;
};

/**
 * Enabled rituals with the words a visitor should actually see.
 *
 * Shared by the page and the API on purpose. They drifted apart once already:
 * the API resolved the catalog translation and the page did not, so every
 * observance rendered as the generic fallback label unless the family had
 * typed their own name for it.
 *
 * A null `name` is left null rather than filled from English. A Japanese page
 * that silently prints an English ritual name has misrepresented what the
 * family offered; the caller can hide the control instead.
 */
export async function offerableRituals(
  memorialId: string,
  locale: string,
): Promise<OfferableRitual[]> {
  const enabled = await enabledRituals(memorialId);

  return Promise.all(
    enabled.map(async (ritual) => {
      const translation = await publishedTranslation(
        ritual.ritualVersionId,
        locale,
      );

      return {
        ...ritual,
        name: ritual.displayNameOverride ?? translation?.name ?? null,
        description: translation?.description ?? null,
        method: translation?.method ?? null,
        translated: translation !== null,
      };
    }),
  );
}

/** The setting for one ritual version, whether enabled or not. */
export async function ritualSettingFor(
  memorialId: string,
  ritualVersionId: string,
): Promise<EnabledRitual & { enabled: boolean } | null> {
  const [row] = await db()
    .select({
      ritualVersionId: memorialRitualSettings.ritualVersionId,
      ritualDefinitionId: memorialRitualSettings.ritualDefinitionId,
      displayNameOverride: memorialRitualSettings.displayNameOverride,
      allowAnonymous: memorialRitualSettings.allowAnonymous,
      allowMessage: memorialRitualSettings.allowMessage,
      moderationMode: memorialRitualSettings.moderationMode,
      enabled: memorialRitualSettings.enabled,
    })
    .from(memorialRitualSettings)
    .where(
      and(
        eq(memorialRitualSettings.memorialId, memorialId),
        eq(memorialRitualSettings.ritualVersionId, ritualVersionId),
      ),
    );

  return row ?? null;
}
