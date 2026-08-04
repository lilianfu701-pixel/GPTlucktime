import { z } from "zod";
import { correlationIdFrom, jsonError, jsonSuccess } from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { publishBiography } from "@/modules/memorials/content-service";
import { refuseContentError } from "@/modules/memorials/content-http";

export const dynamic = "force-dynamic";

/**
 * Publishes the saved draft.
 *
 * The moment a family's words about someone become readable by whoever the
 * memorial's privacy allows, so it is a step they take rather than a
 * consequence of having typed.
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

  const result = await publishBiography(actor, id, correlationId);

  if (!result.ok) {
    return refuseContentError(result.error, correlationId);
  }

  return jsonSuccess(
    { publishedVersion: result.value.publishedVersion },
    correlationId,
  );
}
