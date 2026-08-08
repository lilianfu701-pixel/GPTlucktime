import { z } from "zod";

import type { SocialRepository } from "./social-repository";

type Session = { user: { id: string } };
type SessionReader = (headers: Headers) => Promise<Session | null>;
type RouteContext = { params: Promise<{ profileId: string }> };
type ProfileAction = "like" | "favorite" | "view" | "block";
type ListKind = "matches" | "likes" | "favorites" | "visitors";

const profileIdSchema = z.string().uuid();
const idempotencyKeyPattern = /^[\x21-\x7e]{8,200}$/;
const cursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const errorResponse = (code: string, status: number) =>
  Response.json({ code, message: code }, { status });

const actionMethods = {
  like: { post: "like", delete: "unlike" },
  favorite: { post: "favorite", delete: "removeFavorite" },
  view: { post: "view", delete: null },
  block: { post: "block", delete: "unblock" },
} as const;

export function createProfileActionHandler(input: {
  action: ProfileAction;
  getSession: SessionReader;
  repository: Pick<SocialRepository,
    "like" | "unlike" | "favorite" | "removeFavorite" | "view" | "block" | "unblock">;
}) {
  return async (request: Request, context: RouteContext) => {
    let session: Session | null;
    try {
      session = await input.getSession(request.headers);
    } catch {
      return errorResponse("INTERNAL_ERROR", 500);
    }
    if (!session) return errorResponse("UNAUTHORIZED", 401);

    let profileId: string;
    try {
      const params = await context.params;
      profileId = profileIdSchema.parse(params.profileId);
    } catch {
      return errorResponse("INVALID_PROFILE_ID", 400);
    }

    const methods = actionMethods[input.action];
    if (request.method === "DELETE") {
      if (!methods.delete) return errorResponse("METHOD_NOT_ALLOWED", 405);
      try {
        const result = await input.repository[methods.delete](session.user.id, profileId);
        return Response.json(result);
      } catch (error) {
        return mapSocialError(error);
      }
    }
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!idempotencyKeyPattern.test(idempotencyKey)) {
      return errorResponse("INVALID_IDEMPOTENCY_KEY", 400);
    }
    try {
      const result = await input.repository[methods.post](session.user.id, profileId, idempotencyKey);
      return Response.json(result);
    } catch (error) {
      return mapSocialError(error);
    }
  };
}

export function createSocialListHandler(input: {
  kind: ListKind;
  getSession: SessionReader;
  repository: Pick<SocialRepository, "listMatches" | "listLikes" | "listFavorites" | "listVisitors">;
}) {
  return async (request: Request) => {
    let session: Session | null;
    try {
      session = await input.getSession(request.headers);
    } catch {
      return errorResponse("INTERNAL_ERROR", 500);
    }
    if (!session) return errorResponse("UNAUTHORIZED", 401);
    if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", 405);

    const search = new URL(request.url).searchParams;
    const allowed = input.kind === "likes"
      ? new Set(["pageSize", "cursor", "direction"])
      : new Set(["pageSize", "cursor"]);
    for (const key of search.keys()) {
      if (!allowed.has(key) || search.getAll(key).length !== 1) {
        return errorResponse("INVALID_PAGINATION", 400);
      }
    }
    const rawPageSize = search.get("pageSize");
    const pageSize = rawPageSize === null ? 20 : Number(rawPageSize);
    const cursor = search.get("cursor") ?? undefined;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50
      || (cursor !== undefined && (cursor.length > 1200 || !cursorPattern.test(cursor)))) {
      return errorResponse("INVALID_PAGINATION", 400);
    }
    const direction = search.get("direction") ?? "received";
    if (input.kind === "likes" && direction !== "sent" && direction !== "received") {
      return errorResponse("INVALID_LIKES_DIRECTION", 400);
    }

    try {
      const page = input.kind === "likes"
        ? await input.repository.listLikes(session.user.id, {
          pageSize,
          cursor,
          direction: direction as "sent" | "received",
        })
        : input.kind === "matches"
          ? await input.repository.listMatches(session.user.id, { pageSize, cursor })
          : input.kind === "favorites"
            ? await input.repository.listFavorites(session.user.id, { pageSize, cursor })
            : await input.repository.listVisitors(session.user.id, { pageSize, cursor });
      return Response.json({ [input.kind]: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_CURSOR") {
        return errorResponse("INVALID_CURSOR", 400);
      }
      return errorResponse("INTERNAL_ERROR", 500);
    }
  };
}

function mapSocialError(error: unknown) {
  if (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT") {
    return errorResponse("IDEMPOTENCY_CONFLICT", 409);
  }
  if (error instanceof Error && error.message === "INTERACTION_NOT_ALLOWED") {
    return errorResponse("INTERACTION_NOT_ALLOWED", 404);
  }
  return errorResponse("INTERNAL_ERROR", 500);
}
