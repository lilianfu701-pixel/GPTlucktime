import "server-only";

import { headers } from "next/headers";

import {
  clientKeyFromHeaders,
  createFixedWindowRateLimiter,
  type RateLimitDecision,
} from "./fixed-window-rate-limiter";

const chartGenerationLimiter = createFixedWindowRateLimiter({
  limit: 10,
  windowMs: 60_000,
  maxEntries: 5_000,
});

/**
 * This limiter is independent from intake validation and local to one server instance.
 * Vercel Firewall remains the deployment-level layer for global enforcement.
 */
export async function checkChartGenerationRateLimit(): Promise<RateLimitDecision> {
  const requestHeaders = await headers();
  return chartGenerationLimiter.consume(clientKeyFromHeaders(requestHeaders));
}
