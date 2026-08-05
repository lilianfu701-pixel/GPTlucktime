import "server-only";

import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { createClient } from "redis";

import * as schema from "@/db/schema";
import { db } from "@/infrastructure/db/client";
import { readEnv } from "@/shared/env";

import { createAuthConfiguration } from "./auth-config";
import {
  EncryptionKeyRing,
  StableHmac,
  parseEncryptionKeyRing,
  parseLegacyEncryptionKeys,
} from "./auth-crypto";
import {
  HttpMessageSender,
  NOTIFICATION_OUTBOX_UNAVAILABLE,
  type MessageDispatcher,
} from "./message-sender";
import { DurableNotificationDispatcher, drainNotificationOutbox } from "./notification-outbox";
import { RedisSmsAbuseStore, SmsAbuseGuard } from "./sms-abuse-guard";

const env = readEnv(process.env);
const sender = new HttpMessageSender({
  email: env.EMAIL_WEBHOOK_URL && env.EMAIL_WEBHOOK_TOKEN
    ? { endpoint: env.EMAIL_WEBHOOK_URL, token: env.EMAIL_WEBHOOK_TOKEN }
    : undefined,
  sms: env.SMS_WEBHOOK_URL && env.SMS_WEBHOOK_TOKEN
    ? { endpoint: env.SMS_WEBHOOK_URL, token: env.SMS_WEBHOOK_TOKEN }
    : undefined,
});
const dispatcher: MessageDispatcher = env.AUTH_ENCRYPTION_KEYS && env.AUTH_DELIVERY_HMAC_KEY
  ? new DurableNotificationDispatcher(
      db,
      new EncryptionKeyRing(parseEncryptionKeyRing(env.AUTH_ENCRYPTION_KEYS), {
        legacyKeys: env.AUTH_LEGACY_ENCRYPTION_KEY
          ? parseLegacyEncryptionKeys(env.AUTH_LEGACY_ENCRYPTION_KEY)
          : undefined,
      }),
      new StableHmac(env.AUTH_DELIVERY_HMAC_KEY),
    )
  : {
      async assertHealthy() { throw new Error(NOTIFICATION_OUTBOX_UNAVAILABLE); },
      async enqueueEmailVerification() { throw new Error(NOTIFICATION_OUTBOX_UNAVAILABLE); },
      async enqueuePasswordReset() { throw new Error(NOTIFICATION_OUTBOX_UNAVAILABLE); },
      async enqueueSmsOtp() { throw new Error(NOTIFICATION_OUTBOX_UNAVAILABLE); },
    };
const smsAbuseGuard = env.SMS_ABUSE_HMAC_KEY && env.SMS_ALLOWED_CALLING_CODES
  ? new SmsAbuseGuard(
      new RedisSmsAbuseStore(createClient({ url: env.REDIS_URL })),
      {
        hmacKey: env.SMS_ABUSE_HMAC_KEY,
        allowedCallingCodes: env.SMS_ALLOWED_CALLING_CODES.split(","),
        highRiskCallingCodes: env.SMS_HIGH_RISK_CALLING_CODES?.split(","),
        deniedPrefixes: env.SMS_DENIED_PREFIXES?.split(","),
      },
    )
  : undefined;

export const auth = betterAuth(createAuthConfiguration({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    usePlural: true,
    transaction: true,
  }),
  sender,
  dispatcher,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.APP_URL,
  secureCookies: env.NODE_ENV === "production",
  smsAbuseGuard,
  trustedProxyToken: env.AUTH_TRUSTED_PROXY_TOKEN,
}));

export const runAuthNotificationDeliveryWorker = () =>
  dispatcher instanceof DurableNotificationDispatcher
    ? drainNotificationOutbox({ outbox: dispatcher, sender })
    : Promise.resolve(0);
