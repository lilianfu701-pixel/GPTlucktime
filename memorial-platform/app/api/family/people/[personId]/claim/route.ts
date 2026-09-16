import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { claimNode } from "@/modules/genealogy/people";

/**
 * Claims a living family node as oneself.
 *
 * Used to take over a masked node seeded from a 族谱 once a descendant registers
 * and recognises their own place. Stewardship moves to the claimant (`selfUserId`),
 * which is also what lets their own name show unmasked to them thereafter. The
 * claim is not adjudicated here; a contested one goes through the same dispute
 * path as a contested memorial.
 */
const MESSAGES: Record<string, string> = {
  SELF_ALREADY_PLACED: "You are already in the tree as someone else.",
  ALREADY_IN_TREE: "That place has already been claimed.",
};

export async function POST(
  request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { personId } = await context.params;

  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const result = await claimNode(actor, personId, correlationId);
  if (!result.ok) {
    if (result.error === "AUTH_REQUIRED") {
      return jsonError("AUTH_REQUIRED", correlationId);
    }
    return jsonUnprocessable(correlationId, {
      _: [MESSAGES[result.error] ?? "That place could not be claimed."],
    });
  }

  return jsonSuccess({ personId: result.value.personId }, correlationId);
}
