import { z } from "zod";
import { correlationIdFrom, jsonError, jsonSuccess } from "@/lib/api";
import { normalizeLocale } from "@/lib/locale";
import { currentActor } from "@/modules/auth/current-user";
import { memorialRoleFor } from "@/modules/memorials/membership";
import { canOnMemorial } from "@/modules/permissions/policy";
import { ritualChoices } from "@/modules/religion/memorial-settings";

export const dynamic = "force-dynamic";

/**
 * What this family may offer, and what they have already chosen.
 *
 * Gated on `configure_rituals` rather than on being able to see the memorial.
 * The list is the full published catalogue, and which observances exist is not
 * private — but a visitor has no use for it, and an endpoint that answers
 * everyone is one more surface to keep correct.
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
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const role = await memorialRoleFor(id, actor.userId);
  if (!role) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  if (!canOnMemorial({ actor, role, action: "configure_rituals" })) {
    return jsonError("MEMORIAL_FORBIDDEN", correlationId);
  }

  const locale = normalizeLocale(
    new URL(request.url).searchParams.get("locale") ?? "en",
  );

  const choices = await ritualChoices(id, locale);

  return jsonSuccess(
    {
      // Anything without reviewed wording in this language is withheld rather
      // than offered in English. A family cannot meaningfully consent to an
      // observance described in a language they are not reading.
      rituals: choices.filter((choice) => choice.name !== null),
      locale,
    },
    correlationId,
  );
}
