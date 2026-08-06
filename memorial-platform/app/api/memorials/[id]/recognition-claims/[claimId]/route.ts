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
  decideRecognitionClaim,
  withdrawRecognitionClaim,
} from "@/modules/memorials/recognition";

export const dynamic = "force-dynamic";

const schema = z.object({
  decision: z.enum(["confirmed", "rejected", "withdrawn"]),
  decisionNote: z.string().trim().max(1000).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; claimId: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { claimId } = await context.params;

  if (!z.uuid().safeParse(claimId).success) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const actor = await currentActor();
  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const { decision, decisionNote } = body.value;

  const result =
    decision === "withdrawn"
      ? await withdrawRecognitionClaim(actor, claimId, correlationId)
      : await decideRecognitionClaim(
          actor,
          claimId,
          decision,
          decisionNote,
          correlationId,
        );

  if (!result.ok) {
    if (result.error === "AUTH_REQUIRED") {
      return jsonError("AUTH_REQUIRED", correlationId);
    }
    if (result.error === "CLAIM_NOT_FOUND") {
      return jsonError("MEMORIAL_NOT_FOUND", correlationId);
    }
    if (result.error === "ALREADY_DECIDED") {
      return jsonUnprocessable(correlationId, {
        _: ["This claim has already been decided."],
      });
    }
    return jsonError("MEMORIAL_FORBIDDEN", correlationId);
  }

  return jsonSuccess({ status: result.value.status }, correlationId);
}
