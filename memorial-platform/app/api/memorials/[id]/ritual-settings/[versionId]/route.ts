import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { setRitualSetting } from "@/modules/religion/memorial-settings";

export const dynamic = "force-dynamic";

const schema = z.object({
  enabled: z.boolean(),
  displayNameOverride: z.string().trim().max(120).nullable().optional(),
  allowAnonymous: z.boolean().optional(),
  allowMessage: z.boolean().optional(),
  moderationMode: z.enum(["pre_review", "post_review"]).optional(),
  /** Required to switch one on. The service refuses without it. */
  familyConfirmed: z.boolean().optional(),
});

/**
 * Turns one observance on or off for this memorial.
 *
 * Every rule that matters lives in `setRitualSetting`: owner only, a published
 * revision only, and an explicit confirmation before anything is offered to
 * visitors. This handler adds no judgement of its own.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { id, versionId } = await context.params;

  if (
    !z.uuid().safeParse(id).success ||
    !z.uuid().safeParse(versionId).success
  ) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const actor = await currentActor();

  const result = await setRitualSetting(
    actor,
    id,
    versionId,
    body.value,
    correlationId,
  );

  if (!result.ok) {
    switch (result.error) {
      case "AUTH_REQUIRED":
        return jsonError("AUTH_REQUIRED", correlationId);
      case "MEMORIAL_NOT_FOUND":
        return jsonError("MEMORIAL_NOT_FOUND", correlationId);
      case "MEMORIAL_FORBIDDEN":
        return jsonError("MEMORIAL_FORBIDDEN", correlationId);
      case "RITUAL_VERSION_NOT_FOUND":
      case "RITUAL_VERSION_NOT_PUBLISHED":
        // One answer for both. Which revisions exist but are unpublished is
        // catalogue detail a family has no reason to be told about.
        return jsonError("RITUAL_NOT_ENABLED", correlationId);
      case "FAMILY_CONFIRMATION_REQUIRED":
        return jsonUnprocessable(correlationId, {
          familyConfirmed: [
            "Please confirm this suits your family before offering it.",
          ],
        });
    }
  }

  return jsonSuccess(
    { ritualVersionId: result.value.ritualVersionId, enabled: result.value.enabled },
    correlationId,
  );
}
