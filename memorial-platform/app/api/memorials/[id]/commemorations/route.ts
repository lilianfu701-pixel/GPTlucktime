import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
  requestIpHash,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { createCommemoration } from "@/modules/commemorations/service";

const schema = z.object({
  ritualVersionId: z.uuid({ error: "That way of remembering is not available." }),
  message: z.string().max(2000).optional(),
  locale: z.string().min(2).max(10).default("en"),
  anonymous: z.boolean().optional(),
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

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return jsonUnprocessable(correlationId, {
      _: ["A valid Idempotency-Key header is required."],
    });
  }

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  // Anonymous visitors are permitted where the family allowed it, so there is no
  // sign-in gate here; the service decides.
  const actor = await currentActor();

  const result = await createCommemoration(
    actor,
    { memorialId: id, ...body.value },
    idempotencyKey,
    { requestIpHash: requestIpHash(request) },
    correlationId,
  );

  if (!result.ok) {
    switch (result.error) {
      case "MEMORIAL_NOT_FOUND":
        return jsonError("MEMORIAL_NOT_FOUND", correlationId);
      case "RITUAL_NOT_ENABLED":
        return jsonError("RITUAL_NOT_ENABLED", correlationId);
      case "AUTH_REQUIRED":
        return jsonError("AUTH_REQUIRED", correlationId);
      case "BLOCKED":
        return jsonError("MEMORIAL_FORBIDDEN", correlationId);
      case "RATE_LIMITED":
        return jsonError("RATE_LIMITED", correlationId);
      case "IDEMPOTENCY_CONFLICT":
        return jsonError("IDEMPOTENCY_CONFLICT", correlationId);
      case "ANONYMOUS_NOT_ALLOWED":
        return jsonUnprocessable(correlationId, {
          anonymous: ["The family has asked visitors to sign in."],
        });
      case "MESSAGE_NOT_ALLOWED":
        return jsonUnprocessable(correlationId, {
          message: ["The family has not opened messages for this."],
        });
      case "EMPTY_MESSAGE":
        return jsonUnprocessable(correlationId, {
          message: ["Write a few words, or leave the message empty."],
        });
    }
  }

  return jsonSuccess(
    { id: result.value.id, status: result.value.status },
    correlationId,
    // 201 for the first, 200 for a replay, and 202 where the family will read it
    // first — a caller must not display a pending message as published.
    result.value.created
      ? result.value.status === "pending_review"
        ? 202
        : 201
      : 200,
  );
}
