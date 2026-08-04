import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  readJson,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { saveBiography } from "@/modules/memorials/content-service";
import { refuseContentError } from "@/modules/memorials/content-http";

export const dynamic = "force-dynamic";

const schema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.string().max(50_000),
  sourceLocale: z.string().min(2).max(10),
});

/**
 * Saves a life story as a new draft version.
 *
 * Saving and publishing are separate on purpose: every revision is kept, and a
 * family writing about a parent should be able to stop halfway and come back
 * without anyone else having seen the unfinished sentence.
 */
export async function PUT(
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

  const result = await saveBiography(actor, id, body.value, correlationId);

  if (!result.ok) {
    return refuseContentError(result.error, correlationId);
  }

  return jsonSuccess(
    { biographyId: result.value.biographyId, version: result.value.version },
    correlationId,
  );
}
