import "server-only";

import { db } from "@/infrastructure/db/client";
import { runAuthNotificationDeliveryWorker } from "@/modules/auth/auth";
import { HttpMessageSender } from "@/modules/auth/message-sender";
import { readEnv } from "@/shared/env";

import { NotificationDispatcher, type NotificationChannel } from "./notification-router";
import { DrizzleInAppNotificationProvider, DrizzleNotificationStore } from "./notification-store";

const env = readEnv(process.env);
const primarySender = new HttpMessageSender({
  email: env.EMAIL_WEBHOOK_URL && env.EMAIL_WEBHOOK_TOKEN
    ? { endpoint: env.EMAIL_WEBHOOK_URL, token: env.EMAIL_WEBHOOK_TOKEN } : undefined,
  sms: env.SMS_WEBHOOK_URL && env.SMS_WEBHOOK_TOKEN
    ? { endpoint: env.SMS_WEBHOOK_URL, token: env.SMS_WEBHOOK_TOKEN } : undefined,
});
const fallbackSender = new HttpMessageSender({
  email: env.EMAIL_FALLBACK_WEBHOOK_URL && env.EMAIL_FALLBACK_WEBHOOK_TOKEN
    ? { endpoint: env.EMAIL_FALLBACK_WEBHOOK_URL, token: env.EMAIL_FALLBACK_WEBHOOK_TOKEN } : undefined,
  sms: env.SMS_FALLBACK_WEBHOOK_URL && env.SMS_FALLBACK_WEBHOOK_TOKEN
    ? { endpoint: env.SMS_FALLBACK_WEBHOOK_URL, token: env.SMS_FALLBACK_WEBHOOK_TOKEN } : undefined,
});
type Job = { id: string; templateKey?: unknown; locale?: unknown;
  recipient?: unknown; payload?: unknown; [key: string]: unknown };
const externalProvider = (channel: "email" | "sms", sender: HttpMessageSender) => ({ channel: channel as NotificationChannel,
  deliver: async (job: Job, context: { idempotencyKey: string }) => {
    const recipient = job.recipient as { email?: string | null; sms?: string | null } | undefined;
    const to = recipient?.[channel];
    if (!to || typeof job.templateKey !== "string" || (job.locale !== "en" && job.locale !== "zh-CN")) {
      return { delivered: false };
    }
    const variables = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
      ? Object.fromEntries(Object.entries(job.payload).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string")) : {};
    await sender.sendTemplateNotification(channel, { to, templateKey: job.templateKey, locale: job.locale, variables },
      { deliveryKey: context.idempotencyKey });
    return { delivered: true };
  } });

export async function runConfiguredNotificationWorkers() {
  const authProcessed = await runAuthNotificationDeliveryWorker();
  const dispatcher = new NotificationDispatcher({
    store: new DrizzleNotificationStore(db, { hmacKey: env.BETTER_AUTH_SECRET }),
    providers: [externalProvider("email", primarySender), externalProvider("email", fallbackSender),
      externalProvider("sms", primarySender), externalProvider("sms", fallbackSender),
      { channel: "inApp", deliver: (job, context) => new DrizzleInAppNotificationProvider(db).deliver(job, context) }],
  });
  let notificationsProcessed = 0;
  for (let index = 0; index < 50 && await dispatcher.runOne(); index += 1) notificationsProcessed += 1;
  return { authProcessed, notificationsProcessed };
}
