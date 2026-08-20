import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ADMIN_QUEUE_PERMISSIONS } from "@/modules/admin/admin-service";

describe("admin production wiring", () => {
  it("wires both production routes through the admin-only runtime", async () => {
    const [actions, entitlements, runtime] = await Promise.all([
      readFile("src/app/api/v1/admin/users/[userId]/actions/route.ts", "utf8"),
      readFile("src/app/api/v1/admin/entitlements/route.ts", "utf8"),
      readFile("src/modules/admin/runtime.ts", "utf8"),
    ]);
    expect(actions).toMatch(/export const POST = createAdminUserActionsHandler\(adminRouteDependencies\)/u);
    expect(entitlements).toMatch(/export const POST = createAdminEntitlementsHandler\(adminRouteDependencies\)/u);
    expect(runtime).toContain("adminSessions");
    expect(runtime).not.toContain("@/modules/auth/auth");
  });

  it("wires approval collection/detail/decision and authenticated execution worker routes", async () => {
    const [collection, detail, decision, worker, runtime] = await Promise.all([
      readFile("src/app/api/v1/admin/approvals/route.ts", "utf8"),
      readFile("src/app/api/v1/admin/approvals/[approvalId]/route.ts", "utf8"),
      readFile("src/app/api/v1/admin/approvals/[approvalId]/decision/route.ts", "utf8"),
      readFile("src/app/api/internal/workers/admin/route.ts", "utf8"),
      readFile("src/modules/admin/runtime.ts", "utf8"),
    ]);
    expect(collection).toContain("createAdminApprovalCollectionHandler");
    expect(detail).toContain("createAdminApprovalDetailHandler");
    expect(decision).toContain("createAdminApprovalDecisionHandler");
    expect(worker).toContain("createAdminApprovalWorkerRoute");
    expect(runtime).toContain("AdminApprovalWorker");
    expect(runtime).toContain("DrizzleAdminApprovalExecutionRepository");
    expect(runtime).toContain("AdminOutboxWorker");
    expect(runtime).toContain("RedisStreamAdminEventSink");
    expect(runtime).toContain("AdminExportPurgeWorker");
    expect(runtime).toContain("DrizzleAdminExportPurgeRepository");
    expect(runtime).toContain("ADMIN_EXPORT_S3_ENDPOINT");
    expect(runtime).not.toMatch(/S3AdminExportStorage\(\{[\s\S]*PROFILE_MEDIA_STORAGE_/u);
  });

  it("renders an isolated server admin console only after permission and before queue reads", async () => {
    const [page, english, chinese] = await Promise.all([
      readFile("src/app/[locale]/admin/page.tsx", "utf8"),
      readFile("messages/en.json", "utf8").then(JSON.parse),
      readFile("messages/zh-CN.json", "utf8").then(JSON.parse),
    ]);
    expect(page).not.toContain("use client");
    expect(page).toContain("readAdminPageSession");
    expect(page).toContain("requirePermission");
    expect(page).toContain("requireRecentMfa");
    expect(page).toContain("listQueue");
    expect(page.indexOf("requirePermission")).toBeLessThan(page.indexOf("listQueue"));
    expect(page.indexOf("requireRecentMfa")).toBeLessThan(page.indexOf("listQueue"));
    expect(page).toContain('getTranslations({ locale: resolvedLocale, namespace: "admin" })');
    expect(page).toContain("t(`queues.${item}`)");
    expect(Object.keys(english.admin.queues)).toEqual(Object.keys(chinese.admin.queues));
    expect(Object.keys(english.admin.queues)).toEqual(Object.keys(ADMIN_QUEUE_PERMISSIONS));
    expect(page).toContain("searchParams");
    expect(page).toContain("queue");
    expect(page).toContain("cursor");
    expect(page).toContain("limit");
    expect(page).toContain("<Link");
    expect(page).not.toContain("More items are available.</p>");
    expect(page).toMatch(/try\s*\{[\s\S]*readAdminPageSession[\s\S]*\}\s*catch\s*\{\s*notFound\(\);?\s*\}/u);
  });
});
