import "server-only";

import { createClient } from "redis";

import { db } from "@/infrastructure/db/client";
import { auth, enqueueSecurePrivacyCredential } from "@/modules/auth/auth";
import { runDeletionRenewalCancellation, runDeletionRenewalResume } from "@/modules/billing/runtime";
import { readEnv } from "@/shared/env";

import { DataExportService } from "./data-export-service";
import { DeletionService, DeletionWorker } from "./deletion-service";
import { S3PrivacyExportStorage } from "./privacy-export-storage";
import { decryptPrivacyExport, PrivacyExportCleanupWorker, PrivacyExportWorker } from "./privacy-export-worker";
import { RedisPrivacyRateLimiter } from "./privacy-rate-limiter";
import { DrizzlePrivacyRepository } from "./privacy-repository";
import { DrizzleDeletionWorkerStore, DrizzlePrivacyExportWorkerStore } from "./privacy-worker-store";
import { DrizzlePrivacyWorkflowStore } from "./privacy-worker-store";
import { PrivacyWorkflowWorker } from "./privacy-workflow-worker";

const env = readEnv(process.env);
const appOrigin = env.APP_URL.replace(/\/$/u, "");
const repository = new DrizzlePrivacyRepository(db, () => new Date(), async (transaction, input) => {
  await enqueueSecurePrivacyCredential(transaction, { kind: "deletion_cancellation",
    recipient: input.recipient, locale: input.locale,
    actionUrl: `${appOrigin}/${input.locale}/privacy/cancel-deletion#credential=${input.token}`,
    validUntil: input.expiresAt });
});
const redis = createClient({ url: env.REDIS_URL });
const limiter = new RedisPrivacyRateLimiter(redis, { hmacKey: env.BETTER_AUTH_SECRET });
const getSession = async (headers: Headers) => {
  const session = await auth.api.getSession({ headers });
  return session ? {
    user: { id: session.user.id, emailVerified: session.user.emailVerified },
    session: { createdAt: session.session.createdAt },
  } : null;
};
const configuredStorage = () => {
  if (!env.PRIVACY_EXPORT_S3_ENDPOINT || !env.PRIVACY_EXPORT_S3_REGION || !env.PRIVACY_EXPORT_S3_BUCKET
    || !env.PRIVACY_EXPORT_S3_ACCESS_KEY || !env.PRIVACY_EXPORT_S3_SECRET_KEY) throw new Error("PRIVACY_EXPORT_UNAVAILABLE");
  return new S3PrivacyExportStorage({ endpoint: env.PRIVACY_EXPORT_S3_ENDPOINT, region: env.PRIVACY_EXPORT_S3_REGION,
    bucket: env.PRIVACY_EXPORT_S3_BUCKET, accessKeyId: env.PRIVACY_EXPORT_S3_ACCESS_KEY,
    secretAccessKey: env.PRIVACY_EXPORT_S3_SECRET_KEY });
};
const secureCredentialDeliveryAvailable = () => Boolean(env.EMAIL_WEBHOOK_URL && env.EMAIL_WEBHOOK_TOKEN
  && env.AUTH_ENCRYPTION_KEYS && env.AUTH_DELIVERY_HMAC_KEY && env.NOTIFICATION_WORKER_CRON_SECRET
  && env.PRIVACY_WORKER_CRON_SECRET);
const exportConfigurationAvailable = () => Boolean(env.PRIVACY_EXPORT_ENCRYPTION_KEY && env.PRIVACY_EXPORT_S3_ENDPOINT
  && env.PRIVACY_EXPORT_S3_REGION && env.PRIVACY_EXPORT_S3_BUCKET && env.PRIVACY_EXPORT_S3_ACCESS_KEY
  && env.PRIVACY_EXPORT_S3_SECRET_KEY && secureCredentialDeliveryAvailable());

