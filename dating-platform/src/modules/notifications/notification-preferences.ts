import { eq } from "drizzle-orm";
import { z } from "zod";

import { notificationPreferences, profilePreferences, profiles } from "@/db/schema";
import type { db as productionDatabase } from "@/infrastructure/db/client";

type NotificationDatabase = typeof productionDatabase;
type Session = { user: { id: string } };

export const notificationPreferencesSchema = z.object({
  locale: z.enum(["en", "zh-CN"]),
  timeZone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }),
  marketingEnabled: z.boolean(), emailEnabled: z.boolean(), smsEnabled: z.boolean(), inAppEnabled: z.boolean(),
  quietStartHour: z.number().int().min(0).max(23).nullable(),
  quietEndHour: z.number().int().min(0).max(23).nullable(),
}).strict().refine((value) => (value.quietStartHour === null) === (value.quietEndHour === null)
  && (value.quietStartHour === null || value.quietStartHour !== value.quietEndHour));

type Preferences = z.infer<typeof notificationPreferencesSchema>;
const publicPreferences = (row: typeof notificationPreferences.$inferSelect): Preferences => ({
  locale: row.locale === "zh-CN" ? "zh-CN" : "en",
  timeZone: row.timeZone,
  marketingEnabled: row.marketingEnabled,
  emailEnabled: row.emailEnabled,
  smsEnabled: row.smsEnabled,
  inAppEnabled: row.inAppEnabled,
  quietStartHour: row.quietStartHour,
  quietEndHour: row.quietEndHour,
});

export class NotificationPreferencesRepository {
  private readonly database: NotificationDatabase;
  constructor(database: unknown) { this.database = database as NotificationDatabase; }

  async get(userId: string): Promise<Preferences> {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as NotificationDatabase;
      const [existing] = await tx.select().from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId)).limit(1);
      if (existing) return publicPreferences(existing);
      const [profile] = await tx.select({ timeZone: profiles.timeZone, languageCodes: profilePreferences.languageCodes })
        .from(profiles).leftJoin(profilePreferences, eq(profilePreferences.userId, profiles.userId))
        .where(eq(profiles.userId, userId)).limit(1);
      const locale = profile?.languageCodes?.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
      const [created] = await tx.insert(notificationPreferences).values({ userId, locale,
        timeZone: profile?.timeZone ?? "UTC" }).onConflictDoNothing().returning();
      const row = created ?? (await tx.select().from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId)).limit(1))[0];
      if (!row) throw new Error("PREFERENCES_UNAVAILABLE");
      return publicPreferences(row);
    });
  }

  async update(userId: string, input: Preferences): Promise<Preferences> {
    const [row] = await this.database.insert(notificationPreferences).values({ userId, ...input })
      .onConflictDoUpdate({ target: notificationPreferences.userId, set: input }).returning();
    if (!row) throw new Error("PREFERENCES_UNAVAILABLE");
    return publicPreferences(row);
  }
}

const error = (code: string, status: number, traceId: string, retryable = false) => Response.json({ error: { code,
  messageKey: `errors.${code === "UNAUTHORIZED" ? "unauthorized" : code === "METHOD_NOT_ALLOWED" ? "methodNotAllowed"
    : code === "PAYLOAD_TOO_LARGE" ? "payloadTooLarge" : code === "URI_TOO_LONG" ? "uriTooLong"
      : code === "RATE_LIMITED" ? "rateLimited" : code === "SERVICE_UNAVAILABLE" ? "serviceUnavailable"
        : code === "INTERNAL_ERROR" ? "internal" : "invalidRequest"}`,
  retryable, traceId } }, { status });

export function createNotificationPreferencesHandler(input: {
  getSession(headers: Headers): Promise<Session | null>;
  repository: { get(userId: string): Promise<Preferences>; update(userId: string, value: Preferences): Promise<Preferences> };
  limiter: { consume(input: { userId: string; key: "notification.preferences" }): Promise<{
    allowed: boolean; retryAfterSeconds: number;
  }> };
}) {
  return async (request: Request) => {
    const traceId = crypto.randomUUID();
    let session: Session | null;
    try { session = await input.getSession(request.headers); } catch { return error("INTERNAL_ERROR", 500, traceId, true); }
    if (!session) return error("UNAUTHORIZED", 401, traceId);
    let limit;
    try { limit = await input.limiter.consume({ userId: session.user.id, key: "notification.preferences" }); }
    catch { return error("SERVICE_UNAVAILABLE", 503, traceId, true); }
    if (!limit.allowed) return error("RATE_LIMITED", 429, traceId, true);
    if (request.method === "GET") {
      if (new TextEncoder().encode(request.url).byteLength > 2_048) return error("URI_TOO_LONG", 414, traceId);
      if (new URL(request.url).search.length > 0) return error("INVALID_REQUEST", 400, traceId);
      try { return Response.json({ data: { preferences: await input.repository.get(session.user.id) } }); }
      catch { return error("INTERNAL_ERROR", 500, traceId, true); }
    }
    if (request.method !== "PATCH") return error("METHOD_NOT_ALLOWED", 405, traceId);
    if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
      return error("INVALID_REQUEST", 415, traceId);
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > 4_096) return error("PAYLOAD_TOO_LARGE", 413, traceId);
    let parsed: ReturnType<typeof notificationPreferencesSchema.safeParse>;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > 4_096) return error("PAYLOAD_TOO_LARGE", 413, traceId);
      parsed = notificationPreferencesSchema.safeParse(JSON.parse(text));
    } catch { return error("INVALID_REQUEST", 400, traceId); }
    if (!parsed.success) return error("INVALID_REQUEST", 400, traceId);
    try { return Response.json({ data: { preferences: await input.repository.update(session.user.id, parsed.data) } }); }
    catch { return error("INTERNAL_ERROR", 500, traceId, true); }
  };
}
