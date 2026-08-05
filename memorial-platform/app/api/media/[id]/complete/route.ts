import { correlationIdFrom, jsonError, jsonSuccess } from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { markUploadComplete } from "@/modules/media/service";
import { drainOutboxAfterResponse } from "@/modules/outbox/drain-after";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marks an upload as complete so the processing pipeline picks it up.
 *
 * The client calls this after a successful PUT to the presigned URL. The asset
 * moves from `pending_upload` to `scanning`, and a `media.process` outbox
 * event is published so the worker (or the inline drain) starts verification.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { id } = await context.params;

  if (!UUID_RE.test(id)) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const result = await markUploadComplete(actor, id, correlationId);

  if (!result.ok) {
    switch (result.error) {
      case "ASSET_NOT_FOUND":
      case "MEMORIAL_NOT_FOUND":
        return jsonError("MEMORIAL_NOT_FOUND", correlationId);
      case "MEMORIAL_FORBIDDEN":
        return jsonError("MEMORIAL_FORBIDDEN", correlationId);
      case "NOT_AWAITING_PROCESSING":
        return jsonError("INVALID_INPUT", correlationId);
    }
  }

  drainOutboxAfterResponse(correlationId);

  return jsonSuccess(
    {
      mediaAssetId: result.value.mediaAssetId,
      status: result.value.status,
    },
    correlationId,
    202,
  );
}