const exportService = new DataExportService({ createOrGet: (input) => repository.createOrGetExport(input),
  enqueueNotification: (input) => repository.enqueueNotification({ ...input, templateKey: "privacy.exportAccepted" }),
  claimDownload: (input) => repository.claimDownload(input),
  readDownload: async (claim) => {
    if (!env.PRIVACY_EXPORT_ENCRYPTION_KEY || claim.encryptionKeyId !== "privacy-export-v1") {
      throw new Error("PRIVACY_EXPORT_UNAVAILABLE");
    }
    const encrypted = await configuredStorage().readEncrypted({ objectKey: claim.objectKey,
      objectVersion: claim.objectVersion, integritySha256: claim.integritySha256 });
    return decryptPrivacyExport(encrypted, { keyId: claim.encryptionKeyId,
      key: Buffer.from(env.PRIVACY_EXPORT_ENCRYPTION_KEY, "base64url") });
  }, completeDownload: (claim) => repository.completeDownload(claim),
  releaseDownload: (claim) => repository.releaseDownload(claim) });
const deletionService = new DeletionService({ begin: (input) => repository.beginDeletion(input),
  revokeSessions: (userId) => repository.revokeSessions(userId), hideProfile: (userId) => repository.hideProfile(userId),
  enqueueRenewalCancellation: (input) => repository.enqueueRenewalCancellation(input),
  enqueueNotification: (input) => repository.enqueueNotification(input), cancel: (input) => repository.cancelDeletion(input),
  authenticateCancellation: (input) => repository.authenticateCancellationCredential(input),
  hasLegalHold: (userId) => repository.hasLegalHold(userId) });

export const exportRouteDependencies = { getSession, service: exportService, limiter,
  isAvailable: exportConfigurationAvailable };
export const deletionRouteDependencies = { getSession, service: deletionService, limiter,
  isAvailable: secureCredentialDeliveryAvailable };

export async function runConfiguredPrivacyWorkers() {
  const deletionWorker = new DeletionWorker(new DrizzleDeletionWorkerStore(db));
  const workflowWorker = new PrivacyWorkflowWorker({ store: new DrizzlePrivacyWorkflowStore(db),
    cancelRenewal: runDeletionRenewalCancellation, resumeRenewal: runDeletionRenewalResume });
  let exportsProcessed = 0; let exportsExpired = 0; let deletionsProcessed = 0; let workflowsProcessed = 0;
  for (let index = 0; index < 10 && await workflowWorker.runOne(); index += 1) workflowsProcessed += 1;
  for (let index = 0; index < 10 && await deletionWorker.runOne(); index += 1) deletionsProcessed += 1;
  if (env.PRIVACY_EXPORT_ENCRYPTION_KEY && env.PRIVACY_EXPORT_S3_ENDPOINT && env.PRIVACY_EXPORT_S3_REGION
    && env.PRIVACY_EXPORT_S3_BUCKET && env.PRIVACY_EXPORT_S3_ACCESS_KEY && env.PRIVACY_EXPORT_S3_SECRET_KEY) {
    const exportStore = new DrizzlePrivacyExportWorkerStore(db, () => new Date(), async (transaction, input) => {
      await enqueueSecurePrivacyCredential(transaction, { kind: "privacy_export_download",
        recipient: input.recipient, locale: input.locale,
        actionUrl: `${appOrigin}/${input.locale}/privacy/export/${input.jobId}#credential=${input.token}`,
        validUntil: input.expiresAt });
    });
    const storage = configuredStorage();
    const exportWorker = new PrivacyExportWorker({ store: exportStore,
      collect: (userId) => exportStore.collect(userId), storage, encryption: {
        keyId: "privacy-export-v1", key: Buffer.from(env.PRIVACY_EXPORT_ENCRYPTION_KEY, "base64url"),
      } });
    const cleanupWorker = new PrivacyExportCleanupWorker({ store: exportStore, storage });
    for (let index = 0; index < 10 && await exportWorker.runOne(); index += 1) exportsProcessed += 1;
    for (let index = 0; index < 10 && await cleanupWorker.runOne(); index += 1) exportsExpired += 1;
  }
  return { exportsProcessed, exportsExpired, deletionsProcessed, workflowsProcessed };
}
