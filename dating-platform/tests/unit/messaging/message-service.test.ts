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
      method: "POST", body: JSON.stringify({ profileId, userId }),
    }))).status).toBe(400);
  });

  it("reads and writes member messages and maps safe policy errors", async () => {
    const repository = {
      sendMessage: vi.fn().mockResolvedValue({ id: "message" }),
      listMessages: vi.fn().mockResolvedValue({ messages: [], nextAfterSequence: null }),
    };
    const handler = createMessagesHandler({ getSession: authenticated, repository: repository as never });
    const sent = await handler(new Request(`https://example.test/api/v1/conversations/${conversationId}/messages`, {
      method: "POST", body: JSON.stringify({ clientId, body: "Hello" }),
    }), context);
    expect(sent.status).toBe(201);
    expect(repository.sendMessage).toHaveBeenCalledWith(userId, conversationId, { clientId, body: "Hello" });

    const page = await handler(new Request(
      `https://example.test/api/v1/conversations/${conversationId}/messages?afterSequence=0&pageSize=50`,
    ), context);
    expect(page.status).toBe(200);
    repository.sendMessage.mockRejectedValueOnce(new MessagingError("VERIFICATION_REQUIRED", ["phone"]));
    const denied = await handler(new Request(`https://example.test/api/v1/conversations/${conversationId}/messages`, {
      method: "POST", body: JSON.stringify({ clientId, body: "Hello" }),
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
      method: "POST", body: JSON.stringify({ clientId, body: "\u0000" }),
    }), context)).status).toBe(400);
    expect(repository.sendMessage).not.toHaveBeenCalled();
  });

  it("issues tickets only from trusted active sessions and rejects client identity fields", async () => {
    const issuer = { issue: vi.fn().mockResolvedValue({ ticket: "signed", expiresAt: "2026-08-08T12:05:00.000Z" }) };
    const handler = createRealtimeTicketHandler({ getSession: authenticated, issuer });
    const response = await handler(new Request("https://example.test/api/v1/realtime/ticket", {
      method: "POST", body: JSON.stringify({}),
    }));
    expect(response.status).toBe(200);
    expect(issuer.issue).toHaveBeenCalledWith(userId, sessionId);
    expect((await handler(new Request("https://example.test/api/v1/realtime/ticket", {
      method: "POST", body: JSON.stringify({ userId }),
    }))).status).toBe(400);
    expect((await createRealtimeTicketHandler({ getSession: authenticated, issuer: null })(
      new Request("https://example.test/api/v1/realtime/ticket", { method: "POST", body: JSON.stringify({}) }),
    )).status).toBe(503);
  });
});
