// @vitest-environment node

import { createServer as createHttpServer } from "node:http";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";

import { createRealtimeServer, type ReceiptInput, type SocketIdentity } from "../../../realtime/server";
import {
  createRealtimeClient,
  type RecoveredMessage,
  RealtimeMessageStore,
} from "@/modules/messaging/realtime-client";

const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000101";
const secondConversationId = "00000000-0000-4000-8000-000000000102";

const once = <T>(socket: ClientSocket, event: string) => new Promise<T>((resolve) => {
  socket.once(event, resolve);
});
const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("real-time delivery", () => {
  const clients: ClientSocket[] = [];
  const servers: Array<ReturnType<typeof createRealtimeServer>> = [];

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    for (const server of servers) await server.stop();
  });

  const setup = async (options: {
    maxConversationRooms?: number;
    revocations?: { versionsForPairs(pairs: Array<{ lowUserId: string; highUserId: string }>): Promise<Array<{ lowUserId: string; highUserId: string; version: number }>> };
    onBackgroundError?: (code: "REVOCATION_POLL_FAILED") => void;
    receiptRecord?: (userId: string, input: ReceiptInput) => Promise<Record<string, unknown>>;
    authorizeConversation?: (identity: SocketIdentity, conversationId: string) => Promise<{ conversationId: string; lowUserId: string; highUserId: string }>;
    maxConcurrentActions?: number;
  } = {}) => {
    const httpServer = createHttpServer();
    let blocked = false;
    let authorizationCalls = 0;
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
          authorizationCalls += 1;
          if (options.authorizeConversation) return options.authorizeConversation(identity, requestedId);
          if (blocked || ![conversationId, secondConversationId].includes(requestedId) || ![alice, bob].includes(identity.userId)) {
            throw new Error("NOT_AUTHORIZED");
          }
          return { conversationId: requestedId, lowUserId: alice, highUserId: bob };
        },
      },
      receipts: {
        record: options.receiptRecord ?? (async (userId, input) => ({ ...input, userId, deliveredAt: input.at, readAt: input.kind === "read" ? input.at : null })),
      },
      maxConversationRooms: options.maxConversationRooms,
      revocations: options.revocations,
      onBackgroundError: options.onBackgroundError,
      maxConcurrentActions: options.maxConcurrentActions,
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
    return { server, connect, url: address.url, block: () => { blocked = true; }, authorizationCalls: () => authorizationCalls };
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

  it("rejects room growth before another authorization query", async () => {
    const { connect, authorizationCalls } = await setup({ maxConversationRooms: 1 });
    const socket = connect("alice-ticket");
    await once(socket, "connect");
    expect(await socket.emitWithAck("conversation.join", { conversationId })).toEqual({ ok: true });
    expect(await socket.emitWithAck("conversation.join", { conversationId: secondConversationId }))
      .toEqual({ ok: false, code: "LIMIT_REACHED" });
    expect(authorizationCalls()).toBe(1);
  });

  it("coalesces revocation polls and reports background failures without rejecting", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const errors: string[] = [];
    const { server, connect } = await setup({
      revocations: {
        versionsForPairs: async () => {
          calls += 1;
          if (calls === 1) await barrier;
          else throw new Error("database temporarily unavailable");
          return [];
        },
      },
      onBackgroundError: (code) => errors.push(code),
    });
    const socket = connect("alice-ticket");
    await once(socket, "connect");
    await socket.emitWithAck("conversation.join", { conversationId });

    const first = server.pollRevocations();
    const overlapping = server.pollRevocations();
    await overlapping;
    expect(calls).toBe(1);
    release();
    await first;
    await expect(server.pollRevocations()).resolves.toBeUndefined();
    expect(errors).toEqual(["REVOCATION_POLL_FAILED"]);
  });

  it("recovers a missed message after a real disconnect and acknowledges delivered/read receipts", async () => {
    const recorded: Array<{ userId: string; input: ReceiptInput }> = [];
    const { server, url } = await setup({
      receiptRecord: async (userId, input) => {
        recorded.push({ userId, input });
        return { userId, ...input };
      },
    });
    const recovered: RecoveredMessage[] = [{
      id: "00000000-0000-4000-8000-000000000301",
      conversationId,
      sequence: 1,
      body: "before connect",
      sender: "them",
      createdAt: "2026-08-08T12:00:00.000Z",
    }];
    let observed: RecoveredMessage[] = [];
    const states: string[] = [];
    const client = createRealtimeClient({
      url,
      fetchTicket: async () => ({ ticket: "bob-ticket", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      recover: async (_requestedId, afterSequence) => recovered.filter(({ sequence }) => sequence > afterSequence),
      onState: (state) => states.push(state),
      onMessages: (_requestedId, rows) => { observed = rows; },
      ackTimeoutMs: 500,
    });
    try {
      await client.join(conversationId);
      await client.start();
      await waitFor(() => observed.some(({ sequence }) => sequence === 1));
      await waitFor(() => recorded.some(({ input }) => input.messageId === recovered[0]!.id && input.kind === "delivered"));

      const live: RecoveredMessage = {
        id: "00000000-0000-4000-8000-000000000302",
        conversationId,
        sequence: 2,
        body: "while online",
        sender: "them",
        createdAt: "2026-08-08T12:01:00.000Z",
      };
      recovered.push(live);
      await server.publishMessage({
        eventId: "00000000-0000-4000-8000-000000000202",
        messageId: live.id,
        conversationId,
        sequence: live.sequence,
      });
      await waitFor(() => observed.some(({ sequence }) => sequence === 2));

      for (const socket of server.io.sockets.sockets.values()) socket.disconnect(true);
      const missed: RecoveredMessage = {
        id: "00000000-0000-4000-8000-000000000303",
        conversationId,
        sequence: 3,
        body: "missed during disconnect",
        sender: "them",
        createdAt: "2026-08-08T12:02:00.000Z",
      };
      recovered.push(missed);
      await waitFor(() => observed.some(({ sequence }) => sequence === 3));
      await client.markRead(missed);
      await waitFor(() => recorded.some(({ input }) => input.messageId === missed.id && input.kind === "read"));

      expect(observed.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
      expect(recorded.filter(({ input }) => input.kind === "delivered").map(({ input }) => input.messageId))
        .toEqual(expect.arrayContaining(recovered.map(({ id }) => id)));
      expect(states.filter((state) => state === "online")).toHaveLength(2);
    } finally {
      client.stop();
    }
  });

  it("retries a transient join requested after the socket is already online", async () => {
    let joinAttempts = 0;
    const states: string[] = [];
    const { url } = await setup({
      authorizeConversation: async (_identity, requestedId) => {
        joinAttempts += 1;
        if (joinAttempts === 1) throw new Error("RETRY_LATER");
        return { conversationId: requestedId, lowUserId: alice, highUserId: bob };
      },
    });
    const client = createRealtimeClient({
      url,
      fetchTicket: async () => ({ ticket: "bob-ticket", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      recover: async () => [],
      onState: (state) => states.push(state),
      onMessages: () => undefined,
      maxRetries: 2,
      ackTimeoutMs: 100,
    });
    try {
      await client.start();
      await waitFor(() => states.at(-1) === "online");
      await client.join(conversationId);
      expect(joinAttempts).toBe(2);
      expect(states).toContain("retrying");
      expect(states.at(-1)).toBe("online");
    } finally { client.stop(); }
  });

  it("hydrates HTTP history even when the real-time socket never connects", async () => {
    const history: RecoveredMessage[] = [{
      id: "00000000-0000-4000-8000-000000000401",
      conversationId,
      sequence: 1,
      body: "HTTP remains available",
      sender: "them",
      createdAt: "2026-08-08T12:00:00.000Z",
    }];
    let observed: RecoveredMessage[] = [];
    const states: string[] = [];
    const client = createRealtimeClient({
      url: "http://127.0.0.1:1",
      fetchTicket: async () => ({ ticket: "unused", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      recover: async () => history,
      onState: (state) => states.push(state),
      onMessages: (_requestedId, rows) => { observed = rows; },
      maxRetries: 0,
      ackTimeoutMs: 50,
    });
    try {
      await client.start();
      await waitFor(() => states.at(-1) === "failed");
      await client.join(conversationId);
      expect(observed).toEqual(history);
      expect(states.at(-1)).toBe("failed");
    } finally { client.stop(); }
  });

  it("queues delivered receipts for every newly hydrated message beyond 100", async () => {
    const delivered = new Set<string>();
    const { url } = await setup({
      receiptRecord: async (_userId, input) => {
        if (input.kind === "delivered") delivered.add(input.messageId);
        return {};
      },
    });
    const history = Array.from({ length: 101 }, (_, index): RecoveredMessage => ({
      id: `00000000-0000-4000-8000-${String(index + 500).padStart(12, "0")}`,
      conversationId,
      sequence: index + 1,
      body: String(index + 1),
      sender: "them",
      createdAt: "2026-08-08T12:00:00.000Z",
    }));
    const client = createRealtimeClient({
      url,
      fetchTicket: async () => ({ ticket: "bob-ticket", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      recover: async (_requestedId, afterSequence) => history.filter(({ sequence }) => sequence > afterSequence),
      onState: () => undefined,
      onMessages: () => undefined,
      ackTimeoutMs: 500,
    });
    try {
      await client.join(conversationId);
      await client.start();
      await waitFor(() => delivered.size >= 100);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(delivered.size).toBe(101);
    } finally { client.stop(); }
  });

  it("waits for join authorization before queueing 101 hydrated receipts", async () => {
    let releaseAuthorization!: () => void;
    let authorizationStarted!: () => void;
    const started = new Promise<void>((resolve) => { authorizationStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    const delivered = new Set<string>();
    const { server, url } = await setup({
      authorizeConversation: async (_identity, requestedId) => {
        authorizationStarted();
        await gate;
        return { conversationId: requestedId, lowUserId: alice, highUserId: bob };
      },
      receiptRecord: async (_userId, input) => {
        delivered.add(input.messageId);
        return {};
      },
    });
    let receiptAttempts = 0;
    server.io.on("connection", (socket) => socket.on("receipt.update", () => { receiptAttempts += 1; }));
    const history = Array.from({ length: 101 }, (_, index): RecoveredMessage => ({
      id: `00000000-0000-4000-8000-${String(index + 700).padStart(12, "0")}`,
      conversationId,
      sequence: index + 1,
      body: String(index + 1),
      sender: "them",
      createdAt: "2026-08-08T12:00:00.000Z",
    }));
    const states: string[] = [];
    const client = createRealtimeClient({
      url,
      fetchTicket: async () => ({ ticket: "bob-ticket", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      recover: async (_requestedId, afterSequence) => history.filter(({ sequence }) => sequence > afterSequence),
      onState: (state) => states.push(state),
      onMessages: () => undefined,
      ackTimeoutMs: 1_000,
    });
    try {
      await client.start();
      await waitFor(() => states.at(-1) === "online");
      const joining = client.join(conversationId);
      await started;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const attemptsBeforeAck = receiptAttempts;
      releaseAuthorization();
      await joining;
      await waitFor(() => delivered.size === 101);
      expect(attemptsBeforeAck).toBe(0);
      expect(receiptAttempts).toBe(101);
    } finally {
      releaseAuthorization();
      client.stop();
    }
  });

  it("retries HTTP recovery errors inside the join budget before returning online", async () => {
    const { url } = await setup();
    let recoveryAttempts = 0;
    const states: string[] = [];
    const client = createRealtimeClient({
      url,
      fetchTicket: async () => ({ ticket: "bob-ticket", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      recover: async () => {
        recoveryAttempts += 1;
        if (recoveryAttempts === 1) throw new Error("network disconnected");
        return [];
      },
      onState: (state) => states.push(state),
      onMessages: () => undefined,
      maxRetries: 2,
      ackTimeoutMs: 500,
    });
    try {
      await client.start();
      await waitFor(() => states.at(-1) === "online");
      await client.join(conversationId);
      expect(recoveryAttempts).toBe(2);
      expect(states).toContain("retrying");
      expect(states.at(-1)).toBe("online");
    } finally { client.stop(); }
  });

  it("classifies unknown join and receipt failures as retryable without leaking details", async () => {
    const joinFailure = await setup({
      authorizeConversation: async () => { throw new Error("database password secret"); },
    });
    const joinSocket = joinFailure.connect("alice-ticket");
    await once(joinSocket, "connect");
    expect(await joinSocket.emitWithAck("conversation.join", { conversationId })).toMatchObject({
      ok: false,
      code: "RETRY_LATER",
    });

    const receiptFailure = await setup({
      receiptRecord: async () => { throw new Error("database password secret"); },
    });
    const receiptSocket = receiptFailure.connect("bob-ticket");
    await once(receiptSocket, "connect");
    await receiptSocket.emitWithAck("conversation.join", { conversationId });
    const receiptAck = await receiptSocket.emitWithAck("receipt.update", {
      conversationId,
      messageId: "00000000-0000-4000-8000-000000000999",
      kind: "delivered",
      at: "2026-08-08T12:00:00.000Z",
    });
    expect(receiptAck).toMatchObject({ ok: false, code: "RETRY_LATER" });
    expect(JSON.stringify(receiptAck)).not.toContain("password");
  });

  it("uses a short retry for concurrency saturation and cancels join backoff on stop", async () => {
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const authorizationStarted = new Promise<void>((resolve) => { started = resolve; });
    const { connect } = await setup({
      maxConcurrentActions: 1,
      authorizeConversation: async (_identity, requestedId) => {
        started();
        await barrier;
        return { conversationId: requestedId, lowUserId: alice, highUserId: bob };
      },
    });
    const socket = connect("alice-ticket");
    await once(socket, "connect");
    const first = socket.emitWithAck("conversation.join", { conversationId });
    try {
      await authorizationStarted;
      const saturated = await socket.emitWithAck("conversation.join", { conversationId: secondConversationId }) as { retryAfterMs?: number };
      expect(saturated).toMatchObject({ ok: false, code: "RETRY_LATER" });
      expect(saturated.retryAfterMs).toBeGreaterThanOrEqual(100);
      expect(saturated.retryAfterMs).toBeLessThanOrEqual(500);
    } finally {
      release();
      await first.catch(() => undefined);
    }

    const retryServer = await setup({
      authorizeConversation: async () => { throw new Error("RETRY_LATER"); },
    });
    const states: string[] = [];
    const managed = createRealtimeClient({
      url: retryServer.url,
      fetchTicket: async () => ({ ticket: "bob-ticket", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      recover: async () => [],
      onState: (state) => states.push(state),
      onMessages: () => undefined,
      maxRetries: 5,
    });
    let settled = false;
    try {
      await managed.start();
      await waitFor(() => states.at(-1) === "online");
      void managed.join(conversationId).then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => states.at(-1) === "retrying");
      managed.stop();
      await waitFor(() => settled, 100);
    } finally {
      release();
      managed.stop();
    }
  });
});
