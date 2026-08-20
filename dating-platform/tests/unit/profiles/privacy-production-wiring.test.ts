import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("privacy production wiring", () => {
  it("routes export and deletion through server-only database, auth, Redis and S3 dependencies", () => {
    const runtime = readFileSync("src/modules/profiles/privacy-runtime.ts", "utf8");
    const exportRoute = readFileSync("src/app/api/v1/me/export/route.ts", "utf8");
    const deleteRoute = readFileSync("src/app/api/v1/me/delete/route.ts", "utf8");
    const workerRoute = readFileSync("src/app/api/internal/workers/privacy/route.ts", "utf8");
    expect(runtime).toContain('import "server-only"');
    expect(runtime).toContain("DrizzlePrivacyRepository");
    expect(runtime).toContain("RedisPrivacyRateLimiter");
    expect(runtime).toContain("S3PrivacyExportStorage");
    expect(exportRoute).toContain('export const runtime = "nodejs"');
    expect(exportRoute).toContain("export const PATCH = handler");
    expect(deleteRoute).toContain("export const DELETE");
    expect(deleteRoute).toContain("export const GET = handler");
    expect(runtime).toContain("PrivacyExportWorker");
    expect(runtime).toContain("DeletionWorker");
    expect(runtime).toContain("PrivacyWorkflowWorker");
    expect(runtime).toContain("runDeletionRenewalCancellation");
    expect(workerRoute).toContain("PRIVACY_WORKER_CRON_SECRET");
    expect(workerRoute).toContain("messageKey");
    expect(workerRoute).toContain("retryable");
    expect(workerRoute).toContain("traceId");
    expect(workerRoute).toContain("export const GET = handler");
    expect(runtime).toContain("/privacy/cancel-deletion#credential=");
    expect(runtime).toContain("/privacy/export/${input.jobId}#credential=");
    expect(runtime).toMatch(/secureCredentialDeliveryAvailable[\s\S]*EMAIL_WEBHOOK_URL[\s\S]*EMAIL_WEBHOOK_TOKEN[\s\S]*AUTH_ENCRYPTION_KEYS[\s\S]*AUTH_DELIVERY_HMAC_KEY[\s\S]*NOTIFICATION_WORKER_CRON_SECRET/u);
    expect(runtime).toMatch(/secureCredentialDeliveryAvailable[\s\S]*PRIVACY_WORKER_CRON_SECRET/u);
    for (const client of [
      "src/app/[locale]/privacy/cancel-deletion/cancellation-client.tsx",
      "src/app/[locale]/privacy/export/[jobId]/download-client.tsx",
    ]) {
      const source = readFileSync(client, "utf8");
      expect(source).toContain("window.location.hash");
      expect(source).not.toMatch(/console\.|localStorage|sessionStorage/u);
    }
  });

  it("keeps a gated real PostgreSQL independent-pool concurrency suite", () => {
    const gate = "tests/integration/profiles/privacy-concurrency-postgres.test.ts";
    expect(existsSync(gate)).toBe(true);
    const source = readFileSync(gate, "utf8");
    expect(source).toContain("TEST_DATABASE_URL");
    expect(source).toContain("describe.skip");
    expect(source.match(/new Pool/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain("SKIP LOCKED");
  });
});
