import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import {
  acceptSuggestion,
  declineSuggestion,
} from "@/modules/genealogy/matching";

const schema = z.object({ decision: z.enum(["accept", "decline"]) });

/**
 * Answers a possible match.
 *
 * Every refusal here is a 404, including the case where the caller is the newer
 * side of a suggestion the older side has not accepted yet. Anything else would
 * let somebody create a node for a guessed name and learn from the error
 * message whether that person appears in a private tree.
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

  const result =
    body.value.decision === "accept"
      ? await acceptSuggestion(actor, id, correlationId)
      : await declineSuggestion(actor, id, correlationId);

  if (!result.ok) {
    if (result.error === "AUTH_REQUIRED") {
      return jsonError("AUTH_REQUIRED", correlationId);
    }
    if (result.error === "SUGGESTION_NOT_FOUND") {
      return jsonError("MEMORIAL_NOT_FOUND", correlationId);
    }
    return jsonUnprocessable(correlationId, {
      _: ["That has already been answered."],
    });
  }

  return jsonSuccess(result.value, correlationId);
}
