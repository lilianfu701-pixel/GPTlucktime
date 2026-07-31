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
  addLivingRelative,
  placeSelf,
} from "@/modules/genealogy/people";

/**
 * Adds a person to the family graph.
 *
 * Two shapes, deliberately separate. `self` is the one living node that is not
 * somebody's account of another person, and only its own account may create it.
 * `relative` records somebody who has not signed up, which is why it takes a
 * name and at most a year and nothing else.
 */
const schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("self"),
    displayName: z.string().trim().min(1).max(200),
  }),
  z.object({
    kind: z.literal("relative"),
    displayName: z.string().trim().min(1).max(200),
    birthYear: z.number().int().min(1000).max(2200).optional(),
  }),
]);

const MESSAGES: Record<string, string> = {
  NAME_REQUIRED: "A name is required.",
  IMPLAUSIBLE_YEARS: "Check the year: it is outside the range we can record.",
  SELF_ALREADY_PLACED: "You are already in the tree.",
  ALREADY_IN_TREE: "That person is already recorded here.",
};

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

  const result =
    body.value.kind === "self"
      ? await placeSelf(actor, body.value.displayName, correlationId)
      : await addLivingRelative(
          actor,
          {
            displayName: body.value.displayName,
            birthYear: body.value.birthYear,
          },
          correlationId,
        );

  if (!result.ok) {
    if (result.error === "AUTH_REQUIRED") {
      return jsonError("AUTH_REQUIRED", correlationId);
    }
    return jsonUnprocessable(correlationId, {
      _: [MESSAGES[result.error] ?? "That could not be recorded."],
    });
  }

  return jsonSuccess({ personId: result.value.personId }, correlationId, 201);
}
