import { createClient } from "redis";

import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { createNotificationPreferencesHandler, NotificationPreferencesRepository } from "@/modules/notifications/notification-preferences";
import { RedisPrivacyRateLimiter } from "@/modules/profiles/privacy-rate-limiter";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
const limiter = new RedisPrivacyRateLimiter(createClient({ url: env.REDIS_URL }), { hmacKey: env.BETTER_AUTH_SECRET,
  limit: 30, windowMs: 60 * 60_000 });
const handler = createNotificationPreferencesHandler({ getSession: (headers) => auth.api.getSession({ headers }),
  repository: new NotificationPreferencesRepository(db), limiter });

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
