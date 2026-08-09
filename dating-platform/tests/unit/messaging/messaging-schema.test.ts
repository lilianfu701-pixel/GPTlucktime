import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  conversationMembers,
  conversations,
  messageAttachments,
  messageOutboxEvents,
  messageReceipts,
  messages,
} from "@/db/schema";

describe("messaging schema", () => {
  it("defines durable conversations, append-oriented messages, outbox, and future media contracts", () => {
    expect(Object.keys(getTableColumns(conversations))).toEqual(expect.arrayContaining([
      "id", "lowUserId", "highUserId", "status", "nextSequence", "version", "lastMessageAt",
    ]));
    expect(Object.keys(getTableColumns(conversationMembers))).toEqual(expect.arrayContaining([
      "conversationId", "userId", "lastReadSequence", "hiddenAt", "version",
    ]));
    expect(Object.keys(getTableColumns(messages))).toEqual(expect.arrayContaining([
      "id", "conversationId", "sequence", "senderUserId", "clientId", "body", "createdAt",
    ]));
    expect(Object.keys(getTableColumns(messageOutboxEvents))).toEqual(expect.arrayContaining([
      "id", "messageId", "payload", "status", "leaseId", "leaseExpiresAt", "publishedAt",
    ]));
    expect(getTableColumns(messageReceipts).messageId).toBeDefined();
    expect(getTableColumns(messageAttachments).moderationStatus).toBeDefined();
  });
});
