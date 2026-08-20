import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: { userId: "00000000-0000-4000-8000-000000000001", role: "super_admin",
    mfaVerifiedAt: null as Date | null },
  listQueue: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/modules/admin/runtime", () => ({
  readAdminPageSession: async () => state.session,
  adminService: { listQueue: state.listQueue },
}));

import AdminPage from "@/app/[locale]/admin/page";

describe("admin console recent MFA", () => {
  beforeEach(() => state.listQueue.mockClear());

  it.each([
    ["missing", null],
    ["stale", new Date(Date.now() - 6 * 60_000)],
  ])("fails closed before queue reads when MFA is %s", async (_label, mfaVerifiedAt) => {
    state.session.mfaVerifiedAt = mfaVerifiedAt;
    await expect(AdminPage({ params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ queue: "reports" }) })).rejects.toThrow("NOT_FOUND");
    expect(state.listQueue).not.toHaveBeenCalled();
  });
});
