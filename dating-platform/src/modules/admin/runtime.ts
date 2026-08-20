import "server-only";

import { and, eq } from "drizzle-orm";
import { createClient } from "redis";

import { adminRoleAssignments, adminSessions } from "@/db/schema";
import { db } from "@/infrastructure/db/client";
import { DrizzleCaseService } from "@/modules/moderation/case-service";
import { resolveTrustedClientBucket } from "@/modules/auth/trusted-ingress";
import { createStripeClient, StripeBillingAdapter } from "@/modules/billing/stripe-adapter";
import { readEnv } from "@/shared/env";

import {
  DrizzleAdminGovernanceProjection,
  DrizzleAdminQueueRepository,
  DrizzleAdminSessionReader,
  DrizzleApprovalRepository,
  DrizzleVersionedEntitlementConfiguration,
  RedisAdminRateLimiter,
} from "./admin-repository";
import { AdminApprovalWorker } from "./admin-approval-worker";
import { DrizzleAdminApprovalExecutionRepository } from "./admin-execution-repository";
import { S3AdminExportStorage } from "./admin-export-storage";
import { AdminExportPurgeWorker, DrizzleAdminExportPurgeRepository } from "./admin-export-purge";
import { AdminOutboxWorker, DrizzleAdminOutboxRepository, RedisStreamAdminEventSink } from "./admin-outbox-dispatcher";
import { DrizzleAdminSensitiveWorkflowResolver } from "./admin-sensitive-access";
import { AdminService } from "./admin-service";

const env = readEnv(process.env);
const sessionReader = new DrizzleAdminSessionReader(db, env.BETTER_AUTH_SECRET);
const redis = createClient({ url: env.REDIS_URL });
const caseService = new DrizzleCaseService(db, {
  resolveEvidenceReaderRole: async (userId) => {
    const [assignment] = await db.select({ role: adminRoleAssignments.role }).from(adminRoleAssignments)
      .where(and(eq(adminRoleAssignments.userId, userId), eq(adminRoleAssignments.active, "active"))).limit(1);
    if (assignment?.role === "safety") return "safety_specialist";
    if (assignment?.role === "moderation") return "case_worker";
    return null;
  },
});

const governance = new DrizzleAdminGovernanceProjection(db, caseService, env.BETTER_AUTH_SECRET);
export const adminService = new AdminService({
  approvals: new DrizzleApprovalRepository(db, env.BETTER_AUTH_SECRET),
  governance,
  entitlementConfig: new DrizzleVersionedEntitlementConfiguration(db, env.BETTER_AUTH_SECRET),
  queues: new DrizzleAdminQueueRepository(db, env.BETTER_AUTH_SECRET),
});

const limiter = new RedisAdminRateLimiter(redis, env.BETTER_AUTH_SECRET);
const sensitiveAccess = new DrizzleAdminSensitiveWorkflowResolver(db, env.BETTER_AUTH_SECRET);
const appOrigin = new URL(env.APP_URL).origin;

export const readAdminPageSession = (headers: Headers) => sessionReader.read(headers);

export const adminRouteDependencies = {
  getSession: (headers: Headers) => sessionReader.read(headers),
  service: adminService,
  sensitiveAccess,
  limiter,
  isTrustedOrigin: (request: Request) => {
    const origin = request.headers.get("origin");
    if (!origin) return false;
    try { return new URL(origin).origin === appOrigin && new URL(origin).href === `${appOrigin}/`; }
    catch { return false; }
  },
  resolveClientIp: (request: Request) => resolveTrustedClientBucket(request, env.AUTH_TRUSTED_PROXY_TOKEN),
};

export async function runConfiguredAdminApprovalWorker() {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !env.ADMIN_EXPORT_S3_ENDPOINT
    || !env.ADMIN_EXPORT_S3_REGION || !env.ADMIN_EXPORT_S3_BUCKET
    || !env.ADMIN_EXPORT_S3_ACCESS_KEY || !env.ADMIN_EXPORT_S3_SECRET_KEY) {
    throw new Error("ADMIN_WORKER_UNAVAILABLE");
  }
  const stripe = new StripeBillingAdapter({ stripe: createStripeClient(env.STRIPE_SECRET_KEY),
    webhookSecret: env.STRIPE_WEBHOOK_SECRET });
  const storage = new S3AdminExportStorage({ endpoint: env.ADMIN_EXPORT_S3_ENDPOINT,
    region: env.ADMIN_EXPORT_S3_REGION, bucket: env.ADMIN_EXPORT_S3_BUCKET,
    accessKeyId: env.ADMIN_EXPORT_S3_ACCESS_KEY, secretAccessKey: env.ADMIN_EXPORT_S3_SECRET_KEY });
  const repository = new DrizzleAdminApprovalExecutionRepository(db, governance, stripe, storage);
  const purgeRepository = new DrizzleAdminExportPurgeRepository(db, storage);
  const outboxRepository = new DrizzleAdminOutboxRepository(db, new RedisStreamAdminEventSink(redis));
  const [approvals, purge, outbox] = await Promise.all([
    new AdminApprovalWorker(repository).run(10),
    new AdminExportPurgeWorker(purgeRepository).run(10),
    new AdminOutboxWorker(outboxRepository).run(25),
  ]);
  return { approvals, purge, outbox };
}

// Exporting the table symbol here is intentional: the production-wiring gate
// asserts that admin auth is backed by the isolated admin session store.
export { adminSessions };
