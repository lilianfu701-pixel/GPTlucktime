import { correlationIdFrom, jsonError, jsonSuccess } from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { suggestionsFor } from "@/modules/genealogy/matching";

/**
 * Possible matches for this person's own records.
 *
 * Each entry names only the reader's own node. The other side is not in the
 * payload until both families have accepted.
 */
export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  return jsonSuccess(
    { suggestions: await suggestionsFor(actor) },
    correlationId,
  );
}
