import { z } from "zod";
import { correlationIdFrom, jsonError, jsonSuccess } from "@/lib/api";
import { normalizeLocale } from "@/lib/locale";
import { currentActor } from "@/modules/auth/current-user";
import { resolveAccessById } from "@/modules/memorials/access";
import { offerableRituals } from "@/modules/religion/memorial-settings";

export const dynamic = "force-dynamic";

/**
 * What a visitor may offer on this memorial.
 *
 * Exists because `POST /commemorations` requires a `ritualVersionId` and there
 * was previously no way for a client to learn one. A caller that cannot
 * discover the identifier cannot offer a flower, so the whole commemoration
 * surface was unreachable.
 *
 * Access is resolved before anything is read. The set of rituals a family
 * chose is itself private: which observances a household keeps can disclose
 * their religion, and an unlisted memorial must not answer that to a stranger.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { id } = await context.params;

  if (!z.uuid().safeParse(id).success) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const actor = await currentActor();
  const access = await resolveAccessById(id, actor);

  if (!access.allowed) {
    // `decideAccess` already collapses "does not exist" and "you may not know
    // it exists" into NOT_FOUND. Only a viewer who has been told the memorial
    // exists — a lapsed invitation — gets the more specific answer.
    return jsonError(
      access.reason === "INVITATION_REQUIRED"
        ? "INVITATION_REQUIRED"
        : "MEMORIAL_NOT_FOUND",
      correlationId,
    );
  }

  const locale = normalizeLocale(
    new URL(request.url).searchParams.get("locale") ?? "en",
  );

  const rituals = await offerableRituals(id, locale);

  return jsonSuccess(
    {
      rituals: rituals.map((ritual) => ({
        ritualVersionId: ritual.ritualVersionId,
        ritualDefinitionId: ritual.ritualDefinitionId,
        name: ritual.name,
        description: ritual.description,
        method: ritual.method,
        // Null name means this language has no reviewed rendering yet. Said
        // plainly so a client can hide the control rather than print a key or
        // fall back to English inside a page set in another language.
        translated: ritual.translated,
        allowAnonymous: ritual.allowAnonymous,
        allowMessage: ritual.allowMessage,
        // Lets a client warn before submission that a message will be read by
        // the family first, instead of surprising the visitor with a 202.
        moderationMode: ritual.moderationMode,
      })),
      locale,
    },
    correlationId,
  );
}
