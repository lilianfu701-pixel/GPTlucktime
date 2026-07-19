export type RateLimitDecision =
  | Readonly<{
      allowed: true;
      remaining: number;
      resetAtMs: number;
    }>
  | Readonly<{
      allowed: false;
      remaining: 0;
      resetAtMs: number;
      retryAfterMs: number;
    }>;

export interface FixedWindowRateLimiter {
  readonly consume: (key: string, nowMs?: number) => RateLimitDecision;
  readonly size: () => number;
}

interface FixedWindowOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxEntries: number;
}

interface WindowEntry {
  count: number;
  windowStartMs: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

export function createFixedWindowRateLimiter({
  limit,
  windowMs,
  maxEntries,
}: FixedWindowOptions): FixedWindowRateLimiter {
  positiveInteger(limit, "limit");
  positiveInteger(windowMs, "windowMs");
  positiveInteger(maxEntries, "maxEntries");
  const entries = new Map<string, WindowEntry>();

  function removeExpired(nowMs: number): void {
    for (const [key, entry] of entries) {
      if (nowMs >= entry.windowStartMs + windowMs) entries.delete(key);
    }
  }

  function makeRoom(): void {
    while (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      entries.delete(oldestKey);
    }
  }

  return Object.freeze({
    consume(key: string, nowMs = Date.now()): RateLimitDecision {
      if (!Number.isFinite(nowMs)) throw new RangeError("nowMs must be finite.");
      removeExpired(nowMs);

      const normalizedKey = key.trim() || "anonymous";
      let entry = entries.get(normalizedKey);
      if (!entry || nowMs < entry.windowStartMs) {
        if (!entry) makeRoom();
        entry = { count: 0, windowStartMs: nowMs };
        entries.set(normalizedKey, entry);
      }

      const resetAtMs = entry.windowStartMs + windowMs;
      if (entry.count >= limit) {
        return Object.freeze({
          allowed: false as const,
          remaining: 0 as const,
          resetAtMs,
          retryAfterMs: Math.max(1, resetAtMs - nowMs),
        });
      }

      entry.count += 1;
      return Object.freeze({
        allowed: true as const,
        remaining: limit - entry.count,
        resetAtMs,
      });
    },
    size: () => entries.size,
  });
}

type HeaderReader = Readonly<{ get: (name: string) => string | null }>;

function firstAddress(value: string | null): string | null {
  const address = value?.split(",", 1)[0]?.trim();
  return address ? address.slice(0, 200) : null;
}

export function clientKeyFromHeaders(headers: HeaderReader): string {
  return (
    firstAddress(headers.get("x-vercel-forwarded-for")) ??
    firstAddress(headers.get("x-forwarded-for")) ??
    "anonymous"
  );
}
