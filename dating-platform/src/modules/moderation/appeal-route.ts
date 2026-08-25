import { z } from "zod";

import { BoundedJsonError, readBoundedJson } from "@/shared/http/read-bounded-json";

type SessionReader = (headers: Headers) => Promise<{ user: { id: string } } | null>;
type AppealService = {
  listMemberAppeals(userId: string): Promise<unknown>;
  createAppeal(userId: string, originalCaseId: string, statement: string): Promise<unknown>;
};
const inputSchema = z.object({ originalCaseId: z.string().uuid(), statement: z.string().trim().min(1).max(2000) }).strict();
const error = (code: string, status: number) => Response.json({ code, messageKey: `errors.${code.toLowerCase().replaceAll("_", ".")}` },
  { status, headers: { "cache-control": "private, no-store" } });

export function createMemberAppealsHandler(input: { getSession: SessionReader; service: AppealService }) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "POST") return error("METHOD_NOT_ALLOWED", 405);
    let session;
    try { session = await input.getSession(request.headers); } catch { return error("SERVICE_UNAVAILABLE", 503); }
    if (!session) return error("UNAUTHORIZED", 401);
    try {
      if (request.method === "GET") return Response.json(await input.service.listMemberAppeals(session.user.id),
        { headers: { "cache-control": "private, no-store" } });
      const body = inputSchema.parse(await readBoundedJson(request, 8192));
      return Response.json(await input.service.createAppeal(session.user.id, body.originalCaseId, body.statement),
        { status: 201, headers: { "cache-control": "private, no-store" } });
    } catch (caught) {
      if (caught instanceof BoundedJsonError) return error(caught.code === "INVALID_REQUEST" ? "INVALID_APPEAL" : caught.code,
        caught.code === "PAYLOAD_TOO_LARGE" ? 413 : caught.code === "UNSUPPORTED_MEDIA_TYPE" ? 415 : 400);
      if (caught instanceof z.ZodError || caught instanceof SyntaxError) return error("INVALID_APPEAL", 400);
      if (caught instanceof Error && caught.message === "FORBIDDEN") return error("FORBIDDEN", 403);
      if (caught instanceof Error && (caught.message === "INVALID_APPEAL" || caught.message === "APPEAL_CONFLICT")) {
        return error("APPEAL_NOT_AVAILABLE", 409);
      }
      return error("INTERNAL_ERROR", 500);
    }
  };
}
