import { z } from "zod";

import type { DiscoveryRepository } from "./discovery-repository";
import {
  publicDiscoveryFilterSchema,
  SAVED_SEARCH_SCHEMA_VERSION,
  savedDiscoveryFilterSchema,
} from "./discovery-types";

type Session = { user: { id: string } };
type SessionReader = (headers: Headers) => Promise<Session | null>;

const errorResponse = (code: string, status: number) => Response.json({ code, message: code }, { status });

const allowedQueryKeys = new Set([
  "mode", "minimumAge", "maximumAge", "genderCodes", "countryCodes",
  "relationshipGoalCodes", "languageCodes", "pageSize", "cursor",
]);
const arrayQueryKeys = new Set(["genderCodes", "countryCodes", "relationshipGoalCodes", "languageCodes"]);
const numberQueryKeys = new Set(["minimumAge", "maximumAge", "pageSize"]);

function parseDiscoveryQuery(request: Request) {
  const search = new URL(request.url).searchParams;
  for (const key of search.keys()) if (!allowedQueryKeys.has(key)) throw new Error("INVALID_DISCOVERY");
  const input: Record<string, unknown> = {};
  for (const key of allowedQueryKeys) {
    if (!search.has(key)) continue;
    if (!arrayQueryKeys.has(key) && search.getAll(key).length !== 1) throw new Error("INVALID_DISCOVERY");
    if (arrayQueryKeys.has(key)) input[key] = search.getAll(key);
    else if (numberQueryKeys.has(key)) input[key] = Number(search.get(key));
    else input[key] = search.get(key);
  }
  return publicDiscoveryFilterSchema.parse(input);
}

export function createDiscoverHandler(input: {
  getSession: SessionReader;
  repository: Pick<DiscoveryRepository, "discover">;
}) {
  return async (request: Request) => {
    let session: Session | null;
    try { session = await input.getSession(request.headers); } catch { return errorResponse("INTERNAL_ERROR", 500); }
    if (!session) return errorResponse("UNAUTHORIZED", 401);
    let filters;
    try { filters = parseDiscoveryQuery(request); } catch { return errorResponse("INVALID_DISCOVERY", 400); }
    try {
      return Response.json(await input.repository.discover(session.user.id, filters));
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_CURSOR") return errorResponse("INVALID_CURSOR", 400);
      if (error instanceof Error && error.message === "PROFILE_INCOMPLETE") return errorResponse("PROFILE_INCOMPLETE", 409);
      if (error instanceof Error && error.message === "DISCOVERY_SNAPSHOT_BUSY") {
        return errorResponse("DISCOVERY_RETRY", 409);
      }
      return errorResponse("INTERNAL_ERROR", 500);
    }
  };
}

const createSavedSearchSchema = z.object({
  name: z.string().trim().min(1).max(80),
  filters: savedDiscoveryFilterSchema,
}).strict();
const renameSavedSearchSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
}).strict();
const deleteSavedSearchSchema = z.object({ id: z.string().uuid() }).strict();

const safeSavedSearch = (row: Record<string, unknown>) => {
  if (row.schemaVersion !== SAVED_SEARCH_SCHEMA_VERSION) return null;
  const filters = savedDiscoveryFilterSchema.safeParse(row.filters);
  if (!filters.success) return null;
  const safe: Record<string, unknown> = { id: String(row.id), name: String(row.name), filters: filters.data };
  if (row.createdAt) safe.createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  if (row.updatedAt) safe.updatedAt = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt);
  return safe;
};

export function createSavedSearchHandler(input: {
  getSession: SessionReader;
  repository: Pick<DiscoveryRepository,
    "listSavedSearches" | "createSavedSearch" | "renameSavedSearch" | "deleteSavedSearch">;
}) {
  return async (request: Request) => {
    let session: Session | null;
    try { session = await input.getSession(request.headers); } catch { return errorResponse("INTERNAL_ERROR", 500); }
    if (!session) return errorResponse("UNAUTHORIZED", 401);
    try {
      if (request.method === "GET") {
        const rows = await input.repository.listSavedSearches(session.user.id);
        return Response.json({ savedSearches: rows.flatMap((row) => {
          const safe = safeSavedSearch(row as Record<string, unknown>);
          return safe ? [safe] : [];
        }) });
      }
      let body: unknown;
      try { body = await request.json(); } catch { return errorResponse("INVALID_SAVED_SEARCH", 400); }
      if (request.method === "POST") {
        const parsed = createSavedSearchSchema.safeParse(body);
        if (!parsed.success) return errorResponse("INVALID_SAVED_SEARCH", 400);
        const created = await input.repository.createSavedSearch(session.user.id, parsed.data.name, parsed.data.filters);
        const safe = safeSavedSearch(created as Record<string, unknown>);
        return safe ? Response.json({ savedSearch: safe }, { status: 201 }) : errorResponse("INTERNAL_ERROR", 500);
      }
      if (request.method === "PATCH") {
        const parsed = renameSavedSearchSchema.safeParse(body);
        if (!parsed.success) return errorResponse("INVALID_SAVED_SEARCH", 400);
        const updated = await input.repository.renameSavedSearch(session.user.id, parsed.data.id, parsed.data.name);
        if (!updated) return errorResponse("SAVED_SEARCH_NOT_FOUND", 404);
        const safe = safeSavedSearch(updated as Record<string, unknown>);
        return safe ? Response.json({ savedSearch: safe }) : errorResponse("INTERNAL_ERROR", 500);
      }
      if (request.method === "DELETE") {
        const parsed = deleteSavedSearchSchema.safeParse(body);
        if (!parsed.success) return errorResponse("INVALID_SAVED_SEARCH", 400);
        return await input.repository.deleteSavedSearch(session.user.id, parsed.data.id)
          ? Response.json({ deleted: true })
          : errorResponse("SAVED_SEARCH_NOT_FOUND", 404);
      }
      return errorResponse("METHOD_NOT_ALLOWED", 405);
    } catch (error) {
      if (error instanceof Error && error.message === "SAVED_SEARCH_LIMIT") {
        return errorResponse("SAVED_SEARCH_LIMIT", 409);
      }
      if ((error as { code?: string }).code === "23505") return errorResponse("SAVED_SEARCH_CONFLICT", 409);
      return errorResponse("INTERNAL_ERROR", 500);
    }
  };
}
