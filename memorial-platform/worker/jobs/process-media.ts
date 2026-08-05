import { z } from "zod";
import { processUploadedAsset } from "@/modules/media/service";
import { AlwaysCleanScanner } from "@/modules/media/storage";
import type { MalwareScanner } from "@/modules/media/storage";

const payloadSchema = z.object({
  mediaAssetId: z.uuid(),
  correlationId: z.string().min(1).max(64),
});

export type JobOutcome =
  | { handled: true; status: string }
  | { handled: false; reason: string; retryable: boolean };

/**
 * Handles a `media.process` event.
 *
 * A rejected file is a finished outcome, not a failure to retry: scanning the
 * same executable again will reach the same conclusion. Only a genuinely
 * transient problem is worth another attempt, so the two are reported
 * separately and the runner does not spin on the former.
 */
export async function handleMediaProcess(
  payload: unknown,
  scanner: MalwareScanner = new AlwaysCleanScanner(),
): Promise<JobOutcome> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    // A malformed event will never become valid. Retrying is pointless.
    return { handled: false, reason: "INVALID_PAYLOAD", retryable: false };
  }

  const result = await processUploadedAsset(
    parsed.data.mediaAssetId,
    scanner,
    parsed.data.correlationId,
  );

  if (result.ok) {
    return { handled: true, status: result.value.status };
  }

  switch (result.error) {
    case "MALWARE_DETECTED":
    case "CONTENT_MISMATCH":
    case "PROCESSING_FAILED":
      // Decided. The asset is rejected and the bytes are gone.
      return { handled: true, status: "rejected" };
    case "NOT_AWAITING_PROCESSING":
      // Another worker already took it, or it was processed before.
      return { handled: true, status: "already_settled" };
    case "ASSET_NOT_FOUND":
      return { handled: false, reason: "ASSET_NOT_FOUND", retryable: false };
    case "BYTES_MISSING":
      // The client may still be uploading, or may have abandoned it. Worth one
      // more look before the attempt limit gives up on it.
      return { handled: false, reason: "BYTES_MISSING", retryable: true };
  }
}
