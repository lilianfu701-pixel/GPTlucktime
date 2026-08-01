import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { publishMemorial } from "@/modules/memorials/privacy";

const schema = z.object({
  confirmPublicExposure: z.boolean().optional(),
});

/**
 * Publishes a draft memorial.
 *
 * Separate from creation on purpose: a family writes the life story, chooses
 * the photographs and decides what visitors may offer while the page is still
 * theirs alone, and this is the step where they say it is ready to be read.
 */
export async function POST(
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

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const result = await publishMemorial(actor, id, body.value, correlationId);

  if (!result.ok) {
    switch (result.error) {
      case "AUTH_REQUIRED":
        return jsonError("AUTH_REQUIRED", correlationId);
      case "MEMORIAL_NOT_FOUND":
        return jsonError("MEMORIAL_NOT_FOUND", correlationId);
      case "MEMORIAL_FORBIDDEN":
        return jsonError("MEMORIAL_FORBIDDEN", correlationId);
      case "OWNERSHIP_FROZEN":
        return jsonUnprocessable(correlationId, {
          _: [
            "This memorial cannot change while a question about who manages it is being looked at.",
          ],
        });
      case "NOT_PUBLISHABLE":
        // Covers an already published page as well as one a reviewer hid or a
        // merge closed. Deliberately one message: the reasons a memorial is
        // unavailable are not all the owner's business to distinguish here.
        return jsonUnprocessable(correlationId, {
          _: ["This memorial cannot be published from here."],
        });
      case "PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED":
        return jsonUnprocessable(correlationId, {
          confirmPublicExposure: [
            "Please confirm that this memorial may be seen publicly. Once it is public, a search engine may keep a copy for some time.",
          ],
        });
    }
  }

  return jsonSuccess(
    {
      slug: result.value.slug,
      publishedAt: result.value.publishedAt.toISOString(),
    },
    correlationId,
  );
}
