import { jsonError, jsonUnprocessable } from "@/lib/api";
import type { ContentError } from "./content-service";

/**
 * Maps a content refusal onto a response.
 *
 * Shared by the save and publish routes so the two cannot drift into
 * describing the same refusal differently. `CONTENT_NOT_FOUND` deliberately
 * answers the same as a missing memorial: whether a draft exists is not
 * something to disclose to someone who may not edit the page.
 */
export function refuseContentError(
  error: ContentError,
  correlationId: string,
): Response {
  switch (error) {
    case "AUTH_REQUIRED":
      return jsonError("AUTH_REQUIRED", correlationId);
    case "MEMORIAL_NOT_FOUND":
    case "CONTENT_NOT_FOUND":
      return jsonError("MEMORIAL_NOT_FOUND", correlationId);
    case "MEMORIAL_FORBIDDEN":
      return jsonError("MEMORIAL_FORBIDDEN", correlationId);
    case "EMPTY_BODY":
      return jsonUnprocessable(correlationId, {
        body: ["Please write something before saving."],
      });
    case "NOTHING_TO_PUBLISH":
      return jsonUnprocessable(correlationId, {
        _: ["There is no saved draft to publish."],
      });
  }
}
