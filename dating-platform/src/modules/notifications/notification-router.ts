export type NotificationCategory = "security" | "transactional" | "marketing";
export type NotificationChannel = "email" | "sms" | "inApp";

type Preferences = {
  locale: "en" | "zh-CN";
  timeZone: string;
  marketingEnabled: boolean;
  channelConsent: Record<NotificationChannel, boolean>;
  quietHours: { startHour: number; endHour: number } | null;
};

type RouteInput = {
  category: NotificationCategory;
  preferredChannels: NotificationChannel[];
  preferences: Preferences;
  now: Date;
};

const localParts = (date: Date, timeZone: string) => Object.fromEntries(
  new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23" }).formatToParts(date)
    .filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
) as Record<"year" | "month" | "day" | "hour", number>;

const zonedDate = (parts: { year: number; month: number; day: number; hour: number }, timeZone: string) => {
  const nominal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour);
  let candidate = new Date(nominal);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const local = localParts(candidate, timeZone);
    const rendered = Date.UTC(local.year, local.month - 1, local.day, local.hour);
    candidate = new Date(candidate.getTime() + nominal - rendered);
  }
  return candidate;
};

const quietEnd = (now: Date, timeZone: string, quiet: NonNullable<Preferences["quietHours"]>) => {
  const local = localParts(now, timeZone);
  const crossesMidnight = quiet.startHour >= quiet.endHour;
  const quietNow = crossesMidnight
    ? local.hour >= quiet.startHour || local.hour < quiet.endHour
    : local.hour >= quiet.startHour && local.hour < quiet.endHour;
  if (!quietNow) return null;
  const target = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (crossesMidnight && local.hour >= quiet.startHour) target.setUTCDate(target.getUTCDate() + 1);
  return zonedDate({ year: target.getUTCFullYear(), month: target.getUTCMonth() + 1,
    day: target.getUTCDate(), hour: quiet.endHour }, timeZone);
};

export function routeNotification(input: RouteInput) {
  if (input.category === "marketing" && !input.preferences.marketingEnabled) {
    return { status: "suppressed" as const, reason: "marketing_opt_out" as const };
  }
  const channels = [...new Set([...input.preferredChannels, "inApp" as const])]
    .filter((channel) => input.preferences.channelConsent[channel]);
  if (channels.length === 0) return { status: "suppressed" as const, reason: "no_consented_channel" as const };
  const base = { locale: input.preferences.locale, channels };
  const availableAt = input.category === "security" || !input.preferences.quietHours ? null
    : quietEnd(input.now, input.preferences.timeZone, input.preferences.quietHours);
  return availableAt ? { status: "deferred" as const, ...base, availableAt }
    : { status: "ready" as const, ...base };
}

export type NotificationOutbox = {
  enqueue(input: { userId: string; dedupeKey: string; category: NotificationCategory; templateKey: string;
    locale: "en" | "zh-CN"; channels: NotificationChannel[]; availableAt: Date; maxAttempts: number }): Promise<void>;
};

export async function enqueueRoutedNotification(outbox: NotificationOutbox, input: RouteInput & {
  userId: string; dedupeKey: string; templateKey: string;
}) {
  const route = routeNotification(input);
  if (route.status === "suppressed") return route;
  await outbox.enqueue({ userId: input.userId, dedupeKey: input.dedupeKey, category: input.category,
    templateKey: input.templateKey, locale: route.locale, channels: route.channels,
    availableAt: route.status === "deferred" ? route.availableAt : input.now, maxAttempts: 5 });
  return route;
}

type DeliveryJob = { id: string; leaseId: string; channels: readonly NotificationChannel[]; attempts: number;
  maxAttempts: number; providerIdempotencyKey: string; [key: string]: unknown };
type DeliveryStore = {
  claim(): Promise<DeliveryJob | null>;
  complete(id: string, leaseId: string): Promise<void>;
  retry(id: string, leaseId: string, input: { errorCode: "DELIVERY_FAILED"; availableAt: Date }): Promise<void>;
  manualReview(id: string, leaseId: string, errorCode: "DELIVERY_FAILED"): Promise<void>;
};
type DeliveryProvider = { channel: NotificationChannel;
  deliver(job: DeliveryJob, context: { idempotencyKey: string }): Promise<{ delivered: boolean }> };

export class NotificationDispatcher {
  constructor(private readonly dependencies: { store: DeliveryStore; providers: DeliveryProvider[];
    clock?: () => Date }) {}

  async runOne() {
    const job = await this.dependencies.store.claim();
    if (!job) return false;
    for (const channel of job.channels) {
      for (const provider of this.dependencies.providers.filter((candidate) => candidate.channel === channel).slice(0, 3)) {
        try {
          if ((await provider.deliver(job, { idempotencyKey: `${job.providerIdempotencyKey}:${channel}` })).delivered) {
            await this.dependencies.store.complete(job.id, job.leaseId); return true;
          }
        } catch { /* provider details intentionally remain inside the adapter */ }
      }
    }
    if (job.attempts >= job.maxAttempts) {
      await this.dependencies.store.manualReview(job.id, job.leaseId, "DELIVERY_FAILED");
    }
    else {
      const now = (this.dependencies.clock ?? (() => new Date()))();
      const delay = Math.min(3_600_000, 1_000 * (2 ** Math.max(0, job.attempts - 1)));
      await this.dependencies.store.retry(job.id, job.leaseId,
        { errorCode: "DELIVERY_FAILED", availableAt: new Date(now.getTime() + delay) });
    }
    return true;
  }
}
