import type { Server as HttpServer } from "node:http";

import { Server, type Socket } from "socket.io";
import { z } from "zod";

export type SocketIdentity = { userId: string; sessionId: string; issuedAt: Date; expiresAt: Date };
export type AuthorizedConversation = {
  conversationId: string;
  lowUserId: string;
  highUserId: string;
  revocationVersion?: number;
};
export interface RealtimeAuthorization {
  authenticate(ticket: string): Promise<SocketIdentity>;
  authorizeConversation(identity: SocketIdentity, conversationId: string): Promise<AuthorizedConversation>;
}
export interface RealtimeReceiptService {
  record(userId: string, input: ReceiptInput): Promise<Record<string, unknown>>;
}
export interface RealtimeRevocationSource {
  versionsForPairs(pairs: Array<{ lowUserId: string; highUserId: string }>): Promise<Array<{
    lowUserId: string; highUserId: string; version: number;
  }>>;
}

const uuid = z.string().uuid();
const handshake = z.object({ ticket: z.string().min(1).max(4096) }).strict();
const joinInput = z.object({ conversationId: uuid }).strict();
const receiptInput = z.object({
  conversationId: uuid,
  messageId: uuid,
  kind: z.enum(["delivered", "read"]),
  at: z.string().datetime({ offset: true }),
}).strict();
const messageEvent = z.object({
  eventId: uuid,
  messageId: uuid,
  conversationId: uuid,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type ReceiptInput = z.infer<typeof receiptInput>;
export type RealtimeMessageEvent = z.infer<typeof messageEvent>;
export type RealtimeBackgroundErrorCode = "REVOCATION_POLL_FAILED" | "OUTBOX_CONSUME_FAILED";

export const createRealtimeBackgroundReporter = (
  write: (code: RealtimeBackgroundErrorCode) => void = (code) => { process.stderr.write(`${code}\n`); },
) => (code: RealtimeBackgroundErrorCode) => write(code);

type SocketData = {
  identity: SocketIdentity;
  conversations: Map<string, AuthorizedConversation>;
};

const pairKey = (lowUserId: string, highUserId: string) => `${lowUserId}:${highUserId}`;

export function createRealtimeServer(options: {
  httpServer: HttpServer;
  authorization: RealtimeAuthorization;
  receipts: RealtimeReceiptService;
  revocations?: RealtimeRevocationSource;
  revocationPollMs?: number;
  allowedOrigins?: readonly string[];
  maxConversationRooms?: number;
  maxConcurrentActions?: number;
  onBackgroundError?: (code: "REVOCATION_POLL_FAILED") => void;
}) {
  const io = new Server<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>(options.httpServer, {
    serveClient: false,
    maxHttpBufferSize: 8_192,
    transports: ["websocket"],
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, !origin || !options.allowedOrigins || options.allowedOrigins.includes(origin));
    },
  });
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pollInFlight = false;
  const maxRooms = Math.min(Math.max(options.maxConversationRooms ?? 100, 1), 500);
  const maxConcurrent = Math.min(Math.max(options.maxConcurrentActions ?? 4, 1), 20);

  io.use(async (socket, next) => {
    const parsed = handshake.safeParse(socket.handshake.auth);
    if (!parsed.success) return next(new Error("NOT_AUTHORIZED"));
    try {
      socket.data.identity = await options.authorization.authenticate(parsed.data.ticket);
      socket.data.conversations = new Map();
      return next();
    } catch {
      return next(new Error("NOT_AUTHORIZED"));
    }
  });

  io.on("connection", (socket: Socket<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>) => {
    void socket.join(`user:${socket.data.identity.userId}`);
    const disconnectAtExpiry = setTimeout(
      () => socket.disconnect(true),
      Math.max(socket.data.identity.expiresAt.getTime() - Date.now(), 0),
    );
    disconnectAtExpiry.unref?.();
    socket.once("disconnect", () => clearTimeout(disconnectAtExpiry));
    let concurrentActions = 0;
    let rateWindowStartedAt = Date.now();
    let joinCount = 0;
    let receiptCount = 0;
    const admit = (kind: "join" | "receipt") => {
      const now = Date.now();
      if (now - rateWindowStartedAt >= 60_000) {
        rateWindowStartedAt = now;
        joinCount = 0;
        receiptCount = 0;
      }
      if (concurrentActions >= maxConcurrent) return { admitted: false, retryAfterMs: 250 };
      if (kind === "join" && ++joinCount > 60) {
        return { admitted: false, retryAfterMs: Math.max(60_000 - (now - rateWindowStartedAt), 250) };
      }
      if (kind === "receipt" && ++receiptCount > 120) {
        return { admitted: false, retryAfterMs: Math.max(60_000 - (now - rateWindowStartedAt), 250) };
      }
      concurrentActions += 1;
      return { admitted: true, retryAfterMs: 0 };
    };
    const release = () => { concurrentActions = Math.max(concurrentActions - 1, 0); };
    socket.on("conversation.join", async (raw, acknowledge?: (result: unknown) => void) => {
      const parsed = joinInput.safeParse(raw);
      if (!parsed.success) return acknowledge?.({ ok: false, code: "NOT_AVAILABLE" });
      if (!socket.data.conversations.has(parsed.data.conversationId)
        && socket.data.conversations.size >= maxRooms) {
        return acknowledge?.({ ok: false, code: "LIMIT_REACHED" });
      }
      const admission = admit("join");
      if (!admission.admitted) return acknowledge?.({
        ok: false,
        code: "RETRY_LATER",
        retryAfterMs: admission.retryAfterMs,
      });
      try {
        const authorized = await options.authorization.authorizeConversation(socket.data.identity, parsed.data.conversationId);
        socket.data.conversations.set(authorized.conversationId, authorized);
        await socket.join(`conversation:${authorized.conversationId}`);
        return acknowledge?.({ ok: true });
      } catch (error) {
        if (error instanceof Error && error.message === "RETRY_LATER") {
          return acknowledge?.({ ok: false, code: "RETRY_LATER", retryAfterMs: 250 });
        }
        if (error instanceof Error && ["NOT_AUTHORIZED", "NOT_AVAILABLE"].includes(error.message)) {
          return acknowledge?.({ ok: false, code: "NOT_AVAILABLE" });
        }
        return acknowledge?.({ ok: false, code: "RETRY_LATER", retryAfterMs: 500 });
      } finally { release(); }
    });
    socket.on("receipt.update", async (raw, acknowledge?: (result: unknown) => void) => {
      const parsed = receiptInput.safeParse(raw);
      if (!parsed.success || !socket.data.conversations.has(parsed.data.conversationId)) {
        return acknowledge?.({ ok: false, code: "NOT_AVAILABLE" });
      }
      const admission = admit("receipt");
      if (!admission.admitted) return acknowledge?.({
        ok: false,
        code: "RETRY_LATER",
        retryAfterMs: admission.retryAfterMs,
      });
      try {
        const result = await options.receipts.record(socket.data.identity.userId, parsed.data);
        return acknowledge?.({ ok: true, receipt: result });
      } catch (error) {
        if (error instanceof Error && ["RECEIPT_NOT_AVAILABLE", "NOT_AUTHORIZED", "NOT_AVAILABLE"].includes(error.message)) {
          return acknowledge?.({ ok: false, code: "NOT_AVAILABLE" });
        }
        return acknowledge?.({ ok: false, code: "RETRY_LATER", retryAfterMs: 500 });
      } finally { release(); }
    });
  });

  const revokePair = async (revocation: { lowUserId: string; highUserId: string; version: number }) => {
    const key = pairKey(revocation.lowUserId, revocation.highUserId);
    for (const socket of io.sockets.sockets.values()) {
      const affected = [...socket.data.conversations.values()].some((conversation) =>
        pairKey(conversation.lowUserId, conversation.highUserId) === key
        && revocation.version > (conversation.revocationVersion ?? 0));
      if (affected) socket.disconnect(true);
    }
  };

  const pollRevocations = async () => {
    if (!options.revocations || pollInFlight) return;
    pollInFlight = true;
    try {
      const byPair = new Map<string, { lowUserId: string; highUserId: string }>();
      for (const socket of io.sockets.sockets.values()) {
        for (const conversation of socket.data.conversations.values()) {
          byPair.set(pairKey(conversation.lowUserId, conversation.highUserId), conversation);
        }
      }
      const pairs = [...byPair.values()];
      for (let index = 0; index < pairs.length; index += 100) {
        for (const revocation of await options.revocations.versionsForPairs(pairs.slice(index, index + 100))) {
          await revokePair(revocation);
        }
      }
    } catch { options.onBackgroundError?.("REVOCATION_POLL_FAILED"); } finally { pollInFlight = false; }
  };

  return {
    io,
    async start(input: { host: "127.0.0.1" | "0.0.0.0"; port: number }) {
      await new Promise<void>((resolve, reject) => {
        options.httpServer.once("error", reject);
        options.httpServer.listen(input.port, input.host, () => resolve());
      });
      if (options.revocations) {
        pollTimer = setInterval(() => { void pollRevocations(); }, options.revocationPollMs ?? 1_000);
        pollTimer.unref?.();
      }
      const address = options.httpServer.address();
      if (!address || typeof address === "string") throw new Error("REALTIME_LISTEN_FAILED");
      const clientHost = input.host === "0.0.0.0" ? "127.0.0.1" : input.host;
      return { url: `http://${clientHost}:${address.port}`, port: address.port };
    },
    async stop() {
      if (pollTimer) clearInterval(pollTimer);
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
    async publishMessage(raw: RealtimeMessageEvent) {
      const event = messageEvent.parse(raw);
      io.to(`conversation:${event.conversationId}`).emit("message.created" as never, event as never);
    },
    revokePair,
    pollRevocations,
  };
}

export async function startRealtimeProcess(input: Partial<NodeJS.ProcessEnv> = process.env) {
  const { readEnv } = await import("@/shared/env");
  const env = readEnv(input);
  const [{ createServer }, { db }, { SocialRepository }, receiptModule, authModule, outboxModule] = await Promise.all([
    import("node:http"),
    import("@/infrastructure/db/client"),
    import("@/modules/social/social-repository"),
    import("@/modules/messaging/message-receipt-repository"),
    import("./authenticate-socket"),
    import("./outbox-consumer"),
  ]);
  if (!env.REALTIME_TICKET_KEYS) throw new Error("REALTIME_NOT_CONFIGURED");
  const { parseSocketTicketKeyRing } = await import("@/modules/messaging/socket-ticket");
  const httpServer = createServer();
  const social = new SocialRepository(db, {
    cursorSecret: env.BETTER_AUTH_SECRET,
    idempotencySecret: env.BETTER_AUTH_SECRET,
  });
  const receiptRepository = new receiptModule.MessageReceiptRepository(db, { interactionPolicy: social });
  const reportBackgroundError = createRealtimeBackgroundReporter();
  const { entitlementService } = await import("@/modules/entitlements/runtime");
  const { MessageReceiptService } = await import("@/modules/messaging/message-receipt-service");
  const server = createRealtimeServer({
    httpServer,
    authorization: new authModule.DrizzleRealtimeAuthorization(db, parseSocketTicketKeyRing(env.REALTIME_TICKET_KEYS)),
    receipts: new MessageReceiptService(receiptRepository, entitlementService),
    revocations: new authModule.DrizzleRealtimeRevocationSource(db),
    revocationPollMs: env.REALTIME_POLL_MS ?? 1_000,
    allowedOrigins: [new URL(env.APP_URL).origin],
    onBackgroundError: reportBackgroundError,
  });
  const store = new outboxModule.DrizzleMessageOutboxStore(db);
  const publish = outboxModule.createAuthorizedRealtimePublisher(db, social, server.publishMessage);
  const consumer = new outboxModule.MessageOutboxConsumer(store, publish);
  let running = false;
  const consume = async () => {
    if (running) return;
    running = true;
    try { await consumer.runOnce(); } catch { reportBackgroundError("OUTBOX_CONSUME_FAILED"); } finally { running = false; }
  };
  const address = await server.start({
    host: env.REALTIME_HOST ?? "127.0.0.1",
    port: env.REALTIME_PORT ?? 3100,
  });
  const timer = setInterval(() => { void consume(); }, env.REALTIME_POLL_MS ?? 1_000);
  timer.unref?.();
  void consume();
  return {
    ...address,
    async stop() {
      clearInterval(timer);
      await server.stop();
    },
  };
}
