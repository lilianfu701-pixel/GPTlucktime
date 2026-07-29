import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLogs, contentTranslations, contentVersions } from "@/db/schema";
import { err, ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { normalizeLocale } from "@/lib/locale";

export type TranslationError =
  | "AUTH_REQUIRED"
  | "VERSION_NOT_FOUND"
  | "SAME_AS_SOURCE"
  | "MACHINE_TRANSLATION_NEEDS_REVIEW"
  | "EMPTY_BODY";

/**
 * What a reader actually gets.
 *
 * `isTranslated` and `method` are part of the contract, not decoration. Doc 07
 * section 3 requires a machine translation to be visible as one, and a reader
 * deciding whether to trust the wording of a condolence needs to know a machine
 * produced it.
 */
export type RenderedContent = {
  title: string | null;
  body: string;
  /** The language actually rendered, which may not be the one asked for. */
  locale: string;
  requestedLocale: string;
  isTranslated: boolean;
  method: "human" | "machine" | null;
};

/**
 * Stores a translation of one version.
 *
 * Attached to a version, never to the item: a translation must not survive onto
 * text it was not made from. The original is untouched by this call.
 */
export async function saveTranslation(
  actor: { userId: string | null },
  input: {
    contentVersionId: string;
    targetLocale: string;
    title?: string | undefined;
    body: string;
    method: "human" | "machine";
    /** Only a human reviewer may move a translation to `published`. */
    publish?: boolean | undefined;
  },
  correlationId: string,
): Promise<Result<{ translationId: string; status: string }, TranslationError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const body = input.body.trim();
  if (body.length === 0) {
    return err("EMPTY_BODY");
  }

  const [version] = await db()
    .select({
      id: contentVersions.id,
      sourceLocale: contentVersions.sourceLocale,
    })
    .from(contentVersions)
    .where(eq(contentVersions.id, input.contentVersionId));

  if (!version) {
    return err("VERSION_NOT_FOUND");
  }

  const targetLocale = normalizeLocale(input.targetLocale);
  if (normalizeLocale(version.sourceLocale) === targetLocale) {
    return err("SAME_AS_SOURCE");
  }

  // A machine translation may be stored and may be shown while labelled, but it
  // cannot become the published rendering without someone taking responsibility
  // for the wording. Doc 07 section 3 and doc 05 section 7.
  if (input.publish && input.method === "machine") {
    return err("MACHINE_TRANSLATION_NEEDS_REVIEW");
  }

  const status = input.publish ? "published" : "draft";

  const [row] = await db()
    .insert(contentTranslations)
    .values({
      contentVersionId: version.id,
      targetLocale,
      title: input.title ?? null,
      body,
      method: input.method,
      status,
      reviewerUserId: input.publish ? actor.userId : null,
      reviewedAt: input.publish ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [
        contentTranslations.contentVersionId,
        contentTranslations.targetLocale,
      ],
      set: {
        title: input.title ?? null,
        body,
        method: input.method,
        status,
        reviewerUserId: input.publish ? actor.userId : null,
        reviewedAt: input.publish ? new Date() : null,
      },
    })
    .returning({ id: contentTranslations.id });

  if (!row) {
    throw new Error("translation upsert returned no row");
  }

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "content_translation.saved",
    resourceType: "content_version",
    resourceId: version.id,
    newValue: { targetLocale, method: input.method, status },
    correlationId,
  });

  return ok({ translationId: row.id, status });
}

/**
 * Publishes a translation after a person has reviewed it.
 *
 * The reviewer is recorded on the row. A machine draft becomes publishable by
 * passing through here, which is the point: someone is named.
 */
export async function approveTranslation(
  actor: { userId: string | null },
  translationId: string,
  correlationId: string,
): Promise<Result<{ status: "published" }, TranslationError>> {
  if (!actor.userId) {
    return err("AUTH_REQUIRED");
  }

  const [translation] = await db()
    .select({ id: contentTranslations.id })
    .from(contentTranslations)
    .where(eq(contentTranslations.id, translationId));

  if (!translation) {
    return err("VERSION_NOT_FOUND");
  }

  await db()
    .update(contentTranslations)
    .set({
      status: "published",
      reviewerUserId: actor.userId,
      reviewedAt: new Date(),
    })
    .where(eq(contentTranslations.id, translationId));

  await db().insert(auditLogs).values({
    actorUserId: actor.userId,
    action: "content_translation.approved",
    resourceType: "content_translation",
    resourceId: translationId,
    newValue: { status: "published" },
    correlationId,
  });

  return ok({ status: "published" });
}

/**
 * Renders a version in the reader's language.
 *
 * When no published translation exists, the original is returned rather than
 * nothing. A memorial page that goes blank because a translation is missing is
 * worse for a family than one that shows the language they wrote in.
 */
export async function renderContent(input: {
  version: {
    id: string;
    title: string | null;
    body: string;
    sourceLocale: string;
  };
  requestedLocale: string;
}): Promise<RenderedContent> {
  const requested = normalizeLocale(input.requestedLocale);
  const source = normalizeLocale(input.version.sourceLocale);

  const original: RenderedContent = {
    title: input.version.title,
    body: input.version.body,
    locale: input.version.sourceLocale,
    requestedLocale: requested,
    isTranslated: false,
    method: null,
  };

  if (requested === source) {
    return original;
  }

  const [translation] = await db()
    .select({
      title: contentTranslations.title,
      body: contentTranslations.body,
      method: contentTranslations.method,
    })
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.contentVersionId, input.version.id),
        eq(contentTranslations.targetLocale, requested),
        // A draft or in-review translation is not shown to readers.
        eq(contentTranslations.status, "published"),
      ),
    );

  if (!translation) {
    return original;
  }

  return {
    title: translation.title,
    body: translation.body,
    locale: requested,
    requestedLocale: requested,
    isTranslated: true,
    method: translation.method,
  };
}
