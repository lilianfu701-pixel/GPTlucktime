import "server-only";

import { createClient } from "redis";

import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { readEnv } from "@/shared/env";

import { DrizzleReportRepository } from "./report-repository";
import { RedisReportRateLimiter } from "./report-rate-limiter";
import { ReportService, RuleBasedReportRiskAssessor } from "./report-service";

const env = readEnv(process.env);
const repository = new DrizzleReportRepository(db, {
  idempotencySecret: env.BETTER_AUTH_SECRET,
  jurisdictionPolicy: (countryCode) => ({
    jurisdictionCode: /^[A-Z]{2}$/u.test(countryCode) ? countryCode : "ZZ",
    workflowCode: "safety-legal-review-v1",
    dueAt: new Date(Date.now() + 60 * 60_000),
  }),
});
const service = new ReportService(repository, new RuleBasedReportRiskAssessor());
const limiter = new RedisReportRateLimiter(createClient({ url: env.REDIS_URL }), {
  hmacKey: env.BETTER_AUTH_SECRET,
});

export const reportRouteDependencies = {
  getSession: async (headers: Headers) => {
    const session = await auth.api.getSession({ headers });
    return session ? { user: { id: session.user.id } } : null;
  },
  service,
  limiter,
};

export const myReportsRouteDependencies = {
  getSession: reportRouteDependencies.getSession,
  service,
};
