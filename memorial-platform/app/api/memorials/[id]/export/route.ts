import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { requestDeletion } from "@/modules/memorials/deletion";
import { requestExport } from "@/modules/memorials/export";

/**
 * Asks for a copy of a memorial.
 *
 * Answers 202: the archive is built by a worker, because gathering media for a
 * memorial with hundreds of photographs does not belong inside a request.
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

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return jsonUnprocessable(correlationId, {
      _: ["A valid Idempotency-Key header is required."],
    });
  }

  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const result = await requestExport(actor, id, idempotencyKey, correlationId);

  if (!result.ok) {
    switch (result.error) {
      case "AUTH_REQUIRED":
        return jsonError("AUTH_REQUIRED", correlationId);
      case "MEMORIAL_NOT_FOUND":
        return jsonError("MEMORIAL_NOT_FOUND", correlationId);
      case "MEMORIAL_FORBIDDEN":
        return jsonError("MEMORIAL_FORBIDDEN", correlationId);
      case "EXPORT_IN_PROGRESS":
        return jsonError("EXPORT_IN_PROGRESS", correlationId);
    }
  }

  return jsonSuccess(
    { exportJobId: result.value.exportJobId, status: "requested" },
    correlationId,
    // 202 whether it started the job or matched a retry: in both cases the
    // archive is being prepared and is not ready yet.
    202,
  );
}

const deleteSchema = z.object({
  confirmed: z.boolean(),
});

/**
 * Starts deleting a memorial. Owner only, and only with an explicit
 * confirmation.
 *
 * Answers 202: the page stops being reachable now, and the data is destroyed
 * after the recovery period.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { id } = await context.params;

  if (!z.uuid().safeParse(id).success) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8) {
    return jsonUnprocessable(correlationId, {
      _: ["A valid Idempotency-Key header is required."],
    });
  }

  const body = await readJson(request, deleteSchema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const result = await requestDeletion(actor, id, body.value, correlationId);

  if (!result.ok) {
    switch (result.error) {
      case "AUTH_REQUIRED":
        return jsonError("AUTH_REQUIRED", correlationId);
      case "MEMORIAL_NOT_FOUND":
      case "ALREADY_REQUESTED":
        return jsonError("MEMORIAL_NOT_FOUND", correlationId);
      case "MEMORIAL_FORBIDDEN":
        return jsonError("MEMORIAL_FORBIDDEN", correlationId);
      case "OWNERSHIP_FROZEN":
        return jsonUnprocessable(correlationId, {
          _: [
            "This memorial cannot be deleted while a question about who manages it is being looked at.",
          ],
        });
      case "CONFIRMATION_REQUIRED":
        return jsonUnprocessable(correlationId, {
          confirmed: [
            "Please confirm you want to delete this memorial. It can be restored within the recovery period.",
          ],
        });
    }
  }

  return jsonSuccess(
    { purgeAfter: result.value.purgeAfter.toISOString() },
    correlationId,
    202,
  );
}
