import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { changePrivacy } from "@/modules/memorials/privacy";
import { drainOutboxAfterResponse } from "@/modules/outbox/drain-after";

const schema = z.object({
  visibility: z.enum(["public", "unlisted", "invite_only"], {
    error: "Choose who can see this memorial.",
  }),
  searchEngineIndexable: z.boolean().optional(),
  confirmPublicExposure: z.boolean().optional(),
});

/**
 * Changes who can see a memorial. Owner only.
 *
 * The answer is never cached: a stale copy of a privacy setting is the one
 * thing a shared cache must not hold.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { id } = await context.params;

  if (!z.uuid().safeParse(id).success) {
    // An unparseable id is treated as a memorial that is not there, so this
    // route cannot be used to tell valid ids from invalid ones.
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const result = await changePrivacy(actor, id, body.value, correlationId);

  if (!result.ok) {
    switch (result.error) {
      case "AUTH_REQUIRED":
        return jsonError("AUTH_REQUIRED", correlationId);
      case "MEMORIAL_NOT_FOUND":
        return jsonError("MEMORIAL_NOT_FOUND", correlationId);
      case "MEMORIAL_FORBIDDEN":
        return jsonError("MEMORIAL_FORBIDDEN", correlationId);
      case "OWNERSHIP_FROZEN":
        // An ownership claim is open. Doc 06 section 7 freezes privacy so the
        // page cannot be put beyond reach of the person contesting it.
        return jsonUnprocessable(correlationId, {
          visibility: [
            "This memorial cannot change while a question about who manages it is being looked at.",
          ],
        });
      case "PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED":
        return jsonUnprocessable(correlationId, {
          confirmPublicExposure: [
            "Please confirm that this memorial may be seen publicly. Once it is public, a search engine may keep a copy for some time.",
          ],
        });
    }
  }

  /*
   * The urgent direction is removal. A family switching a memorial to private
   * has the row protecting them already, but the search document is a copy,
   * and leaving it until a scheduler runs means their decision is visible in
   * results after they made it.
   */
  if (result.value.changed) {
    drainOutboxAfterResponse(correlationId);
  }

  return jsonSuccess(
    {
      visibility: result.value.visibility,
      searchEngineIndexable: result.value.searchEngineIndexable,
      changed: result.value.changed,
    },
    correlationId,
  );
}
