import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { signUpload } from "@/modules/media/service";

const schema = z.object({
  memorialId: z.uuid({ error: "This memorial is not available." }),
  fileName: z.string().min(1).max(400),
  contentType: z.string().min(3).max(100),
  size: z.number().int().positive(),
});

/**
 * Authorizes an upload and hands back a short-lived URL.
 *
 * Receiving a URL is not permission to publish. The bytes land in a quarantine
 * prefix, are checked against what was declared, and only then become reachable.
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

  const result = await signUpload(actor, body.value, correlationId);

  if (!result.ok) {
    switch (result.error) {
      case "AUTH_REQUIRED":
        return jsonError("AUTH_REQUIRED", correlationId);
      case "MEMORIAL_NOT_FOUND":
        return jsonError("MEMORIAL_NOT_FOUND", correlationId);
      case "MEMORIAL_FORBIDDEN":
        return jsonError("MEMORIAL_FORBIDDEN", correlationId);
      case "UNSUPPORTED_TYPE":
        return jsonUnprocessable(correlationId, {
          contentType: [
            "That kind of file cannot be added. Photographs, video and audio recordings are accepted.",
          ],
        });
      case "FILE_TOO_LARGE":
        return jsonUnprocessable(correlationId, {
          size: ["That file is larger than the limit for this kind of file."],
        });
      case "EMPTY_FILE":
        return jsonUnprocessable(correlationId, {
          size: ["That file appears to be empty."],
        });
    }
  }

  return jsonSuccess(
    {
      mediaAssetId: result.value.mediaAssetId,
      url: result.value.url,
      headers: result.value.headers,
      expiresInSeconds: result.value.expiresInSeconds,
      // Stated plainly so a client does not treat a completed upload as a
      // published photograph.
      status: "pending_upload",
    },
    correlationId,
    201,
  );
}
