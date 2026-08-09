import { z } from "zod";

import { MessageRepository, MessagingError } from "./message-repository";
import { normalizeSendMessageInput } from "./message-input";

type Session = { user: { id: string }; session: { id: string } };
type SessionReader = (headers: Headers) => Promise<Session | null>;
type MessageContext = { params: Promise<{ conversationId: string }> };
type TicketIssuer = { issue(userId: string, sessionId: string): Promise<{ ticket: string; expiresAt: string }> };

const uuid = z.string().uuid();
const cursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CONVERSATION_JSON_MAX_BYTES = 1_024;
const MESSAGE_JSON_MAX_BYTES = 16_384;
const REALTIME_JSON_MAX_BYTES = 1_024;

export function parseSendMessageInput(value: unknown) {
  return normalizeSendMessageInput(value);
}

const errorResponse = (code: string, status: number, extra?: Record<string, unknown>) =>
  Response.json({ code, message: code, ...extra }, { status });

class RequestBodyError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE") {
    super(code);
  }
}

async function readJson(request: Request, maxBytes: number) {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new RequestBodyError("UNSUPPORTED_MEDIA_TYPE");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared)) throw new RequestBodyError("INVALID_REQUEST");
    if (Number(declared) > maxBytes) throw new RequestBodyError("PAYLOAD_TOO_LARGE");
  }
  if (!request.body) throw new RequestBodyError("INVALID_REQUEST");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    if (total > maxBytes) throw new RequestBodyError("PAYLOAD_TOO_LARGE");
    throw new RequestBodyError("INVALID_REQUEST");
  }
}

