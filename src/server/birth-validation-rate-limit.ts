import "server-only";

import { headers } from "next/headers";

import {
  clientKeyFromHeaders,
  createFixedWindowRateLimiter,
  type RateLimitDecision,
} from "./fixed-window-rate-limiter";

const birthValidationLimiter = createFixedWindowRateLimiter({
  limit: 30,
  windowMs: 60_000,
  maxEntries: 5_000,
});

/**
 * This bounded limiter is local to one serverless instance and resets on cold starts.
 * Production deployments should layer Vercel Firewall rate limits for global coverage.
 */
export async function checkBirthValidationRateLimit(): Promise<RateLimitDecision> {
  const requestHeaders = await headers();
  return birthValidationLimiter.consume(clientKeyFromHeaders(requestHeaders));
}
