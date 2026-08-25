import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { RedisTokenBucketRateLimiter } from "@/infrastructure/security/rate-limit";
import {
  canonicalizeFreeTestEmail,
  createFreeTestRedisClient,
  FreeTestNotificationAdapter,
  type FreeTestMailboxItem,
} from "@/modules/auth/free-test-notification-adapter";
import { resolveTrustedClientBucket } from "@/modules/auth/trusted-ingress";
import { BoundedJsonError, readBoundedJson } from "@/shared/http/read-bounded-json";
import { readEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  email: z.string().max(254),
  accessCode: z.string().max(256),
}).strict();
const headers = { "cache-control": "no-store" };
const failure = (code: string, status: number) => Response.json({ error: { code } }, { status, headers });

type Mailbox = { consumeLatest(recipient: string): Promise<FreeTestMailboxItem | null> };
type Limiter = Pick<RedisTokenBucketRateLimiter, "consume">;

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export function createFreeTestMailboxHandler(input: {
  enabled: boolean;
  accessSecret: string | undefined;
  appUrl: string;
  trustedProxyToken: string | undefined;
  mailbox: Mailbox;
  limiter: Limiter;
}) {
  const appOrigin = new URL(input.appUrl).origin;
  return async function POST(request: Request): Promise<Response> {
    if (!input.enabled || !input.accessSecret) return failure("NOT_FOUND", 404);
    if (request.headers.get("origin") !== appOrigin) return failure("FORBIDDEN", 403);
    let body: unknown;
    try { body = await readBoundedJson(request, 4_096); } catch (error) {
      return failure(error instanceof BoundedJsonError && error.code === "PAYLOAD_TOO_LARGE"
        ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST", error instanceof BoundedJsonError
          && error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400);
    }
    const parsed = requestSchema.safeParse(body);
    const email = parsed.success ? canonicalizeFreeTestEmail(parsed.data.email) : null;
    if (!parsed.success || !email) return failure("INVALID_REQUEST", 400);
    const clientBucket = resolveTrustedClientBucket(request, input.trustedProxyToken);
    const decision = await input.limiter.consume({ bucket: "verification",
      identifier: `${clientBucket}\u0000${email}` });
    if (!decision.allowed) return failure("TOO_MANY_REQUESTS", 429);
    if (!constantTimeEqual(parsed.data.accessCode, input.accessSecret)) return failure("NOT_FOUND", 404);
    try {
      const item = await input.mailbox.consumeLatest(email);
      return item ? Response.json(item, { headers }) : failure("NOT_FOUND", 404);
    } catch { return failure("SERVICE_UNAVAILABLE", 503); }
  };
}

const env = readEnv(process.env);
const enabled = env.FREE_TEST_MODE === "1" && Boolean(env.FREE_TEST_ACCESS_SECRET);
const redis = createFreeTestRedisClient(env.REDIS_URL);
const accessSecret = env.FREE_TEST_ACCESS_SECRET;
const mailbox: Mailbox = enabled && accessSecret
  ? new FreeTestNotificationAdapter({ redis, accessSecret, appUrl: env.APP_URL })
  : { async consumeLatest() { return null; } };
const rateKey = createHmac("sha256", accessSecret ?? env.BETTER_AUTH_SECRET)
  .update("datecn/free-test/rate-limit/v1")
  .digest("base64url");
const limiter = new RedisTokenBucketRateLimiter(redis, { hmacKey: rateKey });

export const POST = createFreeTestMailboxHandler({ enabled, accessSecret, appUrl: env.APP_URL,
  trustedProxyToken: env.AUTH_TRUSTED_PROXY_TOKEN, mailbox, limiter });