const bodyErrorResponse = (error: unknown, invalidCode: "INVALID_REQUEST" | "INVALID_MESSAGE") => {
  if (error instanceof RequestBodyError && error.code === "PAYLOAD_TOO_LARGE") {
    return errorResponse("PAYLOAD_TOO_LARGE", 413);
  }
  if (error instanceof RequestBodyError && error.code === "UNSUPPORTED_MEDIA_TYPE") {
    return errorResponse("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  return errorResponse(invalidCode, 400);
};

async function requireSession(getSession: SessionReader, headers: Headers) {
  try {
    return await getSession(headers);
  } catch {
    throw new Error("SESSION_UNAVAILABLE");
  }
}

export function createConversationsHandler(input: {
  getSession: SessionReader;
  repository: Pick<MessageRepository, "createConversation" | "listConversations">;
}) {
  return async (request: Request) => {
    let session: Session | null;
    try { session = await requireSession(input.getSession, request.headers); } catch {
      return errorResponse("INTERNAL_ERROR", 500);
    }
    if (!session) return errorResponse("UNAUTHORIZED", 401);

    if (request.method === "POST") {
      let payload: unknown;
      try { payload = await readJson(request, CONVERSATION_JSON_MAX_BYTES); } catch (error) {
        return bodyErrorResponse(error, "INVALID_REQUEST");
      }
      const parsed = z.object({ profileId: uuid }).strict().safeParse(payload);
      if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);
      try {
        return Response.json(
          await input.repository.createConversation(session.user.id, parsed.data.profileId),
          { status: 201 },
        );
      } catch (error) {
        return mapMessagingError(error);
      }
    }
    if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", 405);
    const search = new URL(request.url).searchParams;
    for (const key of search.keys()) {
      if (!["pageSize", "cursor"].includes(key) || search.getAll(key).length !== 1) {
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
    try {
      return Response.json(await input.repository.listConversations(session.user.id, { pageSize, cursor }));
    } catch (error) {
      return mapMessagingError(error);
    }
  };
}

export function createMessagesHandler(input: {
  getSession: SessionReader;
  repository: Pick<MessageRepository, "sendMessage" | "listMessages">;
}) {
  return async (request: Request, context: MessageContext) => {
    let session: Session | null;
    try { session = await requireSession(input.getSession, request.headers); } catch {
      return errorResponse("INTERNAL_ERROR", 500);
    }
    if (!session) return errorResponse("UNAUTHORIZED", 401);
    let conversationId: string;
    try {
      conversationId = uuid.parse((await context.params).conversationId);
    } catch {
      return errorResponse("CONVERSATION_NOT_AVAILABLE", 404);
    }

    if (request.method === "POST") {
      let payload: unknown;
      try { payload = await readJson(request, MESSAGE_JSON_MAX_BYTES); } catch (error) {
        return bodyErrorResponse(error, "INVALID_MESSAGE");
      }
      let parsed: { clientId: string; body: string };
      try { parsed = parseSendMessageInput(payload); } catch { return errorResponse("INVALID_MESSAGE", 400); }
      try {
        return Response.json(
          await input.repository.sendMessage(session.user.id, conversationId, parsed),
          { status: 201 },
        );
      } catch (error) {
        return mapMessagingError(error);
      }
    }
    if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", 405);
    const search = new URL(request.url).searchParams;
    for (const key of search.keys()) {
      if (!["afterSequence", "pageSize"].includes(key) || search.getAll(key).length !== 1) {
        return errorResponse("INVALID_PAGINATION", 400);
      }
    }
    const rawAfter = search.get("afterSequence");
    const rawPageSize = search.get("pageSize");
    const afterSequence = rawAfter === null ? 0 : Number(rawAfter);
    const pageSize = rawPageSize === null ? 50 : Number(rawPageSize);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return errorResponse("INVALID_PAGINATION", 400);
    }
    try {
      return Response.json(await input.repository.listMessages(
        session.user.id,
        conversationId,
        { afterSequence, pageSize },
      ));
    } catch (error) {
      return mapMessagingError(error);
    }
  };
}

export function createRealtimeTicketHandler(input: {
  getSession: SessionReader;
  issuer: TicketIssuer | null;
}) {
  return async (request: Request) => {
    let session: Session | null;
    try { session = await requireSession(input.getSession, request.headers); } catch {
      return errorResponse("INTERNAL_ERROR", 500);
    }
    if (!session) return errorResponse("UNAUTHORIZED", 401);
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405);
    let payload: unknown;
    try { payload = await readJson(request, REALTIME_JSON_MAX_BYTES); } catch (error) {
      return bodyErrorResponse(error, "INVALID_REQUEST");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload as Record<string, unknown>).length !== 0) {
      return errorResponse("INVALID_REQUEST", 400);
    }
    if (!input.issuer) return errorResponse("REALTIME_UNAVAILABLE", 503);
    try {
      return Response.json(await input.issuer.issue(session.user.id, session.session.id));
    } catch (error) {
      if (error instanceof Error && error.message === "REALTIME_SESSION_NOT_AVAILABLE") {
        return errorResponse("REALTIME_SESSION_NOT_AVAILABLE", 403);
      }
      return errorResponse("INTERNAL_ERROR", 500);
    }
  };
}

function mapMessagingError(error: unknown) {
  if (!(error instanceof MessagingError)) return errorResponse("INTERNAL_ERROR", 500);
  if (error.code === "CONVERSATION_NOT_AVAILABLE") {
    return errorResponse("CONVERSATION_NOT_AVAILABLE", 404);
  }
  if (error.code === "MESSAGE_IDEMPOTENCY_CONFLICT") {
    return errorResponse("MESSAGE_IDEMPOTENCY_CONFLICT", 409);
  }
  if (error.code === "INVALID_MESSAGE") return errorResponse("INVALID_MESSAGE", 400);
  if (error.code === "VERIFICATION_REQUIRED") {
    return errorResponse("VERIFICATION_REQUIRED", 403, { unmet: error.unmet ?? [] });
  }
  if (error.code === "MESSAGE_SEND_DENIED") return errorResponse("MESSAGE_SEND_DENIED", 403);
  if (error.code === "INVALID_CURSOR") return errorResponse("INVALID_CURSOR", 400);
  return errorResponse("INTERNAL_ERROR", 500);
}
