import "server-only";

import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { createClient } from "redis";

import * as schema from "@/db/schema";
import { db } from "@/infrastructure/db/client";
import { readEnv } from "@/shared/env";

import { createAuthConfiguration } from "./auth-config";
import { createFreeTestRedisClient, FreeTestNotificationAdapter } from "./free-test-notification-adapter";
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
import { InMemorySmsAbuseStore, RedisSmsAbuseStore, SmsAbuseGuard } from "./sms-abuse-guard";
import { E2eNotificationAdapter } from "@/modules/e2e/notification-adapter";
import { requireE2eRuntime } from "@/modules/e2e/e2e-guard";

const env = readEnv(process.env);
const e2e = process.env.E2E_MODE === "1" ? requireE2eRuntime(process.env) : null;
const e2eAdapter = e2e ? new E2eNotificationAdapter() : null;
const freeTestAdapter = env.FREE_TEST_MODE === "1" && env.FREE_TEST_ACCESS_SECRET
  ? new FreeTestNotificationAdapter({ redis: createFreeTestRedisClient(env.REDIS_URL),
      accessSecret: env.FREE_TEST_ACCESS_SECRET, appUrl: env.APP_URL })
  : null;
const sender = e2eAdapter ?? freeTestAdapter ?? new HttpMessageSender({
  email: env.EMAIL_WEBHOOK_URL && env.EMAIL_WEBHOOK_TOKEN
    ? { endpoint: env.EMAIL_WEBHOOK_URL, token: env.EMAIL_WEBHOOK_TOKEN }
    : undefined,
  sms: env.SMS_WEBHOOK_URL && env.SMS_WEBHOOK_TOKEN
    ? { endpoint: env.SMS_WEBHOOK_URL, token: env.SMS_WEBHOOK_TOKEN }
    : undefined,
});
const dispatcher: MessageDispatcher = e2eAdapter ?? freeTestAdapter ?? (env.AUTH_ENCRYPTION_KEYS && env.AUTH_DELIVERY_HMAC_KEY
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
    });
const smsAbuseGuard = e2e
  ? new SmsAbuseGuard(new InMemorySmsAbuseStore(), {
      hmacKey: env.BETTER_AUTH_SECRET,
      allowedCallingCodes: ["1", "86"],
      cooldownMs: 0,
    })
  : env.SMS_ABUSE_HMAC_KEY && env.SMS_ALLOWED_CALLING_CODES
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
  secureCookies: env.NODE_ENV === "production" || env.FREE_TEST_MODE === "1",
  smsAbuseGuard,
  trustedProxyToken: env.AUTH_TRUSTED_PROXY_TOKEN,
  freeTestMode: env.FREE_TEST_MODE === "1",
}));

export const runAuthNotificationDeliveryWorker = () =>
  dispatcher instanceof DurableNotificationDispatcher
    ? drainNotificationOutbox({ outbox: dispatcher, sender })
    : Promise.resolve(0);

export const enqueueSecurePrivacyCredential = async (transaction: unknown,
  input: { kind: "deletion_cancellation" | "privacy_export_download"; recipient: string;
    locale: "en" | "zh-CN"; actionUrl: string; validUntil: Date }) => {
  if (!(dispatcher instanceof DurableNotificationDispatcher)) throw new Error(NOTIFICATION_OUTBOX_UNAVAILABLE);
  await dispatcher.enqueuePrivacyCredential(
    transaction as Parameters<Parameters<typeof db.transaction>[0]>[0], input);
};
