// @vitest-environment node

import { createServer as createHttpServer } from "node:http";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";

import { createRealtimeServer, type SocketIdentity } from "../../../realtime/server";
import { RealtimeMessageStore } from "@/modules/messaging/realtime-client";

const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000101";

const once = <T>(socket: ClientSocket, event: string) => new Promise<T>((resolve) => {
  socket.once(event, resolve);
});

describe("real-time delivery", () => {
  const clients: ClientSocket[] = [];
  const servers: Array<ReturnType<typeof createRealtimeServer>> = [];

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    for (const server of servers) await server.stop();
  });

  const setup = async () => {
    const httpServer = createHttpServer();
    let blocked = false;
    const identities = new Map<string, SocketIdentity>([
      ["alice-ticket", { userId: alice, sessionId: "00000000-0000-4000-8000-000000000011", issuedAt: new Date("2026-08-08T12:00:00Z"), expiresAt: new Date(Date.now() + 60_000) }],
      ["bob-ticket", { userId: bob, sessionId: "00000000-0000-4000-8000-000000000012", issuedAt: new Date("2026-08-08T12:00:00Z"), expiresAt: new Date(Date.now() + 60_000) }],
    ]);
    const server = createRealtimeServer({
      httpServer,
      authorization: {
        authenticate: async (ticket) => {
          const identity = identities.get(ticket);
          if (!identity) throw new Error("NOT_AUTHORIZED");
          return identity;
        },
        authorizeConversation: async (identity, requestedId) => {
          if (blocked || requestedId !== conversationId || ![alice, bob].includes(identity.userId)) {
            throw new Error("NOT_AUTHORIZED");
          }
          return { conversationId, lowUserId: alice, highUserId: bob };
        },
      },
      receipts: {
        record: async (userId, input) => ({ ...input, userId, deliveredAt: input.at, readAt: input.kind === "read" ? input.at : null }),
      },
    });
    servers.push(server);
    const address = await server.start({ host: "127.0.0.1", port: 0 });
    const connect = (ticket: string, extraAuth?: Record<string, unknown>) => {
      const socket = createClient(address.url, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        auth: { ticket, ...extraAuth },
      });
      clients.push(socket);
      return socket;
    };
    return { server, connect, block: () => { blocked = true; } };
  };

  it("accepts only a valid ticket and authorizes opaque conversation rooms", async () => {
    const { connect } = await setup();
    const invalid = connect("invalid");
    await expect(once<Error>(invalid, "connect_error")).resolves.toMatchObject({ message: "NOT_AUTHORIZED" });
    const forged = connect("alice-ticket", { userId: bob });
    await expect(once<Error>(forged, "connect_error")).resolves.toMatchObject({ message: "NOT_AUTHORIZED" });

    const valid = connect("alice-ticket");
    await once(valid, "connect");
    const denied = await valid.emitWithAck("conversation.join", {
      conversationId: "00000000-0000-4000-8000-000000000999",
    });
    expect(denied).toEqual({ ok: false, code: "NOT_AVAILABLE" });
    expect(await valid.emitWithAck("conversation.join", { conversationId })).toEqual({ ok: true });
  });

  it("delivers one minimal event and the cursor store recovers only missing messages", async () => {
    const { server, connect } = await setup();
    const recipient = connect("bob-ticket");
    await once(recipient, "connect");
    await recipient.emitWithAck("conversation.join", { conversationId });
    const event = { eventId: "00000000-0000-4000-8000-000000000201", messageId: "00000000-0000-4000-8000-000000000301", conversationId, sequence: 1 };
    const observed = once<typeof event>(recipient, "message.created");
    await server.publishMessage(event);
    expect(await observed).toEqual(event);
    recipient.disconnect();

    const store = new RealtimeMessageStore();
    store.mergeLive(event);
    store.mergeRecovery(conversationId, [
      { id: event.messageId, conversationId, sequence: 1, body: "first", sender: "them", createdAt: "2026-08-08T12:00:00Z" },
      { id: "00000000-0000-4000-8000-000000000302", conversationId, sequence: 2, body: "second", sender: "them", createdAt: "2026-08-08T12:01:00Z" },
    ]);
    store.mergeLive({ eventId: "00000000-0000-4000-8000-000000000202", messageId: "00000000-0000-4000-8000-000000000302", conversationId, sequence: 2 });
    expect(store.lastSequence(conversationId)).toBe(2);
    expect(store.messages(conversationId).map(({ sequence }) => sequence)).toEqual([1, 2]);
  });

  it("disconnects current pair sockets on block revocation and rejects a reconnect join", async () => {
    const { server, connect, block } = await setup();
    const recipient = connect("bob-ticket");
    await once(recipient, "connect");
    await recipient.emitWithAck("conversation.join", { conversationId });
    const disconnected = once(recipient, "disconnect");
    block();
    await server.revokePair({ lowUserId: alice, highUserId: bob, version: 2 });
    await disconnected;

    const reconnect = connect("bob-ticket");
    await once(reconnect, "connect");
    expect(await reconnect.emitWithAck("conversation.join", { conversationId }))
      .toEqual({ ok: false, code: "NOT_AVAILABLE" });
  });
});
