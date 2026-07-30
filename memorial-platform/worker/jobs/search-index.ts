import { z } from "zod";
import {
  findDuplicateCandidates,
  recordDuplicateCandidates,
} from "@/modules/search/duplicates";
import { indexMemorial, removeFromIndex } from "@/modules/search/indexer";

const payloadSchema = z.object({
  memorialId: z.uuid(),
  correlationId: z.string().min(1).max(64).optional(),
});

export type SearchJobOutcome =
  | { handled: true; action: "indexed" | "removed"; duplicateCandidates?: number }
  | { handled: false; reason: string; retryable: boolean };

/**
 * Handles `search.index`.
 *
 * Indexing is a convenience, not a protection: the query filters on the live
 * memorial row, so a memorial that should not be findable is already not
 * findable regardless of whether this job has run.
 *
 * Duplicate detection runs here rather than at creation time so it does not
 * stand between a grieving family and the memorial they are trying to make.
 */
export async function handleSearchIndex(
  payload: unknown,
): Promise<SearchJobOutcome> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { handled: false, reason: "INVALID_PAYLOAD", retryable: false };
  }

  const indexed = await indexMemorial(parsed.data.memorialId);
  if (!indexed) {
    // The memorial was removed between the event and this run.
    return { handled: false, reason: "MEMORIAL_NOT_FOUND", retryable: false };
  }

  const matches = await findDuplicateCandidates(parsed.data.memorialId);
  const recorded = await recordDuplicateCandidates(
    parsed.data.memorialId,
    matches,
  );

  return { handled: true, action: "indexed", duplicateCandidates: recorded };
}

/** Handles `search.remove`. */
export async function handleSearchRemove(
  payload: unknown,
): Promise<SearchJobOutcome> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { handled: false, reason: "INVALID_PAYLOAD", retryable: false };
  }

  await removeFromIndex(parsed.data.memorialId);
  return { handled: true, action: "removed" };
}
