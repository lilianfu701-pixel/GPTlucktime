import { createHmac } from "node:crypto";

export type SmsAbuseConfig = {
  hmacKey: string;
  allowedCallingCodes: string[];
  highRiskCallingCodes?: string[];
  deniedPrefixes?: string[];
  cooldownMs?: number;
  windowMs?: number;
  ipLimit?: number;
  actorLimit?: number;
  targetLimit?: number;
};

export class SmsAbuseError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "SmsAbuseError";
  }
}

export interface SmsAbuseStore {
  claim(key: string, ttlMs: number): Promise<boolean>;
  increment(key: string, windowMs: number): Promise<number>;
}

type StoredCounter = { value: number; expiresAt: number };

export class InMemorySmsAbuseStore implements SmsAbuseStore {
  private readonly values = new Map<string, StoredCounter>();

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const existing = this.values.get(key);
    if (existing && existing.expiresAt > now) return false;
    if (ttlMs > 0) this.values.set(key, { value: 1, expiresAt: now + ttlMs });
    return true;
  }

  async increment(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const existing = this.values.get(key);
    const next = existing && existing.expiresAt > now
      ? { value: existing.value + 1, expiresAt: existing.expiresAt }
      : { value: 1, expiresAt: now + windowMs };
    this.values.set(key, next);
    return next.value;
  }

  keys(): string[] {
    return [...this.values.keys()];
  }
}

type RedisLike = {
  isOpen?: boolean;
  connect(): Promise<unknown>;
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

export class RedisSmsAbuseStore implements SmsAbuseStore {
  private readonly client: RedisLike;

  constructor(client: unknown) {
    this.client = client as RedisLike;
  }

  private async ready(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    if (ttlMs <= 0) return true;
    await this.ready();
    return await this.client.set(key, "1", { NX: true, PX: ttlMs }) === "OK";
  }

  async increment(key: string, windowMs: number): Promise<number> {
    await this.ready();
    const value = await this.client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n",
      { keys: [key], arguments: [String(windowMs)] },
    );
    return Number(value);
  }
}

export function validateSmsTarget(
  target: string,
  config: SmsAbuseConfig,
): { callingCode: string; highRisk: boolean } {
  if (!/^\+[1-9]\d{7,14}$/.test(target)) throw new SmsAbuseError("INVALID_PHONE_NUMBER", 400);
  if (config.deniedPrefixes?.some((prefix) => target.startsWith(prefix))) {
    throw new SmsAbuseError("SMS_DESTINATION_DENIED", 400);
  }
  const callingCode = [...config.allowedCallingCodes]
    .sort((left, right) => right.length - left.length)
    .find((code) => target.startsWith(`+${code}`));
  if (!callingCode) throw new SmsAbuseError("SMS_COUNTRY_NOT_ALLOWED", 400);
  return { callingCode, highRisk: config.highRiskCallingCodes?.includes(callingCode) ?? false };
}

export class SmsAbuseGuard {
  constructor(private readonly store: SmsAbuseStore, readonly config: SmsAbuseConfig) {}

  private key(scope: string, value: string): string {
    const digest = createHmac("sha256", this.config.hmacKey).update(value).digest("base64url");
    return `auth:sms:${scope}:${digest}`;
  }

  async check(input: {
    ip: string;
    actorId?: string;
    target: string;
    challengeVerified?: boolean;
  }): Promise<void> {
    const { highRisk } = validateSmsTarget(input.target, this.config);
    if (highRisk && input.challengeVerified !== true) {
      throw new SmsAbuseError("SMS_CHALLENGE_REQUIRED", 403);
    }
    if (!await this.store.claim(this.key("cooldown", input.target), this.config.cooldownMs ?? 60_000)) {
      throw new SmsAbuseError("SMS_COOLDOWN", 429);
    }
    const windowMs = this.config.windowMs ?? 3_600_000;
    const checks: Array<[string, string, number]> = [
      ["ip", input.ip, this.config.ipLimit ?? 10],
      ["target", input.target, this.config.targetLimit ?? 3],
    ];
    if (input.actorId) checks.push(["actor", input.actorId, this.config.actorLimit ?? 5]);
    for (const [scope, value, limit] of checks) {
      if (await this.store.increment(this.key(scope, value), windowMs) > limit) {
        throw new SmsAbuseError("SMS_RATE_LIMITED", 429);
      }
    }
  }
}
