import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { pendingForActor, proposeLink } from "@/modules/genealogy/links";

const schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("parent"),
    parentId: z.uuid(),
    childId: z.uuid(),
    nature: z
      .enum(["unspecified", "birth", "adoptive", "step", "foster"])
      .optional(),
  }),
  z.object({
    kind: z.literal("partner"),
    personId: z.uuid(),
    partnerId: z.uuid(),
  }),
]);

const MESSAGES: Record<string, string> = {
  SAME_PERSON: "Those are the same person.",
  WOULD_CREATE_CYCLE:
    "That would make somebody their own ancestor. Check the direction.",
  ALREADY_LINKED: "Those two are already connected.",
};

/** Relationships waiting on this person's answer. */
export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  return jsonSuccess({ pending: await pendingForActor(actor) }, correlationId);
}

/**
 * Proposes a relationship.
 *
 * Answers 201 whether the link was confirmed outright — both sides already
 * this person's — or is waiting on another family. The body says which.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);

  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const result = await proposeLink(actor, body.value, correlationId);

  if (!result.ok) {
    if (result.error === "AUTH_REQUIRED") {
      return jsonError("AUTH_REQUIRED", correlationId);
    }
    // NOT_YOUR_SIDE and PERSON_NOT_FOUND answer alike: somebody with no
    // standing must not learn which of the two ids exists.
    if (result.error === "NOT_YOUR_SIDE" || result.error === "PERSON_NOT_FOUND") {
      return jsonError("MEMORIAL_NOT_FOUND", correlationId);
    }
    return jsonUnprocessable(correlationId, {
      _: [MESSAGES[result.error] ?? "That relationship could not be recorded."],
    });
  }

  return jsonSuccess(result.value, correlationId, 201);
}
