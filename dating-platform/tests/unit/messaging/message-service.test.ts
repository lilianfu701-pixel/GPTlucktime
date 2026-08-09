// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createConversationsHandler,
  createMessagesHandler,
  createRealtimeTicketHandler,
  parseSendMessageInput,
} from "@/modules/messaging/message-service";
import { MessagingError } from "@/modules/messaging/message-repository";

const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000003";
const profileId = "00000000-0000-4000-8000-000000000004";
const clientId = "00000000-0000-4000-8000-000000000005";
const authenticated = async () => ({ user: { id: userId }, session: { id: sessionId } });
const context = { params: Promise.resolve({ conversationId }) };

const streamingRequest = (url: string, chunks: Uint8Array[], headers: Record<string, string> = {}) => {
  let index = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = new Request(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, wasCancelled: () => cancelled };
};

describe("message input", () => {
  it("accepts valid Unicode by code point and canonicalizes NFC", () => {
    expect(parseSendMessageInput({ clientId, body: "e\u0301" })).toEqual({ clientId, body: "é" });
    expect(parseSendMessageInput({ clientId, body: "😀".repeat(2000) }).body).toHaveLength(4000);
  });

  it("rejects whitespace-only, forbidden controls, lone surrogates, too-long content, and extra fields", () => {
    for (const value of [
      { clientId, body: " \n\t " },
      { clientId, body: "bad\u0000text" },
      { clientId, body: "bad\rtext" },
      { clientId, body: "bad\ud800text" },
      { clientId, body: "a".repeat(2001) },
      { clientId, body: "hello", role: "admin" },
      { clientId: "client-1", body: "hello" },
    ]) expect(() => parseSendMessageInput(value)).toThrow("INVALID_MESSAGE");
  });
});

