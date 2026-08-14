import { describe, expect, it, vi } from "vitest";

import { ReconciliationService, type LedgerSnapshot } from "@/modules/billing/reconciliation-service";

describe("ReconciliationService", () => {
  it("creates reviewable discrepancies without editing payment history", async () => {
    const store = {
      acquireRun: vi.fn(async () => ({ id: "run-1", cursor: null })),
      snapshotPage: vi.fn(async () => ({ subscriptions: [], invoices: [{ id: "in_internal", amount: 1299 }],
        refunds: [], disputes: [], nextCursor: null })),
      saveDiscrepancies: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined),
      failRun: vi.fn(async () => undefined),
    };
    const provider = { listLedgerPage: vi.fn(async () => ({
      subscriptions: [{ id: "sub_provider", status: "active" }], invoices: [], refunds: [], disputes: [], nextCursor: null,
    })) };
    const service = new ReconciliationService({ store, provider, batchSize: 50 });
    const result = await service.run("daily:2026-08-12");
    expect(result).toEqual({ runId: "run-1", discrepancies: 2, nextCursor: null });
    expect(store.saveDiscrepancies).toHaveBeenCalledWith("run-1", expect.arrayContaining([
      expect.objectContaining({ kind: "missing_internal", providerObjectId: "sub_provider" }),
      expect.objectContaining({ kind: "missing_provider", providerObjectId: "in_internal" }),
    ]));
    expect(Object.keys(store)).not.toContain("updatePayments");
  });

  it("uses an idempotent leased run and records retryable failure", async () => {
    const store = {
      acquireRun: vi.fn(async () => ({ id: "run-1", cursor: "cursor-a" })),
      snapshotPage: vi.fn(async () => ({ subscriptions: [], invoices: [], refunds: [], disputes: [], nextCursor: null })),
      saveDiscrepancies: vi.fn(), completeRun: vi.fn(), failRun: vi.fn(),
    };
    const provider = { listLedgerPage: vi.fn(async () => { throw new Error("provider token secret"); }) };
    const service = new ReconciliationService({ store, provider, batchSize: 50 });
    await expect(service.run("daily:2026-08-12")).rejects.toThrow("RECONCILIATION_RETRY_LATER");
    expect(provider.listLedgerPage).toHaveBeenCalledWith({ cursor: null, limit: 50 });
    expect(store.failRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ retryable: true }));
  });

  it("collects every provider and internal page before bidirectional comparison", async () => {
    const internalRows = Array.from({ length: 101 }, (_, index) => ({ id: `in_${String(index).padStart(3, "0")}`, amount: index }));
    const providerPages = [internalRows.slice(0, 60), internalRows.slice(60)];
    let providerIndex = 0;
    const provider = { listLedgerPage: vi.fn(async () => ({ subscriptions: [], invoices: providerPages[providerIndex]!,
      refunds: [], disputes: [], nextCursor: ++providerIndex < providerPages.length ? `p${providerIndex}` : null })) };
    let internalIndex = 0;
    const internalPages = [internalRows.slice(0, 50), internalRows.slice(50, 100), internalRows.slice(100)];
    const store = {
      acquireRun: vi.fn(async () => ({ id: "run-all", cursor: null, leaseId: "lease-1" })),
      snapshotPage: vi.fn(async () => ({ subscriptions: [], invoices: internalPages[internalIndex]!,
        refunds: [], disputes: [], nextCursor: ++internalIndex < internalPages.length ? `i${internalIndex}` : null })),
      saveDiscrepancies: vi.fn(async () => undefined), completeRun: vi.fn(async () => undefined), failRun: vi.fn(),
      renewRun: vi.fn(async () => undefined),
    };
    const result = await new ReconciliationService({ store, provider, batchSize: 50 }).run("daily:all-pages");
    expect(result).toEqual({ runId: "run-all", discrepancies: 0, nextCursor: null });
    expect(provider.listLedgerPage).toHaveBeenCalledTimes(2);
    expect(store.snapshotPage).toHaveBeenCalledTimes(3);
    expect(store.saveDiscrepancies).not.toHaveBeenCalled();
    expect(store.completeRun).toHaveBeenCalledOnce();
  });

  it("supports more than twenty provider pages within one leased run attempt", async () => {
    let page = 0;
    const rows = Array.from({ length: 21 }, (_, index) => ({ id: `sub_${index}`, status: "active" }));
    const provider = { listLedgerPage: vi.fn(async () => ({ subscriptions: [rows[page]!], invoices: [], refunds: [],
      disputes: [], nextCursor: ++page < rows.length ? `p${page}` : null })) };
    const store = {
      acquireRun: vi.fn(async () => ({ id: "run-21", cursor: null, leaseId: "lease-21" })),
      snapshotPage: vi.fn(async () => ({ subscriptions: rows, invoices: [], refunds: [], disputes: [], nextCursor: null })),
      saveDiscrepancies: vi.fn(), completeRun: vi.fn(async () => undefined), failRun: vi.fn(),
      renewRun: vi.fn(async () => undefined),
    };
    await expect(new ReconciliationService({ store, provider, batchSize: 25 }).run("daily:21-pages"))
      .resolves.toMatchObject({ discrepancies: 0 });
    expect(provider.listLedgerPage).toHaveBeenCalledTimes(21);
    expect(store.acquireRun).toHaveBeenCalledOnce();
    expect(store.completeRun).toHaveBeenCalledOnce();
  });

  it("canonicalizes semantically equivalent provider and internal ledger shapes and reports only a real difference", async () => {
    const internal = { subscriptions: [{ id: "sub_active", status: "active" }, { id: "sub_grace", status: "grace_period" }],
      invoices: [{ id: "in_paid", status: "paid", amount: 1299 }],
      refunds: [{ id: "re_1", amount: 100 }], disputes: [{ id: "dp_1", status: "needs_review", amount: 1299 }] };
    const providerEquivalent = { subscriptions: [{ id: "sub_active", status: "active" }, { id: "sub_grace", status: "past_due" }],
      invoices: [{ id: "in_paid", status: "paid", amount: 1299 }],
      refunds: [{ id: "re_1", status: "succeeded", amount: 100 }],
      disputes: [{ id: "dp_1", status: "needs_response", amount: 1299 }], nextCursor: null };
    const makeStore = () => ({ acquireRun: vi.fn(async () => ({ id: "run-canonical", cursor: null })),
      snapshotPage: vi.fn(async () => ({ ...internal, nextCursor: null })), saveDiscrepancies: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined), failRun: vi.fn() });
    const equivalentStore = makeStore();
    await expect(new ReconciliationService({ store: equivalentStore,
      provider: { listLedgerPage: async () => providerEquivalent }, batchSize: 25 }).run("canonical:equal"))
      .resolves.toMatchObject({ discrepancies: 0 });
    expect(equivalentStore.saveDiscrepancies).not.toHaveBeenCalled();

    const changedStore = makeStore();
    const changed = { ...providerEquivalent,
      invoices: [{ id: "in_paid", status: "paid", amount: 1300 }] };
    await expect(new ReconciliationService({ store: changedStore,
      provider: { listLedgerPage: async () => changed }, batchSize: 25 }).run("canonical:changed"))
      .resolves.toMatchObject({ discrepancies: 1 });
    expect(changedStore.saveDiscrepancies).toHaveBeenCalledWith("run-canonical", [
      expect.objectContaining({ kind: "value_mismatch", objectType: "invoices", providerObjectId: "in_paid" }),
    ]);
  });

  it("persists phase and cursor across ticks to converge beyond one thousand provider pages without restart", async () => {
    const total = 1_001;
    const providerRows = Array.from({ length: total }, (_, index) => ({ id: `sub_${index}`, status: "active" }));
    let phase: "provider" | "internal" | "compare" = "provider";
    let cursor: string | null = null;
    let completed = false;
    let providerPages = 0;
    let internalPages = 0;
    let comparePages = 0;
    const collected = { provider: [] as LedgerSnapshot["subscriptions"],
      internal: [] as LedgerSnapshot["subscriptions"] };
    const providerCursors: Array<string | null> = [];
    const store = {
      acquireRun: vi.fn(async () => completed ? ({ id: "run-resume", cursor: null, completed: true, discrepancyCount: 0 })
        : ({ id: "run-resume", cursor, phase, leaseId: "lease-resume", providerPages, internalPages, comparePages })),
      snapshotPage: vi.fn(async () => ({ subscriptions: providerRows, invoices: [], refunds: [], disputes: [], nextCursor: null })),
      saveCollectedPage: vi.fn(async (_runId: string, side: "provider" | "internal", page: LedgerSnapshot) => {
        collected[side].push(...page.subscriptions);
      }),
      checkpointRun: vi.fn(async (_runId: string, next: { phase: typeof phase; cursor: string | null;
        providerPages: number; internalPages: number; comparePages: number }) => {
        phase = next.phase; cursor = next.cursor; providerPages = next.providerPages;
        internalPages = next.internalPages; comparePages = next.comparePages;
      }),
      comparisonPage: vi.fn(async (_runId: string, input: { cursor: string | null; limit: number }) => {
        const start = input.cursor ? Number(input.cursor) : 0;
        const end = Math.min(start + input.limit, collected.provider.length);
        return { rows: collected.provider.slice(start, end).map((providerRow, index) => ({
          objectType: "subscriptions" as const, providerObjectId: providerRow.id, provider: providerRow,
          internal: collected.internal[start + index] ?? null,
        })), nextCursor: end < collected.provider.length ? String(end) : null };
      }),
      renewRun: vi.fn(async () => undefined), saveDiscrepancies: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => { completed = true; }), failRun: vi.fn(),
    };
    const provider = { listLedgerPage: vi.fn(async ({ cursor: current }: { cursor: string | null }) => {
      providerCursors.push(current);
      const index = current ? Number(current.slice(1)) : 0;
      return { subscriptions: [providerRows[index]!], invoices: [], refunds: [], disputes: [],
        nextCursor: index + 1 < total ? `p${index + 1}` : null };
    }) };
    const service = new ReconciliationService({ store, provider, batchSize: 25, pagesPerRun: 100 });
    for (let tick = 0; tick < 20 && !completed; tick += 1) await service.run("resume:1001-pages");
    expect(completed).toBe(true);
    expect(provider.listLedgerPage).toHaveBeenCalledTimes(total);
    expect(providerCursors.filter((value) => value === null)).toHaveLength(1);
    expect(store.checkpointRun.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(store.acquireRun.mock.calls.length).toBeLessThan(20);
    expect(store.completeRun).toHaveBeenCalledOnce();
    expect(store.saveDiscrepancies).not.toHaveBeenCalled();
  });

  it("persists cursor history across ticks and backs off on a repeated provider cursor", async () => {
    let cursor: string | null = null;
    const history = new Set<string>();
    const failRun = vi.fn(async () => undefined);
    const store = {
      acquireRun: vi.fn(async () => ({ id: "run-cycle", cursor, phase: "provider" as const, leaseId: "lease-cycle",
        providerPages: history.size, internalPages: 0, comparePages: 0 })),
      snapshotPage: vi.fn(), saveCollectedPage: vi.fn(async () => undefined),
      checkpointRun: vi.fn(async (_runId: string, next: { cursor: string | null }) => {
        if (next.cursor && history.has(next.cursor)) throw new Error("RECONCILIATION_CURSOR_CYCLE");
        if (next.cursor) history.add(next.cursor);
        cursor = next.cursor;
      }),
      comparisonPage: vi.fn(), saveDiscrepancies: vi.fn(), completeRun: vi.fn(), failRun,
    };
    const provider = { listLedgerPage: vi.fn(async ({ cursor: current }: { cursor: string | null }) => ({
      subscriptions: [], invoices: [], refunds: [], disputes: [],
      nextCursor: current === null ? "cursor-a" : current === "cursor-a" ? "cursor-b" : "cursor-a",
    })) };
    const service = new ReconciliationService({ store, provider, batchSize: 25, pagesPerRun: 1 });
    await service.run("cycle:persisted");
    await service.run("cycle:persisted");
    await expect(service.run("cycle:persisted")).rejects.toThrow("RECONCILIATION_RETRY_LATER");
    expect(provider.listLedgerPage).toHaveBeenCalledTimes(3);
    expect(failRun).toHaveBeenLastCalledWith("run-cycle",
      { retryable: true, errorCode: "RECONCILIATION_CURSOR_CYCLE" }, "lease-cycle");
  });

  it("compares a large staged ledger in bounded database pages across worker ticks", async () => {
    const total = 250;
    const rows = Array.from({ length: total }, (_, index) => ({ objectType: "invoices" as const,
      providerObjectId: `in_${String(index).padStart(4, "0")}`,
      provider: { id: `in_${String(index).padStart(4, "0")}`, status: "paid", amount: index },
      internal: { id: `in_${String(index).padStart(4, "0")}`, status: "paid", amount: index },
    }));
    let cursor: string | null = null;
    let completed = false;
    const pageSizes: number[] = [];
    const store = {
      acquireRun: vi.fn(async () => completed
        ? ({ id: "run-merge", cursor: null, phase: "compare" as const, completed: true, discrepancyCount: 0 })
        : ({ id: "run-merge", cursor, phase: "compare" as const, leaseId: "lease-merge",
          providerPages: 1, internalPages: 1, comparePages: cursor ? Number(cursor) / 40 : 0 })),
      snapshotPage: vi.fn(), saveCollectedPage: vi.fn(async () => undefined),
      comparisonPage: vi.fn(async (_runId: string, input: { cursor: string | null; limit: number }) => {
        const start = input.cursor ? Number(input.cursor) : 0;
        const page = rows.slice(start, start + input.limit);
        pageSizes.push(page.length);
        return { rows: page, nextCursor: start + page.length < rows.length ? String(start + page.length) : null };
      }),
      checkpointRun: vi.fn(async (_runId: string, next: { cursor: string | null }) => { cursor = next.cursor; }),
      saveDiscrepancies: vi.fn(async () => undefined), countDiscrepancies: vi.fn(async () => 0),
      completeRun: vi.fn(async () => { completed = true; }), failRun: vi.fn(),
    };
    const service = new ReconciliationService({ store, provider: { listLedgerPage: vi.fn() }, batchSize: 40, pagesPerRun: 2 });
    for (let tick = 0; tick < 10 && !completed; tick += 1) await service.run("compare:bounded");
    expect(completed).toBe(true);
    expect(store.comparisonPage).toHaveBeenCalledTimes(7);
    expect(Math.max(...pageSizes)).toBeLessThanOrEqual(40);
    expect(store.saveDiscrepancies).not.toHaveBeenCalled();
    expect(store.completeRun).toHaveBeenCalledOnce();
  });
});
