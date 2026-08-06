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
  createRecognitionClaim,
  listPendingClaims,
} from "@/modules/memorials/recognition";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { id } = await context.params;

  if (!z.uuid().safeParse(id).success) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const actor = await currentActor();
  const result = await listPendingClaims(actor, id);

  if (!result.ok) {
    if (result.error === "AUTH_REQUIRED") {
      return jsonError("AUTH_REQUIRED", correlationId);
    }
    return jsonError("MEMORIAL_FORBIDDEN", correlationId);
  }

  return jsonSuccess({ claims: result.value.claims }, correlationId);
}

const postSchema = z.object({
  claimedName: z.string().trim().min(1).max(200),
  claimedRelationship: z.string().trim().min(1).max(100),
});

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
  const body = await readJson(request, postSchema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const result = await createRecognitionClaim(
    actor,
    {
      memorialId: id,
      claimedName: body.value.claimedName,
      claimedRelationship: body.value.claimedRelationship,
    },
    correlationId,
  );

  if (!result.ok) {
    if (result.error === "AUTH_REQUIRED") {
      return jsonError("AUTH_REQUIRED", correlationId);
    }
    if (result.error === "MEMORIAL_NOT_FOUND") {
      return jsonError("MEMORIAL_NOT_FOUND", correlationId);
    }
    if (result.error === "CANNOT_CLAIM_OWN_MEMORIAL") {
      return jsonUnprocessable(correlationId, {
        _: ["You cannot claim a relative on your own memorial."],
      });
    }
    if (result.error === "ALREADY_CLAIMED") {
      return jsonUnprocessable(correlationId, {
        _: ["You already have a pending claim on this memorial."],
      });
    }
    return jsonError("MEMORIAL_FORBIDDEN", correlationId);
  }

  return jsonSuccess({ claimId: result.value.claimId }, correlationId, 201);
}
