import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { confirmLink, rejectLink } from "@/modules/genealogy/links";

const schema = z.object({ decision: z.enum(["confirm", "reject"]) });

/**
 * Answers a proposed relationship.
 *
 * A caller with no standing gets the same 404 as for a link that does not
 * exist: a stranger must not learn that two families are being connected.
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
    body.value.decision === "confirm"
      ? await confirmLink(actor, id, correlationId)
      : await rejectLink(actor, id, correlationId);

  if (!result.ok) {
    if (result.error === "AUTH_REQUIRED") {
      return jsonError("AUTH_REQUIRED", correlationId);
    }
    if (result.error === "LINK_NOT_FOUND") {
      return jsonError("MEMORIAL_NOT_FOUND", correlationId);
    }
    if (result.error === "NOT_YOUR_SIDE") {
      return jsonUnprocessable(correlationId, {
        _: ["The other family has to be the one to accept this."],
      });
    }
    if (result.error === "WOULD_CREATE_CYCLE") {
      return jsonUnprocessable(correlationId, {
        _: ["That would make somebody their own ancestor."],
      });
    }
    return jsonUnprocessable(correlationId, {
      _: ["That has already been answered."],
    });
  }

  return jsonSuccess({ linkId: result.value.linkId }, correlationId);
}
