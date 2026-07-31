import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { addMemorialSubject } from "@/modules/genealogy/people";
import { readTreeForMemorial } from "@/modules/genealogy/tree";

/**
 * The family tree shown on a memorial page.
 *
 * Refuses exactly as the memorial itself would, before reading anything, so
 * this cannot become a side door into a page that answers 404 at its own
 * address. Nodes inside the tree are filtered again one by one.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { id } = await context.params;

  if (!z.uuid().safeParse(id).success) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const url = new URL(request.url);
  const depth = Number(url.searchParams.get("depth") ?? "3");
  const actor = await currentActor();

  const result = await readTreeForMemorial(actor, id, {
    depth: Number.isFinite(depth) ? depth : 3,
  });

  if (!result.ok) {
    // Both "no tree here" and "not yours to see" answer the same way.
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  return jsonSuccess(result.value, correlationId);
}

/** Puts the memorial's subject into the graph. Owner or administrator only. */
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
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const result = await addMemorialSubject(actor, id, correlationId);

  if (!result.ok) {
    if (result.error === "MEMORIAL_FORBIDDEN") {
      return jsonError("MEMORIAL_FORBIDDEN", correlationId);
    }
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  return jsonSuccess(
    { personId: result.value.personId },
    correlationId,
    result.value.created ? 201 : 200,
  );
}
