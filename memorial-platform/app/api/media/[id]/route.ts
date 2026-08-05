import { correlationIdFrom, jsonError, jsonSuccess } from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { familyMediaView, softDeleteMedia } from "@/modules/media/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapError(
  error: string,
  correlationId: string,
): Response {
  switch (error) {
    case "ASSET_NOT_FOUND":
    case "MEMORIAL_NOT_FOUND":
      return jsonError("MEMORIAL_NOT_FOUND", correlationId);
    case "MEMORIAL_FORBIDDEN":
      return jsonError("MEMORIAL_FORBIDDEN", correlationId);
    default:
      return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }
}

/**
 * Returns the current status and URL for an asset.
 *
 * The client polls this after completing an upload to learn when processing
 * finishes. Once the status is `ready`, the response includes a URL.
 */
export async function GET(
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

  const result = await familyMediaView(actor, id);
  if (!result.ok) {
    return mapError(result.error, correlationId);
  }

  return jsonSuccess(
    {
      status: result.value.status,
      altText: result.value.altText,
      url: result.value.url,
    },
    correlationId,
  );
}

/**
 * Soft-deletes a media asset.
 *
 * The storage objects are removed and the row is marked deleted. The audit
 * trail stays for accountability.
 */
export async function DELETE(
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

  const result = await softDeleteMedia(actor, id, correlationId);
  if (!result.ok) {
    return mapError(result.error, correlationId);
  }

  return jsonSuccess({ deleted: true }, correlationId);
}
