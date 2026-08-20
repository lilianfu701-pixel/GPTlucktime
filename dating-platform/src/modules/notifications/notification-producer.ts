import { eq } from "drizzle-orm";

import { notificationOutbox, notificationPreferences, profilePreferences, profiles } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type NotificationTransaction = typeof productionDatabase;

export async function enqueueProductionNotification(transaction: unknown, input: { userId: string; dedupeKey: string;
  category: "security" | "transactional" | "marketing"; templateKey: string; payload?: Record<string, string>;
  preferredChannels?: Array<"email" | "sms" | "inApp">; availableAt: Date }) {
  const tx = transaction as NotificationTransaction;
  const [preference] = await tx.select().from(notificationPreferences)
    .where(eq(notificationPreferences.userId, input.userId)).limit(1);
  const [profile] = preference ? [] : await tx.select({ timeZone: profiles.timeZone,
    languageCodes: profilePreferences.languageCodes }).from(profiles)
    .leftJoin(profilePreferences, eq(profilePreferences.userId, profiles.userId))
    .where(eq(profiles.userId, input.userId)).limit(1);
  const locale = preference?.locale === "zh-CN"
    || profile?.languageCodes?.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
  const consentedChannels = preference ? [preference.emailEnabled && "email", preference.smsEnabled && "sms",
    preference.inAppEnabled && "inApp"].filter((channel): channel is string => Boolean(channel)) : ["email", "inApp"];
  const channels = input.preferredChannels?.filter((channel) => consentedChannels.includes(channel)) ?? consentedChannels;
  await tx.insert(notificationOutbox).values({ userId: input.userId, dedupeKey: input.dedupeKey,
    category: input.category, templateKey: input.templateKey, locale, channels, payload: input.payload ?? {},
    availableAt: input.availableAt }).onConflictDoNothing({ target: [notificationOutbox.userId,
    notificationOutbox.dedupeKey] });
}