describe("messaging routes", () => {
  it("authenticates before parsing resources or bodies", async () => {
    const getSession = async () => null;
    const repository = {
      createConversation: vi.fn(), listConversations: vi.fn(),
      sendMessage: vi.fn(), listMessages: vi.fn(),
    };
    const conversations = createConversationsHandler({ getSession, repository: repository as never });
    const messages = createMessagesHandler({ getSession, repository: repository as never });
    expect((await conversations(new Request("https://example.test/api/v1/conversations", {
      method: "POST", body: "not-json",
    }))).status).toBe(401);
    expect((await messages(new Request("https://example.test/api/v1/conversations/bad/messages", {
      method: "POST", body: "not-json",
    }), { params: Promise.resolve({ conversationId: "bad" }) })).status).toBe(401);
    expect(repository.createConversation).not.toHaveBeenCalled();
  });

  it("creates and lists conversations with strict bounded inputs", async () => {
    const repository = {
      createConversation: vi.fn().mockResolvedValue({ id: conversationId }),
      listConversations: vi.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
    };
    const handler = createConversationsHandler({ getSession: authenticated, repository: repository as never });
    const created = await handler(new Request("https://example.test/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ profileId }),
      headers: { "content-type": "application/json" },
    }));
    expect(created.status).toBe(201);
    expect(repository.createConversation).toHaveBeenCalledWith(userId, profileId);
    expect((await handler(new Request("https://example.test/api/v1/conversations?pageSize=51"))).status).toBe(400);
    expect((await handler(new Request("https://example.test/api/v1/conversations?unknown=1"))).status).toBe(400);
    expect((await handler(new Request("https://example.test/api/v1/conversations", {
      method: "POST", body: JSON.stringify({ profileId, userId }), headers: { "content-type": "application/json" },
    }))).status).toBe(400);
  });

  it("bounds conversation JSON by declared and streamed bytes before calling the repository", async () => {
    const repository = { createConversation: vi.fn(), listConversations: vi.fn() };
    const handler = createConversationsHandler({ getSession: authenticated, repository: repository as never });
    const oversized = JSON.stringify({ profileId, padding: "x".repeat(2_000) });
    const encoder = new TextEncoder();
    const chunked = streamingRequest("https://example.test/api/v1/conversations", [
      encoder.encode(oversized.slice(0, 500)), encoder.encode(oversized.slice(500)),
    ]);
    expect((await handler(chunked.request)).status).toBe(413);
    expect(chunked.wasCancelled()).toBe(true);
    const forged = streamingRequest("https://example.test/api/v1/conversations", [encoder.encode(oversized)], {
      "content-length": "10",
    });
    expect((await handler(forged.request)).status).toBe(413);
    expect((await handler(new Request("https://example.test/api/v1/conversations", {
      method: "POST", body: "{}", headers: { "content-type": "text/plain" },
    }))).status).toBe(415);
    expect((await handler(new Request("https://example.test/api/v1/conversations", {
      method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": "999999" },
    }))).status).toBe(413);
    expect(repository.createConversation).not.toHaveBeenCalled();
  });

  it("reads and writes member messages and maps safe policy errors", async () => {
    const repository = {
      sendMessage: vi.fn().mockResolvedValue({ id: "message" }),
      listMessages: vi.fn().mockResolvedValue({ messages: [], nextAfterSequence: null }),
    };
    const handler = createMessagesHandler({ getSession: authenticated, repository: repository as never });
    const sent = await handler(new Request(`https://example.test/api/v1/conversations/${conversationId}/messages`, {
      method: "POST", body: JSON.stringify({ clientId, body: "Hello" }), headers: { "content-type": "application/json" },
    }), context);
    expect(sent.status).toBe(201);
    expect(repository.sendMessage).toHaveBeenCalledWith(userId, conversationId, { clientId, body: "Hello" });

    const page = await handler(new Request(
      `https://example.test/api/v1/conversations/${conversationId}/messages?afterSequence=0&pageSize=50`,
    ), context);
    expect(page.status).toBe(200);
    repository.sendMessage.mockRejectedValueOnce(new MessagingError("VERIFICATION_REQUIRED", ["phone"]));
    const denied = await handler(new Request(`https://example.test/api/v1/conversations/${conversationId}/messages`, {
      method: "POST", body: JSON.stringify({ clientId, body: "Hello" }), headers: { "content-type": "application/json" },
    }), context);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: "VERIFICATION_REQUIRED", message: "VERIFICATION_REQUIRED", unmet: ["phone"] });
    repository.listMessages.mockRejectedValueOnce(new MessagingError("CONVERSATION_NOT_AVAILABLE"));
    const absent = await handler(new Request(
      `https://example.test/api/v1/conversations/${conversationId}/messages`,
    ), context);
    expect(absent.status).toBe(404);
    expect(JSON.stringify(await absent.json())).not.toContain(conversationId);
  });

  it("rejects malformed pagination and message input", async () => {
    const repository = { sendMessage: vi.fn(), listMessages: vi.fn() };
    const handler = createMessagesHandler({ getSession: authenticated, repository: repository as never });
    for (const url of [
      `https://example.test/api/v1/conversations/${conversationId}/messages?afterSequence=-1`,
      `https://example.test/api/v1/conversations/${conversationId}/messages?afterSequence=1.5`,
      `https://example.test/api/v1/conversations/${conversationId}/messages?pageSize=101`,
      `https://example.test/api/v1/conversations/${conversationId}/messages?cursor=secret`,
    ]) expect((await handler(new Request(url), context)).status).toBe(400);
    expect((await handler(new Request(`https://example.test/api/v1/conversations/${conversationId}/messages`, {
      method: "POST", body: JSON.stringify({ clientId, body: "\u0000" }), headers: { "content-type": "application/json" },
    }), context)).status).toBe(400);
    expect(repository.sendMessage).not.toHaveBeenCalled();
  });

  it("bounds message JSON by actual bytes, rejects invalid UTF-8 and never calls the repository", async () => {
    const repository = { sendMessage: vi.fn(), listMessages: vi.fn() };
    const handler = createMessagesHandler({ getSession: authenticated, repository: repository as never });
    const encoder = new TextEncoder();
    const oversized = JSON.stringify({ clientId, body: "x".repeat(17_000) });
    for (const request of [
      streamingRequest(`https://example.test/api/v1/conversations/${conversationId}/messages`, [
        encoder.encode(oversized.slice(0, 8_000)), encoder.encode(oversized.slice(8_000)),
      ]).request,
      streamingRequest(`https://example.test/api/v1/conversations/${conversationId}/messages`, [encoder.encode(oversized)], {
        "content-length": "100",
      }).request,
      new Request(`https://example.test/api/v1/conversations/${conversationId}/messages`, {
        method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": "20000" },
      }),
    ]) expect((await handler(request, context)).status).toBe(413);
    const invalidUtf8 = streamingRequest(
      `https://example.test/api/v1/conversations/${conversationId}/messages`,
      [Uint8Array.from([0xc3, 0x28])],
    );
    expect((await handler(invalidUtf8.request, context)).status).toBe(400);
    expect(repository.sendMessage).not.toHaveBeenCalled();
  });

  it("issues tickets only from trusted active sessions and rejects client identity fields", async () => {
    const issuer = { issue: vi.fn().mockResolvedValue({ ticket: "signed", expiresAt: "2026-08-08T12:05:00.000Z" }) };
    const handler = createRealtimeTicketHandler({ getSession: authenticated, issuer });
    const response = await handler(new Request("https://example.test/api/v1/realtime/ticket", {
      method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(issuer.issue).toHaveBeenCalledWith(userId, sessionId);
    expect((await handler(new Request("https://example.test/api/v1/realtime/ticket", {
      method: "POST", body: JSON.stringify({ userId }), headers: { "content-type": "application/json" },
    }))).status).toBe(400);
    expect((await createRealtimeTicketHandler({ getSession: authenticated, issuer: null })(
      new Request("https://example.test/api/v1/realtime/ticket", { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } }),
    )).status).toBe(503);
  });

  it("bounds realtime ticket JSON and rejects unsupported media before issuer use", async () => {
    const issuer = { issue: vi.fn() };
    const handler = createRealtimeTicketHandler({ getSession: authenticated, issuer });
    const huge = streamingRequest("https://example.test/api/v1/realtime/ticket", [
      new TextEncoder().encode(JSON.stringify({ padding: "x".repeat(2_000) })),
    ]);
    expect((await handler(huge.request)).status).toBe(413);
    expect((await handler(new Request("https://example.test/api/v1/realtime/ticket", {
      method: "POST", body: "{}", headers: { "content-type": "application/octet-stream" },
    }))).status).toBe(415);
    expect(issuer.issue).not.toHaveBeenCalled();
  });
});
