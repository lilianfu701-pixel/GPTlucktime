import { removeFromIndex } from "@/modules/search/indexer";
import type { HandlerRegistry } from "@/modules/outbox/runner";
import { handleMediaProcess } from "./jobs/process-media";
import { handleSearchIndex } from "./jobs/search-index";

/**
 * Which topics this worker can actually do something about.
 *
 * Deliberately not exhaustive. A topic is registered only when the work behind
 * it can genuinely be performed; anything else is left in the queue for a
 * worker that can, rather than claimed and buried. See the README in this
 * directory for the topics that are waiting on a provider, and why leaving them
 * queued is the honest state rather than an oversight.
 */
export function buildRegistry(): HandlerRegistry {
  return {
    "search.index": async (payload) => toResult(await handleSearchIndex(payload)),
    // A memorial that has just been created or has just changed its privacy
    // both need the same thing: the index brought back in line with the row.
    "memorial.created": async (payload) =>
      toResult(await handleSearchIndex(payload)),
    "memorial.privacy_changed": async (payload) =>
      toResult(await handleSearchIndex(payload)),
    // First publication is the moment a memorial becomes findable, so it needs
    // the same reconciliation. Registered rather than left queued because the
    // work behind it genuinely can be done — the rule above is about topics
    // waiting on a provider, not about topics nobody got round to.
    "memorial.published": async (payload) =>
      toResult(await handleSearchIndex(payload)),
    "search.remove": async (payload) => {
      const memorialId = readMemorialId(payload);
      if (!memorialId) {
        return { handled: false, reason: "INVALID_PAYLOAD", retryable: false };
      }
      await removeFromIndex(memorialId);
      return { handled: true };
    },
    "media.process": async (payload) => toResult(await handleMediaProcess(payload)),
  };
}

function readMemorialId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { memorialId?: unknown }).memorialId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Job outcomes already carry `handled`/`retryable`; this only narrows them. */
function toResult(
  outcome:
    | { handled: true }
    | { handled: false; reason: string; retryable: boolean },
):
  | { handled: true }
  | { handled: false; reason: string; retryable: boolean } {
  return outcome.handled
    ? { handled: true }
    : { handled: false, reason: outcome.reason, retryable: outcome.retryable };
}
